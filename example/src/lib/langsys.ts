/**
 * One server instance for the process.
 *
 * Safe to create at module scope BECAUSE this package holds no module-level mutable
 * state — the instance carries configuration and caches, never request data. Everything
 * request-varying lives in the AsyncLocalStorage scope opened by `run()`.
 *
 * That is the whole distinction from the client SDKs: creating their `LangsysApp` at
 * module scope on a server is what produces the cross-request race.
 */
import { createLangsysServer } from 'langsys-js-server';
import { env } from '$env/dynamic/private';

export const BASE_LOCALE = 'en';
export const LOCALES = ['en', 'it', 'de', 'ru'] as const;
export type Locale = (typeof LOCALES)[number];

export const langsys = createLangsysServer({
    projectId: env.LANGSYS_PROJECT_ID ?? 'example-project',
    apiKey: env.LANGSYS_API_KEY ?? 'example-key',
    baseLocale: BASE_LOCALE,
    apiUrl: env.LANGSYS_API_URL ?? 'http://localhost:5571/api',
    debug: env.LANGSYS_DEBUG === '1',
    // Short TTL so the example is pleasant to poke at. Production defaults to 300s.
    catalogTtlSeconds: Number(env.LANGSYS_TTL ?? 5),
});

export function isLocale(value: string | undefined): value is Locale {
    return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}
