import type { LayoutServerLoad } from './$types';

/**
 * Pass the server's catalog to the client so it can seed hydration with the SAME
 * catalog the server rendered against.
 */
export const load: LayoutServerLoad = async ({ locals }) => ({
    langsysCatalog: locals.langsysCatalog,
    langsysLocale: locals.langsysLocale,
});
