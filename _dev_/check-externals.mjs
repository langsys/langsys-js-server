/**
 * Every external import in the SHIPPED bundle must be declared by the SHIPPED manifest.
 *
 * This is the check that catches the crash-on-first-require class. It compares two
 * independent sources taken from the same tarball — the imports esbuild actually left in
 * `dist/`, and the `dependencies` block npm will actually install — so it fails when they
 * disagree, which is precisely when a consumer gets `ERR_MODULE_NOT_FOUND`.
 *
 * ## Why the obvious check does not work
 *
 * The first version of this asserted "no devDependency appears in a consumer's
 * node_modules". That check can never fail, for a reason specific to how this package is
 * built: `tsup.config.ts` sets no `external`, so tsup derives externals from
 * `dependencies`. Demote a dependency and tsup stops externalising it and BUNDLES it
 * instead — the manifest and the artifact are re-derived together on every build, so they
 * cannot disagree, so the assertion has no way to go red. Measured, not assumed: demoting
 * `parse5` to devDependencies inlines parse5's source into `dist/index.mjs` and the
 * package keeps working.
 *
 *   > A check that produces no signal reads as a pass.
 *
 * The skew is only reachable when the manifest changes WITHOUT a rebuild — a hand-edited
 * `dependencies` block, a release script that packs a stale `dist/`, a merge that touches
 * one side. That is the real-world shape, and it is invisible from the working tree where
 * every dependency is installed.
 *
 * Verified to fail: drop `parse5` from `dependencies` after a build, pack, and install —
 * the tarball still carries `from 'parse5'` and importing it dies with
 * ERR_MODULE_NOT_FOUND. This check reports that before anyone installs it.
 *
 * Usage: node check-externals.mjs <extracted-package-dir>
 */
import fs from 'node:fs';
import path from 'node:path';
import { builtinModules } from 'node:module';

const pkgDir = process.argv[2];
if (!pkgDir) {
    console.error('usage: check-externals.mjs <extracted-package-dir>');
    process.exit(2);
}

const manifest = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
const declared = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
]);

/** `foo`, `foo/bar`, `@scope/foo`, `@scope/foo/bar` -> the installable package name. */
function packageNameOf(specifier) {
    const parts = specifier.split('/');
    return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function externalsOf(file) {
    const source = fs.readFileSync(file, 'utf8');
    const found = new Set();
    // Both quote styles: esbuild emits single quotes, but a hand-edit or a different
    // bundler version emits double. An earlier version of this matched only double
    // quotes and reported "no external imports" for a bundle that had three.
    const patterns = [
        /(?:^|[\s;}])import\s+[^'"()]*?from\s*['"]([^'"]+)['"]/g,
        /(?:^|[\s;}])import\s*['"]([^'"]+)['"]/g,
        /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
        /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
        /\bfrom\s*['"]([^'"]+)['"]/g,
    ];
    for (const re of patterns) {
        for (const [, spec] of source.matchAll(re)) {
            if (spec.startsWith('.') || spec.startsWith('/')) continue;
            found.add(spec);
        }
    }
    return found;
}

const entries = ['dist/index.mjs', 'dist/index.js']
    .map((rel) => path.join(pkgDir, rel))
    .filter((file) => fs.existsSync(file));

if (entries.length === 0) {
    console.log('    FAIL no dist entry points found to scan');
    process.exit(1);
}

let failures = 0;
let scanned = 0;

for (const file of entries) {
    const specifiers = externalsOf(file);
    scanned += specifiers.size;
    for (const spec of [...specifiers].sort()) {
        const bare = spec.replace(/^node:/, '');
        if (spec.startsWith('node:') || builtinModules.includes(bare)) {
            // Builtins are fine, but the `node:` prefix is load-bearing for Deno and
            // Workers — see tsup.config.ts. tests/build-output.test.ts owns that
            // assertion; noted here so a bare builtin is not silently blessed.
            if (!spec.startsWith('node:')) {
                console.log(`    WARN ${path.basename(file)}: builtin '${spec}' has no node: prefix`);
            }
            continue;
        }
        const name = packageNameOf(spec);
        if (declared.has(name)) {
            console.log(`    ok   ${path.basename(file)} imports '${spec}' (declared)`);
        } else {
            console.log(`    FAIL ${path.basename(file)} imports '${spec}' but '${name}' is NOT in dependencies`);
            console.log(`         a consumer installing this tarball gets ERR_MODULE_NOT_FOUND on first import`);
            failures++;
        }
    }
}

// Prove the scan ran. Zero external specifiers across two bundles means the patterns
// matched nothing, which is a broken scanner reporting a clean result.
if (scanned === 0) {
    console.log('    FAIL scanned 0 import specifiers across the shipped bundles — the scanner is broken,');
    console.log('         not the package. A bundle that imports nothing at all would still need node:async_hooks.');
    process.exit(1);
}

process.exit(failures === 0 ? 0 : 1);
