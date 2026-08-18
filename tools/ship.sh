#!/usr/bin/env bash
# Ship what is committed — Worker and site — and nothing else.
#
#   npm run deploy            # typecheck, test, deploy both, verify
#   npm run deploy -- --api   # Worker only
#   npm run deploy -- --web   # site only
#
# WHY THIS EXISTS
#
# The routine deploy used to be two commands typed by hand:
#
#     cd apps/api && npx wrangler deploy
#     npm run build && npx wrangler pages deploy apps/web/dist --project-name=race-lens
#
# Both read the WORKING TREE. On 2026-08-11 that tree also held another session's
# half-finished admin work — an owner/photographer split with a new OWNER_EMAIL
# binding that production did not have — and two deploys went out from it. Nothing
# in either command asks whose code it is about to make live.
#
# So this script never builds from the working tree at all. It checks out HEAD into
# a temporary worktree and builds there, which means uncommitted work cannot reach
# production even by accident: not yours, not a collaborator's, not a stray edit
# from an agent running in the same checkout. A dirty tree is reported, loudly,
# and then ignored rather than shipped.
#
# It also pins --branch=main on the Pages deploy. Without it wrangler infers the
# branch from git, and from a detached worktree that inference produces a PREVIEW
# deployment that looks successful and changes nothing on the live site. That
# happened too, in the same hour.
set -euo pipefail
cd "$(dirname "$0")/.."

RED=$'\e[31m'; GRN=$'\e[32m'; YEL=$'\e[33m'; DIM=$'\e[2m'; OFF=$'\e[0m'
step() { echo; echo "${DIM}──${OFF} $1"; }
ok()   { echo "  ${GRN}ok${OFF}    $1"; }
warn() { echo "  ${YEL}warn${OFF}  $1"; }
die()  { echo "  ${RED}FAIL${OFF}  $1" >&2; exit 1; }

DO_API=1; DO_WEB=1
for a in "$@"; do
  case "$a" in
    --api) DO_WEB=0 ;;
    --web) DO_API=0 ;;
    *) die "Unknown option: $a (expected --api or --web)" ;;
  esac
done

REPO=$(pwd)
SHA=$(git rev-parse HEAD)
SUBJECT=$(git log -1 --format=%s)

step "1/5  What is about to go live"
echo "        ${SHA:0:9}  $SUBJECT"

# Uncommitted work is not an error — it is simply not shipped, and saying so is
# the whole point. Deploying it silently is what this script exists to prevent.
DIRTY=$(git status --porcelain)
if [ -n "$DIRTY" ]; then
  warn "the working tree has uncommitted changes; they will NOT be deployed:"
  echo "$DIRTY" | sed 's/^/          /'
fi

# Unpushed is a warning rather than a refusal: an emergency fix should not be
# blocked on GitHub being reachable. But "what is live" must be recoverable from
# the repo, and an unpushed commit is not.
if ! git merge-base --is-ancestor "$SHA" "origin/main" 2>/dev/null; then
  warn "HEAD is not on origin/main — nobody else can reproduce what you are shipping."
fi

step "2/5  Isolated checkout of $SHA"
TREE=$(mktemp -d)
cleanup() { git worktree remove --force "$TREE" >/dev/null 2>&1 || true; rm -rf "$TREE"; }
trap cleanup EXIT
rm -rf "$TREE"
git worktree add -q --detach "$TREE" "$SHA"
# Symlinked, not installed: `npm ci` here would add minutes to every deploy for a
# tree that is thrown away. The models are gitignored (16 MB of binaries) and the
# build copies public/ verbatim, so a worktree without them ships a site whose
# face search 404s.
ln -s "$REPO/node_modules"          "$TREE/node_modules"
ln -s "$REPO/apps/api/node_modules" "$TREE/apps/api/node_modules" 2>/dev/null || true
ln -s "$REPO/apps/web/node_modules" "$TREE/apps/web/node_modules" 2>/dev/null || true
[ -d "$REPO/apps/web/public/models" ] && ln -s "$REPO/apps/web/public/models" "$TREE/apps/web/public/models"
ok "built from a clean checkout, not from your working tree"

step "3/5  Typecheck and tests"
( cd "$TREE" && npm run typecheck >/dev/null ) || die "typecheck failed"
ok "typecheck"
( cd "$TREE" && npm --workspace apps/api run test >/dev/null ) || die "Worker tests failed"
ok "Worker tests (admin gate, face-box contract)"

step "4/5  Deploy"
if [ "$DO_API" = 1 ]; then
  OUT=$( cd "$TREE/apps/api" && npx wrangler deploy 2>&1 ) || { echo "$OUT"; die "Worker deploy failed"; }
  ok "Worker  $(echo "$OUT" | grep -oE 'Current Version ID: .*' || echo deployed)"
fi
if [ "$DO_WEB" = 1 ]; then
  ( cd "$TREE" && npm run build >/dev/null ) || die "frontend build failed"
  # --branch=main is required, not cosmetic: see the note at the top.
  # Deployed FROM apps/web, not from the repo root. `wrangler pages deploy` looks
  # for a `functions/` directory relative to its working directory, and this
  # project's lives at apps/web/functions — so deploying from the root uploaded
  # dist without the Pages Function, silently. Every shared album link went out
  # with the shell's generic title and no preview image, on both the custom domain
  # and pages.dev, for as long as this script has existed.
  OUT=$( cd "$TREE/apps/web" && npx wrangler pages deploy dist \
           --project-name=race-lens --branch=main 2>&1 ) || { echo "$OUT"; die "Pages deploy failed"; }
  echo "$OUT" | grep -q 'Deployment alias URL' \
    && warn "Pages reported an alias URL — check this landed on production, not a preview"
  ok "site    $(echo "$OUT" | grep -oE 'https://[a-z0-9]+\.race-lens\.pages\.dev' | head -1)"
fi

step "5/5  Verify against the live origins"
API=https://race-lens-api.jt7.workers.dev
SITE=https://racelens.runlytics.fit
curl -sf "$API/health" >/dev/null && ok "Worker /health responds" || die "Worker /health did not respond"
curl -sf "$API/api/events" >/dev/null && ok "public API answers" || die "public API did not answer"
if [ "$DO_WEB" = 1 ]; then
  LIVE=$(curl -sf "$SITE/" | grep -oE 'assets/index-[A-Za-z0-9_-]+\.js' | head -1)
  BUILT=$(basename "$(ls "$TREE"/apps/web/dist/assets/index-*.js | head -1)")
  [ "assets/$BUILT" = "$LIVE" ] \
    && ok "site is serving this build ($BUILT)" \
    || warn "site serves $LIVE but this build was $BUILT — the CDN may still be catching up"
fi

echo
echo "  Shipped ${SHA:0:9} — $SUBJECT"
