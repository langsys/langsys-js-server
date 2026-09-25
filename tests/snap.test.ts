import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLangsysServer, canonicalSnapshotJson, parseSnapshot, SnapshotError } from '../src/index.js';
import { startDouble, type Double } from './support/double.js';

/**
 * SNAP-1's one snapshot format, `langsys-catalog-snapshot` v1, and its loader.
 *
 * The canonical serialisation's expected bytes and checksum below were produced by a different
 * implementation — Python's `json.dumps(sort_keys=True, ensure_ascii=False, separators=(',', ':'))`,
 * which sorts keys by code point and escapes exactly as CID-1 does — never by the code under test.
 * The input carries the cases the spec names: an empty category map, an integer-like key, a key
 * above U+FFFF beside one in U+E000–U+FFFF, U+2028, a C0 control with a letter in its hex, a tab and a newline in values, a block map with a
 * null translation, and a category held in one locale and not another.
 */
const ORACLE: { body: Record<string, unknown>; canonical: string; checksum: string } = {"body": {"project_id": "p", "generated_at": "2026-09-24T12:00:00Z", "base_locale": "en", "locales": ["de", "it"], "categories": ["404", "Errors", "\ue000", "\ud83d\ude00"], "catalog": {"it": {"404": {}, "Errors": {"Line\u2028sep": "Riga\u2028sep", "Bell\u0007": null, "Sep\u001cx": "Tab\there\nnewline", "abc123": {"Inner": null, "Two": "Due"}}, "\ue000": {"k": "v"}, "\ud83d\ude00": {"smile": "sorriso"}}, "de": {"Errors": {"Line\u2028sep": null}}}}, "canonical": "{\"base_locale\":\"en\",\"catalog\":{\"de\":{\"Errors\":{\"Line\u2028sep\":null}},\"it\":{\"404\":{},\"Errors\":{\"Bell\\u0007\":null,\"Line\u2028sep\":\"Riga\u2028sep\",\"Sep\\u001cx\":\"Tab\\there\\nnewline\",\"abc123\":{\"Inner\":null,\"Two\":\"Due\"}},\"\ue000\":{\"k\":\"v\"},\"\ud83d\ude00\":{\"smile\":\"sorriso\"}}},\"categories\":[\"404\",\"Errors\",\"\ue000\",\"\ud83d\ude00\"],\"generated_at\":\"2026-09-24T12:00:00Z\",\"locales\":[\"de\",\"it\"],\"project_id\":\"p\"}", "checksum": "sha256:db951dbc98b977419e46b7fe2551d9845a13d203189c303a3a7897c5f3673642"};

describe('SNAP-1 — the canonical serialisation', () => {
    it('produces the oracle bytes exactly', () => {
        expect(canonicalSnapshotJson(ORACLE.body)).toBe(ORACLE.canonical);
    });

    it('and so the oracle checksum', () => {
        const hex = createHash('sha256').update(canonicalSnapshotJson(ORACLE.body), 'utf8').digest('hex');
        expect(`sha256:${hex}`).toBe(ORACLE.checksum);
    });

    it('CONTROL: JSON.stringify of the same object is not canonical (integer-like keys reorder, U+1F600 vs U+E000)', () => {
        const sortedDefault = (v: unknown): unknown =>
            v && typeof v === 'object' && !Array.isArray(v)
                ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortedDefault((v as Record<string, unknown>)[k])]))
                : v;
        expect(JSON.stringify(sortedDefault(ORACLE.body))).not.toBe(ORACLE.canonical);
    });
});

describe('SNAP-1 — the loader refuses by name', () => {
    const doc = () => ({ format: 'langsys-catalog-snapshot', version: 1, ...structuredClone(ORACLE.body), checksum: ORACLE.checksum });
    it('accepts the oracle document', async () => {
        expect(parseSnapshot(doc()).catalog).toEqual(ORACLE.body.catalog);
    });
    it('an edited file fails its checksum', async () => {
        const d = doc() as { catalog: { it: { Errors: Record<string, unknown> } } };
        d.catalog.it.Errors['Line\u2028sep'] = 'hand-edited';
        expect(() => parseSnapshot(d)).toThrow(/checksum/);
    });
    it('a different format, an unsupported version, and a missing member each name the reason', async () => {
        expect(() => parseSnapshot({ ...doc(), format: 'other' })).toThrow(/format/);
        expect(() => parseSnapshot({ ...doc(), version: 2 })).toThrow(/version/);
        const missing = doc() as Record<string, unknown>;
        delete missing.categories;
        expect(() => parseSnapshot(missing)).toThrow(/categories/);
    });
});

let double: Double;
beforeAll(async () => {
    double = await startDouble();
    await double.seed({
        projects: [
            {
                id: 'p',
                base_locale: 'en',
                target_locales: ['it', 'de'],
                phrases: [
                    { category: 'Errors', phrase: 'The name is required.', translations: { it: 'Il nome è obbligatorio.' } },
                    { category: 'Errors', phrase: 'Untranslated error.' },
                    { category: 'UI', phrase: 'Save', translations: { it: 'Salva', de: 'Speichern' } },
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

const apiCatalog = async (locale: string) =>
    (await (await fetch(`${double.baseUrl}/translations?project_id=p&locale=${locale}`, { headers: { 'x-authorization': 'rk' } })).json()).data;
const server = (apiKey = 'rk') => createLangsysServer({ projectId: 'p', apiKey, baseLocale: 'en', apiUrl: double.baseUrl, harvest: false, flushOnExit: false });

describe('SNAP-1 — the export, against the contract double', () => {
    it('writes format v1 with exactly the API\'s entries for the chosen categories, and a checksum its loader accepts', async () => {
        const snap = await server().exportSnapshot(['it', 'de'], ['UI', 'Errors']);
        const [it_, de] = [await apiCatalog('it'), await apiCatalog('de')];
        expect(snap).toMatchObject({ format: 'langsys-catalog-snapshot', version: 1, project_id: 'p', base_locale: 'en', locales: ['de', 'it'], categories: ['Errors', 'UI'] });
        expect(snap.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
        expect(snap.catalog).toEqual({ it: { Errors: it_.Errors, UI: it_.UI }, de: { Errors: de.Errors, UI: de.UI } });
        expect(snap.catalog.it!.Errors!['Untranslated error.']).toBeNull();
        expect(parseSnapshot(JSON.stringify(snap))).toBeTruthy();
    });

    it('a category a locale does not hold is absent from that locale', async () => {
        const snap = await server().exportSnapshot(['it'], ['UI', 'Nope']);
        expect(Object.keys(snap.catalog.it!)).toEqual(['UI']);
        expect(snap.categories).toEqual(['Nope', 'UI']);
    });

    it('a failed fetch is an error, never a snapshot', async () => {
        await expect(server('nope').exportSnapshot(['it'], ['UI'])).rejects.toThrow(/snapshot/i);
    });
});

const BIN = fileURLToPath(new URL('../bin/langsys-snapshot.mjs', import.meta.url));
const DIST = fileURLToPath(new URL('../dist/index.mjs', import.meta.url));

describe.skipIf(!existsSync(DIST))('SNAP-1 — the export command', { timeout: 20_000 }, () => {
    it('writes a snapshot the loader accepts', async () => {
        const out = join(mkdtempSync(join(tmpdir(), 'snap-')), 'snapshot.json');
        const code = await new Promise<number | null>((resolve) => {
            const child = spawn(process.execPath, [BIN, '--locale', 'it', '--locale', 'de', '--category', 'UI', '--out', out], {
                env: { ...process.env, LANGSYS_PROJECT_ID: 'p', LANGSYS_API_KEY: 'rk', LANGSYS_BASE_LOCALE: 'en', LANGSYS_API_URL: double.baseUrl },
                stdio: 'ignore',
            });
            child.once('exit', resolve);
        });
        expect(code).toBe(0);
        const snap = parseSnapshot(readFileSync(out, 'utf8'));
        expect(snap.catalog).toEqual({ it: { UI: (await apiCatalog('it')).UI }, de: { UI: (await apiCatalog('de')).UI } });
    });
});

/**
 * The core's `snapshot-vectors.json`, vendored by blob `594bd77a0289abfdf608508ac93cc9f4c4f88459` (core
 * `a639ae8c`): 8 exact-bytes rows, 4 refusals, 1 reordered load. The serialisation is the core's
 * own `canonicalSnapshotJson`; before this package took it from `/pure`, its independent
 * implementation agreed with all 13 rows.
 */
const SNAPSHOT_VECTORS = new URL('../node_modules/langsys-js-typescript/tests/fixtures/snapshot-vectors.json', import.meta.url);
const sv = JSON.parse(readFileSync(SNAPSHOT_VECTORS, 'utf8'));

describe('snapshot-vectors.json', () => {
    it('is the blob this package is pinned to', () => {
        const raw = readFileSync(SNAPSHOT_VECTORS);
        expect(createHash('sha1').update(`blob ${raw.length}\0`).update(raw).digest('hex')).toBe('594bd77a0289abfdf608508ac93cc9f4c4f88459');
        expect([sv.rows.length, sv.refusals.length, sv.loads.length]).toEqual([8, 4, 1]);
    });
    it.each(sv.rows.map((r: { id: string }) => [r.id, r]))('row: %s', (_id, r: { document: Record<string, unknown>; canonical: string; checksum: string }) => {
        const { format: _f, version: _v, checksum: _c, ...payload } = r.document;
        const canon = canonicalSnapshotJson(payload);
        expect(canon).toBe(r.canonical);
        expect('sha256:' + createHash('sha256').update(canon, 'utf8').digest('hex')).toBe(r.checksum);
        expect(parseSnapshot(r.document).checksum).toBe(r.checksum);
    });
    it.each(sv.refusals.map((r: { id: string }) => [r.id, r]))('refusal: %s', (_id, r: { document: unknown; refuse: string }) => {
        let caught: unknown;
        try {
            parseSnapshot(r.document);
        } catch (e) {
            caught = e;
        }
        expect(caught).toBeInstanceOf(SnapshotError);
        expect((caught as SnapshotError).reason).toBe(r.refuse);
    });
    it.each(sv.loads.map((r: { id: string }) => [r.id, r]))('load: %s', (_id, r: { document: unknown; locale: string; expect_catalog: unknown }) => {
        expect(parseSnapshot(r.document).catalog[r.locale]).toEqual(r.expect_catalog);
    });
});
