/**
 * Per-event share previews.
 *
 * This site spreads by someone dropping a link into a running club's Telegram
 * or Facebook group. Every /e/:slug URL is the same SPA shell, so every one of
 * those links previewed identically: one generic title, no event name, no
 * photo. The link that does the marketing looked like nothing.
 *
 * Crawlers do not run the SPA, so the tags have to be in the HTML that comes
 * off the wire. This Function serves the ordinary shell and rewrites the head
 * as it streams.
 *
 * Rules it follows:
 *  - Never break the page for a metadata problem. Any failure fetching the
 *    event falls through to the unmodified shell.
 *  - Never block on the API longer than a person would wait for the page.
 */

interface Env {
  ASSETS: Fetcher;
  /** Set in the Pages project to point at a non-default API. */
  API_BASE?: string;
}

const DEFAULT_API = 'https://race-lens-api.jt7.workers.dev';
const API_TIMEOUT_MS = 1500;

interface EventSummary {
  name: string;
  event_date: string | null;
  banner_url: string | null;
  photo_count: number;
  bibs_enabled: boolean;
}

/**
 * Escape for an HTML attribute value.
 *
 * Event names are typed by organizers in /admin and are not trusted input:
 * "Bob's 5K" would terminate a single-quoted attribute, and a name containing
 * a tag would break out of the head entirely.
 */
function attr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function describe(e: EventSummary): string {
  const count = e.photo_count.toLocaleString('en-US');
  const how = e.bibs_enabled ? 'your bib number or your face' : 'your face';
  return `${count} photos from this race. Find yourself by ${how} — free, no account, and your selfie never leaves your phone.`;
}

/** "2 August 2026", or '' when the organizer left the date blank. */
function longDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  });
}

async function loadEvent(base: string, slug: string): Promise<EventSummary | null> {
  // A slow API must not hold the page hostage; the shell alone is a fine result.
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), API_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/api/events/${encodeURIComponent(slug)}`, {
      signal: abort.signal,
      cf: { cacheTtl: 300, cacheEverything: true },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { event?: EventSummary };
    return body.event ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  const { request, env, params } = ctx;

  // params.slug is string | string[] depending on the route shape.
  const slug = Array.isArray(params.slug) ? params.slug[0] : params.slug;

  const url = new URL(request.url);

  // Fetch the ORIGINAL url, not /index.html.
  //
  // _redirects carries the SPA rule `/*  /index.html  200`, and asking the
  // asset server for /index.html directly makes it strip the `/index.html`
  // suffix and answer 308 to `/`. That redirect then became the response —
  // every event link bounced to the home page. Requesting /e/<slug> instead
  // lets the same rule resolve to the shell with a 200, which is what we want
  // to rewrite.
  const shell = await env.ASSETS.fetch(request);

  // Only rewrite an HTML page. If the asset server ever answers something else
  // (a redirect, a 404), pass it through untouched rather than injecting a head
  // into it.
  const isHtml = (shell.headers.get('content-type') ?? '').includes('text/html');
  if (!slug || !isHtml) return shell;

  const event = await loadEvent(env.API_BASE ?? DEFAULT_API, slug);
  if (!event) return shell;

  const date = longDate(event.event_date);
  const title = date ? `${event.name} — ${date}` : event.name;
  const description = describe(event);
  const canonical = `${url.origin}/e/${encodeURIComponent(slug)}`;

  const tags =
    `<title>${attr(title)} | Race Lens</title>` +
    `<meta name="description" content="${attr(description)}" />` +
    `<link rel="canonical" href="${attr(canonical)}" />` +
    `<meta property="og:type" content="website" />` +
    `<meta property="og:site_name" content="Race Lens" />` +
    `<meta property="og:title" content="${attr(title)}" />` +
    `<meta property="og:description" content="${attr(description)}" />` +
    `<meta property="og:url" content="${attr(canonical)}" />` +
    (event.banner_url
      ? `<meta property="og:image" content="${attr(event.banner_url)}" />` +
        `<meta name="twitter:card" content="summary_large_image" />` +
        `<meta name="twitter:image" content="${attr(event.banner_url)}" />`
      : `<meta name="twitter:card" content="summary" />`) +
    `<meta name="twitter:title" content="${attr(title)}" />` +
    `<meta name="twitter:description" content="${attr(description)}" />`;

  return new HTMLRewriter()
    // The shell ships a static <title> and <meta name="description">. Leaving
    // them in place would give crawlers two of each, and which one wins is not
    // something to leave to chance — drop them, then append ours.
    .on('title', { element(el) { el.remove(); } })
    .on('meta[name="description"]', { element(el) { el.remove(); } })
    .on('head', { element(el) { el.append(tags, { html: true }); } })
    .transform(shell);
};
