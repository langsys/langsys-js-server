import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLangsysServer, t } from '../src/index.js';
import { startDouble, type Double } from './support/double.js';

/**
 * The rows CONF-2 grades `contract`, against the vendored double. Every assertion reads the
 * double's ACCEPTED state, never a request. Where the SDK holds something back, the test drifts
 * the double's world so it WOULD accept the write, then asserts the state stays empty — with a
 * control session in the drifted world that learns it may write and does. Without the drift an
 * SDK deciding by `key_type` would pass, because the double declines the write anyway.
 */
let double: Double;
beforeAll(async () => {
    double = await startDouble();
});
afterAll(async () => {
    await double.stop();
});
beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

type Key = { key: string; type: 'read' | 'write' | 'ip_write'; ip_allowlist?: string[] };
const project = { id: 'p', base_locale: 'en', target_locales: ['it'] };
const seed = (keys: Key[], extra: { config?: unknown; faults?: unknown[] } = {}) =>
    double.seed({ projects: [project], keys: keys.map((k) => ({ ...k, project: 'p' })), ...extra });
const server = (apiKey: string) => createLangsysServer({ projectId: 'p', apiKey, baseLocale: 'en', apiUrl: double.baseUrl, flushOnExit: false });
const render = async (s: ReturnType<typeof server>, ...phrases: string[]) => {
    const r = await s.run({ locale: 'it' }, () => phrases.map((p) => t(p)));
    await new Promise((res) => setTimeout(res, 150));
    return r.value;
};
const accepted = async () => (await double.state()).projects.p!.phrases.map((p) => p.phrase).sort();

describe('GATE-1 — the server-computed write_enabled decides, never key_type', () => {
    it('an ip_write key outside the allow-list holds back; after the allow-list widens it still does, until it learns so', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        const T0 = Date.now();
        await seed([{ key: 'ik', type: 'ip_write', ip_allowlist: ['10.0.0.1'] }]);
        const s = server('ik');
        await render(s, 'Held');
        await seed([{ key: 'ik', type: 'ip_write', ip_allowlist: ['127.0.0.1'] }]); // drift: the double would accept now
        // Past any backoff an attempted-and-refused first send would have opened, and inside the
        // catalog TTL, so the SDK still holds what it learned. An SDK that sent the first phrase
        // and was refused would otherwise sit in its backoff window here and pass by accident.
        vi.setSystemTime(T0 + 10_000);
        await render(s, 'Still held');
        expect(await accepted()).toEqual([]);
        // Control, in the drifted world: a session that learns write_enabled: true writes.
        await render(server('ik'), 'Allowed');
        expect(await accepted()).toEqual(['Allowed']);
    });

    it('a plain write key registers — the positive control', async () => {
        await seed([{ key: 'wk', type: 'write' }]);
        await render(server('wk'), 'Written');
        expect(await accepted()).toEqual(['Written']);
    });
});

describe('GATE-8 — a missing write_enabled is a version signal, never permission', () => {
    it('ip_write under a server that omits the field refuses, even where the double would accept', async () => {
        await seed([{ key: 'ik', type: 'ip_write', ip_allowlist: ['127.0.0.1'] }], { config: { legacy_omit_capability: true } });
        await render(server('ik'), 'Not inferred');
        expect(await accepted()).toEqual([]);
    });

    it('CONTROL: a plain write key under the same server falls back and registers', async () => {
        await seed([{ key: 'wk', type: 'write' }], { config: { legacy_omit_capability: true } });
        await render(server('wk'), 'Fallback');
        expect(await accepted()).toEqual(['Fallback']);
    });
});

describe('GATE-2 — a phrase seen before the decision is known is sent once it resolves favourably', () => {
    it('authorization fails first, the phrase is held, and it lands once authorization answers', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        const T0 = Date.now();
        // Unknown needs both sources silent: authorization fails, and the catalog envelope carries
        // no write_enabled (a server predating the field). With either answering, the decision is
        // known and sending at once is correct.
        await seed([{ key: 'wk', type: 'write' }], {
            config: { legacy_omit_capability: true },
            faults: [{ method: 'GET', path: '/authorize-project/p', status: 500 }],
        });
        const s = server('wk');
        await render(s, 'Early');
        expect(await accepted()).toEqual([]);
        vi.setSystemTime(T0 + 60_000);
        await render(s, 'Later');
        await new Promise((res) => setTimeout(res, 150));
        expect(await accepted()).toEqual(['Early', 'Later']);
    });
});

describe('GATE-5 and REG-8 — a failed send is not marked registered, and lands once the endpoint recovers', () => {
    it('the second read observes the phrase the failed first write did not land', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        const T0 = Date.now();
        await seed([{ key: 'wk', type: 'write' }], { faults: [{ method: 'POST', path: '/translatable-items', status: 503 }] });
        const s = server('wk');
        await render(s, 'Retried');
        expect(await accepted(), 'the fault must actually have refused the first write').toEqual([]);
        vi.setSystemTime(T0 + 3_000);
        await render(s, 'Probe');
        await new Promise((res) => setTimeout(res, 150));
        expect(await accepted()).toEqual(['Probe', 'Retried']);
    });
});

describe('REG-9 — batches fit the limit the double enforces', () => {
    it('five phrases against a limit of two all land; one oversized batch would be refused whole', async () => {
        await seed([{ key: 'wk', type: 'write' }], { config: { batch_limit: 2 } });
        await render(server('wk'), 'A', 'B', 'C', 'D', 'E');
        expect(await accepted()).toEqual(['A', 'B', 'C', 'D', 'E']);
    });
});

describe('REG-10 — a failed registration never reaches the render', () => {
    it('a dropped connection on registration still renders, and nothing lands', async () => {
        await seed([{ key: 'wk', type: 'write' }], { faults: [{ method: 'POST', path: '/translatable-items', drop: true }] });
        expect(await render(server('wk'), 'Dropped')).toEqual(['Dropped']);
        expect(await accepted()).toEqual([]);
    });
});

describe('WIRE-2 — an empty 204 success is a success', () => {
    it('after a 204 the next phrase is sent at once: no failure was recorded, so no backoff window opened', async () => {
        await seed([{ key: 'wk', type: 'write' }], { faults: [{ method: 'POST', path: '/translatable-items', status: 204 }] });
        const s = server('wk');
        await render(s, 'Answered 204');
        await render(s, 'Next');
        expect(await accepted()).toContain('Next');
    });
});

describe('WIRE-4 — a failed or unreachable catalog degrades and registers nothing', () => {
    it('clause 2: a 500 on the catalog renders source and queues nothing the double would have accepted', async () => {
        await seed([{ key: 'wk', type: 'write' }], { faults: [{ method: 'GET', path: '/translations', status: 500 }] });
        expect(await render(server('wk'), 'Outage copy')).toEqual(['Outage copy']);
        expect(await accepted()).toEqual([]);
    });

    it('clause 1: a dropped catalog connection does not throw into the render', async () => {
        await seed([{ key: 'wk', type: 'write' }], { faults: [{ method: 'GET', path: '/translations', drop: true }] });
        expect(await render(server('wk'), 'Still renders')).toEqual(['Still renders']);
    });

    it('CONTROL: with the catalog answering, the same miss registers', async () => {
        await seed([{ key: 'wk', type: 'write' }]);
        await render(server('wk'), 'Outage copy');
        expect(await accepted()).toEqual(['Outage copy']);
    });
});

describe('OBS-1 — a refused capability on a key expected to write is surfaced once', () => {
    it('an ip_write key the double refuses warns once, naming the allow-list', async () => {
        await seed([{ key: 'ik', type: 'ip_write', ip_allowlist: ['10.0.0.1'] }]);
        const s = server('ik');
        await render(s, 'One');
        await render(s, 'Two');
        const warnings = vi.mocked(console.warn).mock.calls.map((c) => c.join(' ')).filter((m) => m.includes('write_enabled: false'));
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toMatch(/allow-list/);
    });
});
