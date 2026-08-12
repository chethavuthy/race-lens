# Deploy runbook

Everything that could be verified without credentials has been. What remains
needs accounts only you can create. Run the steps in order — each one is
checked by the step after it.

Track progress with:

```bash
node tools/preflight.mjs
```

**Current state:** deployed. See STATUS below for what is live and the four
things still needing you.


## STATUS — 2026-08-05

**Live and working**

| | |
|---|---|
| Site | <https://race-lens.pages.dev> |
| API | <https://race-lens-api.jt7.workers.dev> |
| Event | The 11th Angkor Empire Marathon 2026 — **151/151 photos, 380 faces, 144 bib numbers** |
| Repo | <https://github.com/chethavuthy/race-lens> |

Verified on production: bib search (exact + suffix), face search (self-match
0.999 from a real runner), thumbnails decoding 60/60, admin 403s, internal API
401s on a bad secret, preflight 0 blocking / 0 warnings.

**Remaining: 2 items, both needing ONE Cloudflare API token**

Nameservers are done — `dig NS runlytics.fit` returns Cloudflare. What is
missing is smaller than it looked:

1. **CNAME records do not exist.** Both Pages custom domains are attached and
   stuck at `status=pending` because nothing points at them:

   ```
   racelens.runlytics.fit    (no record)   ->  needs CNAME race-lens.pages.dev
   race-lens.runlytics.fit   (no record)   ->  needs CNAME race-lens.pages.dev
   ```

2. **Cloudflare Access is unconfigured**, so `/admin` 403s for everyone
   including you.

Neither can be automated with `wrangler login`. That OAuth grant carries
`zone:read` but not `dns_records:write` and has no Access scope at all — both
endpoints return `10000 Authentication error`, verified directly. Re-adding the
Pages custom domains does not make Pages provision the DNS either; that was
tried and the records still do not appear.

**The fix is one token, then one command:**

<https://dash.cloudflare.com/profile/api-tokens> → Create Token → Custom:

| Scope | Permission |
|---|---|
| Zone · DNS | Edit (`runlytics.fit`) |
| Zone · Zone | Read (`runlytics.fit`) |
| Account · Access: Apps and Policies | Edit |
| Account · Cloudflare Pages | Read |

```bash
# paste into .env.deploy as CLOUDFLARE_API_TOKEN=
./tools/finish-deploy.sh
```

It creates both CNAMEs, creates one Access app per hostname (covering
`/api/admin` and `/admin/signin`) with an allow policy for your email, and
verifies. Idempotent — and on an existing app it drops `/admin` from the
destinations, which is what makes the organizer invitation publicly readable.

---|---|
| Site | <https://race-lens.pages.dev> |
| API | <https://race-lens-api.jt7.workers.dev> |
| D1 | `race-lens` · `b2201d61-8877-4c6f-bf73-64b848c89db7` (APAC) |
| R2 | `race-lens` bucket |
| Repo | <https://github.com/chethavuthy/race-lens> |

Verified against production: public API returns `200`, CORS passes for all three
origins, `/api/admin/*` returns **403** (fails closed — no Access policy yet),
`/api/internal/*` returns **401** on a bad ingest secret, SPA deep links work,
and the Phase 5 fixtures are absent from the deployed bundle.

**Pending — 4 things, all needing you**

1. **Nameservers.** `runlytics.fit` is registered at Namecheap and still points
   there, so all four custom URLs are dead until you switch it. At Namecheap →
   Domain List → Manage → Nameservers → *Custom DNS*:

   ```
   grannbo.ns.cloudflare.com
   lou.ns.cloudflare.com
   ```

   Both hostnames are already attached to the Pages project and both Worker
   routes are deployed, so `racelens.runlytics.fit` and
   `race-lens.runlytics.fit` (plus `/admin` on each) start working on their own
   once the zone goes active. Usually under an hour, occasionally 24.

2. **`GOOGLE_API_KEY`.** Nothing can be indexed without it. Set in both places:

   ```bash
   cd apps/api && npx wrangler secret put GOOGLE_API_KEY
   gh secret set GOOGLE_API_KEY --repo chethavuthy/race-lens
   ```

3. **R2 S3 tokens** — dashboard → R2 → Manage API tokens → Create (Object Read
   & Write on `race-lens`). Cannot be minted through the Workers API.

   ```bash
   gh secret set R2_ACCESS_KEY_ID --repo chethavuthy/race-lens
   gh secret set R2_SECRET_ACCESS_KEY --repo chethavuthy/race-lens
   ```

4. **`GH_DISPATCH_TOKEN`** — a fine-grained PAT (Contents: read/write on this
   repo only). Deliberately not set from your existing `gh` OAuth token: that
   one carries `repo`, `gist`, and `admin:public_key` across *every* repo you
   own, and storing it in a Worker secret would hand the Worker all of it.

   ```bash
   cd apps/api && npx wrangler secret put GH_DISPATCH_TOKEN
   ```

**Then, one manual console step:** Cloudflare Access. Until it exists `/admin`
403s for everyone — correct, but you cannot use it either.

Zero Trust → Access → Applications → Add → Self-hosted, one app covering
`racelens.runlytics.fit` and `race-lens.runlytics.fit`, paths `/api/admin` and
`/admin/signin`. Policy: *Allow* → Emails → `vuthychetha@gmail.com`, plus one
line per photographer you let in.

`/admin` itself is deliberately NOT gated: it is the invitation photographers
read before they are on the list, it ships no data, and everything it renders
comes from `/api/admin`. `/admin/signin` is gated in its place so an organizer
who IS on the list has a path that triggers the login.

Access only works on the custom domains — the API is same-origin there. On
`*.pages.dev` the admin UI calls the Worker cross-origin, and a host-scoped
Access cookie will never be sent, so admin is expected to fail there.

---


## Already verified — do not redo

| Gate | Result |
|---|---|
| Phase 5 · embedding parity | **cosine 0.99992** (gate 0.99); landmark error 0.082 px; crop MAE 0.068/255 |
| Phase 4 · vector search | Real Python-built shard → R2 → Worker returns the right photo at score 1.00 |
| API surface | Idempotent upserts, bib exact + suffix match, row allocation, admin fails closed |
| Frontend | Typechecks, builds, zero UI anti-patterns |

Because parity passed, the Hugging Face Spaces fallback in the plan is **not
needed**. Browser-side embedding is the shipping path.

---

## 1 · Google Drive API key

Needed before any album can be indexed. There is no key on this machine.

1. <https://console.cloud.google.com/> → create (or pick) a project.
2. **APIs & Services → Library → Google Drive API → Enable.**
3. **Credentials → Create credentials → API key.**
4. **Restrict the key** — this key is used from CI and the Worker, so:
   - *API restrictions* → Google Drive API only.
   - Leave application restrictions unset (Workers and Actions have no fixed IP).

Verify it against your real album before wiring anything else up:

```bash
export GOOGLE_API_KEY='paste-key-here'
curl -s "https://www.googleapis.com/drive/v3/files?q=%271QAtyyD2KGJ-_HhVVIf2wUJE07UNzaPGw%27+in+parents+and+trashed%3Dfalse&fields=files(id,name,mimeType)&pageSize=5&supportsAllDrives=true&includeItemsFromAllDrives=true&key=$GOOGLE_API_KEY" | head -40
```

- Files listed → good.
- `403` → the key is not enabled or not restricted correctly.
- `404` → the folder is not link-shared. Set it to **Anyone with the link —
  Viewer**.
- Empty `files: []` → almost always a Shared Drive without the two
  `*AllDrives` flags. The app always sends them; this curl does too.

## 2 · Cloudflare

```bash
npx wrangler login
npx wrangler d1 create race-lens        # paste the returned uuid into apps/api/wrangler.toml
npx wrangler r2 bucket create race-lens
npm run db:remote                        # applies schema.sql
```

Set `WEB_ORIGIN` in `apps/api/wrangler.toml` to your real Pages origin, then:

```bash
cd apps/api
npx wrangler secret put GOOGLE_API_KEY
npx wrangler secret put INGEST_SECRET      # openssl rand -hex 32
npx wrangler secret put GH_DISPATCH_TOKEN  # fine-grained PAT, Contents: read/write, this repo only
npx wrangler secret put GH_REPO            # e.g. chetha/race-lens
npx wrangler deploy
```

R2 credentials for the runner: **R2 → Manage API tokens → Create** (Object
Read & Write on `race-lens`). Keep the account id, access key id, and secret.

### Cloudflare Access — do not skip

`/api/admin/*` currently returns 403 to everyone, because `DEV_ADMIN_BYPASS` is
`"0"` and no Access policy exists yet. That is fail-closed, which is correct, but
it also means admin is unusable until you do this:

**Zero Trust → Access → Applications → Add → Self-hosted**

- Application domain: your API hostname, path `/api/admin`
- Add a second destination on the same app, path `/admin/signin`
- Policy: *Allow*, rule **Emails → vuthychetha@gmail.com** (add a line per
  photographer you allow in)

Verify: `/admin` loads for anyone and shows the invitation; `/admin/signin`
prompts for login; `/api/admin/*` 403s in incognito.

## 3 · GitHub

```bash
gh repo create race-lens --private --source=. --remote=origin --push
```

Repo secrets (**Settings → Secrets and variables → Actions**):

`GOOGLE_API_KEY`, `API_BASE_URL`, `INGEST_SECRET`, `R2_ACCOUNT_ID`,
`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`

`API_BASE_URL` is the deployed Worker origin, no trailing slash.

## 4 · Pages

First time only — after that, use `npm run deploy` (see below).

```bash
npm run build
npx wrangler pages deploy apps/web/dist --project-name=race-lens --branch=main
```

`--branch=main` is required. Without it wrangler infers the branch from git, and
anything other than `main` produces a PREVIEW deployment: reported as a success,
serving nothing on the live site.

The build strips `dist/golden` automatically — the Phase 5 fixtures include a
test photo and must not reach a public origin.

## 4b · Shipping a change, afterwards

```bash
npm run deploy          # both, or -- --api / -- --web
```

Do NOT hand-run `wrangler deploy` for routine changes. It reads the WORKING
TREE, so whatever is sitting uncommitted in your checkout goes live with it —
including a collaborator's or an agent's half-finished work, which is exactly how
an unfinished admin change reached production on 2026-08-11.

`tools/ship.sh` builds from a temporary worktree at HEAD instead, so uncommitted
work cannot be shipped even by accident; it lists what it is ignoring, runs
typecheck and the Worker tests inside that checkout, pins the Pages branch, and
then checks the live origins actually serve what it just built.

## 5 · First real album

Your album: **The 11th Angkor Empire Marathon 2026**
`https://drive.google.com/drive/folders/1QAtyyD2KGJ-_HhVVIf2wUJE07UNzaPGw`
(slug will be `the-11th-angkor-empire-marathon-2026`)

1. Open `/admin`, paste the folder URL, press **Check**. You should get a
   recursive image count, subfolder count, and four sample thumbnails within a
   couple of seconds. This is the whole point of the inspect step — every Drive
   failure becomes a red message here instead of a silent 40-minute job.
2. **New event** → name `The 11th Angkor Empire Marathon 2026`, set the date,
   upload a banner.
3. **Start indexing.** Watch the Actions run and the progress bar.
4. When it finishes, verify on `/e/the-11th-angkor-empire-marathon-2026`:
   - **Phase 2** — thumbnails render, count matches the inspect count.
   - **Phase 3** — search a bib number you can read in a photo. Hand-check
     20 photos and record precision/recall.
   - **Phase 6** — take a selfie on a phone. Tune the threshold with
     `?t=` on the search endpoint if there are too many or too few hits;
     0.38 is the default, raise it if you see false positives.

Final check once it is live:

```bash
node tools/preflight.mjs --remote --api=https://your-worker-origin
```

---

## Watch for on the first run

- **Runner disk.** ~3,500 full-size photos fills a runner. The batch loop
  deletes `/tmp/work` between batches, and the workflow reclaims ~25 GB of
  preinstalled toolchains, but a very large album may still need `BATCH_SIZE`
  lowered.
- **`downloadQuotaExceeded`.** Popular albums hit it. The job backs off, marks
  itself `partial`, and keeps everything already downloaded. Re-run the same
  source later; it is idempotent on `(event_id, drive_file_id)`.
- **PaddlePaddle wheels.** The one dependency likely to break the CI install.
  If it fails, pin a known-good version in `indexer/requirements.txt`. Nothing
  else in the pipeline depends on it except bib OCR.

## Regenerating the parity gate

`.venv-golden/` holds the insightface stack used to produce the reference. It is
gitignored and safe to delete; recreate with the commands in this file's history
or:

```bash
python3 -m venv .venv-golden
.venv-golden/bin/pip install "numpy<2" onnxruntime opencv-python-headless insightface
.venv-golden/bin/python tools/golden/make_golden.py <a-face.jpg>
npm run dev:web    # open /golden
```
