import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';

/**
 * The fleet's API contract double (spec CONF-2), vendored byte-exact from
 * `langsys-js-typescript` and cited by git tree: `542f57f5ffcb9038db1b7411152b7e31b96cb269`
 * (`contract-fixture/` at `be6ccd72`). The tree hash is recomputed here from the vendored
 * files, so an edit, a missing file or an extra one fails this test rather than quietly
 * forking the double every SDK is graded against.
 */
const DIR = new URL('../contract-fixture/', import.meta.url);
const PINNED_TREE = '542f57f5ffcb9038db1b7411152b7e31b96cb269';

function gitBlob(raw: Buffer): Buffer {
    return createHash('sha1').update(`blob ${raw.length}\0`).update(raw).digest();
}

function gitTree(entries: { name: string; blob: Buffer }[]): string {
    const body = Buffer.concat(
        [...entries]
            .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
            .map((e) => Buffer.concat([Buffer.from(`100644 ${e.name}\0`), e.blob])),
    );
    return createHash('sha1').update(`tree ${body.length}\0`).update(body).digest('hex');
}

describe('vendored contract double', () => {
    it('is byte-exact to the pinned tree', () => {
        const entries = readdirSync(DIR).map((name) => ({ name, blob: gitBlob(readFileSync(new URL(name, DIR))) }));
        expect(gitTree(entries)).toBe(PINNED_TREE);
    });

    it('CONTROL: one changed byte moves the tree hash', () => {
        const entries = readdirSync(DIR).map((name) => {
            const raw = readFileSync(new URL(name, DIR));
            return { name, blob: gitBlob(name === 'README.md' ? Buffer.concat([raw, Buffer.from(' ')]) : raw) };
        });
        expect(gitTree(entries)).not.toBe(PINNED_TREE);
    });
});
