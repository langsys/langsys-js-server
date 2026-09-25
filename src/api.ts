/**
 * API client — stateless by construction.
 *
 * The base SDK's `LangsysAppAPI` is a module singleton whose `setup()` overwrites
 * `this.headers['x-Authorization']`, and `validate()` calls `setup()`. Two concurrent
 * requests for different projects race on **which API key goes out on the wire** — a
 * wrong-tenant read, which is strictly worse than a wrong-language render.
 *
 * So this client holds its config as constructor-injected `readonly` fields and never
 * mutates them. One instance per `createLangsysServer()` call, no shared state, no
 * `setup()`.
 *
 * Endpoints and headers were verified against `langsys-js-typescript@0.6.5`
 * `dist/index.mjs:88-133`. That artifact is no longer what this package consumes — identity
 * now comes from the core's `/pure` subpath — so treat the citation as the provenance of
 * these endpoint strings at the time they were written, not as a live pin.
 */

import { canonicalizeLocale } from 'langsys-js-typescript/pure';
import type { Catalog, KeyType } from './types.js';

export const DEFAULT_API_URL = 'https://api.langsys.dev/api';

export interface ApiResponse<T = unknown> {
    status: boolean;
    data?: T;
    errors?: unknown;
    /**
     * The session's write capability, as `/translations` and `/translations/data` report
     * it: at ENVELOPE level, a sibling of `data`.
     *
     * `authorize-project/{id}` puts its copy INSIDE `data` instead, beside `key_type` —
     * see `authorize()`. The asymmetry is the whole trap: read the wrong level and the
     * value is `undefined`, which is indistinguishable from a server that never sent it,
     * and the gate silently closes.
     *
     * Typed `unknown` deliberately, so every read goes through `readWriteEnabled()`
     * rather than being coerced at the call site.
     */
    write_enabled?: unknown;
}

/**
 * The write decision carried by a response, distinguishing **false** from **absent**.
 *
 * Only a real boolean counts as an answer. A non-boolean is treated as absent rather than
 * coerced, because the coercion is unsafe in the direction that matters: the string
 * `"false"` is truthy, and reading it as permission converts a closed gate into an open
 * one — the single failure the capability family exists to prevent. Absent then routes to
 * GATE-8, which is bounded and only ever opens for a plain `write` key.
 */
export function readWriteEnabled(source: unknown): boolean | undefined {
    if (typeof source !== 'object' || source === null) return undefined;
    const value = (source as { write_enabled?: unknown }).write_enabled;
    return typeof value === 'boolean' ? value : undefined;
}

/**
 * The server's cap on registration batch size, read from
 * `langsys_settings.translatable_items.batch_limit` on the authorize response.
 *
 * **Nested exactly that deep, and reading one level short is the failure mode.** It
 * returns `undefined`, the SDK silently keeps its own default, and nothing distinguishes
 * that from a server that sent no limit — until the server lowers the cap, at which point
 * oversized batches are REJECTED and registration fails wholesale rather than degrading.
 * Confirmed against `langsys-php`'s `syncBatchLimit()` and the JS core's `langsys-app.ts`.
 *
 * Only a finite number of at least 1 is an answer. `0` and negatives would chunk into
 * empty batches forever, and a non-number is a malformed payload, not a cap — all three
 * route to the default rather than being coerced into one. Floored rather than rejected
 * for a fractional value, because `5.5` still means the server will refuse at 6.
 */
/** The project's served locales from an authorize payload: its base, then its targets. */
function readLocales(data: { base_locale?: unknown; target_locales?: unknown } | undefined): string[] | undefined {
    if (!data || typeof data.base_locale !== 'string') return undefined;
    const targets = Array.isArray(data.target_locales) ? data.target_locales.filter((l): l is string => typeof l === 'string') : [];
    const out: string[] = [];
    for (const raw of [data.base_locale, ...targets]) {
        try {
            const l = canonicalizeLocale(raw);
            if (l && !out.includes(l)) out.push(l);
        } catch {
            // An unparseable locale is not served.
        }
    }
    return out;
}

export function readBatchLimit(source: unknown): number | undefined {
    if (typeof source !== 'object' || source === null) return undefined;
    const settings = (
        source as { langsys_settings?: { translatable_items?: { batch_limit?: unknown } } }
    ).langsys_settings;
    const value = settings?.translatable_items?.batch_limit;
    return typeof value === 'number' && Number.isFinite(value) && value >= 1
        ? Math.floor(value)
        : undefined;
}

/** What `authorize()` learned about this session. */
export interface AuthorizeResult {
    status: boolean;
    keyType: KeyType;
    /** `undefined` means the field was ABSENT — a pre-capability server. See GATE-8. */
    writeEnabled: boolean | undefined;
    /** `undefined` means the server advertised no usable cap; the caller applies its default. */
    batchLimit: number | undefined;
    /** The project's base and target locales, canonical; `undefined` when not advertised. */
    locales: string[] | undefined;
}

export interface TranslatableItem {
    type: 'phrase' | 'content_block';
    phrase?: string;
    category?: string;
    custom_id?: string;
    content?: string;
    label?: string;
    phrases?: { phrase: string }[];
}

export class LangsysApi {
    private readonly apiUrl: string;
    private readonly headers: Readonly<Record<string, string>>;

    constructor(
        /**
         * Readable so `CatalogStore` can namespace its cache keys by project (CACHE-1)
         * from the same source of truth the wire uses. Two fields holding "the project"
         * is how a key and a request drift apart.
         */
        readonly projectId: string | number,
        apiKey: string,
        apiUrl: string = DEFAULT_API_URL,
        private readonly fetchImpl: typeof globalThis.fetch = globalThis.fetch,
    ) {
        this.apiUrl = apiUrl.replace(/\/$/, '');
        this.headers = Object.freeze({
            'Content-Type': 'application/json; charset=utf-8',
            'x-Authorization': apiKey,
            // Declare ICU MessageFormat rendering so the server sends raw ICU
            // (plural/select) instead of flat-template downgrades. Omitting this
            // silently downgrades every plural — and a flat template renders fine in
            // English, which is why it must be sent rather than assumed.
            'X-Langsys-Capabilities': 'icu',
        });
    }

    /**
     * The session's capability and key type, discovered rather than configured.
     *
     * **The flag is read from inside `data`, not off the envelope.** This endpoint is the
     * one that nests it, and GATE-4 turns on the same asymmetry: an SDK that caches
     * `data` wholesale persists the write decision, which is address-dependent and must
     * not outlive the request. Nothing is cached here — the payload is projected to the
     * three fields below and the body is dropped — so there is no artifact left holding
     * it.
     */
    async authorize(): Promise<AuthorizeResult> {
        const res = await this.get(`authorize-project/${this.projectId}`);
        const data = res.data as { key_type?: string; base_locale?: unknown; target_locales?: unknown } | undefined;
        const raw = data?.key_type;
        const keyType: KeyType =
            raw === 'write' || raw === 'read' || raw === 'ip_write' ? raw : 'unknown';
        return {
            status: res.status,
            keyType,
            writeEnabled: readWriteEnabled(data),
            batchLimit: readBatchLimit(data),
            locales: readLocales(data),
        };
    }

    async getTranslations(locale: string): Promise<ApiResponse<Catalog>> {
        return this.get('translations', {
            project_id: String(this.projectId),
            locale: canonicalizeLocale(locale),
        }) as Promise<ApiResponse<Catalog>>;
    }

    async createTranslatableItems(items: TranslatableItem[]): Promise<ApiResponse> {
        return this.send('POST', 'translatable-items', {
            project_id: this.projectId,
            translatable_items: items,
        });
    }

    private async get(path: string, query: Record<string, string> = {}): Promise<ApiResponse> {
        const qs = new URLSearchParams(query).toString();
        return this.send('GET', qs ? `${path}?${qs}` : path);
    }

    private async send(method: 'GET' | 'POST', path: string, body?: unknown): Promise<ApiResponse> {
        const response = await this.fetchImpl(`${this.apiUrl}/${path}`, {
            method,
            headers: this.headers,
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });

        if (!response.ok) {
            return { status: false, errors: [`HTTP ${response.status} ${response.statusText}`] };
        }

        // WIRE-2 — branch on STATUS before parsing. Some endpoints answer 204 with no content
        // type and a zero-length body, and parsing that unconditionally threw on a SUCCESS: the
        // drain logged an accepted registration as failed and, since REG-8, backed off on it.
        if (response.status === 204) return { status: true };

        const json = (await response.json()) as ApiResponse;
        return json;
    }
}
