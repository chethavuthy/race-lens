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

const BASE = import.meta.env.VITE_API_BASE ?? '';

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

  searchBib: (slug: string, bib: string) =>
    req<{ matched: 'exact' | 'suffix' | null; photos: Photo[] }>(
      `/api/events/${slug}/bib/${encodeURIComponent(bib)}`,
    ),

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
  },
};
