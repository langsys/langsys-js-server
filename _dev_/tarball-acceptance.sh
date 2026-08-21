#!/usr/bin/env bash
#
# Run the acceptance smoke against the PACKED TARBALL rather than the working tree.
#
# > The artifact under test must be the artifact that ships.
#
# This repo has already been bitten by the inverse: the e2e suite drove a SvelteKit bundle
# that had inlined `dist/` at ITS last build, so neutering `t()` left all twelve tests
# green. A stale or partial artifact does not error — it passes, about something that is
# not what users get.
#
# What only this check can see:
#   - a path missing from package.json `files`
#   - a runtime dependency declared only in devDependencies
#   - an `exports` condition pointing at a file that is not shipped
#   - the CJS entry point, which nothing else in the suite ever requires
#
# Exit status is the smoke's. Prove it can FAIL before trusting a pass:
#   drop "dist" from `files`, re-run, and this must go red.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# SKIP_BUILD=1 packs whatever `dist/` is already on disk. That is how the manifest and
# the artifact are made to disagree, which is the only way the externals check below can
# be shown to fail — tsup re-derives externals from `dependencies` on every build, so a
# run that always rebuilds can never produce the skew it is looking for.
if [ "${SKIP_BUILD:-0}" = "1" ]; then
    echo "==> SKIP_BUILD=1 — packing the existing dist/"
    [ -d "$REPO/dist" ] || { echo "FAIL: SKIP_BUILD=1 but there is no dist/ to pack"; exit 1; }
else
    echo "==> building"
    (cd "$REPO" && npm run build >/dev/null)
fi

echo "==> packing"
cd "$WORK"
TARBALL="$(cd "$REPO" && npm pack --pack-destination "$WORK" --silent | tail -1)"
[ -f "$WORK/$TARBALL" ] || { echo "FAIL: npm pack produced no tarball"; exit 1; }
echo "    $TARBALL"

echo "==> tarball contents"
tar -tzf "$WORK/$TARBALL" | sed 's/^/    /'

# The entry points named in package.json must actually be inside the tarball. Checked
# against the manifest rather than assumed, because `files` and `exports` are edited
# independently and nothing else cross-checks them.
echo "==> entry points present in the tarball"
LISTING="$WORK/listing.txt"
tar -tzf "$WORK/$TARBALL" > "$LISTING"
for field in main module types; do
    path="$(node -p "require('$REPO/package.json').$field || ''")"
    [ -n "$path" ] || continue
    if grep -qx "package/$path" "$LISTING"; then
        echo "    ok   $field -> $path"
    else
        echo "    FAIL $field -> $path is NOT in the tarball"
        exit 1
    fi
done
for cond in types import require; do
    path="$(node -p "(require('$REPO/package.json').exports?.['.']?.['$cond'] || '').replace(/^\.\//,'')")"
    [ -n "$path" ] || continue
    if grep -qx "package/$path" "$LISTING"; then
        echo "    ok   exports.$cond -> $path"
    else
        echo "    FAIL exports.$cond -> $path is NOT in the tarball"
        exit 1
    fi
done

# Compare the shipped bundle's imports against the shipped manifest. Both come out of the
# same tarball, so this fails exactly when a consumer would get ERR_MODULE_NOT_FOUND.
echo "==> every external import is declared by the shipped manifest"
mkdir -p "$WORK/extract"
tar -xzf "$WORK/$TARBALL" -C "$WORK/extract"
node "$REPO/_dev_/check-externals.mjs" "$WORK/extract/package"

echo "==> installing into an empty project"
mkdir -p "$WORK/consumer"
cd "$WORK/consumer"
echo '{"name":"tarball-consumer","private":true,"type":"module","version":"1.0.0"}' > package.json
npm install "$WORK/$TARBALL" --silent --no-audit --no-fund

echo "==> ESM entry point"
cp "$REPO/_dev_/tarball-smoke.mjs" ./smoke.mjs
node ./smoke.mjs
ESM_STATUS=$?

echo "==> CJS entry point"
cat > ./smoke.cjs <<'CJS'
const ls = require('langsys-js-server');
const missing = ['createLangsysServer', 't', 'tokenizeHtml', 'generateCustomId'].filter((k) => typeof ls[k] !== 'function');
if (missing.length) {
    console.log(`  FAIL require() is missing: ${missing.join(', ')}`);
    process.exit(1);
}
const id = ls.generateCustomId('__uncategorized__', ls.tokenizeHtml('<p>Based on <b>5</b> reviews</p>'));
console.log(`  ok   require() exposes ${Object.keys(ls).length} exports`);
console.log(`  DIGEST ${id}`);
CJS
node ./smoke.cjs

echo
echo "TARBALL ACCEPTANCE PASS"
exit $ESM_STATUS
