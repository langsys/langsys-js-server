import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLangsysServer, t } from '../src/index.js';
import { startDouble, seedDoc, type Double } from './support/double.js';

/**
 * CACHE-2 against the contract double: a failed catalog fetch is remembered for a bounded
 * window (3s doubling to ~5min, reset on success), per project and locale, on the server object.
 * The double holds the catalog behind a one-shot fault, so a lookup inside the window that
 * rendered the translation would prove the SDK fetched again. Only `Date` is faked; the double
 * and the sockets run on real time.
 */
let double: Double;
beforeAll(async () => {
    double = await startDouble();
});
afterAll(async () => {
    await double.stop();
});

const T0 = Date.UTC(2026, 0, 1);
beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

const hello = { phrase: 'Hello', translations: { it: 'Ciao' } };
const server = () => createLangsysServer({ projectId: 'p', apiKey: 'wk', baseLocale: 'en', apiUrl: double.baseUrl, harvest: false });
const render = async (s: ReturnType<typeof server>) => (await s.run({ locale: 'it' }, () => t('Hello'))).value;

describe('CACHE-2 — a failed catalog fetch is remembered for a bounded window', () => {
    it('CONTROL: a successful first fetch renders the translation at once', async () => {
        await double.seed(seedDoc({ phrases: [hello] }));
        expect(await render(server())).toBe('Ciao');
    });

    it('degrades, stays on source inside the window, and translates after it', async () => {
        await double.seed(seedDoc({ phrases: [hello], faults: [{ method: 'GET', path: '/translations', status: 500 }] }));
        const s = server();
        expect(await render(s)).toBe('Hello');
        vi.setSystemTime(T0 + 2_999);
        expect(await render(s), 'fetched again inside the window').toBe('Hello');
        vi.setSystemTime(T0 + 3_000);
        expect(await render(s)).toBe('Ciao');
    });

    it('the window doubles on a consecutive failure', async () => {
        await double.seed(seedDoc({ phrases: [hello], faults: [{ method: 'GET', path: '/translations', status: 500, times: 2 }] }));
        const s = server();
        await render(s); // fails at 0 -> window to 3s
        vi.setSystemTime(T0 + 3_000);
        expect(await render(s)).toBe('Hello'); // fails again -> 6s window, to 9s
        vi.setSystemTime(T0 + 8_999);
        expect(await render(s)).toBe('Hello');
        vi.setSystemTime(T0 + 9_000);
        expect(await render(s)).toBe('Ciao');
    });

    it('resets on the first success: the next failure opens a 3s window, not 6s', async () => {
        await double.seed(seedDoc({ phrases: [hello], faults: [{ method: 'GET', path: '/translations', status: 500 }] }));
        // A 1s TTL, so the catalog is fetched again after the success rather than served from memory.
        const s = createLangsysServer({ projectId: 'p', apiKey: 'wk', baseLocale: 'en', apiUrl: double.baseUrl, harvest: false, catalogTtlSeconds: 1 });
        await render(s); // fails at 0 -> window to 3s
        vi.setSystemTime(T0 + 3_000);
        expect(await render(s)).toBe('Ciao'); // success: the window must clear
        await double.seed(seedDoc({ phrases: [hello], faults: [{ method: 'GET', path: '/translations', status: 500 }] }));
        vi.setSystemTime(T0 + 5_000);
        expect(await render(s)).toBe('Hello'); // a FIRST failure again
        vi.setSystemTime(T0 + 8_000);
        expect(await render(s), 'still inside a doubled 6s window: the success did not reset it').toBe('Ciao');
    });

    it('is per locale: a failing locale does not hold back another', async () => {
        await double.seed({
            ...seedDoc({ faults: [{ method: 'GET', path: '/translations', status: 500 }] }),
            projects: [{ id: 'p', base_locale: 'en', target_locales: ['it', 'de'], phrases: [{ phrase: 'Hello', translations: { it: 'Ciao', de: 'Hallo' } }] }],
        });
        const s = server();
        expect(await render(s)).toBe('Hello'); // it fails
        expect((await s.run({ locale: 'de' }, () => t('Hello'))).value).toBe('Hallo');
    });

    it('is per server object: another instance is not held back', async () => {
        await double.seed(seedDoc({ phrases: [hello], faults: [{ method: 'GET', path: '/translations', status: 500 }] }));
        expect(await render(server())).toBe('Hello');
        expect(await render(server())).toBe('Ciao');
    });
});
