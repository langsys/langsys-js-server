import { t } from 'langsys-js-server';
import type { PageServerLoad } from './$types';

/**
 * `t()` called from a `load` function — no component context anywhere in sight.
 *
 * This is the case that makes AsyncLocalStorage a requirement rather than a
 * convenience: framework context (Svelte context, Vue provide, React context) cannot
 * reach here, and this is precisely where the crawler-visible strings are built.
 */
export const load: PageServerLoad = async () => ({
    // Indexed metadata. The original defect was that these rendered in English on every
    // non-base locale, and `curl` could not tell that from a working page.
    title: t('Hydration begins with better water.'),
    tagline: t('Trusted by professionals', 'marketing'),
    greeting: t('Welcome back, {name}', { name: 'Ada' }),
    bottles: t('{n, plural, one {# bottle} other {# bottles}}', { n: 3 }),
    cta: t('Shop now'),
    guide: t('Read the guide'),
    imageAlt: t('A glass of water'),
});
