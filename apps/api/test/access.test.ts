/**
 * verifyAccessJwt, exercised against a keypair we control.
 *
 * Production cannot test this: the hostname gate 403s on workers.dev and Access
 * itself 302s on the custom domain, so both outer layers shield the function from
 * any request an outsider can make. It only ever runs for a real logged-in session
 * — which means a bug here surfaces as the organizer being locked out of /admin,
 * and that is precisely the failure worth catching before it happens.
 *
 * So: generate an RSA keypair, serve it as the team JWKS through a stubbed fetch,
 * and sign real tokens. Everything except Cloudflare's own private key is genuine,
 * including the WebCrypto verification path.
 */
import { generateKeyPairSync, createSign, randomBytes } from 'node:crypto';
import { verifyAccessJwt, onAccessHost } from '../src/access.ts';

const TEAM = 'animekizz';
const AUD_A = 'a'.repeat(64);
const AUD_B = 'b'.repeat(64);
const OTHER_APP_AUD = 'c'.repeat(64);   // e.g. the team's unrelated dashboard
const KID = 'testkid0000000001';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = publicKey.export({ format: 'jwk' });

// Serve the JWKS the way Cloudflare does.
let jwksRequests = 0;
globalThis.fetch = async (url) => {
  if (String(url) === `https://${TEAM}.cloudflareaccess.com/cdn-cgi/access/certs`) {
    jwksRequests++;
    return new Response(JSON.stringify({
      keys: [{ kid: KID, kty: 'RSA', alg: 'RS256', use: 'sig', n: jwk.n, e: jwk.e }],
    }), { status: 200 });
  }
  return new Response('not found', { status: 404 });
};

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const now = () => Math.floor(Date.now() / 1000);

function sign(payload, { alg = 'RS256', kid = KID, breakSig = false } = {}) {
  const head = b64({ alg, kid, typ: 'JWT' });
  const body = b64(payload);
  const signer = createSign('RSA-SHA256');
  signer.update(`${head}.${body}`);
  let sig = signer.sign(privateKey).toString('base64url');
  if (breakSig) sig = Buffer.from(randomBytes(256)).toString('base64url');
  return `${head}.${body}.${sig}`;
}

const good = () => ({
  aud: AUD_A,
  iss: `https://${TEAM}.cloudflareaccess.com`,
  email: 'vuthychetha@gmail.com',
  exp: now() + 3600,
  iat: now(),
});

const env = { CF_ACCESS_TEAM: TEAM, CF_ACCESS_AUD: `${AUD_A},${AUD_B}`, ACCESS_HOSTS: '' };

let fail = 0;
async function check(label, token, wantAccept, envOverride) {
  const claims = await verifyAccessJwt(envOverride ?? env, token);
  const accepted = claims !== null;
  const ok = accepted === wantAccept;
  if (!ok) fail++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${accepted ? 'ACCEPT' : 'reject'} (want ${wantAccept ? 'ACCEPT' : 'reject'})  ${label}`);
  return claims;
}

console.log('verifyAccessJwt:');

// --- must accept -----------------------------------------------------------
const claims = await check('a properly signed token for AUD A', sign(good()), true);
if (claims?.email !== 'vuthychetha@gmail.com') { fail++; console.log('  FAIL  claims.email not returned'); }
await check('the SECOND audience (per-hostname app)', sign({ ...good(), aud: AUD_B }), true);
await check('aud as an array containing a valid tag', sign({ ...good(), aud: [OTHER_APP_AUD, AUD_B] }), true);
await check('exp 30s in the past (inside 60s skew)', sign({ ...good(), exp: now() - 30 }), true);

// --- must reject -----------------------------------------------------------
await check('valid signature, WRONG audience (a sibling app in the same team)',
  sign({ ...good(), aud: OTHER_APP_AUD }), false);
await check('tampered signature', sign(good(), { breakSig: true }), false);
await check('alg: none', sign(good(), { alg: 'none' }), false);
await check('alg: HS256 (confusion attempt)', sign(good(), { alg: 'HS256' }), false);
await check('unknown kid', sign(good(), { kid: 'nope' }), false);
await check('expired well beyond skew', sign({ ...good(), exp: now() - 7200 }), false);
await check('nbf in the future', sign({ ...good(), nbf: now() + 7200 }), false);
await check('wrong issuer (another team)',
  sign({ ...good(), iss: 'https://evil.cloudflareaccess.com' }), false);
await check('no exp claim at all', sign({ aud: AUD_A, iss: `https://${TEAM}.cloudflareaccess.com` }), false);
await check('undefined token', undefined, false);
await check('empty string', '', false);
await check('not a JWT', 'garbage', false);
await check('two segments only', 'aaa.bbb', false);
await check('CF_ACCESS_AUD empty -> fails closed', sign(good()), false,
  { ...env, CF_ACCESS_AUD: '' });
await check('CF_ACCESS_AUD whitespace only -> fails closed', sign(good()), false,
  { ...env, CF_ACCESS_AUD: ' , ' });

// --- JWKS unreachable must fail closed, not open ---------------------------
const realFetch = globalThis.fetch;
globalThis.fetch = async () => new Response('down', { status: 503 });
await check('JWKS 503 (cold cache) -> fails closed', sign(good()), false,
  { ...env, CF_ACCESS_TEAM: 'coldteam' });
globalThis.fetch = realFetch;

// --- the JWKS is cached, not refetched per request -------------------------
const before = jwksRequests;
for (let i = 0; i < 5; i++) await verifyAccessJwt(env, sign(good()));
const added = jwksRequests - before;
if (added === 0) console.log(`  ok   JWKS cached across 5 verifications (0 extra fetches)`);
else { fail++; console.log(`  FAIL JWKS refetched ${added}x across 5 verifications`); }

console.log('\nonAccessHost:');
for (const [hosts, url, want] of [
  ['racelens.runlytics.fit,race-lens.runlytics.fit', 'https://racelens.runlytics.fit/api/admin/events', true],
  ['racelens.runlytics.fit,race-lens.runlytics.fit', 'https://race-lens-api.jt7.workers.dev/api/admin/events', false],
  ['racelens.runlytics.fit', 'https://evil.racelens.runlytics.fit/x', false],
  ['', 'https://racelens.runlytics.fit/x', false],
]) {
  const got = onAccessHost({ ACCESS_HOSTS: hosts }, url);
  const ok = got === want;
  if (!ok) fail++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${String(got).padEnd(5)} ${new URL(url).hostname}  (hosts="${hosts}")`);
}

console.log(fail ? `\n${fail} FAILURES` : '\nall cases pass');
process.exit(fail ? 1 : 0);
