/**
 * `LangsysApi`.
 *
 * Before this file, deleting `'x-Authorization': apiKey` from the headers kept the suite
 * green — no test asserted that the API key went out on the wire at all. So did deleting
 * `X-Langsys-Capabilities: 'icu'`, whose absence makes the server send flat-template
 * downgrades instead of raw ICU: **every plural silently degrades, and renders perfectly
 * in English**, which is why the existing ICU tests could not see it (their stub returned
 * ICU regardless).
 *
 * Also covered: the non-200 branch, which previously passed for the wrong reason. The one
 * failure test returned `new Response('nope', {status: 500})`; with the `ok` check
 * deleted, `response.json()` throws on `'nope'`, `catalog.ts` catches it and logs — the
 * same assertion, an entirely different code path. A 422 carrying valid JSON separates
 * them.
 */

import { describe, expect, it } from 'vitest';
import { LangsysApi, DEFAULT_API_URL } from '../src/api.js';

interface Captured {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string;
}

function makeApi(
    respond: (url: string) => Response,
    opts: { apiUrl?: string; projectId?: string | number; apiKey?: string } = {},
) {
    const calls: Captured[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
        calls.push({
            url: String(url),
            method: init?.method ?? 'GET',
            headers: (init?.headers ?? {}) as Record<string, string>,
            body: init?.body as string | undefined,
        });
        return respond(String(url));
    }) as unknown as typeof globalThis.fetch;

    const api = new LangsysApi(
        opts.projectId ?? 'proj-1',
        opts.apiKey ?? 'secret-key',
        opts.apiUrl ?? 'https://example.test/api',
        fetchImpl,
    );
    return { api, calls };
}

const ok = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

describe('request headers', () => {
    it('sends the API key as x-Authorization', async () => {
        const { api, calls } = makeApi(() => ok({ status: true, data: {} }), { apiKey: 'sk-abc123' });
        await api.getTranslations('it');
        expect(calls[0].headers['x-Authorization']).toBe('sk-abc123');
    });

    it('declares ICU capability, or every plural is silently downgraded', async () => {
        // The server sends flat templates when this is absent. A flat template renders
        // perfectly in English, so nothing looks wrong until a language with more than
        // two plural forms.
        const { api, calls } = makeApi(() => ok({ status: true, data: {} }));
        await api.getTranslations('it');
        expect(calls[0].headers['X-Langsys-Capabilities']).toBe('icu');
    });

    it('sends a JSON content type', async () => {
        const { api, calls } = makeApi(() => ok({ status: true }));
        await api.createTranslatableItems([{ type: 'phrase', phrase: 'x' }]);
        expect(calls[0].headers['Content-Type']).toContain('application/json');
    });

    it('sends the same headers on POST as on GET', async () => {
        const { api, calls } = makeApi(() => ok({ status: true }), { apiKey: 'sk-post' });
        await api.createTranslatableItems([{ type: 'phrase', phrase: 'x' }]);
        expect(calls[0].headers['x-Authorization']).toBe('sk-post');
        expect(calls[0].headers['X-Langsys-Capabilities']).toBe('icu');
    });
});

describe('URL construction', () => {
    it('strips a trailing slash from apiUrl', async () => {
        const { api, calls } = makeApi(() => ok({ status: true, data: {} }), {
            apiUrl: 'https://example.test/api/',
        });
        await api.getTranslations('it');
        expect(calls[0].url).not.toContain('//translations');
        expect(calls[0].url).toContain('https://example.test/api/translations');
    });

    it('defaults to the published API host', () => {
        expect(DEFAULT_API_URL).toBe('https://api.langsys.dev/api');
    });

    it('sends project_id on the translations query', async () => {
        const { api, calls } = makeApi(() => ok({ status: true, data: {} }), { projectId: 42 });
        await api.getTranslations('it');
        expect(new URL(calls[0].url).searchParams.get('project_id')).toBe('42');
    });

    it('CANONICALIZES the locale in the query', async () => {
        // `en_gb` and `en-GB` must not fetch two different cache entries upstream.
        const { api, calls } = makeApi(() => ok({ status: true, data: {} }));
        await api.getTranslations('en_gb');
        expect(new URL(calls[0].url).searchParams.get('locale')).toBe('en-GB');
    });

    it('puts the project id in the authorize path', async () => {
        const { api, calls } = makeApi(() => ok({ status: true, data: { key_type: 'read' } }), {
            projectId: 'proj-xyz',
        });
        await api.authorize();
        expect(calls[0].url).toContain('/authorize-project/proj-xyz');
    });
});

describe('non-200 responses', () => {
    it('returns a failure carrying the status, WITHOUT parsing the body', async () => {
        // A 422 with valid JSON: if the `ok` check were removed this would parse
        // successfully and be treated as a real response. The error string is the
        // positive evidence that the non-200 branch ran.
        const { api } = makeApi(
            () =>
                new Response(JSON.stringify({ status: true, data: { sneaky: 1 } }), {
                    status: 422,
                    headers: { 'content-type': 'application/json' },
                }),
        );

        const res = await api.getTranslations('it');
        expect(res.status).toBe(false);
        expect(JSON.stringify(res.errors)).toContain('HTTP 422');
        expect(res.data).toBeUndefined();
    });

    it('handles a 500 with a non-JSON body', async () => {
        const { api } = makeApi(() => new Response('gateway exploded', { status: 500 }));
        const res = await api.getTranslations('it');
        expect(res.status).toBe(false);
        expect(JSON.stringify(res.errors)).toContain('HTTP 500');
    });

    it('passes a 200 through — the negative control', async () => {
        const { api } = makeApi(() => ok({ status: true, data: { a: 1 } }));
        const res = await api.getTranslations('it');
        expect(res.status).toBe(true);
    });
});

describe('authorize()', () => {
    it('reports a write key', async () => {
        const { api } = makeApi(() => ok({ status: true, data: { key_type: 'write' } }));
        expect(await api.authorize()).toEqual({ status: true, keyType: 'write' });
    });

    it('reports a read key', async () => {
        const { api } = makeApi(() => ok({ status: true, data: { key_type: 'read' } }));
        expect(await api.authorize()).toEqual({ status: true, keyType: 'read' });
    });

    it('maps an unrecognised key_type to unknown rather than trusting it', async () => {
        const { api } = makeApi(() => ok({ status: true, data: { key_type: 'admin' } }));
        expect(await api.authorize()).toEqual({ status: true, keyType: 'unknown' });
    });

    it('maps a missing key_type to unknown', async () => {
        const { api } = makeApi(() => ok({ status: true, data: {} }));
        expect(await api.authorize()).toEqual({ status: true, keyType: 'unknown' });
    });

    it('reports failure without inventing a key type', async () => {
        const { api } = makeApi(() => new Response('nope', { status: 403 }));
        expect(await api.authorize()).toEqual({ status: false, keyType: 'unknown' });
    });
});

describe('createTranslatableItems()', () => {
    it('POSTs the items under translatable_items with the project id', async () => {
        const { api, calls } = makeApi(() => ok({ status: true }), { projectId: 7 });
        await api.createTranslatableItems([
            { type: 'phrase', phrase: 'Hello', category: 'marketing' },
        ]);

        expect(calls[0].method).toBe('POST');
        expect(calls[0].url).toContain('/translatable-items');
        expect(JSON.parse(calls[0].body!)).toEqual({
            project_id: 7,
            translatable_items: [{ type: 'phrase', phrase: 'Hello', category: 'marketing' }],
        });
    });
});

describe('statelessness', () => {
    it('two instances do not share auth headers', async () => {
        // The base SDK's API client is a module singleton whose `setup()` overwrites
        // `this.headers['x-Authorization']`, so two concurrent requests for different
        // projects race on WHICH KEY GOES OUT ON THE WIRE — a wrong-tenant read, which is
        // strictly worse than a wrong-language render.
        const a = makeApi(() => ok({ status: true, data: {} }), { apiKey: 'key-A', projectId: 'A' });
        const b = makeApi(() => ok({ status: true, data: {} }), { apiKey: 'key-B', projectId: 'B' });

        await Promise.all([a.api.getTranslations('it'), b.api.getTranslations('de')]);
        await Promise.all([b.api.getTranslations('fr'), a.api.getTranslations('es')]);

        for (const call of a.calls) expect(call.headers['x-Authorization']).toBe('key-A');
        for (const call of b.calls) expect(call.headers['x-Authorization']).toBe('key-B');
        for (const call of a.calls) expect(call.url).toContain('project_id=A');
        for (const call of b.calls) expect(call.url).toContain('project_id=B');
    });
});
