import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startDouble, seedDoc, type Double } from './support/double.js';

/**
 * MSG-7's build-time command, run as the real `langsys-messages` binary against the contract
 * double. Asserts on what the double ACCEPTED: every declared template under `Errors`, nothing new
 * on a second run, and a template breaking the rules failing the command with an actionable line.
 */
const BIN = fileURLToPath(new URL('../bin/langsys-messages.mjs', import.meta.url));
const DIST = fileURLToPath(new URL('../dist/index.mjs', import.meta.url));
const OK = fileURLToPath(new URL('./support/templates-ok.mjs', import.meta.url));
const BAD = fileURLToPath(new URL('./support/templates-bad.mjs', import.meta.url));

let double: Double;
beforeAll(async () => {
    double = await startDouble();
});
afterAll(async () => {
    await double.stop();
});

function run(module: string, register: boolean, strict = false): Promise<{ code: number | null; out: string; err: string }> {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [BIN, module, ...(register ? ['--register'] : []), ...(strict ? ['--strict'] : [])], {
            env: { ...process.env, LANGSYS_PROJECT_ID: 'p', LANGSYS_API_KEY: 'wk', LANGSYS_BASE_LOCALE: 'en', LANGSYS_API_URL: double.baseUrl },
        });
        let out = '';
        let err = '';
        child.stdout.on('data', (d) => (out += d));
        child.stderr.on('data', (d) => (err += d));
        child.once('exit', (code) => resolve({ code, out, err }));
    });
}

const accepted = async () =>
    (await double.state()).projects.p!.phrases.map((p) => `${p.category}|${p.phrase}`).sort();

describe.skipIf(!existsSync(DIST))('MSG-7 — the build-time command', { timeout: 20_000 }, () => {
    it('lists every template with zero problems, and registers them under Errors', async () => {
        await double.seed(seedDoc());
        const r = await run(OK, true);
        expect(r.code, r.err).toBe(0);
        expect(r.out).toContain('3 template(s), 0 problem(s), 3 registered under Errors');
        expect(await accepted()).toEqual([
            'Errors|The name is required.',
            'Errors|The password is required.',
            'Errors|The password must be at least {min} characters.',
        ]);
    });

    it('a second run registers nothing new', async () => {
        const r = await run(OK, true);
        expect(r.code, r.err).toBe(0);
        expect(r.out).toContain('0 registered');
    });

    it('a template it cannot register is reported with where it came from and the fix, and the command still succeeds', async () => {
        await double.seed(seedDoc());
        const r = await run(BAD, true);
        expect(r.code, 'reporting is not an error: MSG-8 registers the message when first emitted').toBe(0);
        expect(r.err).toMatch(/PROBLEM app\/validators\/signup\.ts: "\$property must be an email" — \$property is a label placeholder/);
        expect(await accepted(), 'the refused template is not registered').toEqual(['Errors|The password is required.']);
    });

    it('under --strict, the same report exits non-zero', async () => {
        await double.seed(seedDoc());
        const r = await run(BAD, true, true);
        expect(r.code).toBe(1);
        expect(r.err).toMatch(/PROBLEM/);
    });

    it('CONTROL: without --register it lists and checks, and registers nothing', async () => {
        await double.seed(seedDoc());
        const r = await run(OK, false);
        expect(r.code).toBe(0);
        expect(await accepted()).toEqual([]);
    });
});

describe('MSG-7 — the command test can run', () => {
    it('dist/ is built, or the command tests above were skipped', () => {
        expect(existsSync(DIST), 'run `npm run build` first').toBe(true);
    });
});
