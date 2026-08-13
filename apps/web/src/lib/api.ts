export interface EventSummary {
  id: string;
  slug: string;
  name: string;
  event_date: string | null;
  banner_url: string | null;
  status: 'draft' | 'indexing' | 'ready' | 'partial';
  photo_count: number;
  face_count: number;
  /** False for events that hand out no bibs; bib search is unavailable. */
  bibs_enabled: boolean;
  created_at?: string;
  /**
   * Who created it. Only sent to the operator, and null on events that predate
   * ownership — which are the operator's own.
   */
  owner_email?: string | null;
}

/**
 * One photographer's contribution to an event — a Drive folder, credited.
 *
 * `name` is null until an organizer records one, in which case the page shows the
 * album link on its own rather than inventing a byline.
 */
export interface Credit {
  name: string | null;
  album_url: string;
  photo_count: number;
}

export interface Photo {
  id: string;
  thumb_url: string | null;
  original_url: string;
  width: number | null;
  height: number | null;
  taken_at: string | null;
}

/** A face box as fractions of its frame: 0..1 from the top-left. */
export interface FaceBox { x: number; y: number; w: number; h: number }

export interface FaceMatch {
  photo: Photo;
  score: number;
  /**
   * The matched face, already converted to fractions by the API.
   *
   * Deliberately NOT pixels. When this was `bbox` in source pixels, the browser
   * had to divide it by photo.width/height to crop the tile — which made the
   * client the second component that had to know the indexer's pixel space, and
   * when the indexer recorded the wrong one, the crop framed empty road while the
   * caption still claimed it was cropped to you. Null when the frame has no
   * recorded dimensions.
   */
  box: FaceBox | null;
}

export interface Job {
  id: string;
  event_id: string;
  status: 'queued' | 'running' | 'done' | 'partial' | 'failed';
  done: number;
  total: number;
  error: string | null;
  updated_at: string;
}

/**
 * Someone who has published at least one event — or who was banned before they
 * got that far, so the screen that can undo it still lists them.
 */
export interface Organizer {
  email: string;
  events: number;
  photos: number;
  published: number;
  /** Null until they publish something; they may be freshly invited. */
  last_event: string | null;
  /** Null for anyone who predates the guest list but owns events. */
  added_at: string | null;
  /** Set when their access has been withdrawn. */
  banned_at: string | null;
}

export class ApiError extends Error {
  constructor(message: string, public code: string, public status: number) {
    super(message);
  }
}

/**
 * Where the API lives, resolved at runtime because one build serves several
 * hostnames.
 *
 * On the custom domains a Worker route claims /api/*, so a relative path keeps
 * the API same-origin. That is not a style preference: Cloudflare Access sets a
 * host-scoped cookie, and a cross-origin admin fetch would never carry it, so
 * /admin would be permanently broken.
 *
 * *.pages.dev has no Worker route, so it falls back to the Worker's own origin
 * and relies on CORS. Public browsing works there; admin does not.
 */
/**
 * The pages.dev fallback is a hardcoded constant, deliberately.
 *
 * It used to read VITE_API_FALLBACK_BASE, which nothing ever set, so the branch
 * was dead and *.pages.dev sent /api/* to the SPA catch-all — which answers with
 * index.html and a 200. JSON.parse then yielded null and every page died with
 * "Cannot read properties of null (reading 'event')". A correctness-critical
 * path must not depend on a build variable someone has to remember to pass.
 */
const PAGES_DEV_API = 'https://race-lens-api.jt7.workers.dev';

function resolveApiBase(): string {
  const forced = import.meta.env.VITE_API_BASE;
  if (forced) return String(forced).replace(/\/+$/, '');
  if (typeof location !== 'undefined' && location.hostname.endsWith('.pages.dev')) {
    return PAGES_DEV_API;
  }
  return '';
}

const BASE = resolveApiBase();

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, init);
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }
  if (!res.ok) {
    throw new ApiError(body?.error ?? `Request failed (${res.status})`, body?.code ?? 'http', res.status);
  }
  return body as T;
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const api = {
  listEvents: () => req<{ events: EventSummary[] }>('/api/events'),

  getEvent: (slug: string) =>
    req<{ event: EventSummary; photos: Photo[]; cursor: string | null; credits: Credit[] }>(
      `/api/events/${slug}`),

  getPhotos: (slug: string, cursor: string | null, limit = 60) =>
    req<{ photos: Photo[]; cursor: string | null }>(
      `/api/events/${slug}/photos?limit=${limit}&cursor=${encodeURIComponent(cursor ?? '')}`,
    ),

  searchBib: (slug: string, bib: string, fuzzy = false) =>
    req<{
      matched: 'exact' | 'suffix' | null;
      bib_read: string | null;
      photos: Photo[];
      fuzzy_available: boolean;
    }>(`/api/events/${slug}/bib/${encodeURIComponent(bib)}${fuzzy ? '?fuzzy=1' : ''}`),

  searchFace: (slug: string, vec: number[], threshold?: number) =>
    req<{ matches: FaceMatch[] }>(
      `/api/events/${slug}/search/face${threshold != null ? `?t=${threshold}` : ''}`,
      json({ vec }),
    ),

  admin: {
    /**
     * Who is signed in. `owner` is false for every photographer let through the
     * Access list, and gates the operator-only half of the admin pages.
     */
    me: () => req<{ email: string | null; owner: boolean }>('/api/admin/me'),

    /** Operator only: the guest list, with what each person has published. */
    organizers: () => req<{ organizers: Organizer[] }>('/api/admin/organizers'),

    /** Let a photographer in. Also lifts a previous removal. */
    addOrganizer: (email: string) =>
      req<{ email: string }>('/api/admin/organizers', json({ email })),

    /** Drop a row typed in error. Refused once they have events. */
    removeOrganizer: (email: string) =>
      req<{ ok: true }>(`/api/admin/organizers/${encodeURIComponent(email)}`,
                        { method: 'DELETE' }),

    ban: (email: string, opts: { reason?: string; unpublish?: boolean } = {}) =>
      req<{ banned: string; unpublished: number }>(
        `/api/admin/organizers/${encodeURIComponent(email)}/ban`, json(opts)),

    unban: (email: string) =>
      req<{ ok: true }>(`/api/admin/organizers/${encodeURIComponent(email)}/ban`,
                        { method: 'DELETE' }),

    inspect: (url: string) =>
      req<{
        folder_id: string;
        image_count: number;
        subfolder_count: number;
        subfolders: string[];
        truncated: boolean;
        samples: { id: string; name: string; thumb: string }[];
      }>('/api/admin/drive/inspect', json({ url })),

    listEvents: () => req<{ events: EventSummary[] }>('/api/admin/events'),

    createEvent: (body: { name: string; event_date?: string; slug?: string; bibs_enabled?: boolean }) =>
      req<{ event: EventSummary }>('/api/admin/events', json(body)),

    uploadBanner: (eventId: string, file: File) => {
      const fd = new FormData();
      fd.append('file', file);
      return req<{ banner_url: string }>(`/api/admin/events/${eventId}/banner`, { method: 'POST', body: fd });
    },

    setStatus: (eventId: string, status: EventSummary['status']) =>
      req<{ event: EventSummary }>(`/api/admin/events/${eventId}`, {
        ...json({ status }),
        method: 'PATCH',
      }),

    setBibsEnabled: (eventId: string, bibsEnabled: boolean) =>
      req<{ event: EventSummary }>(`/api/admin/events/${eventId}`, {
        ...json({ bibs_enabled: bibsEnabled }),
        method: 'PATCH',
      }),

    // imageSource is optional on purpose: omitting it keeps whatever an existing
    // link is already set to. Defaulting it here to 'original' meant the Add-link
    // form, which never passes one, reset the row toggle every time it ran.
    ingest: (eventId: string, driveUrl: string, imageSource?: 'original' | 'thumb') =>
      req<{ job_id: string; source_id: string; folder_id: string }>(
        '/api/admin/ingest',
        json({
          event_id: eventId,
          drive_url: driveUrl,
          ...(imageSource ? { image_source: imageSource } : {}),
        }),
      ),

    startBenchmark: (url: string, sample = 6) =>
      req<{ benchmark_id: string; folder_id: string; sample: number }>(
        '/api/admin/drive/benchmark', json({ url, sample })),

    getBenchmark: (id: string) =>
      req<{ benchmark: {
        id: string; status: string; error: string | null;
        result: null | {
          sampled: number; folder_images: number; size_ratio: number;
          thumb: { bytes: number; faces: number; bibs: number };
          original: { bytes: number; faces: number; bibs: number };
          bibs_only_in_original: string[]; bibs_only_in_thumb: string[];
          est_photos_per_pass: { thumb: number; original: number };
        };
      } }>(`/api/admin/benchmarks/${id}`),

    getJob: (jobId: string) => req<{ job: Job }>(`/api/admin/jobs/${jobId}`),

    getEvent: (eventId: string) =>
      req<{ event: EventSummary }>(`/api/admin/events/${eventId}`),

    setImageSource: (sourceId: string, imageSource: 'original' | 'thumb') =>
      req<{ ok: true }>(`/api/admin/sources/${sourceId}`, {
        ...json({ image_source: imageSource }), method: 'PATCH',
      }),

    /** The photographer's byline on the event page. Empty clears it. */
    setCredit: (sourceId: string, creditName: string) =>
      req<{ ok: true }>(`/api/admin/sources/${sourceId}`, {
        ...json({ credit_name: creditName }), method: 'PATCH',
      }),

    /**
     * One round of a link removal. Returns what is left to purge, because a large
     * album takes several calls — see removeSourceFully in AdminEvent.vue.
     */
    removeSource: (sourceId: string) =>
      req<{ ok: true; purged: number; remaining: number }>(
        `/api/admin/sources/${sourceId}`, { method: 'DELETE' }),

    restoreSource: (sourceId: string) =>
      req<{ ok: true }>(`/api/admin/sources/${sourceId}/restore`, { method: 'POST' }),

    reindexSource: (sourceId: string) =>
      req<{ job_id: string }>(`/api/admin/sources/${sourceId}/reindex`, { method: 'POST' }),

    photos: (eventId: string, cursor: string | null, filter = 'all') =>
      req<{
        photos: (Photo & {
          faces: { id: string; bib: string | null; x: number; y: number; w: number; h: number }[];
          bibs: { bib: string; bib_key: string; conf: number | null; source: string }[];
        })[];
        cursor: string | null;
      }>(`/api/admin/events/${eventId}/photos?filter=${filter}&cursor=${encodeURIComponent(cursor ?? '')}`),

    reindexPhoto: (photoId: string) =>
      req<{ job_id: string }>(`/api/admin/photos/${photoId}/reindex`, { method: 'POST' }),

    setFaceBib: (faceId: string, bib: string) =>
      req<{ ok: true; bib: string | null }>(`/api/admin/faces/${faceId}/bib`, json({ bib })),

    addBib: (photoId: string, bib: string) =>
      req<{ ok: true; bib: string; bib_raw: string }>(
        `/api/admin/photos/${photoId}/bibs`, json({ bib })),

    removeBib: (photoId: string, bib: string) =>
      req<{ ok: true; removed: string }>(
        `/api/admin/photos/${photoId}/bibs/${encodeURIComponent(bib)}`, { method: 'DELETE' }),

    report: (eventId: string) =>
      req<{
        sources: { id: string; drive_folder_id: string; drive_url: string;
                   discovered: number; discovered_known: boolean; indexed: number;
                   missing: number; added_at: string; image_source: string;
                   credit_name: string | null; removed_at: string | null }[];
        totals: { links: number; removed_links: number; found: number; found_known: boolean;
                  indexed: number; missing: number };
        jobs: { id: string; source_id: string | null; status: string; done: number; total: number;
                skipped: number; attempts: number; error: string | null; updated_at: string;
                stale: boolean }[];
        log: { level: string; code: string | null; message: string;
               drive_file_id: string | null; created_at: string }[];
        summary: { level: string; code: string | null; n: number }[];
        quality: { photos: number; faces: number; photos_with_face: number;
                   photos_with_bib: number; distinct_bibs: number;
                   photos_without_face: number; photos_without_bib: number };
        top_bibs: { bib: string; n: number }[];
        /** How many exist server-side vs how many this response carries. */
        jobs_total: number;
        jobs_returned: number;
        log_total: number;
        log_returned: number;
      }>(`/api/admin/events/${eventId}/report`),
  },
};
