import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLangsysServer, t } from '../src/index.js';

/**
 * REG-10's skip reasons that belong to a server object rather than to the session the double
 * computes: harvesting configured off, a decision not yet readable, a backoff window, and a
 * `flush()` handed something `run()` did not return. The session reasons are graded against the
 * contract double in `contract-rows`.
 */
const stub = (opts: { authorizeStatus?: number; catalogStatus?: number; registerStatus?: number } = {}) => {
    const posts: unknown[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
        const href = String(url);
        if (href.includes('authorize-project')) {
            if (opts.authorizeStatus && opts.authorizeStatus !== 200) return new Response('', { status: opts.authorizeStatus });
            return new Response(JSON.stringify({ status: true, data: { key_type: 'write', write_enabled: true, base_locale: 'en', target_locales: ['it'] } }), { status: 200 });
        }
        if (href.includes('translatable-items')) {
            posts.push(JSON.parse(String(init?.body)));
            return new Response(JSON.stringify({ status: true }), { status: opts.registerStatus ?? 200 });
        }
        if (opts.catalogStatus && opts.catalogStatus !== 200) return new Response('', { status: opts.catalogStatus });
        // With authorization unanswered the catalog carries no decision either, so nothing answers it.
        const envelope = opts.authorizeStatus && opts.authorizeStatus !== 200 ? { status: true, data: {} } : { status: true, write_enabled: true, data: {} };
        return new Response(JSON.stringify(envelope), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    return { posts, fetchImpl };
};
const server = (fetchImpl: typeof globalThis.fetch, harvest = true) =>
    createLangsysServer({ projectId: 'p', apiKey: 'k', baseLocale: 'en', fetch: fetchImpl, harvest, flushOnExit: false });

beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
    vi.restoreAllMocks();
});

describe('REG-10 — the server object\'s own skips name their reason', () => {
    it('harvesting configured off: "harvest-disabled"', async () => {
        const { fetchImpl, posts } = stub();
        const s = server(fetchImpl, false);
        const r = await s.run({ locale: 'it' }, () => t('Off'));
        expect(await s.flush(r)).toMatchObject({ status: false, skipped: true, reason: 'harvest-disabled' });
        expect(posts).toEqual([]);
    });

    it('authorization unanswered: "awaiting-authorization", with the item held', async () => {
        const { fetchImpl, posts } = stub({ authorizeStatus: 500 });
        const s = server(fetchImpl);
        const r = await s.run({ locale: 'it' }, () => t('Held'));
        expect(await s.flush(r)).toMatchObject({ status: false, skipped: true, reason: 'awaiting-authorization', held: 1 });
        expect(posts).toEqual([]);
    });

    it('inside a backoff window: "backing-off", after a refusal that is not a skip', async () => {
        const { fetchImpl } = stub({ registerStatus: 500 });
        const s = server(fetchImpl);
        const first = await s.run({ locale: 'it' }, () => t('First'));
        expect(await s.flush(first)).toMatchObject({ status: false, reason: 'refused', held: 1 });
        const second = await s.run({ locale: 'it' }, () => t('Second'));
        expect(await s.flush(second)).toMatchObject({ status: false, skipped: true, reason: 'backing-off', held: 1 });
    });

    it('a value run() did not return: "not-from-run"', async () => {
        const { fetchImpl } = stub();
        expect(await server(fetchImpl).flush({ value: 1 } as never)).toMatchObject({ status: false, skipped: true, reason: 'not-from-run' });
    });

    it('CONTROL: a render with nothing new to register is a success with nothing sent', async () => {
        const { fetchImpl, posts } = stub();
        const s = server(fetchImpl);
        const r = await s.run({ locale: 'it' }, () => 'no phrases');
        expect(await s.flush(r)).toEqual({ status: true, sent: 0 });
        expect(posts).toEqual([]);
    });
});

describe('REG-10 and WIRE-4 — registerTemplates', () => {
    it('with the catalog unreadable, registers nothing and names the reason', async () => {
        const { fetchImpl, posts } = stub({ catalogStatus: 500 });
        const out = await server(fetchImpl).registerTemplates(['The name is required.'], { register: true });
        expect(out.result).toEqual({ status: false, skipped: true, reason: 'catalog-unavailable', sent: 0, held: 0 });
        expect(out.registered).toEqual([]);
        expect(posts).toEqual([]);
    });

    it('CONTROL: with the catalog readable, the template registers and the result is a success', async () => {
        const { fetchImpl, posts } = stub();
        const out = await server(fetchImpl).registerTemplates(['The name is required.'], { register: true });
        expect(out.result).toEqual({ status: true, sent: 1 });
        expect(posts).toHaveLength(1);
    });

    it('a refused batch is a failure, not a skip', async () => {
        const { fetchImpl } = stub({ registerStatus: 500 });
        const out = await server(fetchImpl).registerTemplates(['The name is required.'], { register: true });
        expect(out.result).toMatchObject({ status: false, reason: 'refused', sent: 0, held: 1 });
    });
});
