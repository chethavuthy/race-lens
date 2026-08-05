export interface EventSummary {
  id: string;
  slug: string;
  name: string;
  event_date: string | null;
  banner_url: string | null;
  status: 'draft' | 'indexing' | 'ready' | 'partial';
  photo_count: number;
  face_count: number;
  created_at?: string;
}

export interface Photo {
  id: string;
  thumb_url: string | null;
  original_url: string;
  width: number | null;
  height: number | null;
  taken_at: string | null;
}

export interface FaceMatch {
  photo: Photo;
  score: number;
  bbox: [number, number, number, number];
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
    req<{ event: EventSummary; photos: Photo[]; cursor: string | null }>(`/api/events/${slug}`),

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

    createEvent: (body: { name: string; event_date?: string; slug?: string }) =>
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

    ingest: (eventId: string, driveUrl: string) =>
      req<{ job_id: string; source_id: string; folder_id: string }>(
        '/api/admin/ingest',
        json({ event_id: eventId, drive_url: driveUrl }),
      ),

    getJob: (jobId: string) => req<{ job: Job }>(`/api/admin/jobs/${jobId}`),

    getEvent: (eventId: string) =>
      req<{ event: EventSummary }>(`/api/admin/events/${eventId}`),

    reindexSource: (sourceId: string) =>
      req<{ job_id: string }>(`/api/admin/sources/${sourceId}/reindex`, { method: 'POST' }),

    report: (eventId: string) =>
      req<{
        sources: { id: string; drive_folder_id: string; drive_url: string;
                   discovered: number; discovered_known: boolean; indexed: number;
                   missing: number; added_at: string }[];
        totals: { links: number; found: number; found_known: boolean;
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
      }>(`/api/admin/events/${eventId}/report`),
  },
};
