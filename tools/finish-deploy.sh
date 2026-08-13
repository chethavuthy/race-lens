#!/usr/bin/env bash
# Finish the parts wrangler's OAuth token cannot do.
#
# wrangler login grants zone:read but neither DNS:Edit nor Access:Edit, so the
# last three steps need a real API token:
#   1. CNAME records for the two custom hostnames
#   2. A Cloudflare Access application + policy over /api/admin and /admin/signin
#      (/admin itself is public — it is the invitation photographers read)
#   3. Verification that both actually work
#
#   1. https://dash.cloudflare.com/profile/api-tokens -> Create Token -> Custom
#      Zone   · DNS                        · Edit   (zone: runlytics.fit)
#      Zone   · Zone                       · Read   (zone: runlytics.fit)
#      Account· Access: Apps and Policies  · Edit
#      Account· Cloudflare Pages           · Read
#   2. Put it in .env.deploy as CLOUDFLARE_API_TOKEN=...
#   3. ./tools/finish-deploy.sh
#
# Idempotent: existing records and apps are detected and left alone.
set -euo pipefail
cd "$(dirname "$0")/.."

GRN=$'\e[32m'; YEL=$'\e[33m'; RED=$'\e[31m'; DIM=$'\e[2m'; OFF=$'\e[0m'
ok()   { echo "  ${GRN}ok${OFF}    $1"; }
warn() { echo "  ${YEL}warn${OFF}  $1"; }
die()  { echo "  ${RED}FAIL${OFF}  $1" >&2; exit 1; }

[ -f .env.deploy ] || die "No .env.deploy"
set -a; . ./.env.deploy; set +a
[ -n "${CLOUDFLARE_API_TOKEN:-}" ] || die "CLOUDFLARE_API_TOKEN is empty in .env.deploy — see the header of this script for the exact permissions."

ACC="${CLOUDFLARE_ACCOUNT_ID:?}"
EMAIL="${ADMIN_EMAIL:-vuthychetha@gmail.com}"
# Who gets in. One address is the operator; the rest are photographers who asked
# to have their album indexed, added by hand one at a time — which is why the
# /admin page invites people to message rather than offering a signup form.
#
# Only used when an Access application is CREATED. Adding a photographer to an
# app that already exists is a policy edit in the Cloudflare dashboard, which is
# deliberate: this script must never quietly rewrite who can reach the admin.
EMAILS="${ADMIN_EMAILS:-$EMAIL}"
# printf with the trailing newline, not without: `read` drops a final line that
# has none, which silently allowed only the first address in the list.
INCLUDE=$(printf '%s\n' "$EMAILS" | tr ',' '\n' | while read -r e; do
  e=$(printf '%s' "$e" | tr -d '[:space:]'); [ -n "$e" ] && printf '{"email":{"email":"%s"}},' "$e"
done)
INCLUDE="[${INCLUDE%,}]"
DOMAIN="runlytics.fit"
HOSTS=(racelens.$DOMAIN race-lens.$DOMAIN)
API=https://api.cloudflare.com/client/v4
auth=(-H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json")

jqf() { node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  let j; try{j=JSON.parse(s)}catch{console.log("");process.exit(0)}
  const f=new Function("j","return "+process.argv[1]);
  try{const v=f(j);console.log(v===undefined?"":(typeof v==="object"?JSON.stringify(v):v))}catch{console.log("")}
});' "$1"; }

echo; echo "${DIM}──${OFF} token"
curl -s "${auth[@]}" "$API/user/tokens/verify" | jqf 'j.success?"valid":JSON.stringify(j.errors)' \
  | grep -q valid && ok "token accepted" || die "token rejected — check it was copied whole"

ZONE=$(curl -s "${auth[@]}" "$API/zones?name=$DOMAIN" | jqf 'j.result&&j.result[0]&&j.result[0].id')
[ -n "$ZONE" ] || die "cannot read zone $DOMAIN — token needs Zone:Read on it"
ok "zone $DOMAIN"

echo; echo "${DIM}──${OFF} DNS"
for H in "${HOSTS[@]}"; do
  EXIST=$(curl -s "${auth[@]}" "$API/zones/$ZONE/dns_records?name=$H" | jqf 'j.result&&j.result.length?j.result[0].id:""')
  if [ -n "$EXIST" ]; then ok "$H already has a record"; continue; fi
  R=$(curl -s -X POST "${auth[@]}" "$API/zones/$ZONE/dns_records" \
      --data "{\"type\":\"CNAME\",\"name\":\"$H\",\"content\":\"race-lens.pages.dev\",\"proxied\":true}")
  [ "$(echo "$R" | jqf 'j.success')" = "true" ] \
    && ok "$H -> race-lens.pages.dev (proxied)" \
    || warn "$H: $(echo "$R" | jqf '(j.errors||[]).map(e=>e.code+" "+e.message).join("; ")')"
done

echo; echo "${DIM}──${OFF} Access"
APPS=$(curl -s "${auth[@]}" "$API/accounts/$ACC/access/apps")
if [ "$(echo "$APPS" | jqf 'j.success')" != "true" ]; then
  warn "cannot list Access apps: $(echo "$APPS" | jqf '(j.errors||[]).map(e=>e.code+" "+e.message).join("; ")')"
  warn "token is missing Account · Access: Apps and Policies · Edit"
else
  # ONE app per hostname covering BOTH gated paths.
  #
  # Separate apps per path was wrong: each Access application issues its own
  # JWT audience, so signing in at /admin produced a token /api/admin rejected.
  # The admin page then loaded, its XHR to /api/admin/events got 302'd to the
  # cross-origin Access login, and fetch() failed with a bare "Failed to fetch".
  #
  # /admin itself is deliberately NOT one of them any more. That page is now the
  # invitation a photographer reads before asking to be let in, and behind a
  # login nobody outside the list could ever read it. Nothing is exposed by
  # that: the page ships no data, and every byte it renders comes from
  # /api/admin, which stays gated. /admin/signin is gated in its place so an
  # organizer who IS on the list still has something to open to get a cookie.
  for H in "${HOSTS[@]}"; do
    DEST="[{\"type\":\"public\",\"uri\":\"$H/admin/signin\"},
           {\"type\":\"public\",\"uri\":\"$H/api/admin\"}]"
    AID=$(echo "$APPS" | jqf "((j.result||[]).find(a=>(a.destinations||[]).some(d=>d.uri==='$H/api/admin'))||{}).id")

    if [ -n "$AID" ]; then
      # Existing app: the only thing that may need changing is whether it still
      # holds the whole /admin page shut.
      SHUT=$(echo "$APPS" | jqf "(j.result||[]).some(a=>a.id==='$AID'&&(a.destinations||[]).some(d=>d.uri==='$H/admin'))")
      if [ "$SHUT" != "true" ]; then ok "Access app already correct for $H"; continue; fi
      NAME=$(echo "$APPS" | jqf "((j.result||[]).find(a=>a.id==='$AID')||{}).name")
      U=$(curl -s -X PUT "${auth[@]}" "$API/accounts/$ACC/access/apps/$AID" --data "{
        \"name\":\"$NAME\",\"type\":\"self_hosted\",\"session_duration\":\"24h\",
        \"destinations\":$DEST}")
      [ "$(echo "$U" | jqf 'j.success')" = "true" ] \
        && ok "$H/admin is now public (the invitation); /api/admin still gated" \
        || warn "$H: could not update destinations: $(echo "$U" | jqf '(j.errors||[]).map(e=>e.code+" "+e.message).join("; ")')"
      continue
    fi

    APP=$(curl -s -X POST "${auth[@]}" "$API/accounts/$ACC/access/apps" --data "{
      \"name\":\"Race Lens admin — $H\",\"type\":\"self_hosted\",\"session_duration\":\"24h\",
      \"destinations\":$DEST}")
    AID=$(echo "$APP" | jqf 'j.result&&j.result.id')
    if [ -z "$AID" ]; then
      warn "$H: $(echo "$APP" | jqf '(j.errors||[]).map(e=>e.code+" "+e.message).join("; ")')"
      continue
    fi
    POL=$(curl -s -X POST "${auth[@]}" "$API/accounts/$ACC/access/apps/$AID/policies" --data "{
      \"name\":\"Allow organizers\",\"decision\":\"allow\",\"precedence\":1,
      \"include\":$INCLUDE}")
    [ "$(echo "$POL" | jqf 'j.success')" = "true" ] \
      && ok "$H/api/admin protected, allow ${EMAILS} (one session)" \
      || warn "$H app created but policy failed"
  done
fi

echo; echo "${DIM}──${OFF} verify (DNS and certificates can take a few minutes)"
for H in "${HOSTS[@]}"; do
  C=$(curl -s -o /dev/null -w "%{http_code}" --max-time 20 "https://$H/" 2>/dev/null || echo 000)
  A=$(curl -s -o /dev/null -w "%{http_code}" --max-time 20 "https://$H/api/admin/events" 2>/dev/null || echo 000)
  # The invitation must be readable without signing in — that is the whole point
  # of taking /admin off the Access application.
  P=$(curl -s -o /dev/null -w "%{http_code}" --max-time 20 "https://$H/admin" 2>/dev/null || echo 000)
  case "$C" in
    200) ok "https://$H/ → 200" ;;
    000) warn "https://$H/ not resolving yet — recheck in a few minutes" ;;
    *)   warn "https://$H/ → $C" ;;
  esac
  case "$A" in
    302|403) ok "  /api/admin → $A (Access is gating it)" ;;
    000) : ;;
    *) warn "  /api/admin → $A (expected 302 to the Access login, or 403)" ;;
  esac
  case "$P" in
    200) ok "  /admin → 200 (the invitation is public)" ;;
    000) : ;;
    302) warn "  /admin → 302 (still behind Access — the invitation cannot be read)" ;;
    *) warn "  /admin → $P (expected 200)" ;;
  esac
done
echo
