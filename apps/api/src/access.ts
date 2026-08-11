import type { Env } from './types';

/**
 * Which hostnames Cloudflare Access actually fronts.
 *
 * Presence of `Cf-Access-Jwt-Assertion` is not evidence of anything on its own —
 * the header is client-supplied. The admin middleware used to accept any value,
 * on the premise that every admin-bearing hostname sits behind Access. That
 * premise is false: Access can only be attached to a hostname in a zone we own,
 * and `*.workers.dev` is not one. DEPLOY.md says so directly ("Access only works
 * on the custom domains"), while wrangler.toml deliberately keeps
 * `workers_dev = true` because race-lens.pages.dev has no other API origin.
 *
 * So on race-lens-api.jt7.workers.dev the presence check was equivalent to no
 * check at all, and that origin is published in the browser bundle
 * (lib/api.ts PAGES_DEV_API) and in DEPLOY.md.
 *
 * This is the gate that closes it. Admin is refused outright on any hostname
 * Access does not front, whatever header the caller sends. The workers.dev origin
 * stays ON for public browsing — it just stops serving /api/admin, which it could
 * never serve correctly anyway: the Access cookie is host-scoped, so the admin
 * SPA on *.pages.dev has never been able to authenticate against it.
 *
 * DO NOT TRY TO VERIFY THIS WITH `wrangler dev`. It cannot be done, and the
 * failure looks like a pass. When `routes` are declared in wrangler.toml, wrangler
 * dev rewrites request.url to the FIRST route's hostname, so the Worker sees
 * `racelens.runlytics.fit` no matter which local address you curl — this function
 * returns true for every local request and the gate appears to let everything
 * through, which is indistinguishable from the bug it fixes. Verify against the
 * deployed Worker instead (tools/preflight.mjs does), or unit-test this function
 * directly. It is pure and takes a URL string precisely so that it can be.
 */
export function onAccessHost(env: Env, url: string): boolean {
  const host = new URL(url).hostname.toLowerCase();
  return (env.ACCESS_HOSTS || '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean)
    .includes(host);
}

// ---------------------------------------------------------------------------
// JWT verification
// ---------------------------------------------------------------------------

interface Jwk { kid: string; kty: string; alg?: string; n: string; e: string }

/** Cached JWKS. Access rotates signing keys slowly; an hour is ample. */
const JWKS_TTL_MS = 60 * 60 * 1000;
let jwks: { keys: Jwk[]; fetchedAt: number } | null = null;

function b64url(input: string): Uint8Array {
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/')
    .padEnd(input.length + ((4 - (input.length % 4)) % 4), '=');
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function jsonPart(part: string): any {
  return JSON.parse(new TextDecoder().decode(b64url(part)));
}

async function getKeys(team: string): Promise<Jwk[]> {
  if (jwks && Date.now() - jwks.fetchedAt < JWKS_TTL_MS) return jwks.keys;
  const res = await fetch(`https://${team}.cloudflareaccess.com/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Access JWKS fetch failed: ${res.status}`);
  const body = (await res.json()) as { keys?: Jwk[] };
  jwks = { keys: body.keys ?? [], fetchedAt: Date.now() };
  return jwks.keys;
}

export interface AccessClaims {
  email?: string;
  sub?: string;
  aud: string | string[];
  iss: string;
  exp: number;
  iat?: number;
  nbf?: number;
}

/**
 * Verified Access claims, or null. Never throws for an untrusted token.
 *
 * Fails closed on every uncertainty, including an unreachable JWKS — an admin gate
 * that opens when a dependency is down is not a gate.
 */
export async function verifyAccessJwt(
  env: Env,
  token: string | undefined,
): Promise<AccessClaims | null> {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [rawHeader, rawPayload, rawSig] = parts;

  try {
    const header = jsonPart(rawHeader) as { kid?: string; alg?: string };
    // Pin the algorithm. Trusting the token's own `alg` is how `alg: none` and
    // RS256-to-HS256 confusion attacks work.
    if (header.alg !== 'RS256' || !header.kid) return null;

    const key = (await getKeys(env.CF_ACCESS_TEAM)).find((k) => k.kid === header.kid);
    if (!key) return null;

    const cryptoKey = await crypto.subtle.importKey(
      'jwk',
      { kty: key.kty, n: key.n, e: key.e, alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    const ok = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      cryptoKey,
      b64url(rawSig),
      new TextEncoder().encode(`${rawHeader}.${rawPayload}`),
    );
    if (!ok) return null;

    const claims = jsonPart(rawPayload) as AccessClaims;

    // The audience check is doing real work here, not box-ticking.
    //
    // This Access team (animekizz) also fronts unrelated applications — a
    // dashboard, a bridge, an ingest path on another domain. Every one of them is
    // signed by the SAME team keys, so signature validity alone would let a token
    // minted for any of those in through this door. `aud` is the only claim that
    // distinguishes them.
    //
    // And it is a LIST, because finish-deploy.sh creates one application per
    // hostname, so Race Lens has two AUD tags. Pinning one would 403 the organizer
    // on whichever domain they did not sign in through — a failure this repo
    // already hit once with a per-path split (see the comment above the loop in
    // tools/finish-deploy.sh).
    const allowedAud = (env.CF_ACCESS_AUD || '')
      .split(',').map((a) => a.trim()).filter(Boolean);
    if (!allowedAud.length) return null;
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.some((a) => allowedAud.includes(a))) return null;

    if (claims.iss !== `https://${env.CF_ACCESS_TEAM}.cloudflareaccess.com`) return null;

    const now = Math.floor(Date.now() / 1000);
    // 60s of skew, matching Cloudflare's own examples.
    if (typeof claims.exp !== 'number' || claims.exp + 60 < now) return null;
    if (typeof claims.nbf === 'number' && claims.nbf - 60 > now) return null;

    return claims;
  } catch {
    // A malformed token, an unknown key, or an unreachable JWKS are all rejections
    // rather than 500s — and rejection means no admin access.
    return null;
  }
}
