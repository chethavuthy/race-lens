#!/usr/bin/env node
/**
 * Pre-deploy validation.
 *
 * Every check here corresponds to a way the app fails *silently* in production:
 * a placeholder D1 id, a missing model file that only 404s when someone tries a
 * selfie, an unverified embedding parity gate. Run it before `wrangler deploy`
 * and before pointing Pages at a build.
 *
 *   node tools/preflight.mjs            # checks that need no credentials
 *   node tools/preflight.mjs --remote   # also probes a deployed API base
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const args = process.argv.slice(2);
const remote = args.includes('--remote');
const apiBase = (args.find((a) => a.startsWith('--api='))?.split('=')[1] ?? process.env.API_BASE_URL ?? '').replace(/\/+$/, '');

let fail = 0;
let warn = 0;
const ok = (m) => console.log(`  \x1b[32mok\x1b[0m    ${m}`);
const bad = (m, fix) => { fail++; console.log(`  \x1b[31mFAIL\x1b[0m  ${m}`); if (fix) console.log(`        → ${fix}`); };
const soft = (m, fix) => { warn++; console.log(`  \x1b[33mwarn\x1b[0m  ${m}`); if (fix) console.log(`        → ${fix}`); };

const read = (p) => { try { return readFileSync(join(root, p), 'utf8'); } catch { return null; } };
const sizeOf = (p) => { try { return statSync(join(root, p)).size; } catch { return 0; } };

console.log('\nRace Lens preflight\n');

// ---------------------------------------------------------------- Worker config
console.log('Worker config');
const toml = read('apps/api/wrangler.toml');
if (!toml) {
  bad('apps/api/wrangler.toml is missing');
} else {
  if (/REPLACE_WITH_D1_ID/.test(toml)) {
    bad('database_id is still the placeholder',
        'npx wrangler d1 create race-lens, then paste the id into apps/api/wrangler.toml');
  } else if (/database_id\s*=\s*"[0-9a-f-]{36}"/.test(toml)) {
    ok('D1 database_id looks like a real uuid');
  } else {
    soft('database_id is set but is not a uuid — double-check it');
  }

  // Comma-separated allowlist. A *.pages.dev entry is fine alongside a real
  // domain; it is only a smell when it is the only origin configured.
  const origins = (toml.match(/WEB_ORIGIN\s*=\s*"([^"]*)"/)?.[1] ?? '')
    .split(',').map((o) => o.trim()).filter(Boolean);
  const custom = origins.filter((o) => !/\.pages\.dev$/.test(o));
  if (!origins.length) {
    bad('WEB_ORIGIN is empty — CORS will reject every browser request');
  } else if (!custom.length) {
    soft(`WEB_ORIGIN is only "${origins.join(', ')}"`,
         'Add the real custom domain once its DNS is live');
  } else {
    ok(`WEB_ORIGIN allows ${origins.length} origins (${custom.join(', ')})`);
  }

  // This is the one that must never be wrong in production.
  const bypass = toml.match(/DEV_ADMIN_BYPASS\s*=\s*"([^"]*)"/)?.[1];
  if (bypass === '1') {
    bad('DEV_ADMIN_BYPASS is "1" in wrangler.toml — admin would be WIDE OPEN',
        'Set it to "0". It belongs only in apps/api/.dev.vars, which is gitignored.');
  } else {
    ok('DEV_ADMIN_BYPASS is off (admin fails closed without Cloudflare Access)');
  }

  // ACCESS_HOSTS is what stops /api/admin/* answering on the workers.dev origin,
  // which Cloudflare Access cannot cover. Empty means the gate fails closed
  // everywhere — safe, but admin is then unreachable, so say so rather than
  // letting someone discover it as a 403 they cannot explain.
  const accessHosts = (toml.match(/ACCESS_HOSTS\s*=\s*"([^"]*)"/)?.[1] ?? '')
    .split(',').map((h) => h.trim()).filter(Boolean);
  if (!accessHosts.length) {
    bad('ACCESS_HOSTS is empty — /api/admin/* is refused on every hostname',
        'List the hostnames your Access applications front, e.g. "racelens.runlytics.fit,race-lens.runlytics.fit"');
  } else if (accessHosts.some((h) => /\.workers\.dev$/.test(h))) {
    bad('ACCESS_HOSTS contains a *.workers.dev hostname — that reopens the admin bypass',
        'Access cannot be attached to workers.dev. Remove it; the origin stays live for public browsing.');
  } else {
    ok(`ACCESS_HOSTS gates admin to ${accessHosts.join(', ')}`);
  }

  // Required now that verifyAccessJwt reads them. Absent, it fails closed and the
  // organizer is locked out of /admin with a 403 they cannot explain — safe, but
  // worth catching here rather than in the dashboard.
  const team = toml.match(/CF_ACCESS_TEAM\s*=\s*"([^"]*)"/)?.[1] ?? '';
  if (!team || team.startsWith('<')) {
    bad('CF_ACCESS_TEAM is unset — admin JWT verification fails closed',
        'Your Access team name, i.e. <team>.cloudflareaccess.com');
  } else ok(`CF_ACCESS_TEAM is "${team}"`);

  const auds = (toml.match(/CF_ACCESS_AUD\s*=\s*"([^"]*)"/)?.[1] ?? '')
    .split(',').map((a) => a.trim()).filter(Boolean);
  const looksLikeAud = (a) => /^[0-9a-f]{64}$/.test(a);
  if (!auds.length || auds.some((a) => a.startsWith('<'))) {
    bad('CF_ACCESS_AUD is unset — admin JWT verification fails closed',
        'One AUD tag per Access application, comma-separated');
  } else if (!auds.every(looksLikeAud)) {
    bad(`CF_ACCESS_AUD has ${auds.length} entries but one is not a 64-char hex AUD tag`);
  } else if (auds.length < accessHosts.length) {
    soft(`CF_ACCESS_AUD lists ${auds.length} tag(s) for ${accessHosts.length} host(s)`,
         'finish-deploy.sh creates one application PER HOSTNAME, so expect one AUD each — a missing one 403s that domain');
  } else {
    ok(`CF_ACCESS_AUD accepts ${auds.length} audience(s)`);
  }
}

// ------------------------------------------------------------------- ML models
console.log('\nBrowser face models');
const det = sizeOf('apps/web/public/models/det_500m.onnx');
const rec = sizeOf('apps/web/public/models/w600k_mbf.onnx');
if (det < 1_000_000) bad('det_500m.onnx missing or truncated', './tools/fetch-models.sh');
else ok(`det_500m.onnx  ${(det / 1e6).toFixed(1)} MB`);
if (rec < 5_000_000) bad('w600k_mbf.onnx missing or truncated', './tools/fetch-models.sh');
else ok(`w600k_mbf.onnx ${(rec / 1e6).toFixed(1)} MB`);
if (det && rec) {
  console.log(`        selfie/upload search downloads ${((det + rec) / 1e6).toFixed(0)} MB on first use`);
}

// ------------------------------------------------------- Phase 5 parity evidence
console.log('\nEmbedding parity (Phase 5 gate)');
const parity = read('tools/golden/RESULT.json');
if (!parity) {
  bad('No recorded golden result — browser/Python parity is unverified',
      'python tools/golden/make_golden.py <face.jpg>, then open /golden. ' +
      'If this is wrong, every face search silently returns nothing.');
} else {
  const r = JSON.parse(parity);
  if (r.cosine >= 0.99) ok(`cosine ${r.cosine.toFixed(5)} (gate: >= 0.99)`);
  else bad(`cosine ${r.cosine.toFixed(5)} is below the 0.99 gate`,
           'See the /golden page — it isolates which stage diverged.');
}

// ------------------------------------------------------------------ build output
console.log('\nFrontend build');
if (!existsSync(join(root, 'apps/web/dist/index.html'))) {
  soft('apps/web/dist is not built', 'npm run build');
} else {
  ok('apps/web/dist exists');
  if (!existsSync(join(root, 'apps/web/dist/_redirects'))) {
    bad('dist/_redirects missing — deep links like /e/slug would 404 on Pages');
  } else ok('_redirects present (SPA fallback)');
  // The dev-only golden route must never reach production.
  const hasGolden = existsSync(join(root, 'apps/web/dist/golden'));
  if (hasGolden) soft('dist contains golden fixtures — harmless but unnecessary in production');
}

// ------------------------------------------------------------------ live probe
if (remote) {
  console.log('\nDeployed API');
  if (!apiBase) {
    bad('--remote given but no API base', 'node tools/preflight.mjs --remote --api=https://…');
  } else {
    const probe = async (path, expect, label) => {
      try {
        const res = await fetch(apiBase + path, { redirect: 'manual' });
        if (expect.includes(res.status)) ok(`${label} → ${res.status}`);
        else bad(`${label} → ${res.status} (expected ${expect.join(' or ')})`);
      } catch (e) {
        bad(`${label} → ${e.message}`);
      }
    };
    await probe('/api/events', [200], 'GET /api/events (liveness)');
    await probe('/health', [200, 404], 'GET /health (flaps while a new workers.dev subdomain propagates)');
    // Must be refused: these are the two doors into the system.
    await probe('/api/admin/events', [403, 302], 'GET /api/admin/events, no header');

    // The probe above is NOT sufficient on its own, and used to be the whole test.
    //
    // The admin guard once accepted any non-empty Cf-Access-Jwt-Assertion, and this
    // file sends no such header — so it got its 403 and reported "ok" while
    // `curl -H 'Cf-Access-Jwt-Assertion: x'` against the same URL returned 200 and
    // full organizer control. A check that only exercises the path an attacker
    // would not take is worse than no check: it manufactures confidence.
    //
    // Note this cannot be verified with `wrangler dev` — declaring `routes` makes
    // it rewrite request.url to the first route's hostname, so the hostname gate
    // passes locally no matter what you connect to. Only a deployed origin answers
    // this honestly, which is why it lives behind --remote.
    try {
      const forged = await fetch(`${apiBase}/api/admin/events`, {
        redirect: 'manual',
        headers: { 'Cf-Access-Jwt-Assertion': 'forged.not.a.jwt' },
      });
      if (forged.status === 403 || forged.status === 302) {
        ok(`GET /api/admin/events with a forged assertion → ${forged.status}`);
      } else {
        bad(`forged Cf-Access-Jwt-Assertion → ${forged.status} (expected 403 or 302) — ADMIN IS OPEN`,
            'Check ACCESS_HOSTS in wrangler.toml covers only Access-fronted hostnames, and that this --api base is one of them');
      }
    } catch (e) { bad(`forged-assertion probe → ${e.message}`); }
    try {
      const res = await fetch(`${apiBase}/api/internal/events/x/finalize`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ingest-Secret': 'wrong' }, body: '{}',
      });
      if (res.status === 401) ok('POST /api/internal/* with a bad secret → 401');
      else bad(`POST /api/internal/* with a bad secret → ${res.status} (expected 401)`);
    } catch (e) { bad(`internal probe → ${e.message}`); }
  }
}

console.log(
  `\n${fail ? `\x1b[31m${fail} blocking\x1b[0m` : '\x1b[32m0 blocking\x1b[0m'}` +
  `, ${warn} warning${warn === 1 ? '' : 's'}\n`,
);
process.exit(fail ? 1 : 0);
