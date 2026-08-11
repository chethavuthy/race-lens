#!/usr/bin/env bash
# Push whatever is filled in in .env.deploy to the Worker and to GitHub Actions.
#
#   $EDITOR .env.deploy      # fill in the blanks
#   ./tools/set-secrets.sh
#
# Idempotent, and skips anything still blank. Values are piped to wrangler/gh
# on stdin — never echoed, never logged, never committed (.env.deploy is
# gitignored and chmod 600).
set -euo pipefail
cd "$(dirname "$0")/.."

GRN=$'\e[32m'; YEL=$'\e[33m'; DIM=$'\e[2m'; OFF=$'\e[0m'
[ -f .env.deploy ] || { echo "No .env.deploy — copy .env.deploy.example first." >&2; exit 1; }
set -a; . ./.env.deploy; set +a

REPO="${GH_REPO:-chethavuthy/race-lens}"
API_CFG="--config apps/api/wrangler.toml"

worker() {  # worker <NAME> <value>
  if [ -n "${2:-}" ]; then
    printf '%s' "$2" | npx wrangler secret put "$1" $API_CFG >/dev/null 2>&1 \
      && echo "  ${GRN}set${OFF}   worker/$1" || echo "  FAIL  worker/$1"
  else
    echo "  ${YEL}skip${OFF}  worker/$1 ${DIM}(blank in .env.deploy)${OFF}"
  fi
}
actions() { # actions <NAME> <value>
  if [ -n "${2:-}" ]; then
    # stdin, not --body: an argv value is visible to any `ps` on this machine for
    # as long as the call runs, which contradicts this file's own header. gh reads
    # the value from a file, and `-` means standard input.
    printf '%s' "$2" | gh secret set "$1" --repo "$REPO" --body-file - >/dev/null 2>&1 \
      && echo "  ${GRN}set${OFF}   actions/$1" || echo "  FAIL  actions/$1"
  else
    echo "  ${YEL}skip${OFF}  actions/$1 ${DIM}(blank in .env.deploy)${OFF}"
  fi
}

echo
echo "Worker secrets"
worker  GOOGLE_API_KEY        "${GOOGLE_API_KEY:-}"
worker  GH_DISPATCH_TOKEN     "${GH_DISPATCH_TOKEN:-}"
worker  INGEST_SECRET         "${INGEST_SECRET:-}"
worker  GH_REPO               "${GH_REPO:-}"

echo
echo "GitHub Actions secrets"
actions GOOGLE_API_KEY        "${GOOGLE_API_KEY:-}"
actions INGEST_SECRET         "${INGEST_SECRET:-}"
actions R2_ACCESS_KEY_ID      "${R2_ACCESS_KEY_ID:-}"
actions R2_SECRET_ACCESS_KEY  "${R2_SECRET_ACCESS_KEY:-}"
actions R2_ACCOUNT_ID         "${CLOUDFLARE_ACCOUNT_ID:-}"
actions R2_BUCKET             "race-lens"
actions API_BASE_URL          "${API_BASE_URL:-https://race-lens-api.jt7.workers.dev}"

# A key that cannot read the album is worth catching here, not 40 minutes into
# a CI job.
if [ -n "${GOOGLE_API_KEY:-}" ] && [ -n "${TEST_FOLDER_ID:-}" ]; then
  echo
  echo "Drive check on folder $TEST_FOLDER_ID"
  # --get --data-urlencode keeps the key out of the command line: curl assembles
  # the query itself, so the API key never appears in argv where `ps` can read it.
  # The key arrives on stdin via printf, NOT a here-string: `<<<` appends a newline
  # and `@-` reads it, which encoded the key as "…%0a" and made Drive reject it.
  BODY=$(curl -s --get "https://www.googleapis.com/drive/v3/files" \
    --data-urlencode "q='$TEST_FOLDER_ID' in parents and trashed=false" \
    --data-urlencode "fields=files(id,name,mimeType)" \
    --data-urlencode "pageSize=5" \
    --data-urlencode "supportsAllDrives=true" \
    --data-urlencode "includeItemsFromAllDrives=true" \
    --data-urlencode "key@-" < <(printf '%s' "$GOOGLE_API_KEY"))
  node -e '
const b=JSON.parse(require("fs").readFileSync(0,"utf8"));
if (b.error) { console.log("  FAIL  "+b.error.code+" "+b.error.message);
  if(b.error.code===404) console.log("        folder is not link-shared — set it to Anyone with the link (Viewer)");
  if(b.error.code===403) console.log("        key is not enabled for the Drive API, or is restricted to another API");
  process.exit(1); }
const f=b.files||[];
if(!f.length){ console.log("  WARN  reachable but zero entries at the top level"); process.exit(0); }
console.log(`  ok    ${f.length} entries visible, e.g.:`);
f.slice(0,3).forEach(x=>console.log(`          ${x.name}  (${x.mimeType})`));
' <<<"$BODY"
fi
echo
