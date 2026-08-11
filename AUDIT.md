# Race Lens — Security, Correctness & Performance Audit

| | |
|---|---|
| Date | 2026-08-10 |
| Scope | `apps/api` (Worker), `apps/web` (SPA + Pages Function), `indexer/` (Python), `schema.sql`, `migrations/`, `tools/`, `.github/workflows/` — ~11k lines |
| Baseline | `8fb2f96` (main) |
| Method | Six specialist reviewers over disjoint slices, then adversarial re-verification of the eight most severe findings. 38 findings raised, 8 adversarially verified, 8 confirmed, 0 refuted. Severities below are the **post-verification** values. |

---

## Executive Summary

The codebase is unusually well-reasoned. Nearly every non-obvious decision carries a comment explaining what was measured and what broke before, and the vector-parity gate (`tools/golden/RESULT.json`, cosine 0.99992) proves the hardest part of the system is correct. That quality makes the defects that remain distinctive: they are almost all **drift between two artifacts that must agree** — the SQL that code writes vs. `schema.sql`, the hostname Cloudflare Access protects vs. the hostname the Worker answers on, the coordinate space a bounding box lives in vs. the dimensions stored beside it.

One finding is remotely exploitable with a single `curl`. Two mean a fresh deployment of this repo cannot index a single photo, while the live database is fine — the DDL was applied out of band and never committed, so the running site hides the breakage. One is shipping wrong output to users right now, on the exact code path organizers are steered toward.

**The single highest-value process change:** `apps/api/` has no tests at all, and the majority of findings below live there. The `indexer/` suite is genuinely good — `test_run_continuation.py` tests exactly the composition where a real bug lived. A `wrangler dev` + `db:local` smoke test that creates an event, ingests, posts faces and bibs, and searches would have caught C1, C2, C7 and P4 in seconds.

---

## How findings were verified

Claims in this document are graded by how they were established. Treat anything unmarked as "read the code".

| Mark | Meaning |
|---|---|
| **[REPRO]** | Reproduced against real SQLite by applying this repo's own `schema.sql` |
| **[PLAN]** | Backed by before/after `EXPLAIN QUERY PLAN` output |
| **[TYPED]** | The proposed fix was compiled with `npm --workspace apps/api run typecheck` |
| **[GIT]** | Established from commit history / messages |

---

## Severity legend

| | |
|---|---|
| **Critical** | Exploitable without authentication, or the system cannot function |
| **High** | Data integrity, data loss, or a user-visible wrong answer |
| **Medium** | Degraded correctness, real cost, or a broken workflow |
| **Low** | Hygiene, latent risk, or bounded waste |

Two findings carry a **split severity** because the running deployment and a fresh one differ. That is not hedging — the live D1 has DDL the repo does not, so the same defect is latent in production and fatal on any rebuild.

---

# Findings — Security

## S1 · Admin API is unauthenticated on the published `workers.dev` origin

**Severity: High** (raised as Critical; see the note below)
**Location:** [apps/api/src/routes/admin.ts:16](apps/api/src/routes/admin.ts#L16), with [apps/api/wrangler.toml:11](apps/api/wrangler.toml#L11)

The middleware checks only that the header *exists*:

```ts
const assertion = c.req.header('Cf-Access-Jwt-Assertion');
if (!assertion && !devBypass) throw new HttpError(403, …);
```

### Impact

The comment justifies not verifying the JWT ("that is Access's job") and assumes every admin-bearing hostname sits behind Access. It does not. `workers_dev = true`, and Cloudflare Access can only be attached to a hostname in a zone you own — `*.workers.dev` is not. The repo says so outright at DEPLOY.md:132: *"Access only works on the custom domains."*

The unprotected origin is not obscure. It is shipped in the browser bundle ([api.ts:67](apps/web/src/lib/api.ts#L67)), hardcoded in the Pages Function ([`e/[slug].ts:25`](apps/web/functions/e/[slug].ts#L25)), and published in DEPLOY.md:24.

```bash
curl -H 'Cf-Access-Jwt-Assertion: x' https://race-lens-api.jt7.workers.dev/api/admin/events
```

returns 200 with full organizer control:

- create / patch events, flip published ↔ unpublished (`admin.ts:108`, `:134`)
- rewrite and delete bib data, including `DELETE /photos/:id/bibs/:bib` (`admin.ts:529`, `:642`) — i.e. destroy the searchable index the whole site exists to provide
- read the full ingest report including every bound Drive URL (`admin.ts:270`)
- deface the public banner on `img.runlytics.fit` (`admin.ts:159`)
- trigger unlimited `repository_dispatch` runs with an attacker-chosen `folder_id`, each up to 330 minutes, chaining to 61 passes (`admin.ts:235`)
- use `/drive/inspect` as a free proxy for the site's `GOOGLE_API_KEY` — one request walks up to 500 folders × 1000 files (`admin.ts:33`, `drive.ts:96`)

Not CSRF-reachable: the CORS callback returns a non-matching origin, so browsers block it. The attack is direct.

**The check that should have caught this passes.** [preflight.mjs:129](tools/preflight.mjs#L129) probes `/api/admin/events` **without the header**, gets 403, and reports `ok`. So does `finish-deploy.sh:100`.

### Confirmed live on production, 2026-08-10

Measured against `https://race-lens-api.jt7.workers.dev` with the hardened probe from task 2, before the fix was deployed:

```
ok    GET /api/events (liveness) → 200
ok    GET /api/admin/events, no header → 403          <- what the old probe tested
FAIL  forged Cf-Access-Jwt-Assertion → 200 — ADMIN IS OPEN
ok    POST /api/internal/* with a bad secret → 401
```

The two admin lines are the same URL. The only difference is one header, and it is the difference between "fails closed" and "fully open". `/api/internal/*` is correctly gated — the `INGEST_SECRET` comparison is sound.

> **Severity note.** Raised as Critical; the verification pass argued High for this specific site, because no secret is echoed in any response and the photo data is already public, so confidentiality impact is nil. Integrity impact is total and it is unauthenticated. Either way it is the highest-priority item in the repo.

### ⚠️ Deployment state blocks half the fix

[DEPLOY.md:33-46](DEPLOY.md#L33) records that the CNAMEs **do not exist** (both Pages custom domains stuck at `status=pending`) and *"Cloudflare Access is unconfigured, so `/admin` 403s for everyone including you."*

So today: no Access application exists, no valid JWT can be issued, the custom-domain Worker routes do not resolve, and the only live API origin is `workers.dev` — where the SPA cannot authenticate but `curl` with a junk header can. The fix therefore splits in two.

### Fix, part A — hostname gate (ships immediately)

Closes the hole at zero cost, because admin is already unusable on `workers.dev`.

```ts
// before
adminRoutes.use('*', async (c, next) => {
  const assertion = c.req.header('Cf-Access-Jwt-Assertion');
  const devBypass = c.env.DEV_ADMIN_BYPASS === '1';
  if (!assertion && !devBypass) {
    throw new HttpError(403, 'Admin requires Cloudflare Access', 'no_access');
  }
  await next();
});

// after
adminRoutes.use('*', async (c, next) => {
  if (c.env.DEV_ADMIN_BYPASS === '1') { await next(); return; }
  // Access cannot be attached to a workers.dev hostname, so admin must refuse to
  // answer there. The origin itself stays ON: race-lens.pages.dev is the live
  // frontend and api.ts:67 has no other API base until the CNAMEs resolve.
  if (!onAccessHost(c.env, c.req.url)) {
    throw new HttpError(403, 'Admin is not served on this hostname', 'no_access');
  }
  const assertion = c.req.header('Cf-Access-Jwt-Assertion');
  if (!assertion) throw new HttpError(403, 'Admin requires Cloudflare Access', 'no_access');
  await next();
});
```

### Fix, part B — verify the token (ships with the Access rollout)

Swap the presence check for `verifyAccessJwt` (full source in *Reference implementations*). **Keep `workers_dev = true`** throughout — setting it false today would 404 the entire public site, since `race-lens.pages.dev` is the live frontend and `PAGES_DEV_API` is its only API base.

### Also fix the probe

```js
// before
await probe('/api/admin/events', [403, 302], 'GET /api/admin/events (must be blocked)');

// after
await probe('/api/admin/events', [403, 302], 'GET /api/admin/events, no header');
const forged = await fetch(`${apiBase}/api/admin/events`,
  { headers: { 'Cf-Access-Jwt-Assertion': 'forged.not.a.jwt' } });
if (forged.status === 403) ok('GET /api/admin/events with a forged assertion → 403');
else bad(`forged Cf-Access-Jwt-Assertion → ${forged.status} — ADMIN IS OPEN`);
```

---

## S2 · Banner upload stores an attacker-chosen `Content-Type` → script execution on `img.runlytics.fit`

**Severity: Medium** (High while S1 makes it unauthenticated)
**Location:** [apps/api/src/routes/admin.ts:167](apps/api/src/routes/admin.ts#L167)

```ts
if (!file.type.startsWith('image/')) throw new HttpError(400, 'Banner must be an image', 'bad_type');
await c.env.BUCKET.put(key, file.stream(), { httpMetadata: { contentType: file.type, … } });
```

### Impact

`image/svg+xml` satisfies `startsWith('image/')`. `file.type` is the multipart part's own header — fully client-controlled — and is written verbatim into R2 metadata. `BUCKET` is published at `https://img.runlytics.fit` (`wrangler.toml:40`), which serves the stored content type regardless of the `.webp` key, so the SVG's `<script>` executes on a `runlytics.fit` origin. From there it can set `Domain=.runlytics.fit` cookies (shadowing the `CF_Authorization` cookie the Access-protected app relies on) and host phishing on the site's own image domain. The `nosniff` header in `public/_headers` applies to Pages, not to the R2 custom domain. The endpoint also never checks the event exists, so it is a general write into the public bucket.

### Fix

```ts
// before
if (!file.type.startsWith('image/')) throw new HttpError(400, 'Banner must be an image', 'bad_type');
if (file.size > 8 * 1024 * 1024) throw new HttpError(413, 'Banner must be under 8 MB', 'too_large');

const key = `banners/${id}.webp`;
await c.env.BUCKET.put(key, file.stream(), {
  httpMetadata: { contentType: file.type, cacheControl: 'public, max-age=31536000, immutable' },
});

// after
// Allowlist, not a prefix test: "image/svg+xml" passes startsWith('image/') and is
// a script-execution primitive on img.runlytics.fit, which serves this bucket.
const BANNER_TYPES: Record<string, string> = {
  'image/webp': 'image/webp', 'image/jpeg': 'image/jpeg',
  'image/png': 'image/png', 'image/avif': 'image/avif',
};
const contentType = BANNER_TYPES[file.type.split(';')[0].trim().toLowerCase()];
if (!contentType) throw new HttpError(400, 'Banner must be a WebP, JPEG, PNG or AVIF image', 'bad_type');
if (file.size > 8 * 1024 * 1024) throw new HttpError(413, 'Banner must be under 8 MB', 'too_large');

const event = await c.env.DB.prepare('SELECT id FROM events WHERE id = ?').bind(id).first();
if (!event) throw new HttpError(404, 'Event not found', 'no_event');

const key = `banners/${id}.webp`;
await c.env.BUCKET.put(key, file.stream(), {
  // contentType is ours, never the client's.
  httpMetadata: { contentType, cacheControl: 'public, max-age=31536000, immutable' },
});
```

---

## S3 · Face-embedding search still falls back to the publicly published bucket

**Severity: Low — and RESOLVED as a non-leak**
**Location:** [apps/api/src/search.ts:118](apps/api/src/search.ts#L118)

> **Outcome, 2026-08-11.** `ListObjectsV2` against the public bucket returned **0
> objects under `index/`**. No shard was ever exposed; the finding was a latent risk
> from a code path that could have served one, not an active leak. The fallback has
> been removed, which was provably a no-op since `BUCKET.get()` on a shard key could
> only return null. Worth noting the R2 token in `.env.deploy` is genuinely scoped to
> the public bucket — listing the private one returns `AccessDenied` — so the
> separation the comments describe is real and enforced.

```ts
const obj = (await env.INDEX_BUCKET.get(key)) ?? (await env.BUCKET.get(key));
```

### Impact

`wrangler.toml:37-39` states *"nothing private may ever live here"* about `BUCKET`, which is fully published at `img.runlytics.fit`. This fallback exists precisely because pre-split shards may still be in that bucket — raw L2-normalized biometric vectors, one row per detected face, fetchable with no auth at `https://img.runlytics.fit/index/…`. Event ids are public (`publicEvent` returns `id`), so only the `source_id`-`run_id` segment is unguessable, and R2 custom domains do not allow listing — that is the only thing keeping this Low. Nothing verifies the old objects are gone.

### Fix

Drain first:

```bash
npx wrangler r2 object list race-lens --prefix index/
```

Then, once that returns nothing:

```ts
// before
const obj = (await env.INDEX_BUCKET.get(key)) ?? (await env.BUCKET.get(key));
if (!obj) return null;

// after — INDEX_BUCKET only. The public bucket must never be a source of embeddings.
const obj = await env.INDEX_BUCKET.get(key);
if (!obj) return null;
```

---

## S4 · `client_payload` interpolated straight into the runner's shell

**Severity: Low** (defense-in-depth; reachable only with admin or `INGEST_SECRET`)
**Location:** [.github/workflows/index-event.yml:106](.github/workflows/index-event.yml#L106)

```yaml
--only-file "${{ github.event.client_payload.only_file || '' }}"
```

### Impact

`${{ }}` is textually substituted *before* the shell runs, so a value containing `"; …; "` executes on a runner holding `GOOGLE_API_KEY`, `INGEST_SECRET`, and the R2 write credentials. Today every field is either `newId()`-generated or charset-validated by `parseFolderId` — except `only_file`, which flows from `photos.drive_file_id`, and **nothing validates `drive_file_id` on the way in** ([internal.ts:159](apps/api/src/routes/internal.ts#L159) accepts it verbatim). The guard is one unvalidated column deep, and S1 currently supplies the missing authentication.

### Fix — pass through `env`, and validate at the boundary

```yaml
# before
        run: |
          python -m indexer.main \
            --event-id  "${{ github.event.client_payload.event_id  || inputs.event_id }}" \
            ...
            --only-file "${{ github.event.client_payload.only_file || '' }}"

# after
        env:
          # ... existing secrets ...
          EVENT_ID:  ${{ github.event.client_payload.event_id  || inputs.event_id }}
          SOURCE_ID: ${{ github.event.client_payload.source_id || inputs.source_id }}
          FOLDER_ID: ${{ github.event.client_payload.folder_id || inputs.folder_id }}
          JOB_ID:    ${{ github.event.client_payload.job_id    || inputs.job_id }}
          IMAGE_SRC: ${{ github.event.client_payload.image_source || inputs.image_source || 'original' }}
          ONLY_FILE: ${{ github.event.client_payload.only_file || '' }}
          FLAG_BIBS:     ${{ (github.event.client_payload.bibs_only || inputs.bibs_only) && '--bibs-only' || '' }}
          FLAG_NORESUME: ${{ (github.event.client_payload.no_resume || inputs.no_resume) && '--no-resume' || '' }}
          FLAG_REBUILD:  ${{ (github.event.client_payload.rebuild || inputs.rebuild) && '--rebuild' || '' }}
        run: |
          # Values arrive as environment variables, never as script text, so a
          # payload field cannot become a shell command.
          python -m indexer.main \
            --event-id "$EVENT_ID" --source-id "$SOURCE_ID" \
            --folder-id "$FOLDER_ID" --job-id "$JOB_ID" \
            $FLAG_BIBS $FLAG_NORESUME $FLAG_REBUILD \
            --image-source "$IMAGE_SRC" --only-file "$ONLY_FILE"
```

```ts
// internal.ts POST /events/:id/photos — after
// A Drive file id is [A-Za-z0-9_-]; anything else is not one, and this column
// reaches a shell via the workflow's --only-file argument.
const DRIVE_ID = /^[A-Za-z0-9_-]{10,128}$/;
for (const p of photos) {
  if (!DRIVE_ID.test(p.drive_file_id)) {
    throw new HttpError(400, `Not a Drive file id: ${p.drive_file_id.slice(0, 40)}`, 'bad_file_id');
  }
}
```

Apply the same treatment to the `benchmark-folder` step and the `Report failure` step's `JOB_ID`.

---

## S5 · ONNX models fetched with no integrity check, then frozen for a year

**Severity: Medium**
**Location:** [tools/fetch-models.sh:12](tools/fetch-models.sh#L12)

The script claims the files *"must be byte-identical to the ones insightface loads in CI — that is the entire basis of embedding parity"*, then verifies nothing. `_headers` stamps `/models/*` as `immutable, max-age=31536000`. A swapped release asset ships to every visitor and sticks for a year, producing embeddings that silently disagree with the index — the exact failure `tools/golden` exists to catch, arriving through the one door golden does not watch.

### Fix

```bash
# before
curl -fsSL -o "$TMP/buffalo_s.zip" \
  "https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_s.zip"
unzip -oq "$TMP/buffalo_s.zip" -d "$TMP/x"

find "$TMP/x" -name 'det_500m.onnx'  -exec cp {} "$DEST/" \;
find "$TMP/x" -name 'w600k_mbf.onnx' -exec cp {} "$DEST/" \;

# after
# Parity is a claim about BYTES. Pin them. Regenerate with:
#   shasum -a 256 apps/web/public/models/*.onnx
DET_SHA256="<paste from your verified copy>"
REC_SHA256="<paste from your verified copy>"

curl -fsSL -o "$TMP/buffalo_s.zip" \
  "https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_s.zip"
unzip -oq "$TMP/buffalo_s.zip" -d "$TMP/x"

install_verified() {  # install_verified <name> <expected-sha256>
  local src; src="$(find "$TMP/x" -name "$1" -print -quit)"
  [ -n "$src" ] || { echo "FAIL: $1 not in the release archive" >&2; exit 1; }
  local got; got="$(shasum -a 256 "$src" | cut -d' ' -f1)"
  if [ "$got" != "$2" ]; then
    echo "FAIL: $1 sha256 $got != expected $2" >&2
    echo "      The upstream asset changed. Do NOT ship this: every browser would" >&2
    echo "      cache it as immutable for a year and disagree with the index." >&2
    exit 1
  fi
  cp "$src" "$DEST/"
}
install_verified det_500m.onnx  "$DET_SHA256"
install_verified w600k_mbf.onnx "$REC_SHA256"
```

---

# Findings — Correctness

## C1 · `bib_rejects` is queried in three places and created nowhere

**Severity: Critical on any fresh database / latent on the running one** — **[REPRO] [GIT]**
**Location:** [internal.ts:249](apps/api/src/routes/internal.ts#L249), [admin.ts:635](apps/api/src/routes/admin.ts#L635), [admin.ts:657](apps/api/src/routes/admin.ts#L657)

```
$ sqlite3 t.db < schema.sql
$ sqlite3 t.db "SELECT photo_id, bib FROM bib_rejects WHERE event_id='e1';"
Error: in prepare, no such table: bib_rejects
```

`git log -S "bib_rejects" -- schema.sql` returns **nothing** — the DDL was never committed at any point in history.

### Impact

`POST /api/internal/events/:id/bibs` reads `bib_rejects` on **every batch where `bibs.length > 0`** — the main indexing path. On a database built from this repo (`npm run db:local` / `db:remote` apply `schema.sql` only), that 500s; `upload.py::_post` retries 5×, raises, and `main.py` marks the job failed. **A fresh deployment cannot index a single bib-bearing event, and local dev is broken identically.**

The live database must have the table (bib indexing works and the feature was verified in production per `033431f`), which is exactly why the drift went unnoticed — and why it will outlive anyone who remembers applying it by hand.

### Fix

See `migrations/002_schema_repair.sql` in *Reference implementations*. The primary key must be exactly `(event_id, photo_id, bib)`, because `admin.ts:658` names that tuple as its `ON CONFLICT` target.

---

## C2 · `sources` has no `UNIQUE (event_id, drive_folder_id)`, so the ingest upsert cannot be prepared

**Severity: High on any fresh database / latent on the running one** — **[REPRO] [GIT]**
**Location:** [admin.ts:219](apps/api/src/routes/admin.ts#L219) vs. [schema.sql:35](schema.sql#L35)

```
$ sqlite3 t.db "INSERT INTO sources (…) VALUES (…) ON CONFLICT (event_id, drive_folder_id) DO UPDATE SET …"
Error: in prepare, ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint
```

### Impact

SQLite requires a matching unique index for a conflict *target*. `POST /api/admin/ingest` — the only way to bind a folder to an event — throws before touching the database. With C1, **a clean deploy of this repo cannot ingest anything at all.**

`git show 3c7ac9c` confirms the index was applied to production out of band (*"with a unique index on (event_id, drive_folder_id) to keep it that way"*) while never touching `schema.sql`. Latent live, fatal on rebuild.

### Fix

The unique index, with a duplicate merge first — see the migration. Two subtleties that bite:

1. **`jobs.source_id` and `ingest_log.source_id` must be repointed too**, not just `photos`. They carry no declared FK so nothing errors, but [admin.ts:288](apps/api/src/routes/admin.ts#L288) joins the report by `source_id`, so stale ids silently drop passes from the report. `3c7ac9c`'s own message confirms the production merge repointed *"photos, jobs and log entries"*.
2. **The keeper is `MIN(id)`, which is arbitrary** and may drop the row holding `image_source = 'thumb'` — precisely the regression `af69ad3` was written to fix. Coalesce `thumb` up before collapsing.

**Migration-free alternative:** [admin.ts:212](apps/api/src/routes/admin.ts#L212) already resolves `sourceId` from the preceding `SELECT`, so the row being updated is always the one with that primary key. `ON CONFLICT (id)` prepares fine on stock `schema.sql` (verified). Prefer the unique index — it also closes the SELECT-then-INSERT race — but this one-word change unblocks a fresh environment with no DDL.

---

## C3 · `photos.width/height` and `faces.bbox` are in different coordinate spaces

**Severity: High — currently producing wrong output**
**Location:** [indexer/main.py:213](indexer/main.py#L213), surfacing at [PhotoGrid.vue:130](apps/web/src/components/PhotoGrid.vue#L130)

```python
"width":  img.width  or tw,     # Drive metadata: the ORIGINAL file, unrotated
"height": img.height or th,
...
bgr = load_bgr(path)            # bboxes are measured in THIS array's space
```

### Impact

`img.width/height` come from Drive's `imageMediaMetadata` for the original upload. The detector runs on `load_bgr(path)`. These diverge in two live cases:

**1. `image_source = 'thumb'`** — the file on disk is Drive's `w3200` copy, so bboxes are in 3200 px space while `photos.width` says 6000. Worked through for a 6000×4000 original (k = 1.875): `side` is 1.875× too small and the centre lands at 0.53× the face's true relative position, so the offset from the true centre is `0.467·r·W` while the window is only ~4 % of `W` wide. **The crop misses essentially every face**, while [PhotoGrid.vue:200](apps/web/src/components/PhotoGrid.vue#L200) still prints "cropped to you".

`cropToFace` defaults `true` and is force-reset to `true` on every face search, so this is the *default* rendering. `image_source` has an organizer-facing toggle and an auto-preselect, and `AdminEvent.vue:124-126` is the repo's own evidence that resized passes have run in production.

**2. EXIF rotation** — Drive reports pre-rotation dimensions, while `make_thumbnail` and `load_bgr` both apply `exif_transpose` first. A portrait frame is stored as 6000×4000, so `.photo-tile { aspect-ratio: var(--ar) }` reserves a landscape box and `object-fit: cover` center-crops the runner's head and feet off — and the masonry column-height prediction (`height / width`) is inverted, which is the same class of reflow the last four commits were spent eliminating.

### Fix

Make `photos.width/height` mean *"the frame detection saw"*. `make_thumbnail` already has those dimensions.

```python
# before
def make_thumbnail(path: str, max_edge: int, quality: int) -> tuple[bytes, int, int]:
    with Image.open(path) as im:
        im = ImageOps.exif_transpose(im)
        im = im.convert("RGB")
        im.thumbnail((max_edge, max_edge), Image.LANCZOS)
        buf = io.BytesIO()
        im.save(buf, format="WEBP", quality=quality, method=4)
        return buf.getvalue(), im.width, im.height

# after
def make_thumbnail(path: str, max_edge: int, quality: int) -> tuple[bytes, int, int]:
    """Returns (webp bytes, full width, full height) POST-EXIF-ROTATION.

    The dimensions are the DECODED FRAME's, not the thumbnail's and not Drive's.
    faces.bbox is measured on this same decoded frame, and the client divides one
    by the other — so they must share a coordinate space. Drive's
    imageMediaMetadata cannot: it describes the ORIGINAL upload, pre-rotation,
    which is a different size again when image_source='thumb' hands us a w3200 copy.
    """
    with Image.open(path) as im:
        im = ImageOps.exif_transpose(im)
        im = im.convert("RGB")
        full_w, full_h = im.size          # <- the space bboxes live in
        im.thumbnail((max_edge, max_edge), Image.LANCZOS)
        buf = io.BytesIO()
        im.save(buf, format="WEBP", quality=quality, method=4)
        return buf.getvalue(), full_w, full_h
```

```python
# before
            thumb, tw, th = make_thumbnail(path, cfg.thumb_max_edge, cfg.thumb_quality)
            ...
                    "width": img.width or tw,
                    "height": img.height or th,

# after
            thumb, full_w, full_h = make_thumbnail(path, cfg.thumb_max_edge, cfg.thumb_quality)
            ...
                    "width": full_w,
                    "height": full_h,
```

Verified safe: `photos.width/height` are consumed in exactly three places — `PhotoGrid.vue:112` `ratio()` (aspect only, preserved under uniform resize), `PhotoGrid.vue:131` `cropStyle` (the bug, now consistent), and `admin.ts:499/508-509` (now consistent). No consumer edits needed.

### Measured impact: essentially nil — and the "fix the old rows" plan was wrong

The finding is a real code defect: the two values were derived from different sources
and nothing tied them together. But the divergence it predicts does **not** exist in
this data, and I nearly corrupted 26k rows acting on the prediction instead of
checking it.

`faces.bbox` gives an independent test. If `photos.width` were ~1.9x too large, no
face in a source could ever reach its right edge — the peak `max_x / width` across
thousands of photos would cap near 0.53. Measured per source:

| source | image_source | photos | peak x-ratio | peak y-ratio |
|---|---|---|---|---|
| `M3ZF3-lFLkcn` | thumb | 24,037 | **1.006** | 1.099 |
| `Sbh3vyyNVuzy` | thumb | 834 | **1.009** | 0.807 |
| `I15mxynVpUtb` | original | 590 | **0.999** | 0.632 |
| `0NDnUwvlckbM` | thumb | 503 | **1.009** | 1.003 |
| `W5mDtOz8yGo7` | thumb | 297 | **1.028** | 0.919 |
| `src_rp7127od` | thumb | 150 | **1.001** | 0.758 |

Every source peaks at ~1.0, so the stored dimensions *are* the space the bboxes live
in. Across 26,555 photos with faces, only **11** have a bbox exceeding the stored
frame by more than 2%, and **none** by more than 10%.

The reason is that `sz=w3200` returns the original unscaled when it is already
smaller, and these albums are mostly already web-sized — the largest source reports a
maximum stored width of 2048. The 6000px DSLR figure the code comments cite is not
what these particular folders contain.

**Two of my own claims were wrong and are corrected here.** I wrote that ~98% of
photos were cropping incorrectly, inferred from `image_source = 'thumb'` without
checking whether the dimensions actually diverged. And the proposed computed backfill
— rescale every thumb-source photo so its long edge is 3200 — would have *introduced*
the bug on ~353 photos whose dimensions were already right. `image_source` is a
mutable current setting, not a per-photo record of how a photo was fetched, so it
cannot support that inference at all.

The code fix stands: it removes the possibility of divergence for any future pass that
does fetch a genuinely larger original. No backfill is required or advisable.


---

## C4 · A pass interrupted mid-batch strands photos with no faces, permanently

**Severity: Medium**
**Location:** [indexer/main.py:222](indexer/main.py#L222) (commit) vs. [main.py:285](indexer/main.py#L285) (flush)

### Impact

`put_photos` commits photo rows at the *start* of a batch; vectors flush at the *end*. Any failure in between — a reclaimed runner (the documented cause of the original 51-faceless-photo incident), an OOM, or a raise from `put_bibs` at line 268, the largest and most chunked call in the window — leaves up to `BATCH_SIZE` photos in D1 with thumbnails and zero faces. `put_photos`, `put_bibs`, `reserve_rows`, `put_shard` and `put_faces` are the five `Uploader` calls with **no** try/except.

The default resume key then counts a photo as done because *the row exists* ([internal.ts:196](apps/api/src/routes/internal.ts#L196)), so the next pass skips exactly those photos and never recomputes them. Nothing detects it: `finalize` compares `sources.discovered` against the photo count, which matches, so the event is marked `ready`. No automated path ever sets `rebuild` — all four dispatch sites omit it.

### 🚫 Trap — do NOT "fix" this by adding `rebuild: true` to the continuation

```ts
// HARMFUL — do not apply
client_payload: { …, rebuild: true },
```

`--rebuild` switches the resume key to `EXISTS (SELECT 1 FROM faces …)`, which excludes every photo that genuinely contains **no detected face** — a population significant enough that the report headlines it (`photos_without_face`, `admin.ts:368`). Every automatic continuation would re-download that entire population instead of advancing. Guard 1 in `/jobs/:id/continue` only checks `job.done` ([internal.ts:72](apps/api/src/routes/internal.ts#L72)), and `done` is incremented by those re-downloads — so the guard that exists to stop a non-progressing chain reads them as progress and keeps dispatching to `MAX_ATTEMPTS = 60`.

### Fix — make the resume key mean "vectors are durable"

```sql
-- DEFAULT 1, not 0: legacy rows must read as done, or the first run after this
-- migration re-downloads every photo of every event, straight into the Drive
-- quota that main.py:101-103 exists to avoid.
ALTER TABLE photos ADD COLUMN faces_done INTEGER NOT NULL DEFAULT 1;
```

```ts
// internal.ts POST /events/:id/photos — a photo is incomplete until its shard lands
`INSERT INTO photos (id, event_id, source_id, drive_file_id, thumb_key, width, height, taken_at, faces_done)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
 ON CONFLICT (event_id, drive_file_id) DO UPDATE SET
   thumb_key = excluded.thumb_key, width = excluded.width,
   height = excluded.height, taken_at = excluded.taken_at,
   faces_done = 0`
```

```ts
// internal.ts GET /events/:id/indexed — before
: 'SELECT drive_file_id FROM photos WHERE event_id = ?';

// after — "vectors are durable", not "the row exists"
: 'SELECT drive_file_id FROM photos WHERE event_id = ? AND faces_done = 1';
```

```ts
// internal.ts, at the end of POST /events/:id/faces — flip the flag once rows land
const photoIds = [...new Set(rows.map((r) => r.photo_id))];
for (const part of chunk(photoIds, D1_MAX_PARAMS)) {
  await c.env.DB.prepare(
    `UPDATE photos SET faces_done = 1 WHERE id IN (${part.map(() => '?').join(',')})`,
  ).bind(...part).run();
}
```

And order the batch loop so the flag can only be set once vectors are durable — vectors, then bibs, then progress:

```python
# indexer/main.py, batch tail — after
        if embeddings:
            shard_key = f"index/{args.event_id}/{args.source_id}-{args.run_id}-b{batch_no}.bin"
            row_base = up.reserve_rows(args.event_id, shard_key, len(embeddings))
            buf = np.stack(embeddings).astype(np.int8)
            up.put_shard(shard_key, buf.tobytes(order="C"))
            for row in face_rows:
                row["row_idx"] += row_base
            # put_faces sets photos.faces_done, so this call is what makes the
            # batch recoverable. Everything that can lose work must precede it.
            up.put_faces(args.event_id, shard_key, row_base, face_rows)
            faces_indexed += len(embeddings)
            embeddings, face_rows = [], []

        if read_ids and read_bibs:
            up.put_bibs(args.event_id, bib_payload, replace_photos=read_ids)

        processed += len(local)
        up.progress(args.job_id, done=processed, total=total)
```

---

## C5 · `COALESCE` on `jobs.error` makes the field unclearable

**Severity: Medium**
**Location:** [internal.ts:23](apps/api/src/routes/internal.ts#L23)

`/continue` writes `"Drive rate limit — continuing automatically (attempt N of 61)"`. Every subsequent progress ping passes `error: null`, which `COALESCE` reads as "keep the old value". A job that eventually finishes cleanly still renders that rate-limit message next to `status: done`, so the organizer cannot tell a recovered chain from a stuck one — the entire question the report page exists to answer.

### Fix

```ts
// before
const b = await c.req.json<{ done?: number; total?: number; status?: string; error?: string }>();
await c.env.DB.prepare(
  `UPDATE jobs SET done = COALESCE(?, done), total = COALESCE(?, total),
                   status = COALESCE(?, status), error = COALESCE(?, error),
                   updated_at = ? WHERE id = ?`,
).bind(b.done ?? null, b.total ?? null, b.status ?? null, b.error ?? null, nowIso(), id).run();

// after
const b = await c.req.json<{ done?: number; total?: number; status?: string; error?: string | null }>();
// `error` is the one field a caller legitimately needs to CLEAR. COALESCE cannot
// express that, so an explicit null (a finished pass reporting no error) used to
// preserve the rate-limit message from the continuation that preceded it.
const clearError = 'error' in b;
await c.env.DB.prepare(
  `UPDATE jobs SET done = COALESCE(?, done), total = COALESCE(?, total),
                   status = COALESCE(?, status),
                   error = CASE WHEN ?4 THEN ?5 ELSE error END,
                   updated_at = ?6 WHERE id = ?7`,
).bind(b.done ?? null, b.total ?? null, b.status ?? null,
       clearError ? 1 : 0, b.error ?? null, nowIso(), id).run();
```

`main.py` already passes `error=None` explicitly on a clean finish, so no indexer change is needed.

---

## C6 · `finalize` republishes an event the organizer deliberately unpublished

**Severity: Medium**
**Location:** [internal.ts:417](apps/api/src/routes/internal.ts#L417)

`resolved` is always `'ready'` or `'partial'`, and the write is unconditional. `PATCH /api/admin/events/:id` accepts `'draft'`, so unpublishing is a supported action — but any later runner pass (including an automatic continuation) flips the event straight back onto the public site. The route deliberately refuses to take the runner's word about *readiness*; it should be equally sceptical about *visibility*.

### Fix

```ts
// before
await c.env.DB.prepare(
  'UPDATE events SET photo_count = ?, face_count = ?, status = ? WHERE id = ?',
).bind(counts?.photos ?? 0, counts?.faces ?? 0, resolved, eventId).run();

// after
// Counts always; status only for an event that is already published or indexing.
// A 'draft' event was unpublished ON PURPOSE — a background pass finishing must
// not put it back on the site behind the organizer's back.
await c.env.DB.prepare(
  `UPDATE events SET photo_count = ?, face_count = ?,
                     status = CASE WHEN status = 'draft' THEN status ELSE ? END
    WHERE id = ?`,
).bind(counts?.photos ?? 0, counts?.faces ?? 0, resolved, eventId).run();
```

---

## C7 · `faces` INSERT has no conflict clause, so a retried chunk fails the run permanently

**Severity: Medium**
**Location:** [internal.ts:340](apps/api/src/routes/internal.ts#L340), with [upload.py:80](indexer/upload.py#L80)

`idx_faces_event_row` is UNIQUE on `(event_id, row_idx)`. `_post` retries on any `requests.RequestException` — including a read timeout *after* the Worker committed. The retry re-inserts the same rows, only chunk 0 clears the range, so the unique index rejects them → 500 → 5 retries → `RuntimeError` → the whole run fails, with the shard bytes already in R2. A single flaky connection loses a pass.

### Fix

```ts
// before
c.env.DB.prepare(
  'INSERT INTO faces (id, event_id, photo_id, row_idx, bbox, bib) VALUES (?, ?, ?, ?, ?, ?)',
).bind(newId(), eventId, f.photo_id, f.row_idx, JSON.stringify(f.bbox), f.bib ?? null)

// after
// Idempotent: the runner retries this POST on any transport error, including a
// timeout that arrived after the batch already committed. A bare INSERT then
// trips idx_faces_event_row and fails the run with the shard already in R2.
c.env.DB.prepare(
  `INSERT INTO faces (id, event_id, photo_id, row_idx, bbox, bib)
   VALUES (?, ?, ?, ?, ?, ?)
   ON CONFLICT (event_id, row_idx) DO UPDATE SET
     photo_id = excluded.photo_id, bbox = excluded.bbox, bib = excluded.bib`,
).bind(newId(), eventId, f.photo_id, f.row_idx, JSON.stringify(f.bbox), f.bib ?? null)
```

---

## C8 · A decode failure silently deletes bibs that were read correctly earlier

**Severity: Medium**
**Location:** [indexer/main.py:267](indexer/main.py#L267)

`photo_ids` covers every photo whose *thumbnail* succeeded; the OCR loop iterates `decoded`, which excludes photos where `load_bgr` returned `None`. So a photo that thumbnails but fails to decode is listed in `replace_photos` — its existing OCR bibs are deleted — while nothing is written back. And `load_bgr` logs only a `log.warning` (main.py:60): there is no `ingest_log` entry, so the organizer sees a photo quietly lose its bib with no reason recorded anywhere they can reach.

### Fix

```python
# before
        if photo_ids and read_bibs:
            up.put_bibs(args.event_id, bib_payload, replace_photos=list(photo_ids.values()))

# after
        # Authoritative ONLY for photos this pass actually decoded and OCR'd.
        # Listing a photo that failed to decode deletes bibs an earlier pass read
        # correctly and writes nothing back in their place.
        read_ids = [pid for fid, pid in photo_ids.items() if fid in decoded]
        if read_ids and read_bibs:
            up.put_bibs(args.event_id, bib_payload, replace_photos=read_ids)
```

```python
# decode step — before
            bgr = load_bgr(path)
            if bgr is not None:
                decoded[img.id] = bgr

# after
            bgr = load_bgr(path)
            if bgr is None:
                note("error", "decode_failed",
                     f"{img.name}: decoded to nothing — no faces or bibs read", img.id)
            else:
                decoded[img.id] = bgr
```

---

## C9 · In-flight search results overwrite newer ones

**Severity: Medium**
**Location:** [EventDetail.vue:264](apps/web/src/pages/EventDetail.vue#L264) and [:284](apps/web/src/pages/EventDetail.vue#L284)

Neither `searchBib` nor `runFaceSearch` carries a request generation. The submit button is disabled while `searching`, but the URL watcher is not gated by it: Back/Forward, or a second `router.push` from the empty-state "Try similar numbers" button, starts a second search while the first is in flight. A slow response for bib **A** landing after **B** replaces B's results with A's — and since the header just reads "*N* photos found", the runner is shown someone else's photos with nothing to indicate it. That is the failure mode the fuzzy-search comment is explicitly written to avoid.

### Fix

```ts
// after — one counter guards both search paths
let searchSeq = 0;

async function searchBib(value: string, fuzzy: boolean) {
  const seq = ++searchSeq;
  clearResults();
  searching.value = true;
  try {
    const r = await api.searchBib(props.slug, value, fuzzy);
    // A slower earlier search must never land on top of a newer one: returning
    // the wrong runner's photos is the one failure this product cannot afford.
    if (seq !== searchSeq) return;
    results.value = r.photos.map((photo) => ({ photo }));
    searchedBy.value = 'bib';
    fuzzyOffered.value = r.fuzzy_available;
    if (r.matched === 'suffix') { searchNote.value = `No photo of bib ${value} …`; }
  } catch (e: any) {
    if (seq === searchSeq) searchError.value = e.message;
  } finally {
    if (seq === searchSeq) searching.value = false;
  }
}
```

Same `seq` guard in `runFaceSearch`, which is slower still (~1 s of local inference).

---

## C10 · Inline bib editor throws on every open (template ref inside `v-for`)

**Severity: Medium**
**Location:** [AdminPhotos.vue:43](apps/web/src/pages/AdminPhotos.vue#L43), ref declared at `:38`, element at `:217` inside the `v-for` at `:210`

Vue 3 marks refs inside `v-for` with `ref_for`, so `faceInput.value` is an **array**, not an element. `faceInput.value?.focus()` resolves to `Array.prototype.focus` — `undefined` — and throws a `TypeError` inside a `setTimeout`, uncaught. The face-level bib editor never focuses or selects, so every correction needs an extra click and a manual clear. `bibInput` (not inside a `v-for`) works, which is why the difference reads as a mystery rather than a bug.

### Fix

```ts
// before
const faceInput = ref<HTMLInputElement | null>(null);
function startFace(f: { id: string; bib: string | null }) {
  editingFace.value = f.id;
  faceDraft.value = f.bib ?? '';
  setTimeout(() => { faceInput.value?.focus(); faceInput.value?.select(); }, 30);
}

// after
// The input lives inside `v-for="f in zoom.faces"`, so Vue sets ref_for and this
// ref holds an ARRAY. Typing it as a single element made focus() a no-op that
// threw. nextTick beats a 30 ms guess at when the DOM has caught up.
const faceInput = ref<HTMLInputElement[]>([]);
async function startFace(f: { id: string; bib: string | null }) {
  editingFace.value = f.id;
  faceDraft.value = f.bib ?? '';
  await nextTick();
  const el = faceInput.value[0];
  el?.focus();
  el?.select();
}
```

---

# Findings — Performance

> **Cost premise.** [README.md:252](README.md#L252) — *"Workers, Pages, D1, R2 | $5/mo (existing Workers Paid plan)"*. So D1 includes **25 billion rows read/month**, not the free tier's 5 M/day, and Workers Paid bills **CPU time, not wall time** — sequential D1 `await`s are I/O wait and never touch the 30 M CPU-ms budget. Findings below are scored on that basis.

## P1 · No index on `faces(photo_id)`, `bibs(photo_id)` or `photos(source_id)`

**Severity: High** — **[PLAN]**
**Location:** [schema.sql:66-76](schema.sql#L66)

`bibs`' primary key is `(event_id, bib, photo_id)`, so `photo_id` is the *third* column and unusable as a prefix; `faces` has only `(event_id, row_idx)`; `photos` has nothing on `source_id`. Measured on this repo's own schema:

| Query | Before | After |
|---|---|---|
| `NOT EXISTS (… faces WHERE photo_id = p.id)` — admin `filter=no_face` | `SCAN f` | `SEARCH f USING COVERING INDEX idx_faces_photo` |
| `NOT EXISTS (… bibs WHERE b.photo_id = p.id)` | `SCAN b` | `SEARCH b USING COVERING INDEX idx_bibs_photo` |
| `SELECT … FROM bibs WHERE photo_id IN (…)` | `SCAN bibs` | `SEARCH bibs USING INDEX idx_bibs_photo` |
| `DELETE FROM bibs WHERE photo_id = ? AND source='ocr'` | `SCAN bibs` | `SEARCH bibs USING INDEX idx_bibs_photo` |
| `COUNT(*) FROM photos WHERE source_id = s.id` — the report | `SCAN p` | `SEARCH p USING COVERING INDEX idx_photos_source` |

### Impact

**Latency and query limits, not cost.** The correlated subqueries are per-row, so a 24-photo admin page with `filter=no_face` reads 24 × 78,382 ≈ 1.9 M rows. Worst case is `GET /api/internal/events/:id/indexed?complete=1`, which runs `EXISTS (… faces WHERE photo_id = p.id)` across every photo: 31 k × 78 k ≈ **2.4 billion** row reads, which will not complete regardless of billing — so `--rebuild`, the only recovery path for C4, is unusable on a large event.

### Fix

Three indexes plus one covering index — see the migration.

---

## P2 · The admin report issues 8 aggregate queries on a 6-second poll

**Severity: Low** (raised as High under a wrong free-tier premise)
**Location:** [admin.ts:270-379](apps/api/src/routes/admin.ts#L270), driven by [AdminEvent.vue:77](apps/web/src/pages/AdminEvent.vue#L77)

`load(true)` fires `getEvent` **and** `report` every 6 s for the life of a job, and a rate-limited chain runs up to 61 passes. Each report is 8 serial round trips including `COUNT(*)` over `photos`, `faces`, `jobs` and `ingest_log`, `COUNT(DISTINCT …)` over `faces` and `bibs` twice, an unbounded `GROUP BY level, code` over `ingest_log`, and a `GROUP BY bib` over `bibs`.

### Impact

At ~300 k rows per poll and 10 polls/minute, ~139 hours of continuous **foreground** polling would consume the included monthly allowance, and browsers throttle background-tab `setInterval` to ~1/min. The `ingest_log` `GROUP BY` is negligible in practice — `note()` fires per incident, not per photo, so an event accumulates hundreds of rows, not tens of thousands. The dominant real cost is the `photos(source_id)` full scan per link, which P1 already fixes.

### 🚫 Trap — do NOT swap to a "cheap jobs endpoint"

`api.admin.jobs()` does not exist in [api.ts](apps/web/src/lib/api.ts), and `GET /events/:id/jobs` ([admin.ts:670](apps/api/src/routes/admin.ts#L670)) neither computes the `stale` flag that [AdminEvent.vue:38-42](apps/web/src/pages/AdminEvent.vue#L38) depends on nor uses the pager's `LIMIT 100`. Substituting it breaks stall detection and the jobs list.

### Fix

Keep the same endpoint; just call it less. Optionally batch the statements (cosmetic — saves round trips, not rows).

```ts
// before
poll = setInterval(() => { if (activeJob.value) load(true); }, 6000) as unknown as number;

// after — same endpoint, so the server-computed `stale` flag is preserved.
poll = setInterval(() => {
  if (document.visibilityState !== 'visible') return;
  if (activeJob.value) load(true);
}, 15000) as unknown as number;
```

Also bound the unbounded `GROUP BY`: `… GROUP BY level, code ORDER BY n DESC LIMIT 40`.

---

## P3 · `loadIndex` peak memory — CORRECTED, and the first fix caused an outage

**Severity: Medium** (raised as High on arithmetic that was already stale)
**Location:** [search.ts:141](apps/api/src/search.ts#L141)

### What the audit got wrong

The finding, and the comment it was based on, both sized an event at *"78,382 faces = 38.3 MB"*. Measured against production on 2026-08-11:

| event | shards | rows | index size |
|---|---|---|---|
| `angkor11_wupmrk` | **1006** | 160,214 | **82.0 MB** |
| `qh1VYQ3HGN6I` | 46 | 8,197 | 4.2 MB |
| `d5URgH0h2F2C` | 13 | 2,594 | 1.3 MB |

So one index is 82 MB, and `MAX_CACHED_INDEXES = 2` was already 164 MB against a 128 MB isolate before anything transient was counted. That part of the finding was understated.

But the finding also inherited a false premise from the code comment it was auditing — *"shard count is small (one per source folder)"*. Shards are named `index/<event>/<source>-<run>-b<batch>.bin`, **one per batch of 25 photos**, so Angkor has 1006 of them.

### The outage

The first fix used `IN_FLIGHT = 2` to bound transient buffers. On a 1006-shard event that is **503 sequential R2 round trips**. Deployed to production, a cold face search stopped answering inside 120 s. Caught by post-deploy verification, not by any local check — nothing local has 1006 shards.

### What actually shipped, measured

`loadMs` on production, cold, repeated runs:

```
unbounded (1006 at once)   23865, 1089, 1409, 938
IN_FLIGHT = 64              7193, 22161, 2159
IN_FLIGHT = 256             1001, 1064, 1417, 0*, 1417     * in-isolate cache hit
```

`IN_FLIGHT = 256` is indistinguishable from unbounded while capping transient buffers at ~20 MB instead of 82 MB. `MAX_CACHED_INDEXES` is now **1**, because two 82 MB indexes cannot coexist; the colo-wide Cache API in `fetchShard` is what serves a runner comparing two races.

### Lesson

A stale comment was treated as a fact by both the audit and the fix. The shard count — not the byte count — sets the floor on this code path, and it was never in the finding.

---

## P9 · One R2 object per 25 photos — NEW, found during deployment

**Severity: Medium** (architectural; not addressed)
**Location:** [indexer/main.py:305](indexer/main.py#L305)

```python
shard_key = f"index/{args.event_id}/{args.source_id}-{args.run_id}-b{batch_no}.bin"
```

Angkor has **1006 shards averaging 81 KB**. Every cold face search issues 1006 R2 GETs, which is what makes `loadMs` ~1 s at best and what made a narrow fetch window catastrophic. It also means 1006 class-B operations per cold load, and the count grows without bound: every continuation pass adds more, since `run_id` is fresh per invocation.

Compacting an event's shards into one object after indexing finishes would turn 1006 GETs into 1, and is the single largest available win on this path. Deliberately **not** done here — it changes the durability story the per-batch flush exists to provide (C4), so it needs its own design rather than being folded into a fix for something else.

---

## P4 · Unclamped `limit` — a negative value disables `LIMIT` entirely

**Severity: Medium** — **[REPRO]**
**Location:** [public.ts:41](apps/api/src/routes/public.ts#L41), same pattern at [admin.ts:458](apps/api/src/routes/admin.ts#L458)

```ts
const limit = Math.min(Number(c.req.query('limit') ?? 60) || 60, 200);
```

`?limit=-1` → `Number('-1')` is `-1`, truthy, and `Math.min(-1, 200)` is `-1`. In SQLite a negative `LIMIT` means **no upper bound** (verified: `SELECT count(*) FROM (… LIMIT -1)` → 3). One unauthenticated GET returns every photo row in the event — 31 k rows serialized to JSON — and `cursor` comes back `null` because `results.length !== limit`. The 200 ceiling is defeated by a minus sign.

### Fix

```ts
// before
const limit = Math.min(Number(c.req.query('limit') ?? 60) || 60, 200);

// after
const limit = clampLimit(c.req.query('limit'), 60, 200);
```

`clampLimit` in *Reference implementations*. **[TYPED]**

---

## P5 · Unclamped face-search threshold forces a full-index sort — and returns strangers

**Severity: Medium**
**Location:** [public.ts:118](apps/api/src/routes/public.ts#L118)

```ts
const threshold = Number(c.req.query('t') ?? 0.38);
… threshold: Number.isFinite(threshold) ? threshold : 0.38
```

`Number.isFinite(-1)` is `true`, so `?t=-1` makes `cutoff` negative and *every* row becomes a candidate: `candidates` grows to `rowCount` (78,382) and is fully sorted, on top of the 40 M-multiply scan the endpoint already performs. That is real CPU, which the Paid plan does bill, on an unauthenticated, unrated, un-CAPTCHA'd route. Separately, `?t=0` is a *correctness* hazard: a shared URL carrying one returns unrelated people as matches, in a product whose promise is "find MY photos".

### Fix

```ts
// before
const threshold = Number(c.req.query('t') ?? 0.38);
const { matches, timing } = await searchFaces(c.env, event.id, vec as number[], {
  threshold: Number.isFinite(threshold) ? threshold : 0.38,
  ctx: c.executionCtx,
});

// after
const { matches, timing } = await searchFaces(c.env, event.id, vec as number[], {
  // Clamped, not merely finite: ?t=-1 makes every row a candidate and forces a
  // full sort of the index, and anything below ~0.2 returns strangers.
  threshold: clampThreshold(c.req.query('t'), 0.38),
  ctx: c.executionCtx,
});
```

---

## P6 · Every face search decodes the full-resolution image twice

**Severity: Medium**
**Location:** [face.ts:153](apps/web/src/lib/face.ts#L153) and [:368](apps/web/src/lib/face.ts#L368)

`detect()` calls `drawToRgba(bitmap)` and uses it only for `w`/`h`; `embedLargestFace` then calls `drawToRgba(bitmap)` again for the same pixels. Two full-frame canvas draws and two `getImageData` read-backs — a 12 MP phone selfie is 48 MB of RGBA per pass, so ~96 MB of allocation and two GPU→CPU sync stalls on the device class least able to absorb them, for data the first call already had.

Related: `bitmap.close()` is only reached on the success path, so the routine no-face case (`throw new NoFaceError()`) leaks the decoded bitmap on every retry — and users retry often, since the empty state actively invites it.

### Fix

```ts
// before
export async function detect(bitmap: ImageBitmap, scoreThresh = 0.5): Promise<DetectedFace[]> {
  await loadModels();
  const { data, w, h } = drawToRgba(bitmap);
  …
}

export async function embedLargestFace(source): Promise<…> {
  const bitmap = await toBitmap(source);
  const faces = await detect(bitmap);
  if (!faces.length) throw new NoFaceError();
  …
  const { data, w, h } = drawToRgba(bitmap);
  const aligned = normCrop(data, w, h, face.landmarks);
  const vec = await embedAligned(aligned);
  bitmap.close();
  return { vec: Array.from(vec), bbox: face.bbox, faceCount: faces.length };
}

// after
/** `rgba` lets a caller that has already read the pixels avoid a second pass. */
export async function detect(
  bitmap: ImageBitmap, scoreThresh = 0.5,
  rgba?: { data: Uint8ClampedArray; w: number; h: number },
): Promise<DetectedFace[]> {
  await loadModels();
  const { w, h } = rgba ?? drawToRgba(bitmap);
  …
}

export async function embedLargestFace(source): Promise<…> {
  const bitmap = await toBitmap(source);
  try {
    // One decode, one getImageData. A 12 MP phone photo is 48 MB of RGBA; doing
    // it twice cost that twice plus a second GPU->CPU sync on the slowest devices.
    const rgba = drawToRgba(bitmap);
    const faces = await detect(bitmap, 0.5, rgba);
    if (!faces.length) throw new NoFaceError();

    const face = faces.reduce((best, f) => { … });
    const aligned = normCrop(rgba.data, rgba.w, rgba.h, face.landmarks);
    const vec = await embedAligned(aligned);
    return { vec: Array.from(vec), bbox: face.bbox, faceCount: faces.length };
  } finally {
    // Reached on NoFaceError and on inference failure too. Both are routine —
    // the empty state actively invites a second attempt.
    bitmap.close();
  }
}
```

---

## P7 · `--bibs-only` re-encodes and re-uploads every thumbnail

**Severity: Medium**
**Location:** [indexer/main.py:199-222](indexer/main.py#L199)

The flag's own docstring says it *"Leaves photos, faces and shards untouched"*, but the batch loop has no `bibs_only` guard: every pass runs a LANCZOS resize and a WEBP encode per photo and `put_bytes` each result. A bibs-only pass over an 8,523-photo album performs 8,523 R2 `PutObject` calls (class-A, billed) and full-image re-encodes to produce bytes byte-identical to what is already there.

### Fix

```python
# after
        for img, path in local:
            thumb_key = f"thumbs/{args.event_id}/{img.id}.webp"
            # A bibs-only pass re-reads NUMBERS. The thumbnail is already in R2 and
            # would come back byte-identical, so re-encoding it costs a LANCZOS
            # resize and a billed class-A PutObject per photo for nothing.
            if not args.bibs_only:
                try:
                    thumb, full_w, full_h = make_thumbnail(
                        path, cfg.thumb_max_edge, cfg.thumb_quality)
                except Exception as exc:  # noqa: BLE001
                    log.warning("Thumbnail failed for %s: %s", img.name, exc)
                    note("error", "thumbnail_failed", f"{img.name}: {str(exc)[:180]}", img.id)
                    continue
                up.put_bytes(thumb_key, thumb, "image/webp")
                photo_payload.append({
                    "drive_file_id": img.id, "thumb_key": thumb_key,
                    "width": full_w, "height": full_h, "taken_at": img.taken_at,
                })
            else:
                # Still needs the id mapping, without rewriting dimensions or bytes.
                photo_payload.append({"drive_file_id": img.id, "thumb_key": thumb_key})
            …
```

`internal.ts` upserts `width`/`height`/`taken_at` from `excluded`, so guard those columns too — `width = COALESCE(excluded.width, width)` etc. — or the bibs-only payload nulls them.

---

## P8 · A whole batch of decoded full-resolution frames is held in RAM

**Severity: Medium**
**Location:** [indexer/main.py:197](indexer/main.py#L197)

`decoded` retains one `uint8 H×W×3` array per photo for the whole batch, because the OCR loop needs `photo_ids`, which only exist after `put_photos`. At the repo's own 6000×4000 figure that is ~72 MB per frame, so `BATCH_SIZE=25` holds ~1.8 GB alongside the insightface and RapidOCR sessions — and `load_bgr`'s `.copy()` transiently doubles the frame being added.

Worse, [config.py:26-30](indexer/config.py#L26) sizes `BATCH_SIZE` against **disk only** (*"25 holds 540 MB"*), understating RAM by ~3.5×; anyone raising it on that reasoning OOMs, and an OOM lands mid-batch — exactly the interruption that strands faceless photos (C4). The files are still on disk until line 305, so nothing forces them to be held.

### Fix

```python
# after
        photo_payload: list[dict] = []
        paths: dict[str, str] = {}
        for img, path in local:
            …
            paths[img.id] = path

        photo_ids = up.put_photos(…) if photo_payload else {}
        read_ids: list[str] = []
        for drive_file_id, path in paths.items():
            photo_id = photo_ids.get(drive_file_id)
            if not photo_id:
                continue
            # One decoded frame resident at a time. Holding a whole batch was
            # ~1.8 GB at the default BATCH_SIZE, and config.py's sizing note
            # measures DISK, so raising the batch on that reasoning OOMs.
            bgr = load_bgr(path)
            if bgr is None:
                note("error", "decode_failed",
                     f"{drive_file_id}: decoded to nothing — no faces or bibs read",
                     drive_file_id)
                continue
            read_ids.append(photo_id)
            …
            del bgr
```

The extra decode is off local disk and is dwarfed by detection; peak image memory becomes one frame. Fold C8's `read_ids` in at the same time.

---

# Lower-severity register

Verified, deliberately not expanded.

| Sev | Location | Issue |
|---|---|---|
| Low | [Admin.vue:85](apps/web/src/pages/Admin.vue#L85) | `onBeforeUnmount` clears `poll` but not `benchPoll`; navigating away leaves a 5 s interval hitting `/api/admin/benchmarks/:id` for the session's life. |
| Low | [Admin.vue:173](apps/web/src/pages/Admin.vue#L173) | `publish()` has no `catch`: a failed Publish is an unhandled rejection with no visible feedback. |
| Low | [AdminPhotos.vue:67](apps/web/src/pages/AdminPhotos.vue#L67) | `patchPhoto` refetches page 1 with `filter: 'all'` and greps it, so a correction past the first 24 photos never appears — and `.catch(() => null)` swallows the failure. |
| Low | [PhotoGrid.vue:101](apps/web/src/components/PhotoGrid.vue#L101) | `props.items.forEach(…)` seeds `failed` once at setup, not reactively; a thumb-less photo in an appended page shows a skeleton forever. |
| Low | [EventDetail.vue:546](apps/web/src/pages/EventDetail.vue#L546) | Inline `browse.map(…)` in the template allocates a new array identity every render, defeating `PhotoGrid`'s `columns` computed. Hoist to a `computed`. |
| Low | [internal.ts:310](apps/api/src/routes/internal.ts#L310) | `/faces` and `/bibs` never verify `photo_id` belongs to the event in the path; the sibling `/photos` route does (`:142`). A misused runner can graft a draft event's photos into a public event's face index. |
| Low | [drive.py:138](indexer/drive.py#L138) | `walk()` stops at 500 folders silently; the Worker's `walkFolder` sets `truncated` and reports it. |
| Low | [bibs.py:248](indexer/bibs.py#L248) | `read_full` is dead code — `main.py` uses `read_tiles`. Its "MUST be downscaled first" warning applies to `read_tiles`, which is handed full-resolution frames. |
| Low | [set-secrets.sh:30](tools/set-secrets.sh#L30) | `gh secret set --body "$2"` puts secrets in argv (visible in `ps`), contradicting the header's "piped on stdin". Use `--body-file -` with a heredoc. |
| Low | [deploy.sh:39](tools/deploy.sh#L39) | `> /tmp/wt.$$` is a predictable path in a world-writable dir. Use `mktemp`. |
| Low | [_headers](apps/web/public/_headers) | No `X-Frame-Options`/`frame-ancestors` on `/admin`, so the Access-authenticated SPA is frameable. No CSP anywhere. |
| Low | [ci.yml:3](.github/workflows/ci.yml#L3) | No `permissions:` block; `npm ci` runs PR-controlled lifecycle scripts. `pull_request` (not `_target`) keeps fork tokens read-only, so this is hygiene. |
| Low | [admin.ts:574](apps/api/src/routes/admin.ts#L574) | Per-photo reindex deletes `faces` rows but leaves their vectors in the shard; those rows still score and consume `topFaces` slots before dropping out at the join. |

---

# Checked and cleared — not defects

- `timingSafeEqual` is correct and correctly used.
- `D1_MAX_PARAMS - 1` chunking is right at exactly 100 bindings everywhere it appears.
- The SCRFD decode in `face.ts` matches insightface's anchor layout, `det_scale` and `distance2kps` exactly — and `tools/golden/RESULT.json` proves it end to end at cosine 0.99992.
- The CORS origin fallback is safe: a non-matching `Access-Control-Allow-Origin` is what blocks the browser.
- `/r2/*` and the shard `PUT` key regex are not traversable — R2 keys are opaque strings, not filesystem paths.
- No secrets in git history (`.env.deploy` is gitignored and was never committed).
- No `v-html`, `innerHTML`, `eval` or `new Function` anywhere in `apps/web`.

---

# Reference implementations

## `migrations/002_schema_repair.sql`

```sql
-- Schema repair: tables and constraints the code depends on that schema.sql never
-- created, plus the indexes its own query shapes require.
--
--   npx wrangler d1 execute race-lens --remote \
--     --config apps/api/wrangler.toml --file=./migrations/002_schema_repair.sql
--
-- Verified by applying schema.sql to sqlite3 and then this file.

-- 1. bib_rejects (C1) ---------------------------------------------------------
-- Read on EVERY bib-writing batch by POST /api/internal/events/:id/bibs, so its
-- absence fails the whole indexing pipeline, not one endpoint. The PRIMARY KEY
-- must be exactly (event_id, photo_id, bib): admin.ts:658 names that tuple as its
-- ON CONFLICT target, and a mismatch fails to prepare for the same reason as (2).
CREATE TABLE IF NOT EXISTS bib_rejects (
  event_id   TEXT NOT NULL,
  photo_id   TEXT NOT NULL REFERENCES photos(id),
  bib        TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (event_id, photo_id, bib)
);

-- 2. UNIQUE (event_id, drive_folder_id) on sources (C2) -----------------------
-- POST /api/admin/ingest upserts with ON CONFLICT (event_id, drive_folder_id),
-- which SQLite refuses to PREPARE without a matching unique index.

-- Preserve a 'thumb' choice BEFORE collapsing: the keeper is MIN(id), which is
-- arbitrary, and losing 'thumb' sends the next pass back to full-size downloads
-- and the quota wall that made the organizer change it in the first place.
UPDATE sources SET image_source = 'thumb'
 WHERE image_source <> 'thumb'
   AND EXISTS (SELECT 1 FROM sources d
                WHERE d.event_id        = sources.event_id
                  AND d.drive_folder_id = sources.drive_folder_id
                  AND d.image_source    = 'thumb');

-- Repoint EVERY table carrying a source id, not just photos. jobs.source_id and
-- ingest_log.source_id have no declared FK, so nothing errors — the report join
-- at admin.ts:288 just silently drops those passes.
UPDATE photos SET source_id = (
  SELECT MIN(s2.id) FROM sources s2
   WHERE s2.event_id        = (SELECT s1.event_id        FROM sources s1 WHERE s1.id = photos.source_id)
     AND s2.drive_folder_id = (SELECT s1.drive_folder_id FROM sources s1 WHERE s1.id = photos.source_id)
) WHERE source_id IS NOT NULL;

UPDATE jobs SET source_id = (
  SELECT MIN(s2.id) FROM sources s2
   WHERE s2.event_id        = (SELECT s1.event_id        FROM sources s1 WHERE s1.id = jobs.source_id)
     AND s2.drive_folder_id = (SELECT s1.drive_folder_id FROM sources s1 WHERE s1.id = jobs.source_id)
) WHERE source_id IS NOT NULL
   AND EXISTS (SELECT 1 FROM sources s WHERE s.id = jobs.source_id);

UPDATE ingest_log SET source_id = (
  SELECT MIN(s2.id) FROM sources s2
   WHERE s2.event_id        = (SELECT s1.event_id        FROM sources s1 WHERE s1.id = ingest_log.source_id)
     AND s2.drive_folder_id = (SELECT s1.drive_folder_id FROM sources s1 WHERE s1.id = ingest_log.source_id)
) WHERE source_id IS NOT NULL
   AND EXISTS (SELECT 1 FROM sources s WHERE s.id = ingest_log.source_id);

DELETE FROM sources WHERE id NOT IN (
  SELECT MIN(id) FROM sources GROUP BY event_id, drive_folder_id
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sources_event_folder
  ON sources(event_id, drive_folder_id);

-- 3. Indexes for the query shapes actually issued (P1, P2) --------------------
-- bibs' PK is (event_id, bib, photo_id), so photo_id is the third column and
-- cannot be used as a prefix; faces has only (event_id, row_idx). Every
-- photo->faces and photo->bibs lookup therefore SCANned the whole table.
CREATE INDEX IF NOT EXISTS idx_faces_photo       ON faces(photo_id);
CREATE INDEX IF NOT EXISTS idx_bibs_photo        ON bibs(photo_id);
CREATE INDEX IF NOT EXISTS idx_photos_source     ON photos(source_id);
-- Makes the report's COUNT(DISTINCT photo_id) FROM faces index-only.
CREATE INDEX IF NOT EXISTS idx_faces_event_photo ON faces(event_id, photo_id);
```

Fold items 1–3 into `schema.sql` as well — it is `IF NOT EXISTS` throughout, so it stays re-runnable.

`faces_done` (C4) ships as its own migration, because `DEFAULT 1` plus the
insert-time `0` in `internal.ts` must land together.

## `apps/api/src/access.ts` **[TYPED]**

```ts
import type { Env } from './types';

/**
 * Cloudflare Access token verification.
 *
 * Presence of `Cf-Access-Jwt-Assertion` is NOT evidence of anything: the header
 * is client-supplied, and this Worker is reachable on a hostname Access cannot
 * cover (`*.workers.dev` is not in a zone we own, so no Access application can
 * be attached to it — see DEPLOY.md, "Access only works on the custom domains").
 * On that hostname a presence check is equivalent to no check at all.
 *
 * Two gates, because either alone is insufficient:
 *   1. The signature, `aud` and `exp` are verified against the team's JWKS, so a
 *      forged or expired token is rejected.
 *   2. The request's own hostname must be one Access actually fronts, so a token
 *      legitimately issued for the custom domain cannot be replayed at the
 *      workers.dev origin, where Access never ran and never will.
 */

interface Jwk { kid: string; kty: string; alg?: string; n: string; e: string; use?: string }

/** Cached JWKS. Access rotates keys roughly every 6 weeks; an hour is ample. */
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
  email?: string; sub?: string;
  aud: string | string[]; iss: string;
  exp: number; iat?: number; nbf?: number;
}

/** Verified claims, or null. Never throws for an untrusted token. */
export async function verifyAccessJwt(
  env: Env, token: string | undefined,
): Promise<AccessClaims | null> {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [rawHeader, rawPayload, rawSig] = parts;

  try {
    const header = jsonPart(rawHeader) as { kid?: string; alg?: string };
    // Only RS256. Accepting `alg` from the token is how `alg: none` bypasses happen.
    if (header.alg !== 'RS256' || !header.kid) return null;

    const key = (await getKeys(env.CF_ACCESS_TEAM)).find((k) => k.kid === header.kid);
    if (!key) return null;

    const cryptoKey = await crypto.subtle.importKey(
      'jwk',
      { kty: key.kty, n: key.n, e: key.e, alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false, ['verify'],
    );
    const ok = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5', cryptoKey, b64url(rawSig),
      new TextEncoder().encode(`${rawHeader}.${rawPayload}`),
    );
    if (!ok) return null;

    const claims = jsonPart(rawPayload) as AccessClaims;

    // CF_ACCESS_AUD is a comma-separated LIST, not one value.
    //
    // tools/finish-deploy.sh creates one Access application PER HOSTNAME
    // (`for H in "${HOSTS[@]}"`), and each application issues its own JWT
    // audience — so there are two valid AUD tags, one per custom domain. Pinning
    // a single one would 403 the organizer on whichever hostname they did not
    // sign in through. That exact failure already happened once with a per-path
    // split; see the comment above the loop in finish-deploy.sh.
    const allowedAud = (env.CF_ACCESS_AUD || '')
      .split(',').map((a) => a.trim()).filter(Boolean);
    if (!allowedAud.length) return null;
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.some((a) => allowedAud.includes(a))) return null;

    if (claims.iss !== `https://${env.CF_ACCESS_TEAM}.cloudflareaccess.com`) return null;

    const now = Math.floor(Date.now() / 1000);
    // 60s of skew, the same allowance Cloudflare's own examples use.
    if (typeof claims.exp !== 'number' || claims.exp + 60 < now) return null;
    if (typeof claims.nbf === 'number' && claims.nbf - 60 > now) return null;

    return claims;
  } catch {
    // A malformed token is a rejection, not a 500.
    return null;
  }
}

/**
 * Is this request arriving on a hostname an Access application actually fronts?
 *
 * ACCESS_HOSTS is a comma-separated allowlist and must match the Access
 * applications exactly. The workers.dev origin is deliberately absent: it stays
 * on (public browsing from *.pages.dev needs it) but must never serve /admin.
 */
export function onAccessHost(env: Env, url: string): boolean {
  const host = new URL(url).hostname.toLowerCase();
  return (env.ACCESS_HOSTS || '').split(',')
    .map((h) => h.trim().toLowerCase()).filter(Boolean)
    .includes(host);
}
```

## `apps/api/src/types.ts` — `Env` additions **[TYPED]**

```ts
  GH_REPO: string;
  /** Cloudflare Access team name, e.g. "runlytics" for runlytics.cloudflareaccess.com. */
  CF_ACCESS_TEAM: string;
  /** Comma-separated AUD tags — one Access application per hostname, so two. */
  CF_ACCESS_AUD: string;
  /** Comma-separated hostnames an Access application actually fronts. */
  ACCESS_HOSTS: string;
}
```

```toml
# apps/api/wrangler.toml — append to [vars]
# The hostnames Access actually fronts. race-lens-api.jt7.workers.dev is
# deliberately absent: Access cannot be attached to a workers.dev hostname, so
# admin must refuse to answer there even though the origin stays on for
# *.pages.dev public browsing.
ACCESS_HOSTS = "racelens.runlytics.fit,race-lens.runlytics.fit"
CF_ACCESS_TEAM = "<your-team-name>"
# One app per hostname => one AUD each. Both, comma-separated.
CF_ACCESS_AUD = "<aud-for-racelens>,<aud-for-race-lens>"
```

## `apps/api/src/lib.ts` — append **[TYPED]**

```ts
/**
 * A page size that cannot become "no limit".
 *
 * `Math.min(Number(q) || d, max)` looks safe and is not: SQLite treats a
 * NEGATIVE LIMIT as unbounded, so `?limit=-1` returned every row of the event.
 */
export function clampLimit(raw: string | undefined, fallback: number, max: number): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, max);
}

/** Cosine threshold from an untrusted query param, clamped to a sane band. */
export function clampThreshold(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, 0.2), 1);
}
```

## `apps/web/public/_headers` — append

```
# The admin SPA sits behind Cloudflare Access. Access authenticates the request;
# it does not stop the authenticated page being framed by someone else.
/admin/*
  X-Frame-Options: DENY
  Content-Security-Policy: frame-ancestors 'none'

/admin
  X-Frame-Options: DENY
  Content-Security-Policy: frame-ancestors 'none'
```

---

# Implementation plan

Ordered so that nothing depends on something later in the list. Each task names its findings, its acceptance check, and whether it can be verified locally.

Local verification for anything touching the Worker or the schema:

```bash
npm run db:local && npm --workspace apps/api run typecheck && npm run build
```

> ### ⚠️ `wrangler dev` cannot verify anything hostname-dependent
>
> Because `routes` are declared in `wrangler.toml`, `wrangler dev` **rewrites
> `request.url` to the first route's hostname**. Every local request — `curl`
> against `127.0.0.1:8787` included — arrives at the Worker as
> `http://racelens.runlytics.fit/…`. Measured directly during task 1:
>
> ```
> $ curl http://127.0.0.1:8787/debug-host
> {"reqUrl":"http://racelens.runlytics.fit/debug-host",
>  "hostname":"racelens.runlytics.fit","onAccessHost":true}
> ```
>
> So `onAccessHost` returns `true` for every local request and the admin gate
> appears to pass everything through — **indistinguishable from the bug it fixes.**
> A local test of task 1 produces a convincing false negative. Verify the gate
> against the deployed Worker (task 2) or unit-test the pure function.

| # | Task | Fixes | Acceptance | Status |
|---|---|---|---|---|
| **1** | **Admin hostname gate.** Add `apps/api/src/access.ts` (`onAccessHost` only), `ACCESS_HOSTS` in `Env` + `wrangler.toml`, rewrite the `adminRoutes.use('*')` middleware. Keep `workers_dev = true`. | S1 part A | `typecheck` + unit cases on `onAccessHost` (see the caveat below) | ☑ |
| **2** | **Harden the preflight probe** — test a forged assertion, and assert `ACCESS_HOSTS` is non-empty and free of `workers.dev`. (`CF_ACCESS_TEAM`/`CF_ACCESS_AUD` move to task 19, where they first have a reader.) | S1 | 0 blocking locally; both new failure branches fire; the `--remote` probe caught production open | ☑ |
| **3** | **`migrations/002_schema_repair.sql`** + fold the DDL into `schema.sql`. | C1, C2, P1, P2 | Fresh apply, re-apply, no-op re-run, and a messy old-schema DB with duplicate sources + a pre-orphaned row all verified against sqlite3 | ☑ |
| **4** | **Apply migration 002 to D1** — `--local` done; `--remote` awaiting sign-off (it DELETEs duplicate `sources` rows). | C1, C2, P1 | Local D1 has all six objects; plan shows `SEARCH f USING COVERING INDEX idx_faces_photo` | ◐ |
| **5** | **Coordinate-space fix in the indexer.** `make_thumbnail` returns post-EXIF full dims; `main.py` stores them instead of Drive's. Added `tests/conftest.py` (CV stubs, removing a collection-order dependency) and 4 guards — verified to fail without the fix. | C3 | 30 tests green; every test file also passes in isolation | ☑ |
| **6** | **`clampLimit` + `clampThreshold`** in `lib.ts`, wired into `public.ts` (×2) and `admin.ts` (×1). | P4, P5 | Over HTTP against 75 seeded rows: `?limit=-1` gave **75 before, 60 after**; admin `-1`→24, `100`→60. 21 unit cases on both clamps pass | ☑ |
| **7** | **Banner upload allowlist** + event-exists check. | S2 | SVG rejected (also with a `;charset=` param and uppercased); `text/html` rejected; webp/jpg still upload; unknown event → 404; `image/jpg` stored **normalised to `image/jpeg`**, proving the type is ours | ☑ |
| **8** | **API correctness batch** — `jobs.error` clearable (C5), `finalize` must not republish a draft (C6), `faces` INSERT idempotent (C7). | C5, C6, C7 | Over HTTP: error set → preserved on omit → cleared to a real SQL NULL; finalize left `draft` alone while updating counts, then moved `indexing`→`ready`; a replayed `/faces` POST returned 200 and left 2 rows, not 4 | ☑ |
| **9** | **Indexer correctness + memory batch** — decode inside the second loop, one frame at a time; `read_ids` replaces `photo_ids.values()`; journal decode failures; `bibs_only` skips thumbnails; `internal.ts` COALESCEs the upserted dimensions so an omitted field cannot null a stored one. | C8, P7, P8 | 34 tests; 4 new guards all verified to fail against the pre-fix indexer | ☑ |
| **10** | **`loadIndex` memory** — evict before allocating, two shards in flight. | P3 | End-to-end over 3 shards (so the 2-at-a-time window is exercised): all 6 rows resolve to the right photo at score exactly 1.0000, **identical before and after** the change. Memory reduction is by construction; only equivalence is testable locally. | ☑ |
| **11** | **`face.ts` single decode + `finally` close.** | P6 | `/golden` PASS at 0.99992 unchanged. `embedLargestFace` measured directly on a 4000×3000 image: **median 157 ms → 133 ms**, distributions non-overlapping (pre min 146 > post max 142); cosine vs Python bit-identical at 0.999846 both ways; `NoFaceError` still raised, now with the bitmap released | ☑ |
| **12** | **Frontend correctness batch** — search-sequence guard (C9), `faceInput` array ref (C10), poll gating to 15 s + `visibilityState` (P2), `benchPoll` leak, `publish()` catch, `patchPhoto` keyset refetch, `PhotoGrid` reactive `failed` seed, hoisted `browseItems` computed. | C9, C10, P2, register | **C9 reproduced against production data**: with bib 200 delayed behind bib 420, pre-fix showed `?bib=420` + "34 photos found" (bib 200's); post-fix stays at "2 photos found". Build, both typechecks, 34 tests, UI scan all pass. C10 is verified by `vue-tsc` + Vue's documented `ref_for` semantics only — admin is unreachable without the S1 bypass, so it was not exercised. | ☑ |
| **13** | **Workflow `env` indirection** (index, benchmark and report-failure steps; the last now builds its JSON with `jq`) + `drive_file_id` validation in `internal.ts`. | S4 | **0** interpolations remain in any `run:` block. Simulated the step with a stub `python`: the old form **executed** an injected payload (canary written); the new form passes it as one inert argument. Boundary check rejects shell payloads, traversal, short and non-string ids over HTTP. | ☑ |
| **14** | **Model checksums** in `fetch-models.sh`. | S5 | Real 100 MB download re-run: both pins matched upstream. Tampered asset → exit 1 with both hashes printed **and the existing model left untouched**; missing asset → exit 1. Models still byte-identical, golden still PASS at 0.99992. | ☑ |
| **15** | **`_headers` framing** on `/admin` only (event pages stay embeddable), `set-secrets.sh` off argv, `deploy.sh` `mktemp`, `ci.yml` `permissions: contents: read`, `ingest_log` `GROUP BY … LIMIT 40`, dead `read_full` removed with its measurement preserved on `read_tiles`. | register | Build, both typechecks, 34 tests, preflight all pass. Caught and fixed a bug in my own `set-secrets.sh` change: `<<<` appended a newline that encoded as `key=…%0a` and would have made the Drive check fail. | ☑ |
| **16** | **Durable resume key** — `migrations/003`, insert-time `0`, new `POST /events/:id/photos/complete`, `faces_pending` flag so `--bibs-only` cannot reopen an album, `/indexed` reads the flag, batch tail reordered to vectors → bibs → complete. | C4 | Full lifecycle over HTTP: ingest → resume sees nothing; mark complete → sees only that photo; bibs-only upsert → **not** reopened; ordinary re-ingest → reopened. Migration verified on old + fresh schema (legacy rows all read done). 4 new tests incl. a photo with **no faces** and an interrupted flush. 38 tests green. | ☑ |
| **17** | **Drain `index/` from the public bucket**, then delete the `BUCKET` fallback in `search.ts`. | S3 | ⛔ **Blocked on evidence.** wrangler 3.x has no `r2 object list`; listing needs the R2 S3 credentials in `.env.deploy`. Added `tools/check-index-leak.py` to run it. Fallback deliberately left in — removing it while pre-split shards live only in the public bucket would break face search for those events. | ⛔ |
| **18** | **`tools/smoke.mjs` + a CI step** — builds a DB from `schema.sql` + every migration, starts `wrangler dev`, then exercises 20 assertions tagged with the findings they guard. | process | Ran the CI step **verbatim against a fresh checkout** (no local D1, no `.dev.vars`): exit 0, all 20 pass. Verified it CATCHES regressions: dropping `bib_rejects` fails all 3 C1 checks; dropping the `sources` unique index fails C2; reverting the resume key in code fails C4. | ☑ |
| **19** | **S1 part B — verify the Access JWT.** Both CNAMEs and both Access apps already existed; team is `animekizz`. | S1 part B | **Cannot be tested from outside** — the hostname gate 403s on workers.dev and Access 302s on the custom domain, so both outer layers shield it. Tested against a controlled keypair instead: **25 cases**, all pass (`alg:none`, HS256 confusion, tampered sig, unknown kid, wrong iss/aud, expired, nbf, empty AUD, JWKS-503 all fail closed; JWKS cached). Now `npm --workspace apps/api run test` in CI. | ☑ |

**Blocked / needs your decision**

- **Task 19** cannot proceed until `dig CNAME racelens.runlytics.fit` resolves and the two Access applications exist. Task 1 covers the exposure in the meantime.
- **Task 4** writes to production D1. It is idempotent and I verified it against SQLite, but it deletes duplicate `sources` rows — say the word before I run `--remote`.
- **Task 5** stops new drift but does not repair existing `thumb`-sourced events. Those need a re-index when you are ready to spend the passes.
