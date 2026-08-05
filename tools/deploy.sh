#!/usr/bin/env bash
# Non-interactive production deploy.
#
#   cp .env.deploy.example .env.deploy && $EDITOR .env.deploy && ./tools/deploy.sh
#
# Idempotent: safe to re-run. Secrets are read from .env.deploy and piped
# straight to wrangler/gh — never echoed, never written to the repo.
set -euo pipefail
cd "$(dirname "$0")/.."

RED=$'\e[31m'; GRN=$'\e[32m'; YEL=$'\e[33m'; DIM=$'\e[2m'; OFF=$'\e[0m'
step() { echo; echo "${DIM}──${OFF} $1"; }
ok()   { echo "  ${GRN}ok${OFF}    $1"; }
warn() { echo "  ${YEL}warn${OFF}  $1"; }
die()  { echo "  ${RED}FAIL${OFF}  $1" >&2; exit 1; }

[ -f .env.deploy ] || die "No .env.deploy — copy .env.deploy.example and fill it in."
set -a; . ./.env.deploy; set +a

for v in CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID GOOGLE_API_KEY GH_TOKEN GH_REPO; do
  [ -n "${!v:-}" ] || die "$v is empty in .env.deploy"
done
[ -n "${INGEST_SECRET:-}" ] || { INGEST_SECRET=$(openssl rand -hex 32); export INGEST_SECRET; ok "generated INGEST_SECRET"; }

WRANGLER="npx wrangler"
API_CFG="--config apps/api/wrangler.toml"

step "1/8  Cloudflare auth"
$WRANGLER whoami >/dev/null 2>&1 || die "Cloudflare token rejected. Check CLOUDFLARE_API_TOKEN scopes."
ok "authenticated to account ${CLOUDFLARE_ACCOUNT_ID:0:8}…"

step "2/8  D1 database"
if grep -q REPLACE_WITH_D1_ID apps/api/wrangler.toml; then
  # `d1 create` fails if it already exists, so fall back to looking it up.
  ID=$($WRANGLER d1 create race-lens 2>/dev/null | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1 || true)
  [ -n "$ID" ] || ID=$($WRANGLER d1 list --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);const m=j.find(x=>x.name==="race-lens");process.stdout.write(m?m.uuid:"")}catch{}})')
  [ -n "$ID" ] || die "Could not create or find the race-lens D1 database."
  # macOS and GNU sed disagree on -i; write through a temp file instead.
  sed "s/REPLACE_WITH_D1_ID/$ID/" apps/api/wrangler.toml > /tmp/wt.$$ && mv /tmp/wt.$$ apps/api/wrangler.toml
  ok "database_id set to $ID"
else
  ok "database_id already set"
fi

step "3/8  R2 bucket + schema"
$WRANGLER r2 bucket create race-lens >/dev/null 2>&1 && ok "bucket created" || ok "bucket already exists"
$WRANGLER d1 execute race-lens --remote $API_CFG --file=./schema.sql -y >/dev/null 2>&1 \
  && ok "schema applied" || warn "schema apply reported an error (usually means it is already applied)"

step "4/8  Worker secrets"
put_secret() { printf '%s' "$2" | $WRANGLER secret put "$1" $API_CFG >/dev/null 2>&1 && ok "$1"; }
put_secret GOOGLE_API_KEY    "$GOOGLE_API_KEY"
put_secret INGEST_SECRET     "$INGEST_SECRET"
put_secret GH_DISPATCH_TOKEN "$GH_TOKEN"
put_secret GH_REPO           "$GH_REPO"

step "5/8  Deploy Worker"
OUT=$($WRANGLER deploy $API_CFG 2>&1) || { echo "$OUT"; die "Worker deploy failed"; }
API_URL=$(echo "$OUT" | grep -oE 'https://[a-zA-Z0-9._-]+\.workers\.dev' | head -1)
[ -n "$API_URL" ] || die "Deployed, but could not determine the Worker URL. Check the output above."
ok "Worker live at $API_URL"
curl -sf "$API_URL/health" >/dev/null && ok "/health responds" || die "/health did not respond"

step "6/8  Frontend"
# CORS must name the real Pages origin or every browser request is rejected.
PAGES_URL="https://race-lens.pages.dev"
sed "s|WEB_ORIGIN = \".*\"|WEB_ORIGIN = \"$PAGES_URL\"|" apps/api/wrangler.toml > /tmp/wt2.$$ && mv /tmp/wt2.$$ apps/api/wrangler.toml
$WRANGLER deploy $API_CFG >/dev/null 2>&1 && ok "WEB_ORIGIN pinned to $PAGES_URL"

[ -f apps/web/public/models/w600k_mbf.onnx ] || ./tools/fetch-models.sh >/dev/null
VITE_API_BASE="$API_URL" npm run build --workspace apps/web >/dev/null 2>&1 || die "Frontend build failed"
$WRANGLER pages project create race-lens --production-branch=main >/dev/null 2>&1 || true
$WRANGLER pages deploy apps/web/dist --project-name=race-lens --commit-dirty=true >/dev/null 2>&1 \
  && ok "Pages deployed to $PAGES_URL" || die "Pages deploy failed"

step "7/8  GitHub"
export GH_TOKEN
gh repo view "$GH_REPO" >/dev/null 2>&1 || gh repo create "$GH_REPO" --private --source=. --remote=origin >/dev/null 2>&1
git remote get-url origin >/dev/null 2>&1 || git remote add origin "https://github.com/$GH_REPO.git"
git push -u origin main >/dev/null 2>&1 && ok "pushed to $GH_REPO" || warn "push failed — push manually"

set_secret() { gh secret set "$1" --repo "$GH_REPO" --body "$2" >/dev/null 2>&1 && ok "secret $1"; }
set_secret GOOGLE_API_KEY "$GOOGLE_API_KEY"
set_secret INGEST_SECRET  "$INGEST_SECRET"
set_secret API_BASE_URL   "$API_URL"
set_secret R2_ACCOUNT_ID  "$CLOUDFLARE_ACCOUNT_ID"
set_secret R2_BUCKET      "race-lens"
if [ -n "${R2_ACCESS_KEY_ID:-}" ] && [ -n "${R2_SECRET_ACCESS_KEY:-}" ]; then
  set_secret R2_ACCESS_KEY_ID     "$R2_ACCESS_KEY_ID"
  set_secret R2_SECRET_ACCESS_KEY "$R2_SECRET_ACCESS_KEY"
else
  warn "R2 S3 keys not provided — indexing WILL fail until you add them."
  echo "        Dashboard → R2 → Manage API tokens → Create (Object Read & Write on race-lens),"
  echo "        then put them in .env.deploy and re-run, or set them as repo secrets directly."
fi

step "8/8  Remaining manual step"
cat <<EOS
  ${YEL}Cloudflare Access must be configured by hand${OFF} — until then /admin returns 403
  to everyone (fail-closed, which is correct, but you cannot use it either).

    Zero Trust → Access → Applications → Add → Self-hosted
      App 1:  $(echo "$API_URL" | sed 's|https://||')  path /api/admin
      App 2:  race-lens.pages.dev                       path /admin
      Policy: Allow → Emails → ${ADMIN_EMAIL:-your-email}

  Then verify:  incognito → $PAGES_URL/admin  must 403.
EOS

echo
echo "  Frontend : $PAGES_URL"
echo "  API      : $API_URL"
echo
node tools/preflight.mjs --remote --api="$API_URL" || true
