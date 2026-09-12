#!/usr/bin/env node
/**
 * Compute the CONFORMANCE.md summary from the file's own table.
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
 * `--check` is the half that matters in CI: a summary nobody re-runs is a number that
 * rots silently, which is the failure this repo's rules are mostly about.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'CONFORMANCE.md');

const text = readFileSync(FILE, 'utf8');

/**
 * Rows look like `| GATE-1 | provisional | mock | … |`. Anchored on a rule id so the
 * header row, the separator and any prose table elsewhere in the file cannot be counted.
 */
const ROW = /^\|\s*([A-Z]{3,5}-[0-9].*?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/gm;

/**
 * Expand a cell like `HINT-1, 3–12`, `SSR-1..3` or `GRANT-1..4` into individual rule ids.
 *
 * Rows for rules that are all `n/a` for this profile are collapsed, because eleven
 * identical lines say less than one. Counting ROWS would then under-report coverage by
 * exactly the rules least likely to be noticed missing — so the count is of RULES, and
 * the row/rule split is printed so the difference is visible rather than assumed.
 */
function expand(cell) {
    const family = cell.match(/^([A-Z]{3,5})-/)?.[1];
    if (!family) return [];
    const out = [];
    for (const part of cell.replace(new RegExp(`${family}-`, 'g'), '').split(',')) {
        const range = part.trim().match(/^(\d+)\s*(?:\.\.|–|-)\s*(\d+)$/);
        if (range) {
            for (let i = Number(range[1]); i <= Number(range[2]); i++) out.push(`${family}-${i}`);
        } else {
            const single = part.trim().match(/^(\d+)/);
            if (single) out.push(`${family}-${single[1]}`);
        }
    }
    return out;
}

const rows = [];
for (const m of text.matchAll(ROW)) {
    const ids = expand(m[1]);
    if (!ids.length) continue;
    for (const id of ids) rows.push({ id, status: m[2].trim(), evidence: m[3].trim(), row: m[1] });
}
const rowCount = new Set(rows.map((r) => r.row)).size;

if (rows.length === 0) {
    console.error('No rule rows matched. The table shape changed and this script is now lying by omission.');
    process.exit(2);
}

const tally = (key) =>
    rows.reduce((acc, r) => ((acc[r[key]] = (acc[r[key]] ?? 0) + 1), acc), /** @type {Record<string, number>} */ ({}));

const byStatus = tally('status');
const byEvidence = tally('evidence');
const families = new Set(rows.map((r) => r.id.split('-')[0]));

// Rows this lane actually owes an answer for, as opposed to rows that are someone else's
// profile. The distinction is the whole point of a profiled spec: `n/a` is not a pass and
// it is not a gap, it is a statement that the rule cannot bind here.
const binding = rows.filter((r) => !r.status.startsWith('n/a'));

const lines = [
    `${rows.length} rules across ${families.size} families, in ${rowCount} table rows`,
    `${binding.length} bind this profile · ${rows.length - binding.length} are n/a for it`,
    '',
    'By status:',
    ...Object.entries(byStatus)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `  ${String(v).padStart(3)}  ${k}`),
    '',
    'By evidence grade (CONF-2):',
    ...Object.entries(byEvidence)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `  ${String(v).padStart(3)}  ${k}`),
];

const summary = lines.join('\n');

if (process.argv.includes('--check')) {
    // The file stores the summary between markers so this can be verified rather than
    // trusted. A mismatch is a real failure: it means rows moved and the headline did not.
    const stored = text.match(/<!-- SUMMARY:START -->\n```\n([\s\S]*?)\n```\n<!-- SUMMARY:END -->/);
    if (!stored) {
        console.error('No SUMMARY block found in CONFORMANCE.md. Add the markers or drop --check.');
        process.exit(2);
    }
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
