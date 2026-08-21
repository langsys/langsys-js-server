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
 * Endpoints and headers verified against `langsys-js-typescript@0.6.5`
 * `dist/index.mjs:88-133`.
 */

import { canonicalizeLocale } from './vendor/pure.js';
import type { Catalog, KeyType } from './types.js';

export const DEFAULT_API_URL = 'https://api.langsys.dev/api';

export interface ApiResponse<T = unknown> {
    status: boolean;
    data?: T;
    errors?: unknown;
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
        private readonly projectId: string | number,
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

    /** Returns the project's key type, discovered rather than configured. */
    async authorize(): Promise<{ status: boolean; keyType: KeyType }> {
        const res = await this.get(`authorize-project/${this.projectId}`);
        const data = res.data as { key_type?: string } | undefined;
        const raw = data?.key_type;
        const keyType: KeyType = raw === 'write' || raw === 'read' ? raw : 'unknown';
        return { status: res.status, keyType };
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

        const json = (await response.json()) as ApiResponse;
        return json;
    }
}
