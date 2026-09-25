import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLangsysServer, t, readLegacyKeyFiles, type LegacyKeyFile } from '../src/index.js';

/**
 * The MIG family on the server's `t()`, driven by the core's `mig-vectors.json` (blob
 * `20f2bdd678cb33981e3064e42d43ca62783920ad`, core `a639ae8c`). The resolver and converter are the core's, from
 * `/pure`; these tests prove this package's `t()` reaches them and registers the same phrases the
 * browser core does. Rows outside the JS format set (`core_formats.js`) are not run, except as
 * refusals.
 */
const VECTORS = new URL('../node_modules/langsys-js-typescript/tests/fixtures/mig-vectors.json', import.meta.url);
const VECTORS_BLOB = '20f2bdd678cb33981e3064e42d43ca62783920ad';
const v = JSON.parse(readFileSync(VECTORS, 'utf8'));
const JS: string[] = v.core_formats.js;
const JS_ENTRY_POINTS: string[] = v.core_entry_points.js;
const inJsSet = (format: string | null | undefined) => format === null || format === undefined || JS.includes(format);

type Item = { type: string; phrase?: string; category?: string };
const server = (legacyKeys?: LegacyKeyFile[], debug = false) => {
    const registered: Item[] = [];
    const langsys = createLangsysServer({
        projectId: 'p',
        apiKey: 'k',
        baseLocale: 'en',
        debug,
        flushOnExit: false,
        ...(legacyKeys ? { legacyKeys } : {}),
        fetch: (async (url: string | URL, init?: RequestInit) => {
            const href = String(url);
            if (href.includes('authorize-project')) return new Response(JSON.stringify({ status: true, data: { key_type: 'write', write_enabled: true } }), { status: 200 });
            if (href.includes('translatable-items')) {
                registered.push(...JSON.parse(String(init?.body)).translatable_items);
                return new Response(JSON.stringify({ status: true }), { status: 200 });
            }
            return new Response(JSON.stringify({ status: true, write_enabled: true, data: {} }), { status: 200 });
        }) as unknown as typeof globalThis.fetch,
    });
    return { langsys, registered };
};
const settle = () => new Promise((r) => setTimeout(r, 30));
let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

it('mig-vectors.json is the blob this package is pinned to', () => {
    const raw = readFileSync(VECTORS);
    expect(createHash('sha1').update(`blob ${raw.length}\0`).update(raw).digest('hex')).toBe(VECTORS_BLOB);
    expect(JS).toEqual(['i18next', 'vue-i18n', 'plain']);
    expect([...JS_ENTRY_POINTS].sort()).toEqual(['i18next', 't', 'vue-i18n']);
});

describe('MIG-1 — the mode is explicit and off by default', () => {
    it('with nothing configured, a key-shaped argument is literal source text: no key lookup', async () => {
        const { langsys, registered } = server();
        const out = await langsys.run({ locale: 'it' }, () => t('checkout.submit'));
        await settle();
        expect(out.value).toBe('checkout.submit');
        expect(registered).toEqual([{ type: 'phrase', phrase: 'checkout.submit', category: '' }]);
    });
    it('CONTROL: with the mode on, the same call resolves the key', async () => {
        const { langsys, registered } = server([{ name: 'en.json', data: { checkout: { submit: 'Pay now' } } }]);
        const out = await langsys.run({ locale: 'it' }, () => t('checkout.submit'));
        await settle();
        expect(out.value).toBe('Pay now');
        expect(registered).toEqual([{ type: 'phrase', phrase: 'Pay now', category: 'checkout' }]);
    });
});

const resolutionRows = v.resolution.filter((r: { files: { format?: string }[] }) => r.files.every((f) => inJsSet(f.format)));
describe('MIG-2/3/5/7 — resolution rows, through this package\'s t()', () => {
    it.each(resolutionRows.map((r: { id: string }) => [r.id, r]))('%s', async (_id, r: { files: LegacyKeyFile[]; key: string; category_arg?: string; expected: null | { phrase: string; category: string | null } }) => {
        const { langsys, registered } = server(r.files);
        await langsys.run({ locale: 'it' }, () => (r.category_arg ? t(r.key, r.category_arg) : t(r.key)));
        await settle();
        const want = r.expected === null ? { phrase: r.key, category: r.category_arg ?? '' } : { phrase: r.expected.phrase, category: r.category_arg ?? r.expected.category ?? '' };
        expect(registered).toEqual([{ type: 'phrase', ...want }]);
        expect(registered.some((i) => i.phrase === r.key && r.expected !== null && r.expected.phrase !== r.key), 'MIG-3: the key string is never registered').toBe(false);
    });
});

const callRows = v.calls.filter((r: { entry_point: string }) => JS_ENTRY_POINTS.includes(r.entry_point));
describe('MIG-2 — a literal miss converts under the entry point that received it', () => {
    it.each(callRows.map((r: { id: string }) => [r.id, r]))('%s', async (_id, r: { entry_point: 't' | 'i18next' | 'vue-i18n'; text: string; params: Record<string, unknown>; expected: string }) => {
        const { langsys, registered } = server([{ name: 'en.json', data: {} }]);
        await langsys.run({ locale: 'it' }, () => (r.entry_point === 't' ? t(r.text, r.params as never) : langsys.bridge(r.entry_point)(r.text, r.params as never)));
        await settle();
        expect(registered.map((i) => i.phrase)).toEqual([r.expected]);
    });
    it('the i18next bridge and Langsys t() register one phrase for one sentence', async () => {
        const { langsys, registered } = server([{ name: 'en.json', data: {} }]);
        await langsys.run({ locale: 'it' }, () => {
            langsys.bridge('i18next')('Hello {{name}}', { name: 'Ada' });
            t('Hello {name}', { name: 'Ada' });
        });
        await settle();
        expect(registered.map((i) => i.phrase)).toEqual(['Hello {name}']);
    });
});

describe('MIG-7 — files outside this core\'s formats are refused at load, naming format and file', () => {
    it.each(v.refusals.map((r: { id: string }) => [r.id, r]))('%s', (_id, r: { file: { name: string }; format: string; hint?: string }) => {
        expect(() => server([{ name: r.file.name, format: r.format, data: {} }])).toThrow(new RegExp(r.hint ? r.hint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : r.format));
    });
    it('reads JSON files from disk for a server, and refuses a non-JSON one by name', () => {
        const dir = mkdtempSync(join(tmpdir(), 'mig-'));
        writeFileSync(join(dir, 'en.json'), JSON.stringify({ cart: { title: 'Your cart' } }));
        const files = readLegacyKeyFiles([{ path: join(dir, 'en.json') }]);
        expect(files[0]!.data).toEqual({ cart: { title: 'Your cart' } });
        expect(() => server(readLegacyKeyFiles([{ path: join(dir, 'messages.php') }]))).toThrow(/messages\.php/);
    });
});

describe('MIG-6 — drift is treated, never silent', () => {
    it('a key absent from the file registers its argument and is noted at debug', async () => {
        const { langsys, registered } = server([{ name: 'en.json', data: { a: 'A' } }], true);
        await langsys.run({ locale: 'it' }, () => t('checkout.removed'));
        await settle();
        expect(registered.map((i) => i.phrase)).toEqual(['checkout.removed']);
        const said = [...vi.mocked(console.log).mock.calls, ...warn.mock.calls].map((c) => c.join(' '));
        expect(said.some((m) => m.includes('checkout.removed') && m.includes('not a key'))).toBe(true);
    });
    it('an unrecognised value registers as written and warns at every level, once per file and key', async () => {
        const { langsys, registered } = server([{ name: 'en.json', format: 'plain', data: { cars: 'car | cars' } }]);
        await langsys.run({ locale: 'it' }, () => {
            t('cars');
            t('cars');
        });
        await settle();
        expect(registered.map((i) => i.phrase)).toEqual(['car | cars']);
        const w = warn.mock.calls.map((c) => c.join(' ')).filter((m) => m.includes('"cars"') && m.includes('en.json'));
        expect(w).toHaveLength(1);
    });
    it('a changed value is a new phrase', async () => {
        const a = server([{ name: 'en.json', data: { greet: 'Hello' } }]);
        await a.langsys.run({ locale: 'it' }, () => t('greet'));
        const b = server([{ name: 'en.json', data: { greet: 'Hello there' } }]);
        await b.langsys.run({ locale: 'it' }, () => t('greet'));
        await settle();
        expect([...a.registered, ...b.registered].map((i) => i.phrase)).toEqual(['Hello', 'Hello there']);
    });
});

const valueRows = v.value_conversion.filter((r: { format: string }) => inJsSet(r.format));
describe('MIG-4 — every value-conversion row for this core\'s formats, resolved through t()', () => {
    it.each(valueRows.map((r: { id: string }) => [r.id, r]))('%s', async (_id, r: { format: string; value: string; expected: string; recognised: boolean }) => {
        const { langsys, registered } = server([{ name: 'en.json', format: r.format, data: { k: r.value } }]);
        await langsys.run({ locale: 'it' }, () => t('k'));
        await settle();
        expect(registered.map((i) => i.phrase)).toEqual([r.recognised ? r.expected : r.value]);
    });
});

const pluralRows = v.plural_forms.filter((r: { format: string }) => r.format === 'i18next');
describe('MIG-4 — i18next suffix-paired plurals, resolved through t()', () => {
    it.each(pluralRows.map((r: { id: string }) => [r.id, r]))('%s', async (_id, r: { forms: Record<string, string>; expected: string | null; recognised: boolean }) => {
        const data = Object.fromEntries(Object.entries(r.forms).map(([cat, text]) => [`items_${cat}`, text]));
        const { langsys, registered } = server([{ name: 'en.json', format: 'i18next', data }]);
        await langsys.run({ locale: 'it' }, () => t('items'));
        await settle();
        if (r.recognised) expect(registered.map((i) => i.phrase)).toEqual([r.expected]);
        else expect(registered.map((i) => i.phrase)).not.toContain(r.expected);
    });
});

describe('MIG-8 — t() and a bridge over one resolver register the same phrase, id and category', () => {
    it('a vue-i18n plural key through t() and through the vue-i18n bridge', async () => {
        const files: LegacyKeyFile[] = [{ name: 'en.json', format: 'vue-i18n', data: { cart: { items: 'one item | {n} items' } } }];
        const { langsys, registered } = server(files);
        const out = await langsys.run({ locale: 'it' }, () => [t('cart.items', { n: 3 }), langsys.bridge('vue-i18n')('cart.items', { n: 3 })]);
        await settle();
        expect(out.value[0]).toBe(out.value[1]);
        expect(registered).toHaveLength(1);
        expect(registered[0]!.category).toBe('cart');
        expect(registered[0]!.phrase).toMatch(/^\{count, plural, =1 \{/);
    });
});
