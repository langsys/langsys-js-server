#!/usr/bin/env bash
# Prove the singleton-graph guard can actually FAIL, through this repo's own build.
#
# The guard in tests/build-output.test.ts asserts that dist/ carries no marker from
# `langsys-js-typescript`'s singleton graph. That assertion is only worth anything if a
# real import WOULD put the markers there — and every cheaper way of establishing that has
# now been wrong once:
#
#   v1  asserted no bare `from 'langsys-js-typescript'` import.
#       Could not fail: the core is a devDependency, so tsup INLINES it and there is no
#       import statement to find. Measured: 51,901 -> 116,302 bytes, zero imports.
#
#   v2  greped dist for identifiers (LangsysAppAPI, sTranslations), with a positive
#       control that those names exist in the CORE's published artifact.
#       Two holes, both found by the TS lane. Minifiers mangle internal identifiers, so a
#       fully-inlined graph can grep clean; and a control that reads the core's artifact
#       is checking THEIR build, so it is blind to anything this repo's bundler does.
#
#   v3  this. String-literal markers, which minifiers rewrite the contents of never, and a
#       control that runs THIS repo's real build config over a mutant that imports the
#       graph. Anything short of that is asserting about a pipeline it never ran.
#
# The markers are literals the graph pulls UNCONDITIONALLY through `LangsysApp` — verified
# by this script, not assumed. A marker from a corner the entry never reaches is absent for
# a reason that has nothing to do with the property being asserted, which is a pass that
# proves nothing.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ENTRY="src/index.ts"
BACKUP="$(mktemp)"
MARKERS=(
    'LangsysAppAPI Error:'
    'langsys:translations'
    'discovery/hint'
    'X-Write-Grant'
    '__langsys_probe__'
)

cleanup() {
    [ -f "$BACKUP" ] && cp "$BACKUP" "$ENTRY" && rm -f "$BACKUP"
    npm run build >/dev/null 2>&1
}
trap cleanup EXIT

cp "$ENTRY" "$BACKUP"

echo "Singleton-graph guard: proving it can fail"
echo

# --- baseline: the real bundle must be clean ---
npm run build >/dev/null 2>&1 || { echo "baseline build failed" >&2; exit 1; }
CLEAN_SIZE=$(wc -c < dist/index.mjs | tr -d ' ')
CLEAN_HITS=0
for m in "${MARKERS[@]}"; do
    n=$(grep -c -- "$m" dist/index.mjs || true)
    CLEAN_HITS=$((CLEAN_HITS + n))
done
printf '  clean bundle    %8s bytes   %d marker hits\n' "$CLEAN_SIZE" "$CLEAN_HITS"

# --- mutant: import the graph and build with the REAL config ---
python3 - "$ENTRY" <<'PY'
import sys, pathlib
p = pathlib.Path(sys.argv[1]); s = p.read_text()
anchor = "import { LangsysApi, DEFAULT_API_URL } from './api.js';"
assert anchor in s, "anchor moved; singleton-guard.sh needs updating"
p.write_text(s.replace(anchor, anchor + "\nimport { LangsysApp } from 'langsys-js-typescript';\nvoid LangsysApp;"))
PY

npm run build >/dev/null 2>&1 || { echo "mutant build failed" >&2; exit 1; }
MUTANT_SIZE=$(wc -c < dist/index.mjs | tr -d ' ')
MISSING=()
for m in "${MARKERS[@]}"; do
    n=$(grep -c -- "$m" dist/index.mjs || true)
    [ "$n" -eq 0 ] && MISSING+=("$m")
done
printf '  with the graph  %8s bytes   %d/%d markers present\n' \
    "$MUTANT_SIZE" "$(( ${#MARKERS[@]} - ${#MISSING[@]} ))" "${#MARKERS[@]}"
echo

FAIL=0

if [ "$CLEAN_HITS" -ne 0 ]; then
    echo "  FAIL  the clean bundle already carries $CLEAN_HITS marker hit(s) — the guard is asserting nothing"
    FAIL=1
fi

if [ "${#MISSING[@]}" -ne 0 ]; then
    echo "  FAIL  these markers did NOT appear even with the graph bundled:"
    for m in "${MISSING[@]}"; do echo "          $m"; done
    echo "        A marker the entry never reaches is absent for the wrong reason."
    FAIL=1
fi

if [ "$MUTANT_SIZE" -le "$CLEAN_SIZE" ]; then
    echo "  FAIL  bundling the graph did not grow the bundle — it was not actually inlined"
    FAIL=1
fi

if [ "$FAIL" -eq 0 ]; then
    echo "  PASS  every marker is absent when clean, present when the graph is bundled,"
    echo "        measured through this repo's own build config."
fi

exit $FAIL
