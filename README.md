# Race Lens

Find your race photos by selfie, photo, or bib number.

An organizer pastes a public Google Drive folder link into `/admin`. A GitHub
Actions job downloads the photos, detects faces and bib numbers, and builds a
per-event index. Runners search it from the site.

**No GPU, no inference server, no per-request ML cost.** Indexing runs in CI;
query embedding runs in the user's browser; the Worker only does a dot-product
loop. Originals stay on Drive — we store thumbnails and vectors.

---

## Layout

```
apps/web/     Vite + Vue 3 → Cloudflare Pages
apps/api/     Hono Worker → wrangler (D1 + R2)
indexer/      Python pipeline, runs on a GitHub Actions runner
tools/golden/ Embedding parity harness (the Phase 5 gate)
schema.sql    D1 schema
```

## The vector contract

Three files must agree exactly. Changing one means changing all three.

| | |
|---|---|
| Model | insightface `buffalo_s` — `det_500m.onnx` (SCRFD) + `w600k_mbf.onnx` (MobileFaceNet, 512-d) |
| Embedding | L2-normalized float32[512] |
| Quantization | `int8 = clamp(round(f * 127), -127, 127)` |
| Shard file | flat little-endian int8, `row_count × 512` bytes, no header |
| Ranking | raw int8 dot product; `cosine = score / (127 × 127)` |
| Default threshold | 0.38 |

Implemented in `indexer/faces.py` (reference), `apps/api/src/search.ts`, and
`apps/web/src/lib/face.ts`.

Two properties were verified numerically rather than assumed:

- The closed-form similarity transform in `face.ts` matches skimage's Umeyama
  (what insightface's `norm_crop` uses) to **7e-13** across 2000 randomized
  landmark configurations.
- int8 quantization perturbs a cosine score by **0.0026 mean / 0.0147 worst
  case** — roughly 26× headroom under the 0.38 threshold.

---

## Setup

### 1. Cloudflare

```bash
npm install
npx wrangler d1 create race-lens          # paste the id into apps/api/wrangler.toml
npx wrangler r2 bucket create race-lens
npm run db:remote                          # apply schema.sql
```

Worker secrets:

```bash
cd apps/api
npx wrangler secret put GOOGLE_API_KEY     # Drive API key, no OAuth needed
npx wrangler secret put INGEST_SECRET      # any long random string
npx wrangler secret put GH_DISPATCH_TOKEN  # fine-grained PAT, Contents: RW, this repo only
npx wrangler secret put GH_REPO            # e.g. your-org/race-lens
npx wrangler deploy
```

Then, in the Cloudflare dashboard:

- **Zero Trust → Access → Applications** — add a self-hosted app covering
  `/admin` and `/api/admin/*`, policy = allow your email. Free to 50 users.
  This is the only authentication in the project; there is no auth code.
- Optionally bind a custom domain to the R2 bucket and set `R2_PUBLIC_BASE` in
  `wrangler.toml`. Without it, assets are served through the Worker at `/r2/*`.

### 2. GitHub

Repo secrets: `GOOGLE_API_KEY`, `API_BASE_URL`, `INGEST_SECRET`,
`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`.

Private repo gets 2,000 Actions minutes/month; public is unlimited. Either works.

### 3. Frontend

```bash
./tools/fetch-models.sh    # pulls the two ONNX files into apps/web/public/models
npm run build
```

Deploy `apps/web/dist` to Cloudflare Pages. Point the Pages project at the
Worker (same custom domain, or set `VITE_API_BASE`).

### Local development

```bash
cp apps/api/.dev.vars.example apps/api/.dev.vars   # set DEV_ADMIN_BYPASS=1
npm run db:local
npm run dev:api    # :8787
npm run dev:web    # :5173, proxies /api to the Worker
```

`DEV_ADMIN_BYPASS` is a deploy-time var, never a request header — a
header-triggered bypass would be forgeable by anyone who found the origin.

---

## Build phases

Each phase has a gate. Verify it before starting the next one.

| Phase | Gate |
|---|---|
| 1 · Schema, Worker CRUD, Pages, Access | Event created via `/admin`, visible on `/`, banner renders from R2. `/admin` returns 403 in an incognito window. |
| 2 · Drive inspect, dispatch, thumbnails | Paste a real public folder → correct recursive count → job runs → thumbnails in R2 → grid on `/e/:slug` → progress reaches 100%. **Test a Shared Drive and a nested folder.** |
| 3 · Bib OCR | Enter a known bib on a real album, get the right photos. Record precision/recall on 20 hand-checked photos. |
| 4 · Faces → shards → search | `POST /search/face` with a vector produced *by the Python indexer* returns that runner's photos. Confirm the torso-crop OCR did not regress bib accuracy. |
| 5 · Golden parity, then browser embedding | `/golden` reports **cosine ≥ 0.99**. Only then wire up the real UI. |
| 6 · Tuning and polish | A phone selfie on a real album returns the right runner at an acceptable false-positive rate. |

### Running the Phase 5 gate

```bash
python tools/golden/make_golden.py path/to/a-face.jpg
npm run dev:web
# open http://localhost:5173/golden
```

The page compares three stages, so a failure is diagnosable:

- **Landmark error high** → the detector decode (anchor centres, stride
  scaling) is wrong.
- **Landmarks fine, crop diff high** → the similarity transform or the warp is
  wrong.
- **Both fine, cosine low** → the recognizer's input normalization is wrong.

If the gate still fails after a day, fall back to a FastAPI endpoint on Hugging
Face Spaces running the identical Python code. Parity is then guaranteed, at the
cost of a cold start and the on-device privacy story. Ship that rather than burn
a second day.

---

## Things that will bite you

1. Shared Drives return an **empty list** without both `supportsAllDrives` and
   `includeItemsFromAllDrives` — indistinguishable from an empty folder.
2. Runner disk fills at roughly 3,500 full-size photos. The batch loop deleting
   `/tmp/work` between batches is load-bearing, not an optimization.
3. `downloadQuotaExceeded` on popular albums → back off, mark the job
   `partial`, keep what you have. Never fail the whole run.
4. Google Photos links are not Drive links. Rejected at paste time with an
   explicit message, because organizers paste them constantly.
5. Embedding parity is the whole project. See the gate above.
6. **Do not use Vectorize.** It bills by queried vector dimensions; at 10k faces
   that is ~$0.05 per search. Brute force in the Worker is free and faster at
   this scale.
7. Dedupe is on `(event_id, drive_file_id)`, so re-running a source is
   idempotent. It is deliberately not globally unique on `drive_file_id` — the
   same file can belong to two events.
8. The concatenated shard array is cached in Worker module scope. Refetching
   15 MB from R2 per request is 20 ms vs 400 ms.
9. Bib OCR reads numbers off bystanders. Face-anchored torso crops are what keep
   that under control.
10. `row_base` is allocated by the Worker, not the runner — two sources indexing
    concurrently would otherwise pick the same offset and overwrite each other.

## Design system

`.claude/skills/` vendors a design-engineering skill set (from the sibling
`vestige` project) that the UI is built against:

| Skill | Used for |
|---|---|
| `impeccable` | Design command set, plus a runnable anti-pattern detector |
| `apple-design` | Fluid/physical motion, interruptible transitions |
| `emil-design-eng` | Component polish and the invisible details |
| `animation-vocabulary`, `improve-animations`, `find-animation-opportunities`, `review-animations` | Motion decisions |

The `higgsfield-*`, `shadcn`, and `migrate-radix-to-base` skills were
deliberately not vendored: the first group is AI media generation, and the
latter two are React-only.

Run the detector over the frontend at any time:

```bash
node .claude/skills/impeccable/scripts/detect.mjs apps/web/src
```

It exits non-zero on findings, so it drops straight into CI. URL scanning
(contrast, spacing, rendered layout) additionally needs `npm i -D puppeteer`.

**This is an Operate-mode surface** — the runner is completing a task, not being
sold to. That choice drives several rules the UI follows deliberately:

- Fixed rem type scale, never `clamp()`. Fluid headings serve brand pages; in
  product UI they just shrink unpredictably.
- Skeletons for loading, never a spinner parked in the content area.
- Empty states teach the next move. A bib search with no hits offers face
  search, because that is the one that works when a bib is folded or hidden.
- Motion is one authored moment (results arriving), 150-250 ms, and fully
  disabled under `prefers-reduced-motion`.

Measured colour decisions, so they are not re-litigated by eye:

| Pair | Ratio | Note |
|---|---|---|
| `--text` on `--bg` | 15.7:1 | |
| `--muted` on `--bg` | 6.8:1 | |
| `--accent-ink` on `--accent` | 6.2:1 | White on the accent is **3.07:1** and fails — hence the dark ink on primary buttons |
| `--line-strong` on `--bg` | 3.2:1 | Control boundaries; `--line` stays subtle for decorative edges |

## Non-goals

No accounts, payments, photo editing, video, watermarking, e-commerce, email, or
i18n.

## Cost

| | |
|---|---|
| Workers, Pages, D1, R2 | $5/mo (existing Workers Paid plan) |
| Cloudflare Access, GitHub Actions, Drive API | free tiers |
| Inference | $0 — browser and CI only |

Headroom before anything needs rethinking: ~100 events, ~10k photos and ~50k
faces each.
