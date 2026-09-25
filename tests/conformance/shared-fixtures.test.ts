/**
 * The two cross-SDK identity fixtures, asserted in place and cited by blob.
 *
 * Neither is authored here and neither is copied here. `custom-id-reference.json` is
 * `langsys-php-sdk`'s and is the contract CID-1 names; `canonicalization-reference.json`
 * is the TypeScript core's and covers the TOK batch. Both are consumed from the lane that
 * owns them, because two documents describing one contract drift silently and the drift
 * is discovered by a customer.
 *
 * **Expectations are never recomputed from this package's own functions.** A fixture
 * whose expected values are derived by the same formula as the implementation agrees with
 * it perfectly and proves nothing.
 *
 * **Every read is guarded by `existsSync` before it happens.** A first version of this
 * file put a bare `readFileSync` at describe level under `describe.skipIf(present)`.
 * Vitest executes describe bodies during COLLECTION regardless of the skip, so a missing
 * sibling crashed the whole file — taking unrelated tests down with it — and the "fails
 * loudly" branch never ran at all. It was loud by accident, which is the same class of
 * defect as silent: the signal did not come from the check that claimed to produce it.
 *
 * The presence checks are therefore executed `it`s rather than skipped describes, and the
 * rows are read once at module level behind the guard, which is what lets the per-row
 * `it.each` exist at all — vitest needs the list before it can build the tests.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { createLangsysServer, generateCustomId, t, tokenizeHtml } from '../../src/index.js';

/**
 * `langsys-php-sdk`, via a sibling checkout. Note the directory is `langsys-php-sdk`;
 * the spec and this repo's prose both call the project `langsys-php`, and the two are the
 * same thing.
 *
 * Pinned provenance: blob `633a09d9e1abd81bb1b77a7d861ff9328d734a48`, last written by
 * `65c2221` ("Write invisible characters as escapes, and retire a gate that had come
 * true"). Was `60dc9b33` at `8862841`; thirteen rows both times.
 */
const PHP_FIXTURE = new URL(
    '../../../langsys-php-sdk/tests/fixtures/custom-id-reference.json',
    import.meta.url,
);
const PHP_FIXTURE_BLOB = '633a09d9e1abd81bb1b77a7d861ff9328d734a48';

/**
 * The core's, reached through the same `node_modules` symlink the walker-parity suite uses,
 * and pinned by blob: `cae284dfd6d291ab7f95b2f620f0c0b189362829` (core `2d57cdd9`), 32 rows measured
 * against spec blob `33bbc409`. The blob, the spec blob and the row count are each asserted, and every row
 * is asserted on its own.
 */
const CORE_FIXTURE = new URL(
    '../../node_modules/langsys-js-typescript/tests/fixtures/canonicalization-reference.json',
    import.meta.url,
);
const CORE_FIXTURE_BLOB = 'cae284dfd6d291ab7f95b2f620f0c0b189362829';
/** The spec blob the core measured its rows against. */
const CORE_FIXTURE_SPEC_BLOB = '33bbc4095ef2d13a55926b71045a7094f6b9706a';

const phpPresent = existsSync(PHP_FIXTURE);
const corePresent = existsSync(CORE_FIXTURE);

interface PhpRow {
    category: string | null;
    tokens: string[];
    canonical_json: string;
    custom_id: string;
    serialized_hex: string;
}

interface CoreFixture {
    cases: { id: string; html: string; category?: string; expected_tokens: string[]; expected_custom_id: string }[];
    spec_blob?: string;
}

/**
 * Read once, at module level, but GUARDED by `existsSync` so a missing sibling yields an
 * empty list instead of throwing during collection. That guard is what makes per-row
 * `it.each` safe here — the rows have to exist before vitest builds the test list, and an
 * unguarded read at this point is exactly what crashed an earlier version of this file.
 */
const phpRows: PhpRow[] = phpPresent ? (JSON.parse(readFileSync(PHP_FIXTURE, 'utf8')) as PhpRow[]) : [];
const coreFixture: CoreFixture = corePresent
    ? (JSON.parse(readFileSync(CORE_FIXTURE, 'utf8')) as CoreFixture)
    : { cases: [] };

// ---------------------------------------------------------------------------
describe('the sibling fixtures are present', () => {
    // Executed `it`s, not skipped describes. A missing fixture must produce a NAMED
    // failure from a test that ran, not a collection crash and not a green run with two
    // fewer suites in it.
    it('langsys-php-sdk custom-id-reference.json is checked out', () => {
        expect(
            phpPresent,
            `Expected ${PHP_FIXTURE.pathname}. The CID-1 contract lives in langsys-php-sdk and is ` +
                'asserted in place; check the sibling out rather than copying the file here.',
        ).toBe(true);
    });

    it('the core canonicalization-reference.json is reachable through node_modules', () => {
        expect(
            corePresent,
            `Expected ${CORE_FIXTURE.pathname}. It is reached through the same symlink as the ` +
                'core itself; if that is gone, the parity suite is not running.',
        ).toBe(true);
    });
});

// ---------------------------------------------------------------------------
describe.skipIf(!phpPresent)('langsys-php custom-id-reference.json', () => {
    it('is the blob this package is pinned to', () => {
        // Content-addressed, so this is the fixture's identity rather than its path. A
        // sibling checkout on a different branch is the ordinary way this goes wrong, and
        // it presents as mysterious row failures rather than as "wrong file".
        const { createHash } = require('node:crypto') as typeof import('node:crypto');
        const raw = readFileSync(PHP_FIXTURE);
        const blob = createHash('sha1')
            .update(`blob ${raw.length}\0`)
            .update(raw)
            .digest('hex');
        expect(blob).toBe(PHP_FIXTURE_BLOB);
    });

    it('has the thirteen rows the contract names', () => {
        expect(phpRows).toHaveLength(13);
    });

    // Per row, so every disagreement is reported. A single loop stops at the first
    // failure and reports one row when five may have moved.
    it.each(phpRows.map((r, i) => [i, r] as const))('row %i agrees on all three columns', (_i, row) => {
        const category = row.category ?? '';
        const json = JSON.stringify([category, row.tokens]);

        // Asserted SEPARATELY. The hash agreeing while the bytes differ is impossible,
        // but the reverse is not: a serialization change that happened to collide would
        // pass an id-only check.
        expect(json).toBe(row.canonical_json);
        expect(Buffer.from(json, 'utf8').toString('hex')).toBe(row.serialized_hex);
        expect(generateCustomId(category, row.tokens)).toBe(row.custom_id);
    });

    it('NEGATIVE CONTROL: a mutated category moves the hash', () => {
        expect(generateCustomId('WRONG', phpRows[0].tokens)).not.toBe(phpRows[0].custom_id);
    });
});

// ---------------------------------------------------------------------------
describe.skipIf(!corePresent)('langsys-js-typescript canonicalization-reference.json', () => {
    it('was measured against the spec blob this package rowed against', () => {
        // The fixture records which spec revision its expectations encode. If the core
        // re-measures against a later blob, this fails rather than silently asserting
        // superseded expectations.
        expect(coreFixture.spec_blob ?? '').toContain(CORE_FIXTURE_SPEC_BLOB);
    });

    it('is the blob this package is pinned to, with the thirty-two rows the core authored', () => {
        const { createHash } = require('node:crypto') as typeof import('node:crypto');
        const raw = readFileSync(CORE_FIXTURE);
        expect(createHash('sha1').update(`blob ${raw.length}\0`).update(raw).digest('hex')).toBe(CORE_FIXTURE_BLOB);
        expect(coreFixture.cases).toHaveLength(32);
    });

    it.each(coreFixture.cases.map((c) => [c.id, c] as const))('%s', (_id, row) => {
        const tokens = tokenizeHtml(row.html);
        expect(tokens).toEqual(row.expected_tokens);
        expect(generateCustomId(row.category ?? '', tokens)).toBe(row.expected_custom_id);
    });

    it('NEGATIVE CONTROL: the corpus can disagree', () => {
        const row = coreFixture.cases[0];
        expect(tokenizeHtml(`<p>definitely not ${row.html}</p>`)).not.toEqual(row.expected_tokens);
    });
});

// ---------------------------------------------------------------------------
/**
 * `langsys-php-sdk`'s `interpolation-reference.json`, driven through THIS package's `t()`.
 *
 * The core asserts these rows against its own `interpolate`, which proves the function. It
 * does not prove the path a server SDK takes into it — and that path is where two sibling
 * server cores broke with a correct renderer underneath. So each row renders through
 * `run()` + `t()` in its own locale, exactly as an integrator's call would.
 *
 * Pinned by blob: `017bffdd1d83a1b0a00a91f0d157a7fff726ee90`, 25 rows, the same blob the core
 * vendors. Rows that omit `params` are calls with no argument at all (ICU-1); the last two are
 * ICU-6's formatter-failure vectors.
 */
const PHP_INTERPOLATION_FIXTURE = new URL(
    '../../../langsys-php-sdk/tests/fixtures/interpolation-reference.json',
    import.meta.url,
);
const PHP_INTERPOLATION_FIXTURE_BLOB = '017bffdd1d83a1b0a00a91f0d157a7fff726ee90';
const interpolationPresent = existsSync(PHP_INTERPOLATION_FIXTURE);

interface InterpolationRow {
    description: string;
    template: string;
    /** Absent on the no-params rows: the call carries no argument at all. */
    params?: Record<string, unknown>;
    locale: string;
    expected: string;
}
const interpolationRows: InterpolationRow[] = interpolationPresent
    ? (JSON.parse(readFileSync(PHP_INTERPOLATION_FIXTURE, 'utf8')) as InterpolationRow[])
    : [];

describe('langsys-php-sdk interpolation-reference.json, through this package\'s t()', () => {
    beforeEach(() => {
        // Rows that supply a param the template does not use trip the unmatched-param
        // warning, which is correct and not what these rows assert.
        vi.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('is checked out, and is the blob this package is pinned to', () => {
        expect(interpolationPresent, `Expected ${PHP_INTERPOLATION_FIXTURE.pathname}.`).toBe(true);
        const { createHash } = require('node:crypto') as typeof import('node:crypto');
        const raw = readFileSync(PHP_INTERPOLATION_FIXTURE);
        const blob = createHash('sha1').update(`blob ${raw.length}\0`).update(raw).digest('hex');
        expect(blob).toBe(PHP_INTERPOLATION_FIXTURE_BLOB);
        expect(interpolationRows).toHaveLength(25);
    });

    it.each(interpolationRows.map((r) => [r.description, r] as const))('%s', async (_d, row) => {
        const langsys = createLangsysServer({
            projectId: 'p',
            apiKey: 'k',
            // The row's locale as the BASE locale, so no catalog is fetched and `t()` renders
            // the template itself, interpolated in that locale.
            baseLocale: row.locale,
            harvest: false,
            fetch: (async () =>
                new Response(JSON.stringify({ status: true, data: { key_type: 'read' } }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                })) as unknown as typeof globalThis.fetch,
        });
        // A row with no `params` key is a call with NO argument — not `undefined`, not `{}` —
        // because that call shape is exactly what those rows exist to cover.
        const noParams = !('params' in row);
        const rendered = await langsys.run({ locale: row.locale }, () =>
            noParams ? t(row.template) : t(row.template, row.params as never),
        );
        expect(rendered.value).toBe(row.expected);
    });
});
