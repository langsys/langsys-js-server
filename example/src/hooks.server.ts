/**
 * The whole server-side integration.
 *
 * `run()` wraps `resolve(event)`, which is the ENTIRE render — including every `load`
 * function. That placement matters and is not a style choice:
 *
 *   `load` runs BEFORE layout components. A `run()` in a root layout would leave every
 *   `load` outside the scope, and `load` is exactly where <title>, meta and OG copy get
 *   built — the indexed strings this package exists for. Those would silently render
 *   base language, which is the original defect arriving through a new door.
 *
 * `t()` outside a scope does not throw; it returns the base phrase and warns once. That
 * is the right degraded behaviour, but it means a too-narrow `run()` fails QUIETLY in
 * production and looks perfect in the base locale.
 */
import type { Handle } from '@sveltejs/kit';
import { langsys, BASE_LOCALE, isLocale } from '$lib/langsys';

export const handle: Handle = async ({ event, resolve }) => {
    // Locale from the URL, not from content negotiation. Deterministic locale resolution
    // is a hard requirement for the hydration hand-off: the client must seed the SAME
    // catalog the server rendered against.
    const segment = event.url.pathname.split('/')[1];
    const locale = isLocale(segment) ? segment : BASE_LOCALE;

    // Seed `locals` BEFORE the render, not after.
    //
    // `+layout.server.ts` reads these during `resolve(event)`. Assigning them afterwards
    // meant the payload serialised `{langsysCatalog: undefined, langsysLocale: undefined}`
    // — the hand-off the comment claimed to perform never happened, and nothing failed,
    // because no test asserted it. `app.d.ts` typed the field as non-optional `Catalog`,
    // so TypeScript agreed with the comment rather than with the bytes.
    event.locals.langsysLocale = locale;
    event.locals.langsysCatalog = await langsys.preloadCatalog(locale);

    const { value } = await langsys.run(
        { locale, catalog: event.locals.langsysCatalog },
        () =>
            resolve(event, {
                transformPageChunk: ({ html }) => html.replace('%lang%', locale),
            }),
    );

    return value;
};
