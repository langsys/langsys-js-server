#!/usr/bin/env node
/**
 * Compute the CONFORMANCE.md summary from the file's own table, and refuse a table that
 * is not in the canonical format.
 *
 * The summary line is the part of a conformance file most likely to be wrong, because it
 * is the part a human types from memory after editing fifty rows. Counting it from the
 * rows means it cannot disagree with them — and when it does move, the diff says which
 * row moved rather than only that a number did.
 *
 * Usage:
 *   node _dev_/conformance-summary.mjs            # print the summary
 *   node _dev_/conformance-summary.mjs --check    # exit 1 if the file's stored summary is stale
 *
 * Exit 2 means the TABLE is wrong, not the summary: a collapsed or duplicated row, an id
 * missing from or foreign to the pinned spec, a status or tier outside the vocabulary, or
 * a header citing a different spec blob than the id list below was extracted from.
 *
 * `--check` is the half that matters in CI: a summary nobody re-runs is a number that
 * rots silently, which is the failure this repo's rules are mostly about.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'CONFORMANCE.md');

const text = readFileSync(FILE, 'utf8');

const fail = (lines) => {
    for (const line of [].concat(lines)) console.error(line);
    process.exit(2);
};

/**
 * The spec blob EXPECTED_RULE_IDS was extracted from. The header must cite the same blob:
 * an id list pinned to one revision checked against a file rowed against another passes
 * whenever the two revisions happen to share ids, which is most of the time and exactly
 * when nobody looks.
 */
const PINNED_SPEC_BLOB = '33bbc4095ef2d13a55926b71045a7094f6b9706a';
const header = text.match(/^\|\s*\*\*Spec revision read\*\*\s*\|([^\n]*)$/m);
if (!header || !header[1].includes(`blob ${PINNED_SPEC_BLOB}`)) {
    fail(`The "Spec revision read" header does not cite blob ${PINNED_SPEC_BLOB}, which is the revision this script's id list was extracted from. Move both together.`);
}

/**
 * Canonical rows: `| Rule | Status | Tier | Evidence | Profile |` — the four canonical
 * columns, then Profile, which the canonical format allows as an extra column and this
 * script needs to decide which rules bind this lane. Anchored on a rule id so the header
 * row, the separator and prose tables elsewhere in the file cannot be counted.
 */
const ROW = /^\|\s*([A-Z]{3,5}-[0-9][^|]*?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*$/gm;

/**
 * One id per row. The previous shape collapsed rules that are all `n/a` for this profile
 * (`HINT-1, 3–12`, `SSR-1..3`) and expanded them here. The canonical format does not, and a
 * collapsed row is refused rather than expanded: expansion is where a range typed as
 * `3–12` silently dropped or double-counted an id, and the reader of the file should not
 * need this script to know which rules a row covers.
 */
const ID = /^[A-Z]{3,5}-\d+$/;

const STATUS = [
    /^implemented$/,
    /^provisional$/,
    /^delegated$/,
    /^partial$/,
    /^not implemented$/,
    /^held \(strip ruling\)$/,
    /^waived$/,
    /^n\/a \(profile: [^)]+\)$/,
    /^n\/a \(architecture: [^)]+\)$/,
];
const TIERS = new Set(['live', 'contract', 'mock', 'n/a (pure)', '-']);

const rows = [];
const collapsed = [];
const badVocabulary = [];
for (const m of text.matchAll(ROW)) {
    const id = m[1].trim();
    if (!ID.test(id)) {
        collapsed.push(id);
        continue;
    }
    const row = { id, status: m[2].trim(), tier: m[3].trim(), evidence: m[4].trim(), profile: m[5].trim() };
    if (!STATUS.some((re) => re.test(row.status))) badVocabulary.push(`${id}: status "${row.status}"`);
    if (!TIERS.has(row.tier)) badVocabulary.push(`${id}: tier "${row.tier}"`);
    rows.push(row);
}

if (rows.length === 0) {
    fail('No rule rows matched. The table shape changed and this script is now lying by omission.');
}
if (collapsed.length) {
    fail(['Rows naming more than one rule id — the canonical format is one id per row:', ...collapsed.map((c) => `  ${c}`)]);
}
if (badVocabulary.length) {
    fail(['Status or tier outside the canonical vocabulary:', ...badVocabulary.map((b) => `  ${b}`)]);
}

/**
 * Every rule appears exactly once.
 *
 * The count alone proves the id SET matches the spec's, not that each id appears once — a
 * duplicated row and a missing family cancel out and the total still reads 79. The review
 * that found this also found the arithmetic claim behind it was wrong (no family has seven
 * rules, so a missing one gives 71 or 73, not 72). Both are fixed by checking uniqueness
 * directly rather than inferring it from a total.
 */
const seen = new Set();
const duplicates = [];
for (const r of rows) {
    if (seen.has(r.id)) duplicates.push(r.id);
    seen.add(r.id);
}
if (duplicates.length) {
    fail(['Duplicate rule ids in CONFORMANCE.md — the totals below would be meaningless:', ...duplicates.map((d) => `  ${d}`)]);
}

/**
 * Every rule id in the spec appears, and nothing that is not a rule id does.
 *
 * Uniqueness alone never met the green definition: a DELETED row printed "78 rules" and
 * exited 0, because nothing compared the table against the spec. The expected set is
 * pinned here to PINNED_SPEC_BLOB (113 ids), so this runs in CI without a sibling checkout.
 * When the spec moves, this list and the header move in the same commit, and the header
 * check above fails if only one of them did.
 */
const EXPECTED_RULE_IDS = ["GATE-1","GATE-2","GATE-3","GATE-4","GATE-5","GATE-6","GATE-7","GATE-8","GATE-9","GATE-10","CAT-1","CAT-2","CAT-3","REG-1","REG-2","REG-3","REG-4","REG-5","REG-6","REG-7","REG-8","REG-9","REG-10","REG-11","REG-12","REG-13","HINT-1","HINT-2","HINT-3","HINT-4","HINT-5","HINT-6","HINT-7","HINT-8","HINT-9","HINT-10","HINT-11","HINT-12","HINT-13","ICU-1","ICU-2","ICU-3","ICU-4","ICU-5","ICU-6","CID-1","CID-2","CID-3","CID-4","TOK-1","TOK-2","TOK-3","TOK-4","TOK-5","TOK-6","MARK-1","MARK-2","MARK-3","MARK-4","SSR-1","SSR-2","SSR-3","SRV-1","SRV-2","SRV-3","SRV-4","SRV-5","SRV-6","MSG-1","MSG-2","MSG-3","MSG-4","MSG-5","MSG-6","MSG-7","MSG-8","MSG-9","MSG-10","MSG-11","MSG-12","MIG-1","MIG-2","MIG-3","MIG-4","MIG-5","MIG-6","MIG-7","MIG-8","MIG-9","SNAP-1","SNAP-2","SNAP-3","BIND-1","BIND-2","BIND-3","BIND-4","BIND-5","BIND-6","GRANT-1","GRANT-2","GRANT-3","GRANT-4","CACHE-1","CACHE-2","OBS-1","WIRE-1","WIRE-2","WIRE-3","WIRE-4","WIRE-5","CONF-1","CONF-2","CONF-3"];
const missing = EXPECTED_RULE_IDS.filter((id) => !seen.has(id));
const unknown = [...seen].filter((id) => !EXPECTED_RULE_IDS.includes(id));
if (missing.length || unknown.length) {
    fail([
        ...(missing.length ? [`Rule ids MISSING from CONFORMANCE.md: ${missing.join(', ')}`] : []),
        ...(unknown.length ? [`Rows for ids NOT in the pinned spec: ${unknown.join(', ')}`] : []),
    ]);
}

const countBy = (list, key) =>
    list.reduce((acc, r) => ((acc[r[key]] = (acc[r[key]] ?? 0) + 1), acc), /** @type {Record<string, number>} */ ({}));

const families = new Set(rows.map((r) => r.id.split('-')[0]));

/**
 * Rows this lane owes an answer for, decided by PROFILE — the rule's own field — not by
 * whether its status happens to start with `n/a`.
 *
 * Counting by status prefix was wrong twice over: it let a row opt itself out of the
 * denominator by how it was worded, and it mis-binned a binding rule whose status said it
 * was unfalsifiable here. A rule is this lane's if its profile is `all` or `server`;
 * everything else is someone else's and is neither a pass nor a gap.
 */
// Profiles are the spec's own text, and several are compound (`browser, server`, `server; and a
// binding for …`, `browser, binding (reading); server (producing)`). A rule binds this lane when
// its profile names `all` or `server` anywhere.
const binds = (profile) => /\b(all|server)\b/.test(profile);
const binding = rows.filter((r) => binds(r.profile));
// The first clause, before any `;` elaboration, so the tally reads as a short list.
for (const r of rows) r.profileKey = r.profile.split(';')[0].trim();

const section = (title, counts) => [
    title,
    ...Object.entries(counts)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([k, v]) => `  ${String(v).padStart(3)}  ${k}`),
];

const summary = [
    `${rows.length} rules across ${families.size} families, one row each — each id exactly once`,
    `${binding.length} bind all/server · ${rows.length - binding.length} are another profile's`,
    '',
    ...section('By profile (first clause):', countBy(rows, 'profileKey')),
    '',
    ...section('By status (binding rules only):', countBy(binding, 'status')),
    '',
    ...section('By tier, binding rules only (CONF-2):', countBy(binding, 'tier')),
].join('\n');

if (process.argv.includes('--check')) {
    // The file stores the summary between markers so this can be verified rather than
    // trusted. A mismatch is a real failure: it means rows moved and the headline did not.
    const stored = text.match(/<!-- SUMMARY:START -->\n```\n([\s\S]*?)\n```\n<!-- SUMMARY:END -->/);
    if (!stored) fail('No SUMMARY block found in CONFORMANCE.md. Add the markers or drop --check.');
    if (stored[1].trim() !== summary.trim()) {
        console.error('CONFORMANCE.md summary is STALE. Recompute:\n');
        console.error('--- stored ---\n' + stored[1]);
        console.error('\n--- computed ---\n' + summary);
        process.exit(1);
    }
    console.log('CONFORMANCE.md summary matches its rows.');
    process.exit(0);
}

console.log(summary);
