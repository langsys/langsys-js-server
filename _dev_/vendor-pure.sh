#!/usr/bin/env bash
# Re-vendor the pure functions from the PUBLISHED langsys-js-typescript artifact.
#
# SPEC.md §10 rule 1: verify against the published artifact at a pinned version, never a
# sibling working tree — which can lead the registry by several commits. (It did: at the
# time of writing the working tree was nine commits ahead of the release tag.)
#
# Usage: _dev_/vendor-pure.sh [version]
set -euo pipefail

VERSION="${1:-0.6.5}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "Fetching langsys-js-typescript@${VERSION} from npm..."
( cd "$WORK" && npm pack "langsys-js-typescript@${VERSION}" >/dev/null 2>&1 \
  && tar xzf "langsys-js-typescript-${VERSION}.tgz" )
DIST="$WORK/package/dist/index.mjs"
[ -f "$DIST" ] || { echo "FATAL: dist/index.mjs missing from the published tarball" >&2; exit 1; }

# The published dist imports `intl-messageformat` at module scope. Link this repo's
# node_modules beside it so the smoke check below can actually LOAD the artifact.
[ -d "$ROOT/node_modules" ] && ln -s "$ROOT/node_modules" "$WORK/package/node_modules"

# Resolve a declaration's line range. Fails LOUDLY if a name moved or was renamed,
# rather than silently emitting a short file — SPEC.md §10 rule 4.
range() {
    node -e '
        const fs = require("fs");
        const lines = fs.readFileSync(process.argv[1], "utf8").split("\n");
        const [from, to] = [process.argv[2], process.argv[3]];
        const start = lines.findIndex(l => l.startsWith("function " + from + "(") || l.startsWith("var " + from + " ="));
        if (start < 0) { console.error("FATAL: declaration not found in published dist: " + from); process.exit(1); }
        let end;
        if (to) {
            const s2 = lines.findIndex(l => l.startsWith("function " + to + "(") || l.startsWith("var " + to + " ="));
            if (s2 < 0) { console.error("FATAL: end declaration not found: " + to); process.exit(1); }
            if (s2 < start) { console.error("FATAL: " + to + " precedes " + from + " — the cluster is no longer contiguous"); process.exit(1); }
            end = s2;
            for (let i = s2 + 1; i < lines.length; i++) if (lines[i] === "}" || lines[i].startsWith("var ")) { end = lines[i] === "}" ? i : i - 1; break; }
        } else {
            end = start;
            for (let i = start + 1; i < lines.length; i++) if (lines[i] === "}") { end = i; break; }
            if (lines[start].startsWith("var ")) end = start;
        }
        console.log((start + 1) + "," + (end + 1));
    ' "$DIST" "$1" "${2:-}"
}

emit() { sed -n "$(range "$1" "${2:-}")p" "$DIST"; }

# Rename only the DECLARATION so the clean name is free for a typed wrapper.
# NOTE: internal helpers that are CALLED by other vendored code must NOT be renamed —
# renaming a declaration whose callers were emitted separately produces a ReferenceError
# that @ts-nocheck cannot see. The smoke check at the end is what catches that.
rename_decl() { sed "s/^function $1(/function ${1}Impl(/"; }

OUT="$ROOT/src/vendor/pure.ts"
{
cat <<HDR
/**
 * VENDORED from langsys-js-typescript@${VERSION} — do NOT edit by hand.
 * Regenerate with \`_dev_/vendor-pure.sh ${VERSION}\`.
 *
 * Extracted verbatim from the published npm artifact's \`dist/index.mjs\`, not
 * transcribed. Transcription is where silent divergence enters, and a divergent \`md5\`
 * re-keys every catalog entry this package writes.
 *
 * Why vendored rather than imported: \`langsys-js-typescript\` declares a single \`"."\`
 * export and no \`"sideEffects"\` field, and its \`src/index.ts\` reads through \`LangsysApp\`
 * at module scope — so importing ANY function from it instantiates the whole singleton
 * graph (shared catalog, shared miss queue, shared auth header) inside the server
 * process. See SPEC.md §3.1.
 *
 * The base SDK owner confirmed (2026-08-21) that a \`langsys-js-typescript/pure\` subpath
 * export is feasible but NOT promised, and advised vendoring rather than blocking on it.
 * They also identified the exact module set that is closed under these functions and
 * never reaches the singleton — \`content-block\`, \`interpolate\`, \`locale\`, \`utils\` — which
 * is what is extracted here. If the subpath ships it will export this same set, and only
 * the import line changes.
 *
 * \`tests/conformance/vendor-parity.test.ts\` asserts these produce byte-identical output
 * to the real published package over a fixture corpus. That test is why this file is
 * safe: it sources its expectations from the package, not from this code (SPEC.md §10
 * rule 2 — a check must come from a different source than the claim).
 *
 * @ts-nocheck is deliberate and scoped: the bodies below are the published artifact's
 * own JavaScript, extracted verbatim by \`sed\` rather than retyped. Two mechanical
 * changes are applied and are the ONLY ones: declarations that need their clean name
 * freed for a typed wrapper are renamed to \`...Impl\`, and \`canonicalizeLocale\`'s
 * \`if (logger.debugEnabled) logger.warn(...)\` branch is dropped (this package has no
 * module-global debug flag; the RETURN VALUE, which is all \`custom_id\` depends on, is
 * untouched). Nothing else is edited. Annotating them would mean EDITING vendored
 * code, which defeats the point of extracting it. The typed, checked surface is the
 * wrapper set at the bottom of this file — that is what the rest of the package
 * imports, and it is fully checked.
 */

// @ts-nocheck
/* eslint-disable */
// prettier-ignore-start

import { IntlMessageFormat } from 'intl-messageformat';

/**
 * Inert stand-in for the base SDK's logger singleton, which \`warnUnmatchedParams\`
 * reads. The real singleton carries process-wide \`debugEnabled\`, which is module-global
 * mutable state this package does not have. The unmatched-param warning is genuinely
 * useful, so it is NOT dropped — it is re-issued from \`translator.ts\` against the
 * REQUEST's logger, using the vendored \`findUnusedParamKeys\` below.
 */
const logger = { debugEnabled: false, warn() {}, log() {}, error() {} };

HDR

echo "/* canonicalizeLocale — dist/index.mjs:$(range canonicalizeLocale) */"
# The published version logs through the SDK's logger on the invalid-tag path. The
# fallback CASING is kept byte-identical; only the log is dropped, and this package
# warns about invalid tags itself. The RETURN VALUE is what custom_id depends on.
emit canonicalizeLocale | rename_decl canonicalizeLocale | node -e '
    let s = require("fs").readFileSync(0, "utf8");
    const before = s;
    s = s.replace(/\n\s*if \(logger\.debugEnabled\) logger\.warn\(\n(?:.*\n)*?\s*\);/m, "");
    if (s === before) { console.error("FATAL: logger.warn branch not found in canonicalizeLocale — the vendored patch is stale"); process.exit(1); }
    process.stdout.write(s);
'
echo
echo "/* interpolation cluster (isICU .. simpleInterpolate) — dist/index.mjs:$(range isICU simpleInterpolate) */"
echo "/* Contiguous in the published bundle. Includes normalizeMarkupPlaceholders,"
echo "   findUnusedParamKeys and the ICU node-type constants. */"
emit isICU simpleInterpolate \
  | rename_decl interpolate \
  | rename_decl normalizeMarkupPlaceholders \
  | rename_decl findUnusedParamKeys
echo
echo "/* toUtf8ByteString — dist/index.mjs:$(range toUtf8ByteString) */"
emit toUtf8ByteString
echo
# md5 and md5Legacy get typed wrappers, so their declarations move aside. md5Core is
# internal, has no wrapper, and MUST keep its name — both md5 and md5Legacy call it.
for fn in md5 md5Legacy; do
    echo "/* $fn — dist/index.mjs:$(range $fn) */"
    emit "$fn" | rename_decl "$fn"
    echo
done
echo "/* md5Core — dist/index.mjs:$(range md5Core) */"
emit md5Core
echo

cat <<'FTR'
// prettier-ignore-end

/* ------------------------------------------------------------------ *
 * Typed surface. Everything above is vendored verbatim and unchecked; *
 * everything below is this package's own, checked code.               *
 * ------------------------------------------------------------------ */

import type { TranslateParams } from '../types.js';

/** Normalize a locale tag to canonical BCP 47 form (`en_gb` -> `en-GB`). */
export const canonicalizeLocale: (locale: string) => string = canonicalizeLocaleImpl;

/** Rewrite `%name%` markup placeholders to `{name}` interpolation syntax. */
export const normalizeMarkupPlaceholders: (text: string) => string = normalizeMarkupPlaceholdersImpl;

/**
 * Substitute `params` into `template`, using ICU MessageFormat when the template is ICU
 * and simple `{name}` replacement otherwise.
 *
 * Omitting this step renders the literal `Hello {name}` server-side and correctly
 * client-side — a hydration mismatch on precisely the strings carrying data.
 */
export const interpolate: (template: string, params?: TranslateParams, locale?: string) => string = interpolateImpl;

/** Param keys with no matching placeholder in any of `texts`. */
export const findUnusedParamKeys: (texts: string[], params?: TranslateParams) => string[] = findUnusedParamKeysImpl;

/** MD5 over the UTF-8 bytes of `input`. The current hash. */
export const md5: (input: string) => string = md5Impl;

/**
 * MD5 over the raw UTF-16 code units of `input`. Differs from `md5` for any non-ASCII
 * input. Lookup-only — never hash a new registration with this.
 */
export const md5Legacy: (input: string) => string = md5LegacyImpl;

/**
 * The identity of a content block: `md5(JSON.stringify([category, tokens]))`.
 *
 * `JSON.stringify` rather than `tokens.join('-')` is load-bearing. The collision is a
 * property of the FINAL hashed string, so the encoding is part of the cross-SDK
 * contract, not an implementation detail: `JSON.stringify` shifts every character's
 * offset, so the same phrase pair can collide standalone and not collide here, and
 * changing `category` moves every character into different lanes.
 */
export function generateCustomId(category: string, tokens: string[]): string {
    return md5Impl(JSON.stringify([category, tokens]));
}

/**
 * Lookup-only fallback for content blocks whose id was hashed before `md5` switched to
 * hashing UTF-8 BYTES.
 *
 * **The difference is the MD5 input encoding, not the JSON encoding.** Both this and
 * `generateCustomId` hash `JSON.stringify([category, tokens])` — verified against the
 * published dist, where `generateLegacyCustomId` is `md5Legacy(JSON.stringify(...))`.
 * `md5Legacy` hashes raw UTF-16 code units, so **it differs from `md5` only for
 * non-ASCII input**, and an all-ASCII block produces the identical id under both.
 *
 * That last property is not a curiosity: it means this derivation legitimately collapses
 * onto another for ASCII content, which is why `derivations.ts` deduplicates by id rather
 * than assuming each derivation is a distinct lookup.
 *
 * NEVER register with this. Registration always uses `generateCustomId`; this exists so
 * older catalog entries can still be READ rather than silently falling back to base
 * language.
 */
export function generateLegacyCustomId(category: string, tokens: string[]): string {
    return md5LegacyImpl(JSON.stringify([category, tokens]));
}
FTR
} > "$OUT"

LINES=$(wc -l < "$OUT")
[ "$LINES" -gt 250 ] || { echo "FATAL: vendored file is only $LINES lines — extraction produced too little" >&2; exit 1; }
for needle in 'function md5Core' 'function simpleInterpolate' 'function _recoverMissingArgs' 'var ICU_PLURAL'; do
    grep -q "$needle" "$OUT" || { echo "FATAL: missing from output: $needle" >&2; exit 1; }
done

# Execute the emitted module against the real published package and require the outputs
# to MATCH. A typecheck cannot see into an @ts-nocheck block, so a green typecheck is not
# evidence — this is. SPEC.md §10 rules 3 and 4.
echo "Smoke-testing the emitted module against langsys-js-typescript@${VERSION}..."
node --experimental-strip-types --no-warnings -e '
    (async () => {
        const mine = await import(process.argv[1]);
        const theirs = await import(process.argv[2] + "/package/dist/index.mjs");
        let checked = 0;
        const eq = (what, a, b) => {
            if (a !== b) { console.error(`FATAL: ${what} mismatch\n  vendored: ${JSON.stringify(a)}\n  package:  ${JSON.stringify(b)}`); process.exit(1); }
            checked++;
        };

        for (const [cat, toks] of [
            ["", []], ["", ["Hello world"]], ["marketing", ["Based on", "5", "reviews"]],
            ["", ["Hello world"]], ["", ["e-mail", "café", "日本語"]],
        ]) {
            eq("custom_id", mine.generateCustomId(cat, toks), theirs.generateCustomId(cat, toks));
            eq("legacy custom_id", mine.generateLegacyCustomId(cat, toks), theirs.generateLegacyCustomId(cat, toks));
        }

        for (const l of ["en", "en_gb", "PT-br", "zh_Hans_CN", "not a locale"])
            eq(`canonicalizeLocale(${l})`, mine.canonicalizeLocale(l), theirs.canonicalizeLocale(l));

        for (const [t, p, l] of [
            ["Hello {name}", { name: "Bob" }, "en"],
            ["Hello %name%", { name: "Bob" }, "en"],
            ["{n, plural, one {# item} other {# items}}", { n: 1 }, "en"],
            ["{n, plural, one {# item} other {# items}}", { n: 5 }, "en"],
            ["{n, plural, one {# элемент} few {# элемента} other {# элементов}}", { n: 3 }, "ru"],
            ["No params here", undefined, "en"],
            ["Missing {arg} recovers", {}, "en"],
        ]) eq(`interpolate(${t})`, mine.interpolate(t, p, l), theirs.interpolate(t, p, l));

        // Negative controls: if any of these returned a constant, every check above
        // would also pass.
        if (mine.generateCustomId("", ["a"]) === mine.generateCustomId("", ["b"]))
            { console.error("FATAL: generateCustomId does not discriminate"); process.exit(1); }
        if (mine.interpolate("Hello {name}", { name: "A" }, "en") === mine.interpolate("Hello {name}", { name: "B" }, "en"))
            { console.error("FATAL: interpolate does not discriminate"); process.exit(1); }
        if (!/^[0-9a-f]{32}$/.test(mine.generateCustomId("", ["x"])))
            { console.error("FATAL: not an md5 hex digest"); process.exit(1); }

        console.log(`  ${checked} outputs matched the published package; negative controls discriminate.`);
    })().catch(e => { console.error("FATAL: vendored module failed to execute:", e.message); process.exit(1); });
' "$OUT" "$WORK"

echo "Wrote $OUT ($LINES lines) from langsys-js-typescript@${VERSION}"
