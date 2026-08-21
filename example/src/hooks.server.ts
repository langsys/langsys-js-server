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

    const { value, catalog } = await langsys.run({ locale }, () =>
        resolve(event, {
            transformPageChunk: ({ html }) => html.replace('%lang%', locale),
        }),
    );

    // Hand the exact catalog this render used to the client, so hydration cannot disagree.
    event.locals.langsysCatalog = catalog;
    event.locals.langsysLocale = locale;

    return value;
};
