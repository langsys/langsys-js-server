#!/usr/bin/env bash
# Execute the cross-runtime conformance suite under every available runtime and require
# the identity digests to MATCH.
#
# The per-runtime pass/fail is the lesser half. The real assertion is that every runtime
# computes the SAME custom_id for the same input — a runtime-specific hash would
# fragment catalogs along a line nobody would think to look for, and would do it
# silently, since a re-keyed block renders base language and re-registers.
#
# A runtime that is not installed is reported as SKIPPED and is not counted as a pass.
# "The check did not run" and "the check passed" must not print the same.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

[ -f dist/index.mjs ] || { echo "dist/index.mjs missing — run \`npm run build\` first" >&2; exit 1; }

OUT_DIR="$(mktemp -d)"
trap 'rm -rf "$OUT_DIR"' EXIT

# Entry point each runtime executes. Imports the BUILT dist, which is what users install.
cat > "$OUT_DIR/entry.mjs" <<'ENTRY'
import { runConformance } from '../_dev_/runtime-conformance.mjs';
const mod = await import('../dist/index.mjs');
const report = await runConformance(mod);
console.log('###REPORT###' + JSON.stringify(report));
if (report.failed > 0) process.exit(1);
ENTRY
# Entry lives inside the repo so relative imports and node_modules resolution work.
cp "$OUT_DIR/entry.mjs" "$ROOT/_dev_/.runtime-entry.mjs"
trap 'rm -rf "$OUT_DIR"; rm -f "$ROOT/_dev_/.runtime-entry.mjs"' EXIT

declare -a NAMES=() DIGESTS=()
RAN=0 PASSED=0 SKIPPED=0 FAILED=0

run_one() {
    local label="$1"; shift
    if ! command -v "$1" >/dev/null 2>&1; then
        printf '  %-12s \033[33mSKIPPED\033[0m  (not installed)\n' "$label"
        SKIPPED=$((SKIPPED + 1))
        return
    fi

    local output status
    output="$("$@" 2>&1)"
    status=$?
    RAN=$((RAN + 1))

    local report
    report="$(printf '%s' "$output" | grep -o '###REPORT###.*' | sed 's/###REPORT###//')"

    if [ -z "$report" ]; then
        printf '  %-12s \033[31mFAILED\033[0m   (no report emitted)\n' "$label"
        printf '%s\n' "$output" | tail -15 | sed 's/^/               /'
        FAILED=$((FAILED + 1))
        return
    fi

    local nfailed ntotal digest rtname
    nfailed="$(printf '%s' "$report" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).failed))')"
    ntotal="$(printf '%s' "$report" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).total))')"
    digest="$(printf '%s' "$report" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).digest))')"
    rtname="$(printf '%s' "$report" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).runtime))')"

    NAMES+=("$label")
    DIGESTS+=("$digest")

    if [ "$status" -eq 0 ] && [ "$nfailed" = "0" ]; then
        printf '  %-12s \033[32mPASS\033[0m     %s checks   (%s)\n' "$label" "$ntotal" "$rtname"
        PASSED=$((PASSED + 1))
    else
        printf '  %-12s \033[31mFAILED\033[0m   %s of %s checks   (%s)\n' "$label" "$nfailed" "$ntotal" "$rtname"
        printf '%s' "$report" | node -e '
            let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
                for (const r of JSON.parse(s).results.filter(x=>!x.ok))
                    console.log(`               ${r.name}\n                 actual   ${r.actual}\n                 expected ${r.expected}`);
            })'
        FAILED=$((FAILED + 1))
    fi
}

echo "Cross-runtime conformance (dist/index.mjs)"
echo

run_one "node"    node    _dev_/.runtime-entry.mjs
run_one "deno"    deno    run --allow-read --allow-net --allow-env --unstable-node-globals _dev_/.runtime-entry.mjs
run_one "bun"     bun     _dev_/.runtime-entry.mjs
# Workers runs through its own driver: workerd cannot resolve node_modules, so the dist
# has to be bundled first, exactly as a real Workers build step does.
if [ -d node_modules/miniflare ]; then
    run_one "workers" node _dev_/runtime-conformance-workers.mjs
else
    printf '  %-12s \033[33mSKIPPED\033[0m  (miniflare not installed: npm i -D miniflare)\n' "workers"
    SKIPPED=$((SKIPPED + 1))
fi

echo

# ---------------------------------------------------------------- digest agreement
if [ "${#DIGESTS[@]}" -lt 2 ]; then
    echo -e "\033[33mINCONCLUSIVE\033[0m  only ${#DIGESTS[@]} runtime(s) produced a digest — cross-runtime identity is UNVERIFIED."
    echo "              This is not a pass. Install the missing runtimes to check it."
else
    FIRST="${DIGESTS[0]}"
    MISMATCH=0
    for i in "${!DIGESTS[@]}"; do
        if [ "${DIGESTS[$i]}" != "$FIRST" ]; then
            echo -e "\033[31mIDENTITY MISMATCH\033[0m  ${NAMES[$i]} disagrees with ${NAMES[0]}"
            echo "  ${NAMES[0]}: $FIRST"
            echo "  ${NAMES[$i]}: ${DIGESTS[$i]}"
            MISMATCH=1
        fi
    done
    if [ "$MISMATCH" -eq 0 ]; then
        # Positive evidence, with the count, so an empty digest cannot read as agreement.
        NKEYS="$(printf '%s' "$FIRST" | tr '|' '\n' | grep -c '=' || true)"
        if [ "$NKEYS" -lt 4 ]; then
            echo -e "\033[31mFAILED\033[0m  digest has only $NKEYS entries — too few to be meaningful."
            exit 1
        fi
        echo -e "\033[32mIDENTITY AGREES\033[0m  ${#DIGESTS[@]} runtimes, $NKEYS identity values each, all identical."
    else
        exit 1
    fi
fi

echo
echo "ran $RAN, passed $PASSED, failed $FAILED, skipped $SKIPPED"
[ "$FAILED" -eq 0 ] || exit 1
