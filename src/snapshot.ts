/**
 * The catalog snapshot format every SDK writes and reads (SNAP-1): `langsys-catalog-snapshot`
 * version 1, checksummed over a canonical serialisation every core computes byte for byte.
 */
import type { Catalog } from './types.js';

export const SNAPSHOT_FORMAT = 'langsys-catalog-snapshot';
export const SNAPSHOT_VERSION = 1;

export interface CatalogSnapshot {
    format: typeof SNAPSHOT_FORMAT;
    version: typeof SNAPSHOT_VERSION;
    project_id: string;
    /** UTC, `YYYY-MM-DDTHH:MM:SSZ`. */
    generated_at: string;
    base_locale: string;
    /** Lowercase `xx-yy`, ascending. */
    locales: string[];
    /** Ascending. */
    categories: string[];
    /** Locale → category → that category's flat entries, exactly as `GET /translations` returns them. */
    catalog: Record<string, Catalog>;
    /** `sha256:` and the lowercase hex digest of the canonical serialisation of the members above. */
    checksum: string;
}

/** The members the checksum covers: every member except `format`, `version` and `checksum`. */
const HASHED = ['project_id', 'generated_at', 'base_locale', 'locales', 'categories', 'catalog'] as const;

/**
 * Order by Unicode code point, which is UTF-8 byte order. JavaScript's default `sort()` compares
 * UTF-16 code units, which puts a key above U+FFFF (a surrogate pair, 0xD8xx) before one in
 * U+E000–U+FFFF; comparing code points puts it after, as every other core does.
 */
export function byCodePoint(a: string, b: string): number {
    const x = Array.from(a);
    const y = Array.from(b);
    for (let i = 0; i < Math.min(x.length, y.length); i++) {
        const d = x[i]!.codePointAt(0)! - y[i]!.codePointAt(0)!;
        if (d !== 0) return d;
    }
    return x.length - y.length;
}

const SHORT_ESCAPES: Record<string, string> = { '\b': '\\b', '\t': '\\t', '\n': '\\n', '\f': '\\f', '\r': '\\r' };

/** CID-1's escaping: `"`, `\` and U+0000–U+001F only; everything else is raw UTF-8. */
function quote(s: string): string {
    let out = '"';
    for (const ch of s) {
        const code = ch.codePointAt(0)!;
        if (ch === '"') out += '\\"';
        else if (ch === '\\') out += '\\\\';
        else if (code < 0x20) out += SHORT_ESCAPES[ch] ?? `\\u00${code.toString(16).padStart(2, '0')}`;
        else out += ch;
    }
    return out + '"';
}

/**
 * The canonical serialisation, built by hand rather than with `JSON.stringify`, which would move
 * integer-like keys (`"404"`) ahead of the rest whatever order they were inserted in. No
 * whitespace; members in code point order; a map is `{}` even when empty.
 */
export function canonicalSnapshotJson(value: unknown): string {
    if (value === null) return 'null';
    if (typeof value === 'string') return quote(value);
    if (Array.isArray(value)) return `[${value.map(canonicalSnapshotJson).join(',')}]`;
    if (typeof value === 'object') {
        const record = value as Record<string, unknown>;
        const keys = Object.keys(record).sort(byCodePoint);
        return `{${keys.map((k) => `${quote(k)}:${canonicalSnapshotJson(record[k])}`).join(',')}}`;
    }
    // Numbers and booleans do not occur in the hashed members; serialised plainly if they ever do.
    return JSON.stringify(value);
}

async function sha256Hex(text: string): Promise<string> {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function hashedMembers(doc: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(HASHED.map((k) => [k, doc[k]]));
}

/** Compute the checksum for a snapshot's hashed members. */
export async function snapshotChecksum(doc: Record<string, unknown>): Promise<string> {
    return `sha256:${await sha256Hex(canonicalSnapshotJson(hashedMembers(doc)))}`;
}

/**
 * Load a snapshot: refuse, naming the reason, a different `format`, an unsupported `version`, a
 * missing member, or a checksum that does not match — which is how an edited file is caught
 * (SNAP-3).
 */
export async function verifySnapshot(input: unknown): Promise<CatalogSnapshot> {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        throw new Error('Not a catalog snapshot: expected a JSON object.');
    }
    const doc = input as Record<string, unknown>;
    if (doc.format !== SNAPSHOT_FORMAT) throw new Error(`Not a catalog snapshot: format is ${JSON.stringify(doc.format)}, expected "${SNAPSHOT_FORMAT}".`);
    if (doc.version !== SNAPSHOT_VERSION) throw new Error(`Unsupported snapshot version ${JSON.stringify(doc.version)}; this SDK reads version ${SNAPSHOT_VERSION}.`);
    for (const member of [...HASHED, 'checksum'] as const) {
        if (!Object.prototype.hasOwnProperty.call(doc, member)) throw new Error(`Catalog snapshot is missing the "${member}" member.`);
    }
    const expected = await snapshotChecksum(doc);
    if (doc.checksum !== expected) {
        throw new Error('Catalog snapshot checksum does not match its contents: the file was edited. Re-export it instead.');
    }
    return doc as unknown as CatalogSnapshot;
}
