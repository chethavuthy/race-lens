#!/usr/bin/env bash
# Finish the parts wrangler's OAuth token cannot do.
#
# wrangler login grants zone:read but neither DNS:Edit nor Access:Edit, so the
# last three steps need a real API token:
#   1. CNAME records for the two custom hostnames
#   2. A Cloudflare Access application + policy over /admin and /api/admin
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
  for H in "${HOSTS[@]}"; do
    for P in admin api/admin; do
      DOM="$H/$P"
      HAVE=$(echo "$APPS" | jqf "(j.result||[]).some(a=>a.domain==='$DOM')")
      if [ "$HAVE" = "true" ]; then ok "app exists: $DOM"; continue; fi
      APP=$(curl -s -X POST "${auth[@]}" "$API/accounts/$ACC/access/apps" --data "{
        \"name\":\"Race Lens admin ($DOM)\",\"domain\":\"$DOM\",
        \"type\":\"self_hosted\",\"session_duration\":\"24h\",
        \"allowed_idps\":[],\"auto_redirect_to_identity\":false}")
      AID=$(echo "$APP" | jqf 'j.result&&j.result.id')
      if [ -z "$AID" ]; then
        warn "$DOM: $(echo "$APP" | jqf '(j.errors||[]).map(e=>e.code+" "+e.message).join("; ")')"
        continue
      fi
      POL=$(curl -s -X POST "${auth[@]}" "$API/accounts/$ACC/access/apps/$AID/policies" --data "{
        \"name\":\"Allow owner\",\"decision\":\"allow\",\"precedence\":1,
        \"include\":[{\"email\":{\"email\":\"$EMAIL\"}}]}")
      [ "$(echo "$POL" | jqf 'j.success')" = "true" ] \
        && ok "$DOM protected, allow $EMAIL" \
        || warn "$DOM app created but policy failed: $(echo "$POL" | jqf '(j.errors||[]).map(e=>e.code+" "+e.message).join("; ")')"
    done
  done
fi

echo; echo "${DIM}──${OFF} verify (DNS and certificates can take a few minutes)"
for H in "${HOSTS[@]}"; do
  C=$(curl -s -o /dev/null -w "%{http_code}" --max-time 20 "https://$H/" 2>/dev/null || echo 000)
  A=$(curl -s -o /dev/null -w "%{http_code}" --max-time 20 "https://$H/api/admin/events" 2>/dev/null || echo 000)
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
done
echo
