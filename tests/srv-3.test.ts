import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLangsysServer, t } from '../src/index.js';
import { startDouble, type Double } from './support/double.js';

/**
 * SRV-3 against the contract double: collection runs after the render returns, a read-only key
 * pushes nothing, and a write key on the same render pushes — asserted on what the double
 * ACCEPTED, never on what was sent. The read-only half alone would pass against an SDK that never
 * pushes at all, which is why the write key is the control.
 */
let double: Double;
beforeAll(async () => {
    double = await startDouble();
    await double.seed({
        projects: [{ id: 'p', base_locale: 'en', target_locales: ['it'] }],
        keys: [
            { key: 'rk', type: 'read', project: 'p' },
            { key: 'wk', type: 'write', project: 'p' },
        ],
    });
});
afterAll(async () => {
    await double.stop();
});

const accepted = async () => (await double.state()).projects.p!.phrases.map((p) => p.phrase).sort();
const settle = () => new Promise((r) => setTimeout(r, 150));

describe('SRV-3 — after the response, and never from a read-only key', () => {
    it('collection has not run when the render returns, and has run once it has flushed', async () => {
        const langsys = createLangsysServer({ projectId: 'p', apiKey: 'wk', baseLocale: 'en', apiUrl: double.baseUrl });
        await langsys.run({ locale: 'it' }, () => t('Ordered'));
        expect(await accepted(), 'registered inline, inside the request').not.toContain('Ordered');
        await settle();
        expect(await accepted()).toContain('Ordered');
    });

    it('a read-only key pushes nothing, and the write key on the same render does', async () => {
        const render = () => t('Same render');
        const reader = createLangsysServer({ projectId: 'p', apiKey: 'rk', baseLocale: 'en', apiUrl: double.baseUrl });
        await reader.run({ locale: 'it' }, render);
        await settle();
        expect(await accepted()).not.toContain('Same render');

        const writer = createLangsysServer({ projectId: 'p', apiKey: 'wk', baseLocale: 'en', apiUrl: double.baseUrl });
        await writer.run({ locale: 'it' }, render);
        await settle();
        expect(await accepted()).toContain('Same render');
    });
});
