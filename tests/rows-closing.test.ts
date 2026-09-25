import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLangsysServer, t, renderTranslateBlock, tokenizeHtml, generateCustomId, blockId, deriveBlockIdentity } from '../src/index.js';
import type { SharedCache } from '../src/types.js';

/** REG-11, MARK-1, CID-4, REG-12 and GATE-3 on this package's paths. */
const server = (catalog: Record<string, unknown>, extra: { debug?: boolean; cache?: SharedCache } = {}) => {
    const registered: { type: string; phrase?: string; custom_id?: string }[] = [];
    const langsys = createLangsysServer({
        projectId: 'p',
        apiKey: 'k',
        baseLocale: 'en',
        flushOnExit: false,
        ...extra,
        fetch: (async (url: string | URL, init?: RequestInit) => {
            const href = String(url);
            if (href.includes('authorize-project')) return new Response(JSON.stringify({ status: true, data: { key_type: 'write', write_enabled: true } }), { status: 200 });
            if (href.includes('translatable-items')) {
                registered.push(...JSON.parse(String(init?.body)).translatable_items);
                return new Response(JSON.stringify({ status: true }), { status: 200 });
            }
            return new Response(JSON.stringify({ status: true, write_enabled: true, data: catalog }), { status: 200 });
        }) as unknown as typeof globalThis.fetch,
    });
    return { langsys, registered };
};
const settle = () => new Promise((r) => setTimeout(r, 30));
let logs: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
    logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('REG-11 — warn on ellipsis-terminated text; suppress only on a longer catalog entry sharing the prefix', () => {
    const FULL = 'Our water is filtered through seven stages of purification before bottling.';
    it('two-sided: the truncated form of a catalogued phrase is suppressed, and Loading… registers and warns', async () => {
        const { langsys, registered } = server({ __uncategorized__: { [FULL]: null } }, { debug: true });
        await langsys.run({ locale: 'it' }, () => {
            t('Our water is filtered through seven…');
            t('Our water is filtered through seven...');
            t('Loading…');
        });
        await settle();
        expect(registered.map((i) => i.phrase)).toEqual(['Loading…']);
        const said = logs.mock.calls.map((c) => c.join(' ')).filter((m) => m.includes('ellipsis'));
        expect(said.some((m) => m.includes('"Loading…"'))).toBe(true);
    });
    it('the warning is debug-level: silent without debug, and the phrase still registers', async () => {
        const { langsys, registered } = server({});
        await langsys.run({ locale: 'it' }, () => t('Saving…'));
        await settle();
        expect(registered.map((i) => i.phrase)).toEqual(['Saving…']);
        expect(logs.mock.calls.filter((c) => c.join(' ').includes('ellipsis'))).toEqual([]);
    });
    it('CONTROL: a longer entry in another category is not a second signal', async () => {
        const { langsys, registered } = server({ Other: { [FULL]: null } });
        await langsys.run({ locale: 'it' }, () => t('Our water is filtered through seven…'));
        await settle();
        expect(registered.map((i) => i.phrase)).toEqual(['Our water is filtered through seven…']);
    });
});

describe('MARK-1 — a rendered host carries the id it was rendered from', () => {
    it('the host attributes carry the id the tokenizer derives independently', async () => {
        const html = '<p>Hydration begins</p><p>with better water.</p>';
        const { langsys } = server({});
        const r = (await langsys.run({ locale: 'it' }, () => renderTranslateBlock(html))).value;
        expect(r.hostAttributes).toEqual({ 'data-ls-contentblock': generateCustomId('', tokenizeHtml(html)) });
    });
    it('a phrase-shaped unit carries its id too, and so does a render outside a request', () => {
        const html = '<p>Hello</p>';
        expect(renderTranslateBlock(html).hostAttributes).toEqual({ 'data-ls-contentblock': blockId(html, '') });
    });
});

describe('CID-4 — a legacy match attaches only when its content matches', () => {
    const SELECT = '<select><option>One</option><option>Two</option></select>';
    const legacyId = deriveBlockIdentity(SELECT, 'cat').fallbacks[0]!.id;
    it('a historical id whose block holds this block\'s phrases renders from it', async () => {
        const { langsys } = server({ cat: { [legacyId]: { One: 'Uno', Two: 'Due' } } });
        const r = (await langsys.run({ locale: 'it' }, () => renderTranslateBlock(SELECT, 'cat'))).value;
        expect(r.html).toBe('<select><option>Uno</option><option>Due</option></select>');
    });
    it('a historical id whose block holds other phrases is not attached: the block stays unknown and registers', async () => {
        const { langsys, registered } = server({ cat: { [legacyId]: { Foreign: 'Straniero' } } });
        const r = (await langsys.run({ locale: 'it' }, () => renderTranslateBlock(SELECT, 'cat'))).value;
        await settle();
        expect(r.known).toBe(false);
        expect(registered.map((i) => i.custom_id)).toEqual([blockId(SELECT, 'cat')]);
    });
});

describe('REG-12 — a content block is decided by structure, and both paths agree', () => {
    it('text colliding with a block id is known on t() and on the block path, and registers nowhere', async () => {
        const html = '<p>One</p><p>Two</p>';
        const id = blockId(html, '');
        const { langsys, registered } = server({ __uncategorized__: { [id]: { One: null, Two: null } } });
        await langsys.run({ locale: 'it' }, () => {
            t(id);
            renderTranslateBlock(`<p>${id}</p>`);
        });
        await settle();
        expect(registered).toEqual([]);
    });
});

describe('GATE-3 — the write decision never reaches a cache', () => {
    it('nothing written to the shared cache carries write_enabled', async () => {
        const writes: string[] = [];
        const cache: SharedCache = {
            get: async () => null,
            set: async (_k: string, v: string) => {
                writes.push(v);
            },
        };
        const { langsys } = server({ __uncategorized__: { Hello: 'Ciao' } }, { cache });
        await langsys.run({ locale: 'it' }, () => t('Hello'));
        expect(writes.length, 'the catalog must actually have been cached').toBeGreaterThan(0);
        for (const w of writes) expect(w).not.toMatch(/write_enabled/);
    });
});
