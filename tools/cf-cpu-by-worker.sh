#!/usr/bin/env bash
# Per-Worker CPU attribution for a billing period.
#
# The dashboard's Cost Breakdown card is account-wide and cannot say which
# Worker spent the money. This asks the GraphQL Analytics API instead.
#
# Needs a token with **Account Analytics: Read**. The deploy token in
# .env.deploy does NOT have it (verified 2026-08-11: "authorization denied").
# Keep the analytics token in .env.analytics, which CI never sources.
#
#   set -a; . ./.env.analytics; . ./.env.deploy; set +a
#   ./tools/cf-cpu-by-worker.sh 2026-07-30T00:00:00Z 2026-08-11T23:59:59Z
#
# NOTE ON UNITS: cpuTimeUs is MICROSECONDS, as are the cpuTimeP* quantiles.
# Billing is quoted in ms. An earlier version of this script multiplied
# requests by cpuTimeP75 and labelled the result ms, which was wrong twice
# over — off by 1000x on units, and p75 understates a fat tail by ~4x on top.
# sum.cpuTimeUs is the real total; do not go back to estimating from quantiles.
#
# NOTE ON PAGES: Pages Functions CPU is billed as Workers CPU but lives in a
# SEPARATE dataset (pagesFunctionsInvocationsAdaptiveGroups), which exposes only
# quantiles — there is no cpuTimeUs sum to ask for. Reading only the Workers
# dataset attributes ~20% of the bill and silently loses the rest. This script
# prints Pages request volume and derives Pages CPU as the residual against the
# dashboard total, which you pass in as BILLED_CPU_MS.
set -euo pipefail

START="${1:-$(date -u -v-30d +%Y-%m-%dT00:00:00Z 2>/dev/null || date -u -d '30 days ago' +%Y-%m-%dT00:00:00Z)}"
END="${2:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
: "${CF_ANALYTICS_TOKEN:?set CF_ANALYTICS_TOKEN}"
: "${CLOUDFLARE_ACCOUNT_ID:?set CLOUDFLARE_ACCOUNT_ID}"

read -r -d '' QUERY <<'GQL' || true
query($account:String!,$start:Time!,$end:Time!){
  viewer{accounts(filter:{accountTag:$account}){
    workersInvocationsAdaptive(limit:10000,filter:{datetime_geq:$start,datetime_leq:$end}){
      sum{requests errors cpuTimeUs}
      quantiles{cpuTimeP50 cpuTimeP99}
      dimensions{scriptName date}
    }
  }}
}
GQL

jq -n --arg q "$QUERY" --arg a "$CLOUDFLARE_ACCOUNT_ID" --arg s "$START" --arg e "$END" \
  '{query:$q,variables:{account:$a,start:$s,end:$e}}' \
| curl -s https://api.cloudflare.com/client/v4/graphql \
    -H "Authorization: Bearer $CF_ANALYTICS_TOKEN" \
    -H 'Content-Type: application/json' --data @- \
| jq -r '
  if .errors then ("ERROR: " + (.errors|map(.message)|join("; "))) else
  ([.data.viewer.accounts[0].workersInvocationsAdaptive[]] | . as $all
   | ($all | map(.sum.cpuTimeUs) | add) as $grand
   | $all
   | group_by(.dimensions.scriptName)
   | map({script: .[0].dimensions.scriptName,
          requests: (map(.sum.requests)|add),
          errors: (map(.sum.errors)|add),
          cpu_ms: ((map(.sum.cpuTimeUs)|add)/1000|round),
          # What one request costs on average — the number that says whether a
          # Worker is expensive per call or merely popular.
          mean_ms: (((map(.sum.cpuTimeUs)|add) / (map(.sum.requests)|add) / 1000)*100|round/100),
          p99_ms: ((map(.quantiles.cpuTimeP99)|max)/1000|round),
          pct: (((map(.sum.cpuTimeUs)|add) / $grand * 1000)|round/10)})
   | sort_by(-.cpu_ms)
   | (["SCRIPT","REQUESTS","ERRORS","CPU_MS","%","MEAN_MS","P99_MS"]|@tsv),
     (.[]|[.script,.requests,.errors,.cpu_ms,.pct,.mean_ms,.p99_ms]|@tsv),
     (["TOTAL","","",($grand/1000|round),"100",""]|@tsv))
  end' | column -t

# ---- Pages Functions -------------------------------------------------------
# Billed as Workers CPU, separate dataset, quantiles only.
echo
read -r -d '' PQ <<'GQL' || true
query($account:String!,$start:Time!,$end:Time!){
  viewer{accounts(filter:{accountTag:$account}){
    pagesFunctionsInvocationsAdaptiveGroups(limit:10000,filter:{datetime_geq:$start,datetime_leq:$end}){
      sum{requests errors}
      quantiles{cpuTimeP50 cpuTimeP99}
      dimensions{scriptName date}
    }
  }}
}
GQL

jq -n --arg q "$PQ" --arg a "$CLOUDFLARE_ACCOUNT_ID" --arg s "$START" --arg e "$END" \
  '{query:$q,variables:{account:$a,start:$s,end:$e}}' \
| curl -s https://api.cloudflare.com/client/v4/graphql \
    -H "Authorization: Bearer $CF_ANALYTICS_TOKEN" \
    -H 'Content-Type: application/json' --data @- \
| jq -r '
  if .errors then ("ERROR: " + (.errors|map(.message)|join("; "))) else
  (.data.viewer.accounts[0].pagesFunctionsInvocationsAdaptiveGroups
   | group_by(.dimensions.scriptName)
   | map({script: .[0].dimensions.scriptName,
          requests: (map(.sum.requests)|add),
          errors: (map(.sum.errors)|add),
          # Median-based floor. The true mean is higher whenever p99 >> p50.
          floor_ms: (((map(.sum.requests * .quantiles.cpuTimeP50)|add))/1000|round),
          p50_ms: ((map(.quantiles.cpuTimeP50)|max)/1000|round),
          p99_ms: ((map(.quantiles.cpuTimeP99)|max)/1000|round)})
   | sort_by(-.floor_ms)
   | (["PAGES_PROJECT","REQUESTS","ERRORS","CPU_MS_FLOOR","P50_MS","P99_MS"]|@tsv),
     (.[]|[.script,.requests,.errors,.floor_ms,.p50_ms,.p99_ms]|@tsv))
  end' | column -t
