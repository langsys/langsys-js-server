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
} from '../src/index.js';
import * as pkg from '../src/index.js';
import type { MessageInput } from '../src/index.js';

/**
 * The MSG family on the server profile. The shared `server-message-vectors.json` is the core's,
 * vendored by blob `7333e3919dac43af81c6c20bfdba974efd79725b` (core `239166a6`, measured against spec
 * blob `5d7e6890`) and read through the core's checkout: twelve canonical entries from real framework
 * messages, and resolve rows carrying each framework's native body with the entries attached. Its
 * `render` rows are the client's (MSG-5) and are not rowed here.
 */
const VECTORS = new URL('../node_modules/langsys-js-typescript/tests/fixtures/server-message-vectors.json', import.meta.url);
const VECTORS_BLOB = '7333e3919dac43af81c6c20bfdba974efd79725b';
const VECTORS_SPEC_BLOB = '5d7e6890b733a50fb6f5f5c30e0056c6ef7bcf45';
const v = existsSync(VECTORS) ? JSON.parse(readFileSync(VECTORS, 'utf8')) : { markers: [], fill: [], resolve: [], canonical_entries: [] };

interface ResolveRow {
    id: string;
    body: Record<string, unknown>;
    options: { key: string; pieces?: Record<string, string> };
    expected: Record<string, unknown>[];
    body_unchanged?: boolean;
}

describe('server-message-vectors.json', () => {
    it('is the blob this package is pinned to, measured against the spec blob this package rows against', () => {
        const raw = readFileSync(VECTORS);
        expect(createHash('sha1').update(`blob ${raw.length}\0`).update(raw).digest('hex')).toBe(VECTORS_BLOB);
        expect(v.spec_blob).toContain(VECTORS_SPEC_BLOB);
        expect([v.canonical_entries.length, v.markers.length, v.fill.length, v.resolve.length]).toEqual([12, 13, 10, 10]);
    });
    it.each(v.markers.map((r: { id: string }) => [r.id, r]))('markers: %s', (_id, r: { template: string; expected: string[] }) => {
        expect(templateMarkers(r.template)).toEqual(r.expected);
    });
    it.each(v.fill.map((r: { id: string }) => [r.id, r]))('fill: %s', (_id, r: { template: string; params: Record<string, unknown>; expected: string }) => {
        expect(fillTemplate(r.template, r.params)).toBe(r.expected);
    });
    it.each(v.resolve.map((r: ResolveRow) => [r.id, r]))('resolve: %s', (_id, r: ResolveRow) => {
        const before = structuredClone(r.body);
        expect(resolveServerMessages(r.body, r.options as never)).toEqual(r.expected);
        expect(r.body).toEqual(before);
    });
});

/**
 * The same resolve rows, produced by THIS package rather than read from the file: the framework's
 * native body with the attached member removed, each expected entry rebuilt through `message()` from
 * its template, params, field and code, and attached through `attachMessages()` under the row's key
 * and piece names. What comes back must equal the row's body, native members first and in their own
 * order, and must resolve to its entries. The order of pieces inside an entry is not the wire's
 * contract, and the rows themselves differ on it.
 * Rows whose entries sit in a nested field map, or have no template to build from, are the
 * resolver's alone.
 */
const attachable = (v.resolve as ResolveRow[]).filter((r) => {
    if (r.options.key.includes('.') || !r.expected.length) return false;
    const attached = r.body[r.options.key];
    const templateName = r.options.pieces?.template ?? 'template';
    return Array.isArray(attached) && attached.every((e) => typeof (e as Record<string, unknown>)[templateName] === 'string');
});

describe('server-message-vectors.json resolve rows, built by message() and attached by attachMessages()', () => {
    it('covers the rows that carry an attached array of templated entries', () => {
        expect(attachable.map((r) => r.id)).toEqual(['laravel-422-body', 'fastapi-422-body', 'rails-body-renamed-pieces', 'no-code-where-framework-has-none']);
    });
    it.each(attachable.map((r) => [r.id, r]))('%s', async (_id, r: ResolveRow) => {
        const { langsys } = server();
        const { [r.options.key]: _attached, ...native } = structuredClone(r.body);
        const body = (
            await langsys.run({ locale: 'es' }, () =>
                langsys.attachMessages(
                    native,
                    r.expected.map((e) => langsys.message(e as unknown as MessageInput)),
                    { key: r.options.key, ...(r.options.pieces ? { pieces: r.options.pieces } : {}) },
                ),
            )
        ).value;
        expect(body).toEqual(r.body);
        expect(Object.keys(body)).toEqual(Object.keys(r.body));
        expect(resolveServerMessages(body, r.options as never)).toEqual(r.expected);
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

describe('MSG-1/MSG-4 — an entry is a template and its params; everything around it is the framework\'s', () => {
    it('reproduces every canonical entry from its template and params, field and code passed through', async () => {
        // `framework` and `source` annotate the file and are not wire pieces.
        const wire = v.canonical_entries.map(({ framework: _f, source: _s, ...e }: Record<string, unknown>) => e);
        const { langsys } = server();
        const built = await langsys.run({ locale: 'es' }, () =>
            wire.map((e: { code: string; template: string; params?: Record<string, unknown>; field?: unknown }) =>
                langsys.message({ code: e.code, template: e.template, params: e.params, field: e.field }),
            ),
        );
        expect(built.value).toEqual(wire);
        expect(built.value.filter((e) => Array.isArray(e.field)), 'a path-array field kept as the framework reports it').toHaveLength(2);
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

    const entry = { field: 'password', code: 'min', template: 'The password field must be at least {min} characters.', params: { min: 12 } };

    it('attaches entries to the framework\'s own error body, which is otherwise unchanged', async () => {
        const { langsys } = server();
        const native = { message: 'The given data was invalid.', errors: { password: ['The password field must be at least 12 characters.'] } };
        const body = (await langsys.run({ locale: 'es' }, () => langsys.attachMessages(structuredClone(native), [langsys.message(entry)]))).value;
        const { langsys_errors: attached, ...rest } = body as typeof native & { langsys_errors: unknown };
        expect(rest).toEqual(native);
        expect(attached).toEqual([{ ...entry, message: 'The password field must be at least 12 characters.' }]);
        expect(resolveServerMessages(body, { key: 'langsys_errors' })).toEqual(attached);
    });

    it('under a configured key, on a second framework\'s body shape', async () => {
        const { langsys } = server();
        const native = { statusCode: 400, message: ['password must be longer than or equal to 12 characters'], error: 'Bad Request' };
        const body = (await langsys.run({ locale: 'es' }, () => langsys.attachMessages(structuredClone(native), [langsys.message(entry)], { key: 'translations' }))).value;
        const { translations, ...rest } = body as typeof native & { translations: unknown };
        expect(rest).toEqual(native);
        expect(resolveServerMessages(body, { key: 'translations' })).toEqual(translations);
    });

    it('only template and params are required; message is the fill', async () => {
        const { langsys } = server();
        const e = (await langsys.run({ locale: 'es' }, () => langsys.message({ template: 'At least {min} characters.', params: { min: 3 } }))).value;
        expect(e).toEqual({ template: 'At least {min} characters.', params: { min: 3 }, message: 'At least 3 characters.' });
    });
});

describe('MSG-2 — a code is the framework\'s own, passed through, never chosen from a vocabulary', () => {
    it('passes the framework\'s identifier through unchanged, and omits code when there is none', async () => {
        const { langsys } = server();
        const [withCode, without] = (
            await langsys.run({ locale: 'es' }, () => [
                langsys.message({ code: 'isEmail', template: 'email must be an email' }),
                langsys.message({ template: 'Something went wrong.' }),
            ])
        ).value;
        expect(withCode!.code).toBe('isEmail');
        expect(without).not.toHaveProperty('code');
    });
    it('exports no vocabulary of its own', () => {
        expect(pkg).not.toHaveProperty('SERVER_MESSAGE_CODES');
        expect(pkg).not.toHaveProperty('errorBody');
    });
    it('the same failure keeps its code across locales', async () => {
        const { langsys } = server();
        const a = (await langsys.run({ locale: 'es' }, () => langsys.message({ code: 'min', template: 'Too short.' }))).value;
        const b = (await langsys.run({ locale: 'en' }, () => langsys.message({ code: 'min', template: 'Too short.' }))).value;
        expect([a.code, b.code]).toEqual(['min', 'min']);
    });
});

describe('MSG-11 check 1 — a template holding one of this ecosystem\'s label placeholders is refused', () => {
    it.each(['$property must be an email', 'The ${path} field is required', '${label} is invalid', '"{{#label}}" is required', '{{#key}} must be a string'])('refuses %s', (template) => {
        expect(checkTemplate(template)).toMatch(/label placeholder/);
    });
    it('CONTROL: the label written in, and a number marker, pass', () => {
        expect(checkTemplate('The email field must be a valid email address.')).toBeNull();
        expect(checkTemplate('The password field must be at least {min} characters.')).toBeNull();
    });
    it('two fields failing one rule are two phrases, registered separately', async () => {
        const { langsys, registered } = server();
        await langsys.run({ locale: 'es' }, () => {
            langsys.message({ code: 'required', template: 'The password field is required.' });
            langsys.message({ code: 'required', template: 'The name field is required.' });
        });
        await settle();
        expect(registered.map((i) => i.phrase)).toEqual(['The password field is required.', 'The name field is required.']);
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
