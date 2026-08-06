#!/usr/bin/env bash
# RetailOS invariant checker — mechanical scan for the nine invariants (I1-I9) this codebase
# depends on for correct, non-fabricated business numbers. Catches the machine-checkable subset;
# unit-conversion double-application, store-local period boundaries, consumer idempotency, and
# UI null-rendering still need human review.
# Exit 1 on any Blocking or High finding. Advisory findings report but do not fail.
#
# Usage:  verify-invariants.sh            whole repo
#         verify-invariants.sh --diff     changed files only
#
# Uses grep -E (POSIX) so it runs anywhere. If ripgrep is installed it is used instead
# (faster, respects .gitignore), but it is not required.

set -uo pipefail
cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)" || exit 1

RED=$'\033[31m'; YEL=$'\033[33m'; GRN=$'\033[32m'; DIM=$'\033[2m'; NC=$'\033[0m'
BLOCKING=0; HIGH=0; ADVISORY=0

EXCLUDES=(--exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.git
          --exclude-dir=.next --exclude-dir=coverage --exclude-dir=fixtures
          --exclude-dir=.claude --exclude-dir=.ai --exclude-dir=docs
          --exclude-dir=.turbo --exclude-dir=drizzle --exclude-dir=spikes
          --exclude='*.test.ts' --exclude='*.spec.ts' --exclude='*.type-test.ts'
          --exclude='verify-invariants.sh' --exclude='*.md' --exclude='CLAUDE.md'
          --exclude='*.tsbuildinfo')

# Scope -----------------------------------------------------------------------
DIFF_MODE=0
if [[ "${1:-}" == "--diff" ]]; then
  DIFF_MODE=1
  mapfile -t FILES < <(git diff --name-only --diff-filter=d HEAD 2>/dev/null \
                       | grep -E '\.(ts|tsx|sql)$' || true)
  if [[ ${#FILES[@]} -eq 0 ]]; then echo "No changed .ts/.tsx/.sql files."; exit 0; fi
  echo "${DIM}Scope: ${#FILES[@]} changed file(s)${NC}"
else
  echo "${DIM}Scope: whole repository${NC}"
fi

# search PATTERN [PATH_FILTER_REGEX] [INCLUDE_GLOB]
# Returns file:line:match. PATH_FILTER_REGEX (if given) EXCLUDES matching paths.
#
# Test files (*.test.ts, *.spec.ts, *.type-test.ts) are ALWAYS excluded from results, via a
# result-level grep -v rather than relying on grep's own --include/--exclude flags to compose
# correctly when both are given in the same invocation. They don't: GNU grep's documented
# behavior is that --include takes precedence for any file matching both, which silently
# re-admitted every *.test.ts file into every check that also passed an INCLUDE_GLOB (most of
# them) - discovered when a genuinely test-only Redis call in apps/api/src/trpc/routers/
# login.test.ts got flagged by the I4 cache-key rule despite *.test.ts being in the global
# EXCLUDES array the whole time. This was a real, previously-undetected defect in the scanner
# itself, not a one-off false positive to route around at the call site.
search() {
  local pattern="$1" exclude_paths="${2:-}" include="${3:-}"
  local out=""
  local inc_args=()
  [[ -n "$include" ]] && inc_args=(--include="$include")

  if (( DIFF_MODE )); then
    local existing=()
    for f in "${FILES[@]}"; do [[ -f "$f" ]] && existing+=("$f"); done
    [[ ${#existing[@]} -eq 0 ]] && return 0
    out=$(grep -nEH "$pattern" "${existing[@]}" 2>/dev/null || true)
  else
    out=$(grep -rnEH "$pattern" . "${EXCLUDES[@]}" "${inc_args[@]}" 2>/dev/null || true)
  fi

  out=$(echo "$out" | grep -Ev '\.(test|spec|type-test)\.ts:' || true)
  [[ -n "$exclude_paths" ]] && out=$(echo "$out" | grep -Ev "$exclude_paths" || true)
  echo "$out"
}

report() { # severity id title why results
  local sev="$1" id="$2" title="$3" why="$4" results="$5"
  results=$(echo "$results" | grep -v '^$' || true)
  [[ -z "$results" ]] && return 0
  local color="$YEL"
  case "$sev" in
    BLOCKING) color="$RED"; BLOCKING=$((BLOCKING+1));;
    HIGH)     color="$RED"; HIGH=$((HIGH+1));;
    ADVISORY) color="$YEL"; ADVISORY=$((ADVISORY+1));;
  esac
  printf '\n%s[%s] %s — %s%s\n' "$color" "$sev" "$id" "$title" "$NC"
  printf '%s%s%s\n' "$DIM" "$why" "$NC"
  echo "$results" | head -25 | sed 's/^/  /'
  local n; n=$(echo "$results" | wc -l | tr -d ' ')
  (( n > 25 )) && printf '  %s… %d more%s\n' "$DIM" "$((n-25))" "$NC"
}

echo "──────────────────────────────────────────────────────────────"
echo " RetailOS invariant check"
echo "──────────────────────────────────────────────────────────────"

# ── I1 — LLMs never compute ───────────────────────────────────────────────────
r=$(search '(prompt|system|instruction).*(calculate|compute|sum up|add up|total the)' \
           '' '*.ts')
report BLOCKING I1 "Prompt may instruct the model to compute" \
  "LLMs narrate; metric functions compute. Verify no arithmetic is delegated." "$r"

# ── I9 — AI has no write tools ────────────────────────────────────────────────
r=$(search '(defineTool|registerTool)\(' 'packages/ai/(evals|__)' '*.ts' \
   | grep -Ei 'insert|update|delete|create|approve|send|post|mutate|write' || true)
report BLOCKING I9 "AI tool definition contains a mutating verb" \
  "The AI drafts; humans approve. No tool may write business state." "$r"

# ── I4 — Tenant isolation ─────────────────────────────────────────────────────
# Cache calls: check the surrounding 5 lines, since the key is often built just above.
# packages/session/session-store.ts, apps/api/oauth/state-store.ts, and
# packages/session/rate-limiter.ts excluded: all three ARE the tenant-scoped-cache-key rule's
# subject matter, but their keys are `session:<256-bit-random-token>`, `user-sessions:<userId>`,
# `oauth-state:<256-bit-random-nonce>`, and `rate-limit:<scope>:<ip-or-email>` - unguessable-token-
# keyed, user-keyed, or (for the OAuth state nonce and the rate limiter specifically) not tied to
# any org at all, since both exist for the window BEFORE any identity/tenant is established. None
# are resource-keyed, so there is no cross-tenant collision surface for this rule to catch (a
# session's organizationId lives in its stored payload, not its lookup key; the OAuth state and the
# rate-limit counter have no organizationId to leak at all - an auth attempt has no tenant yet by
# definition, that's what's being resolved). Documented at the call sites too, not just here.
r=""
while IFS= read -r hit; do
  [[ -z "$hit" ]] && continue
  f="${hit%%:*}"; rest="${hit#*:}"; ln="${rest%%:*}"
  [[ -f "$f" ]] || continue
  lo=$(( ln > 5 ? ln - 5 : 1 ))
  ctx=$(sed -n "${lo},$((ln+1))p" "$f" 2>/dev/null)
  echo "$ctx" | grep -qE 'organization_?[Ii]d|orgId|tenantId|__tenant' || r+="$hit"$'\n'
done < <(search '(cacheKey|redis\.(get|set|setex)|cache\.(get|set))' 'packages/session/src/session-store\.ts|apps/api/src/oauth/state-store\.ts|packages/session/src/rate-limiter\.ts' '*.ts')
report BLOCKING I4 "Cache key may lack a tenant component" \
  "A cache hit bypasses RLS entirely — a leak with a different mechanism." "$r"

r=$(search "SET +(SESSION +)?app\.current_org_id" '' '' | grep -Ev 'SET +LOCAL' || true)
report BLOCKING I4 "Tenant context set session-scoped (must be SET LOCAL)" \
  "On a pooled connection a session variable leaks to the next request — possibly another tenant." "$r"

r=$(search '(vectorSearch|embeddingSearch|\.similaritySearch|<=>|<->)' '' '*.ts' \
   | grep -Ev 'organization_?[Ii]d|orgId|tenantId' \
   | grep -Ev ':\s*(//|\*|/\*)' || true)
report BLOCKING I4 "Vector/semantic query may lack an explicit tenant filter" \
  "Retrieval leakage is the likeliest serious failure in an AI product. Filter at query level, not only RLS." "$r"

# RLS coverage: any table whose CREATE statement declares organization_id needs a policy.
# Reads each .sql file, splits on ';', and inspects each CREATE TABLE block.
missing=""
while IFS= read -r sqlfile; do
  [[ -z "$sqlfile" ]] && continue
  while IFS= read -r stmt; do
    case "$stmt" in *CREATE\ TABLE*) ;; *) continue;; esac
    case "$stmt" in *organization_id*) ;; *) continue;; esac
    tbl=$(printf '%s' "$stmt" | grep -oiE 'CREATE TABLE( IF NOT EXISTS)? +[a-z_.]+' \
          | grep -oE '[a-z_]+$' | head -1)
    [[ -z "$tbl" ]] && continue
    if ! grep -rqiE "POLICY.*ON +(public\.)?$tbl\b" . --include='*.sql' "${EXCLUDES[@]}" 2>/dev/null; then
      missing+="$tbl — declares organization_id, no RLS policy found"$'\n'
    fi
  done < <(tr '\n' ' ' < "$sqlfile" | tr ';' '\n')
done < <(if (( DIFF_MODE )); then printf '%s\n' "${FILES[@]}" | grep '\.sql$' || true
         else grep -rl 'CREATE TABLE' . --include='*.sql' "${EXCLUDES[@]}" 2>/dev/null || true; fi)
report BLOCKING I4 "Tenant table without an RLS policy" \
  "Every table with organization_id needs ENABLE + FORCE RLS and a policy." "$missing"

# ── I2 — Metric catalog is the only read path ─────────────────────────────────
r=$(search '\b(SUM|AVG)\s*\(' 'packages/metrics/|packages/db/|\.sql:' '*.ts' || true)
report HIGH I2 "Aggregate outside the metric catalog" \
  "Business numbers come from registered metrics only, or dashboards and the AI diverge." "$r"

# ── I3 — Ledger is append-only ────────────────────────────────────────────────
r=$(search '(UPDATE|DELETE +FROM) +(stock_movements|audit_logs|sales_transactions|outbox_events)' '' '')
report HIGH I3 "Mutation of an append-only table" \
  "Corrections are compensating rows, never edits. Destroys auditability and shrinkage math." "$r"

# ── I5 — Money/quantity typing ────────────────────────────────────────────────
# csv-import.ts (both apps/api/src/integrations and packages/db/src/repositories) excluded:
# totalRowCount/importedRowCount/quarantinedRowCount/skippedRowCount are ROW COUNTS from a CSV
# import (how many rows were parsed/written/quarantined/skipped), not a money or quantity value -
# the regex matches on "Total" as a substring regardless of what it's counting. No arithmetic on
# money or quantity happens through these fields anywhere; they never feed a Money/Quantity<Unit>
# calculation, only a UI/API result summary.
#
# margin.ts excluded for the same reason: `unknownCostEventCount` COUNTS waste/consumption events
# whose cost is unknown - it is an integer event count, never a monetary value, and no arithmetic
# on money flows through it. "Cost" is the only accurate word for what is being counted (events
# with an unknown COST), so renaming to dodge the regex would make the field less clear rather
# than more correct. Every genuine money value in that file is a real `Money`.
r=$(search '[A-Za-z_]*([Pp]rice|[Cc]ost|[Aa]mount|[Tt]otal|[Rr]evenue|[Mm]argin|[Qq]uantity|[Qq]ty)[A-Za-z_]*[[:space:]]*:[[:space:]]*number\b' 'apps/api/src/integrations/csv-import\.ts|packages/db/src/repositories/csv-import-repository\.ts|packages/metrics/src/margin/margin\.ts' '*.ts')
report HIGH I5 "Money or quantity typed as \`number\`" \
  "Float arithmetic on money loses precision silently. Use Money / Quantity<Unit>." "$r"

r=$(search '(price|cost|amount|total|revenue|quantity)[a-z_]*\s+(float|double|real)' '' '*.sql')
report HIGH I5 "Float column in a monetary/quantity path" \
  "Money is NUMERIC(19,4); quantity NUMERIC(19,6)." "$r"

# ── I7 — Degrade to unknown, never zero ───────────────────────────────────────
# reconciliation.ts excluded: its COALESCE(SUM(...), 0)/COALESCE(MAX(...), 0) are a FULL OUTER
# JOIN's standard SQL idiom for "this side of the join has zero matching rows," not an
# application-layer default masking an unknown cost/quantity - SUM() over a real non-empty group
# is never NULL, so the COALESCE only ever fires on a genuine zero-row side, not a missing value.
# expiry-queue.ts excluded: its COALESCE(c.avg_daily_consumption, 0) is the same LEFT JOIN idiom -
# a lot with zero SALE_CONSUMPTION rows in the trailing-30-day window genuinely has no matching
# row on the join's other side. The zero is never fed into value_at_risk (computed straight from
# lots.remaining_quantity * lots.unit_cost, untouched by this COALESCE) - it only decides at-risk
# classification, and per I7 a zero-consumption lot is treated as AT RISK (consumption_cover_days
# stays NULL, never a fabricated number), the opposite of the "looks safe" failure this check guards.
r=$(search '(\?\?|\|\|)[[:space:]]*0\b|COALESCE\([^,]+,[[:space:]]*0\)' 'format|display|/ui/|reconciliation\.ts|expiry-queue\.ts' '' \
   | grep -Ei 'cost|price|margin|revenue|cogs|consumption|qty|quantity|yield' || true)
report HIGH I7 "Null-to-zero coercion in a costing path" \
  "\`?? 0\` looks defensive; in costing it silently inflates margin to 100%. Degrade to unknown." "$r"

# ── I8 — Transactional outbox ─────────────────────────────────────────────────
r=$(search '(await[[:space:]]+)?(publish|emit|enqueue)\(' '' '*.ts' \
   | grep -Ev 'outbox|Outbox' || true)
report HIGH I8 "Event publication not via the outbox" \
  "Commit succeeds, publish fails, nothing looks broken. Write the outbox row inside the transaction." "$r"

# ── Advisory — architectural boundaries ───────────────────────────────────────
r=$(search "from ['\"]@?(anthropic|openai|cohere|@anthropic-ai)" 'packages/ai/' '*.ts')
report ADVISORY ARCH "Model provider SDK imported outside packages/ai" \
  "All model calls go through the provider interface, or swapping providers touches business logic." "$r"

r=$(search "from ['\"].*packages/(domain|metrics|db)/src/[a-z]" '' '*.ts' | grep -v '/index' || true)
report ADVISORY ARCH "Import of module internals rather than its public interface" \
  "Boundaries keep the monolith modular and extractable." "$r"

r=$(search '(OFFSET[[:space:]]+\$?[0-9]|\.offset\()' '' '*.ts')
report ADVISORY PERF "OFFSET pagination" \
  "OFFSET degrades linearly with tenant data volume. Use keyset pagination." "$r"

r=$(search 'CREATE INDEX' '' '*.sql' | grep -v 'CONCURRENTLY' || true)
report ADVISORY MIGRATION "CREATE INDEX without CONCURRENTLY" \
  "Takes ACCESS EXCLUSIVE on a populated table — a direct outage." "$r"

# ── Summary ───────────────────────────────────────────────────────────────────
echo
echo "──────────────────────────────────────────────────────────────"
if (( BLOCKING == 0 && HIGH == 0 && ADVISORY == 0 )); then
  printf '%s No mechanical violations found.%s\n' "$GRN" "$NC"
else
  printf ' Blocking: %d   High: %d   Advisory: %d\n' "$BLOCKING" "$HIGH" "$ADVISORY"
fi
printf '%s Mechanical checks only. Unit-conversion double-application, store-local period\n' "$DIM"
printf ' boundaries, consumer idempotency, and UI null-rendering still need reading.%s\n' "$NC"
echo "──────────────────────────────────────────────────────────────"

(( BLOCKING > 0 || HIGH > 0 )) && exit 1
exit 0
