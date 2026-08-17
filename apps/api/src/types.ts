export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  /** Private: face-embedding shards. Never given a custom domain. */
  INDEX_BUCKET: R2Bucket;
  WEB_ORIGIN: string;
  R2_PUBLIC_BASE: string;
  /** "1" disables the Cloudflare Access check. Local dev only. */
  DEV_ADMIN_BYPASS?: string;
  /** With the bypass on, "photographer" serves the non-operator view. Dev only. */
  DEV_ADMIN_ROLE?: string;
  /** With the bypass on, the email event ownership is keyed on. Dev only. */
  DEV_ADMIN_EMAIL?: string;
  GOOGLE_API_KEY: string;
  INGEST_SECRET: string;
  GH_DISPATCH_TOKEN: string;
  GH_REPO: string;
  /**
   * Comma-separated hostnames a Cloudflare Access application actually fronts.
   * The workers.dev origin is deliberately absent — see lib access.ts.
   */
  ACCESS_HOSTS: string;
  /**
   * The one account that gets the full operator view.
   *
   * Everyone else on the Access list is a photographer indexing their own album:
   * same door, smaller room. They index with resized copies (the only setting
   * that finishes an album inside Drive's limits) and see a plain progress
   * summary rather than passes and log lines.
   */
  OWNER_EMAIL?: string;
  /** Access team name: <team>.cloudflareaccess.com, used for the JWKS and `iss`. */
  CF_ACCESS_TEAM: string;
  /**
   * Comma-separated AUD tags. One Access application per hostname means one AUD
   * each, and the team also fronts unrelated apps whose tokens share these keys —
   * so this list is what scopes a valid signature to Race Lens.
   */
  CF_ACCESS_AUD: string;
}

export interface EventRow {
  id: string;
  slug: string;
  name: string;
  event_date: string | null;
  banner_key: string | null;
  status: 'draft' | 'indexing' | 'ready' | 'partial';
  photo_count: number;
  face_count: number;
  /** 0 for events with no bibs at all; turns off bib OCR and bib search. */
  bibs_enabled: number;
  /**
   * The Access identity that created it. NULL on every event that predates
   * ownership, which means the operator's — see migrations/005.
   */
  owner_email: string | null;
  created_at: string;
}

export interface PhotoRow {
  id: string;
  event_id: string;
  source_id: string;
  drive_file_id: string;
  thumb_key: string;
  width: number | null;
  height: number | null;
  taken_at: string | null;
}

export interface JobRow {
  id: string;
  event_id: string;
  source_id: string | null;
  status: 'queued' | 'running' | 'done' | 'partial' | 'failed' | 'stopped';
  done: number;
  total: number;
  error: string | null;
  /** The organizer asked this pass to stop; the runner honours it between batches. */
  stop_requested?: number;
  updated_at: string;
}
