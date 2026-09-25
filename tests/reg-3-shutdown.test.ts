import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startDouble, seedDoc, type Double } from './support/double.js';

/**
 * REG-3's worker-shutdown half, in a real child process against the contract double (tier
 * contract). The double fails the first registration, so the phrase is held on its request; the
 * child then ends. The assertion is the double's ACCEPTED state after the child has exited: the
 * phrase is there only if the best-effort exit drain sent it. Control: `flushOnExit: false`, and
 * nothing lands. Runs the built `dist/`, the artifact that ships.
 */
const DIST = fileURLToPath(new URL('../dist/index.mjs', import.meta.url));
const CHILD = fileURLToPath(new URL('./support/exit-child.mjs', import.meta.url));

let double: Double;
beforeAll(async () => {
    double = await startDouble();
});
afterAll(async () => {
    await double.stop();
});

function runChild(mode: 'exit' | 'sigterm' | 'off'): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [CHILD, DIST, double.baseUrl, mode], { stdio: 'ignore' });
        // A child that does not end is a failure, never a hang: SIGKILL shows up as the signal.
        const guard = setTimeout(() => child.kill('SIGKILL'), 8_000);
        child.once('exit', (code, signal) => {
            clearTimeout(guard);
            resolve({ code, signal });
        });
    });
}

const accepted = async () => (await double.state()).projects.p!.phrases.map((p) => p.phrase);
const failFirstSend = seedDoc({ faults: [{ method: 'POST', path: '/translatable-items', status: 503 }] });

describe.skipIf(!existsSync(DIST))('REG-3 — held registrations drain when the worker exits', () => {
    it('on a natural exit (beforeExit), the held phrase is accepted after the process ends', { timeout: 15_000 }, async () => {
        await double.seed(failFirstSend);
        const { code } = await runChild('exit');
        expect(code).toBe(0);
        expect(await accepted()).toEqual(['Farewell']);
    });

    it('on SIGTERM, the phrase is accepted and the process still terminates by that signal', { timeout: 15_000 }, async () => {
        await double.seed(failFirstSend);
        const { signal } = await runChild('sigterm');
        expect(signal).toBe('SIGTERM');
        expect(await accepted()).toEqual(['Farewell']);
    });

    it('CONTROL: with flushOnExit off, nothing lands — the first send really did fail', { timeout: 15_000 }, async () => {
        await double.seed(failFirstSend);
        const { code } = await runChild('off');
        expect(code).toBe(0);
        expect(await accepted()).toEqual([]);
    });
});

describe('REG-3 — the exit test can run', () => {
    it('dist/ is built, or the exit-drain tests above were skipped', () => {
        expect(existsSync(DIST), 'run `npm run build` first').toBe(true);
    });
});
