import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import {
    createLangsysServer,
    checkTemplate,
    fillTemplate,
    resolveServerMessages,
    templateMarkers,
    DEFAULT_SERVER_MESSAGE_CATEGORY,
    SERVER_MESSAGE_CODES,
} from '../src/index.js';

/**
 * The MSG family on the server profile. The shared `server-message-vectors.json` is the core's,
 * vendored by blob `c8125549cfee0f5286f79a8cbc194cd30ccd446e` and read through the core's
 * checkout; its `render` rows are the client's (MSG-5) and are not rowed here.
 */
const VECTORS = new URL('../node_modules/langsys-js-typescript/tests/fixtures/server-message-vectors.json', import.meta.url);
const VECTORS_BLOB = 'c8125549cfee0f5286f79a8cbc194cd30ccd446e';
const v = existsSync(VECTORS) ? JSON.parse(readFileSync(VECTORS, 'utf8')) : { markers: [], fill: [], resolve: [], canonical_entries: [] };

describe('server-message-vectors.json', () => {
    it('is the blob this package is pinned to', () => {
        const raw = readFileSync(VECTORS);
        expect(createHash('sha1').update(`blob ${raw.length}\0`).update(raw).digest('hex')).toBe(VECTORS_BLOB);
    });
    it.each(v.markers.map((r: { id: string }) => [r.id, r]))('markers: %s', (_id, r: { template: string; expected: string[] }) => {
        expect(templateMarkers(r.template)).toEqual(r.expected);
    });
    it.each(v.fill.map((r: { id: string }) => [r.id, r]))('fill: %s', (_id, r: { template: string; params: Record<string, unknown>; expected: string }) => {
        expect(fillTemplate(r.template, r.params)).toBe(r.expected);
    });
    it.each(v.resolve.map((r: { id: string }) => [r.id, r]))('resolve: %s', (_id, r: { body: unknown; key?: string; expected: unknown[] }) => {
        expect(resolveServerMessages(r.body, r.key ? { key: r.key } : {})).toEqual(r.expected);
    });
});

const server = (catalog: Record<string, unknown> = {}, keyType = 'write', writeEnabled?: boolean) => {
    const registered: { type: string; phrase?: string; category?: string }[] = [];
    const langsys = createLangsysServer({
        projectId: 'p',
        apiKey: 'k',
        baseLocale: 'en',
        fetch: (async (url: string | URL, init?: RequestInit) => {
            const href = String(url);
            if (href.includes('authorize-project')) {
                const data: Record<string, unknown> = { key_type: keyType, base_locale: 'en', target_locales: ['es'] };
                if (writeEnabled !== undefined) data.write_enabled = writeEnabled;
                return new Response(JSON.stringify({ status: true, data }), { status: 200 });
            }
            if (href.includes('translatable-items')) {
                registered.push(...JSON.parse(String(init?.body)).translatable_items);
                return new Response(JSON.stringify({ status: true }), { status: 200 });
            }
            return new Response(JSON.stringify({ status: true, data: catalog }), { status: 200 });
        }) as unknown as typeof globalThis.fetch,
    });
    return { langsys, registered };
};
const settle = () => new Promise((r) => setTimeout(r, 30));

beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
    vi.restoreAllMocks();
});

describe('MSG-1/MSG-4 — an entry is four fixed pieces, message is the filled template', () => {
    it('reproduces every canonical entry from its template and params', async () => {
        const { langsys } = server();
        const built = await langsys.run({ locale: 'es' }, () =>
            v.canonical_entries.map((e: { code: string; template: string; params?: Record<string, unknown>; field?: string }) =>
                langsys.message({ code: e.code, template: e.template, params: e.params, field: e.field }),
            ),
        );
        expect(built.value).toEqual(v.canonical_entries);
    });

    it('keeps a numeric param a number, and omits params when the template has no marker', async () => {
        const { langsys } = server();
        const [withMarker, without] = (
            await langsys.run({ locale: 'es' }, () => [
                langsys.message({ code: 'too_short', template: 'At least {min} characters.', params: { min: 12 } }),
                langsys.message({ code: 'mismatch', template: 'The passwords do not match.', params: { min: 12 } }),
            ])
        ).value;
        expect(JSON.parse(JSON.stringify(withMarker)).params.min).toBe(12);
        expect(without).not.toHaveProperty('params');
        expect(without!.message).toBe(without!.template);
    });

    it('a missing or null param stays its literal marker, never blanked', async () => {
        const { langsys } = server();
        const e = (await langsys.run({ locale: 'es' }, () => langsys.message({ code: 'too_short', template: 'Between {min} and {max}.', params: { min: 3, max: null } }))).value;
        expect(e.message).toBe('Between 3 and {max}.');
    });

    it('the default envelope resolves back to exactly its entries', async () => {
        const { langsys } = server();
        const body = (
            await langsys.run({ locale: 'es' }, () =>
                langsys.errorBody([langsys.message({ field: 'password', code: 'too_short', template: 'The password must be at least {min} characters.', params: { min: 12 } })]),
            )
        ).value;
        expect(body).toMatchObject({ status: false, error: { code: 'validation_failed', template: 'The request failed validation.' } });
        expect(resolveServerMessages(body).map((e) => e.code)).toEqual(['validation_failed', 'too_short']);
    });
});

describe('MSG-2 — codes are logic, from the shared vocabulary', () => {
    it('exports the vocabulary, fallback included', () => {
        expect(SERVER_MESSAGE_CODES).toContain('invalid');
        expect(SERVER_MESSAGE_CODES).toContain('too_short');
    });
    it('the same failure carries the same code in two locales and after a wording change', async () => {
        const { langsys } = server();
        const es = (await langsys.run({ locale: 'es' }, () => langsys.message({ code: 'required', template: 'The name is required.' }))).value;
        const en = (await langsys.run({ locale: 'en' }, () => langsys.message({ code: 'required', template: 'A name is required.' }))).value;
        expect([es.code, en.code]).toEqual(['required', 'required']);
    });
});

describe('MSG-3/MSG-11 check 1 — a template is refused when it carries a label marker or a framework placeholder', () => {
    it('refuses label-carrying marker names', () => {
        for (const name of ['attribute', 'field', 'label', 'other', 'values']) {
            expect(checkTemplate(`The {${name}} is required.`), name).toMatch(new RegExp(`\\{${name}\\}`));
        }
    });
    it('refuses a leftover framework placeholder', () => {
        expect(checkTemplate('The :attribute is required.')).toMatch(/:attribute/);
        expect(checkTemplate('The {{field}} is required.')).toMatch(/\{\{field\}\}/);
    });
    it('CONTROL: whole sentences and non-translatable markers pass', () => {
        expect(checkTemplate('The password is required.')).toBeNull();
        expect(checkTemplate('The password must be at least {min} characters.')).toBeNull();
    });
    it('two required templates are two phrases, registered separately', async () => {
        const { langsys, registered } = server();
        await langsys.run({ locale: 'es' }, () => {
            langsys.message({ code: 'required', template: 'The password is required.' });
            langsys.message({ code: 'required', template: 'The name is required.' });
        });
        await settle();
        expect(registered.map((i) => i.phrase)).toEqual(['The password is required.', 'The name is required.']);
    });
});

describe('MSG-6/MSG-8 — registered under one category, after the response, when the catalog lacks it', () => {
    it('an unlisted template registers under Errors after run() returns, not before', async () => {
        const { langsys, registered } = server();
        await langsys.run({ locale: 'es' }, () => langsys.message({ code: 'invalid_option', template: 'Archived is not a valid status.' }));
        expect(registered, 'registered inside the request').toEqual([]);
        await settle();
        expect(registered).toEqual([{ type: 'phrase', phrase: 'Archived is not a valid status.', category: DEFAULT_SERVER_MESSAGE_CATEGORY }]);
    });
    it('a template the catalog already lists under the category is not registered', async () => {
        const { langsys, registered } = server({ Errors: { 'The name is required.': null } });
        await langsys.run({ locale: 'es' }, () => langsys.message({ code: 'required', template: 'The name is required.' }));
        await settle();
        expect(registered).toEqual([]);
    });
    it('a write-disabled session registers nothing', async () => {
        const { langsys, registered } = server({}, 'write', false);
        await langsys.run({ locale: 'es' }, () => langsys.message({ code: 'required', template: 'The name is required.' }));
        await settle();
        expect(registered).toEqual([]);
    });
    it('at the base locale too: an API answering in its source language still registers what it emits', async () => {
        const { langsys, registered } = server();
        await langsys.run({ locale: 'en' }, () => langsys.message({ code: 'required', template: 'The email is required.' }));
        await settle();
        expect(registered.map((i) => i.phrase)).toEqual(['The email is required.']);
    });
    it('the category is configurable: registration uses the configured one', async () => {
        const registered: { phrase?: string; category?: string }[] = [];
        const custom = createLangsysServer({
            projectId: 'p',
            apiKey: 'k',
            baseLocale: 'en',
            messageCategory: 'Validation',
            fetch: (async (url: string | URL, init?: RequestInit) => {
                const href = String(url);
                if (href.includes('authorize-project')) return new Response(JSON.stringify({ status: true, data: { key_type: 'write' } }), { status: 200 });
                if (href.includes('translatable-items')) registered.push(...JSON.parse(String(init?.body)).translatable_items);
                return new Response(JSON.stringify({ status: true, data: {} }), { status: 200 });
            }) as unknown as typeof globalThis.fetch,
        });
        await custom.run({ locale: 'es' }, () => custom.message({ code: 'required', template: 'The name is required.' }));
        await settle();
        expect(registered.map((i) => i.category)).toEqual(['Validation']);
    });

    it('a template emitted on every request is queued once per server object, not once per request', async () => {
        const { langsys, registered } = server();
        for (let i = 0; i < 3; i++) {
            await langsys.run({ locale: 'en' }, () => langsys.message({ code: 'required', template: 'The email is required.' }));
            await settle();
        }
        expect(registered.map((i) => i.phrase)).toEqual(['The email is required.']);
    });
});

describe('MSG-11 check 2 — a marker filled with a catalogued phrase warns once', () => {
    const warnings = () => vi.mocked(console.warn).mock.calls.map((c) => c.join(' ')).filter((m) => m.includes('catalogued phrase'));
    it('warns once per (template, marker), however often it renders', async () => {
        const { langsys } = server({ Status: { shipped: null } });
        await langsys.run({ locale: 'es' }, () => {
            for (let i = 0; i < 3; i++) langsys.message({ code: 'invalid', template: 'The order is {status}.', params: { status: 'shipped' } });
        });
        expect(warnings()).toHaveLength(1);
        expect(warnings()[0]).toContain('{status}');
    });
    it('CONTROL: a value that is not a catalogued phrase stays silent', async () => {
        const { langsys } = server({ Status: { shipped: null } });
        await langsys.run({ locale: 'es' }, () => langsys.message({ code: 'invalid', template: 'The order is {status}.', params: { status: 'A-1234' } }));
        expect(warnings()).toEqual([]);
    });
});
