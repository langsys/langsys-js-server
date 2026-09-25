import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ICU-6 on this package's own paths: a formatter failure renders through the SDK's branch
 * selection and warns with debug logging off.
 *
 * `intl-messageformat` renders the spec's vector natively (the shared interpolation rows
 * pass directly in `shared-fixtures`), so the fallback is proved with a FORCED failure: the
 * formatter's `format()` throws while `failure.force` is set, and parsing still works, as in
 * the real failure the rule describes. The core's `interpolate` owns the fallback; these
 * tests prove `t()` and `renderTranslateBlock` reach it. The warning assertions double as the
 * proof that the mock reached the formatter the core actually calls: with no mock in effect,
 * nothing warns.
 */

const failure = vi.hoisted(() => ({ force: false }));

vi.mock('intl-messageformat', async (importOriginal) => {
    const real = await importOriginal<typeof import('intl-messageformat')>();
    class FailingFormat extends real.IntlMessageFormat {
        constructor(...args: ConstructorParameters<typeof real.IntlMessageFormat>) {
            super(...args);
            const format = this.format;
            this.format = ((...values: Parameters<typeof format>) => {
                if (failure.force) throw new Error('FORCED_FORMATTER_FAILURE');
                return format(...values);
            }) as typeof format;
        }
    }
    return { ...real, IntlMessageFormat: FailingFormat, default: FailingFormat };
});

const { createLangsysServer, t, renderTranslateBlock } = await import('../src/index.js');

const VECTOR = 'You have {count, plural, one {{count} car} other {{count} cars}}';

const server = () =>
    createLangsysServer({
        projectId: 'p',
        apiKey: 'k',
        baseLocale: 'en',
        harvest: false,
        // debug deliberately off: the warning must fire regardless.
        fetch: (async () =>
            new Response(JSON.stringify({ status: true, data: { key_type: 'read' } }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            })) as unknown as typeof globalThis.fetch,
    });

let warn: ReturnType<typeof vi.spyOn>;
const warnings = () => warn.mock.calls.map((a: unknown[]) => a.map(String).join(' ')).filter((m: string) => m.includes('message formatter failed'));

beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
    failure.force = false;
    warn.mockRestore();
});

describe('ICU-6 through t()', () => {
    it('CONTROL: the formatter renders the vector natively, and nothing warns', async () => {
        const out = await server().run({ locale: 'en' }, () => [t(VECTOR, { count: 3 }), t(VECTOR, { count: 1 })]);
        expect(out.value).toEqual(['You have 3 cars', 'You have 1 car']);
        expect(warnings()).toEqual([]);
    });

    it('under a forced failure the same row renders through branch selection, values filled', async () => {
        failure.force = true;
        const phrase = `${VECTOR} (t forced)`;
        const out = await server().run({ locale: 'en' }, () => [t(phrase, { count: 3 }), t(phrase, { count: 1 })]);
        expect(out.value).toEqual(['You have 3 cars (t forced)', 'You have 1 car (t forced)']);
    });

    it('and warns with debug off, naming the phrase, the locale and the error, once per (template, locale)', async () => {
        failure.force = true;
        const phrase = `${VECTOR} (warn forced)`;
        await server().run({ locale: 'en' }, () => {
            t(phrase, { count: 3 });
            t(phrase, { count: 5 });
        });
        expect(warnings()).toHaveLength(1);
        expect(warnings()[0]).toContain(JSON.stringify(phrase));
        expect(warnings()[0]).toContain("'en'");
        expect(warnings()[0]).toContain('FORCED_FORMATTER_FAILURE');
    });

    it('never renders an empty string or the raw construct: an unsupplied value stays {argName}', async () => {
        failure.force = true;
        const phrase = `${VECTOR} (unsupplied)`;
        const out = await server().run({ locale: 'en' }, () => t(phrase, { other: 1 }));
        expect(out.value).toBe('You have {count} cars (unsupplied)');
    });
});

describe('ICU-6 through renderTranslateBlock', () => {
    it('a block carrying the vector, forced, renders the other branch with the gap visible', async () => {
        failure.force = true;
        const html = `<p>${VECTOR} (block)</p><p>Two</p>`;
        const out = await server().run({ locale: 'en' }, () => renderTranslateBlock(html));
        expect(out.value.html).toBe('<p>You have {count} cars (block)</p><p>Two</p>');
        expect(warnings().some((w: string) => w.includes('(block)'))).toBe(true);
    });
});
