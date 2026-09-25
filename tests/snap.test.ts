import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLangsysServer } from '../src/index.js';
import { startDouble, type Double } from './support/double.js';

/**
 * SNAP-1: the export is a client-side filter of `GET /translations/data` by category, with no new
 * endpoint. Asserted against the contract double: the snapshot carries exactly the phrases and
 * translations the API returns for the chosen categories, and nothing from the others.
 */
let double: Double;
beforeAll(async () => {
    double = await startDouble();
    await double.seed({
        projects: [
            {
                id: 'p',
                base_locale: 'en',
                target_locales: ['it'],
                phrases: [
                    { category: 'Errors', phrase: 'The name is required.', translations: { it: 'Il nome è obbligatorio.' } },
                    { category: 'Errors', phrase: 'Untranslated error.' },
                    { category: 'UI', phrase: 'Save', translations: { it: 'Salva' } },
                    { category: 'Marketing', phrase: 'Buy now', translations: { it: 'Compra ora' } },
                ],
            },
        ],
        keys: [{ key: 'rk', type: 'read', project: 'p' }],
    });
});
afterAll(async () => {
    await double.stop();
});

const apiData = async () =>
    (await (await fetch(`${double.baseUrl}/translations/data?project_id=p&locale=it`, { headers: { 'x-authorization': 'rk' } })).json()).data;

describe('SNAP-1 — a snapshot is the API catalog filtered by category', () => {
    it('carries exactly what the API returns for the chosen categories, and nothing else', async () => {
        const langsys = createLangsysServer({ projectId: 'p', apiKey: 'rk', baseLocale: 'en', apiUrl: double.baseUrl, harvest: false });
        const snapshot = await langsys.exportSnapshot('it', ['Errors', 'UI']);
        const api = await apiData();
        expect(snapshot).toEqual({ Errors: api.Errors, UI: api.UI });
        expect(snapshot.Errors!['Untranslated error.']).toBeNull();
    });

    it('with no categories, it is the whole catalog', async () => {
        const langsys = createLangsysServer({ projectId: 'p', apiKey: 'rk', baseLocale: 'en', apiUrl: double.baseUrl, harvest: false });
        expect(await langsys.exportSnapshot('it')).toEqual(await apiData());
    });

    it('a failed fetch is an error, never an empty snapshot that would pass for a cache', async () => {
        const langsys = createLangsysServer({ projectId: 'p', apiKey: 'nope', baseLocale: 'en', apiUrl: double.baseUrl, harvest: false });
        await expect(langsys.exportSnapshot('it', ['Errors'])).rejects.toThrow(/snapshot/i);
    });
});

const BIN = fileURLToPath(new URL('../bin/langsys-snapshot.mjs', import.meta.url));
const DIST = fileURLToPath(new URL('../dist/index.mjs', import.meta.url));

describe.skipIf(!existsSync(DIST))('SNAP-1 — the export command', { timeout: 20_000 }, () => {
    it('writes the filtered snapshot to a file', async () => {
        const out = join(mkdtempSync(join(tmpdir(), 'snap-')), 'it.json');
        const code = await new Promise<number | null>((resolve) => {
            const child = spawn(process.execPath, [BIN, '--locale', 'it', '--category', 'UI', '--out', out], {
                env: { ...process.env, LANGSYS_PROJECT_ID: 'p', LANGSYS_API_KEY: 'rk', LANGSYS_BASE_LOCALE: 'en', LANGSYS_API_URL: double.baseUrl },
                stdio: 'ignore',
            });
            child.once('exit', resolve);
        });
        expect(code).toBe(0);
        expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual({ UI: (await apiData()).UI });
    });
});
