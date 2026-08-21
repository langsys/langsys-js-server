/**
 * Cross-runtime conformance.
 *
 * This package claims Node, Deno, Bun and Cloudflare Workers. That claim is load-bearing
 * in a way that is easy to miss: SPEC §11 resolves the package NAME on it. `-server`
 * rather than `-node` is only honest if the thing actually runs off Node — otherwise the
 * narrower name is the correct one, and it is free to change now and expensive later.
 *
 * So the claim gets executed rather than reasoned about.
 *
 * Run by `_dev_/runtime-conformance.sh`, which executes this file under every available
 * runtime and requires the DIGESTS TO MATCH. That is the real assertion: it is not
 * enough for each runtime to pass its own checks independently, because the failure that
 * matters is a runtime computing a *different* `custom_id` for the same input. A block
 * registered from a Node worker and read from a Deno worker must resolve.
 *
 * Imports the BUILT dist, not `src/` — that is what a user installs.
 */

const results = [];
let failed = 0;

function check(name, actual, expected) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    const ok = a === e;
    if (!ok) failed++;
    results.push({ name, ok, ...(ok ? {} : { actual: a, expected: e }) });
    return ok;
}

function record(name, value) {
    // Values that must be IDENTICAL across runtimes but whose expected value is not
    // hardcoded here — the cross-runtime diff is what checks them.
    results.push({ name, ok: true, digest: value });
}

const runtime =
    typeof Deno !== 'undefined' ? `deno ${Deno.version.deno}`
    : typeof Bun !== 'undefined' ? `bun ${Bun.version}`
    : typeof navigator !== 'undefined' && navigator.userAgent?.includes('Cloudflare') ? 'workerd'
    : typeof process !== 'undefined' && process.versions?.node ? `node ${process.versions.node}`
    : 'unknown';

export async function runConformance(mod) {
    const {
        createLangsysServer,
        t,
        tokenizeHtml,
        generateCustomId,
        generateLegacyCustomId,
        deriveBlockIdentity,
        interpolate,
        canonicalizeLocale,
        auditRenderedHtml,
        TRANSLATABLE_ATTRIBUTES,
    } = mod;

    // ---------------------------------------------------------------- 1. import
    // Positive evidence the module graph resolved. On Workers this is where a missing
    // `nodejs_compat` flag fails, and it fails at import time rather than at use.
    check('module exports createLangsysServer', typeof createLangsysServer, 'function');
    check('module exports t', typeof t, 'function');
    check('attribute list survived bundling', TRANSLATABLE_ATTRIBUTES.length, 15);

    // -------------------------------------------------- 2. identity (THE check)
    // If any of these differ between runtimes, catalogs fragment along runtime lines —
    // a class of bug nobody would think to look for.
    const tokens = tokenizeHtml('<p>Based on <b>5</b> reviews</p><img alt="Café ☕">');
    check('tokenizer output', tokens, ['Based on', '5', 'reviews', 'Café ☕']);
    record('custom_id:ascii', generateCustomId('marketing', ['Hello', 'world']));
    record('custom_id:unicode', generateCustomId('', ['Café', '日本語', '👍🏽']));
    record('custom_id:from-html', generateCustomId('marketing', tokens));
    record('legacy_custom_id:unicode', generateLegacyCustomId('', ['Café', '日本語']));

    // md5 over UTF-8 vs UTF-16 is exactly where a runtime's TextEncoder could differ.
    check(
        'utf8 and utf16 hashes differ for non-ascii',
        generateCustomId('', ['Café']) !== generateLegacyCustomId('', ['Café']),
        true,
    );

    const identity = deriveBlockIdentity('<p>Keep</p><script>var a=1;</script>', 'cat');
    record('derivation:primary', identity.primary.id);
    record('derivation:fallback-ids', identity.fallbacks.map((f) => `${f.label}:${f.id}`).join(','));
    check('script content is skipped', identity.primary.tokens, ['Keep']);
    check('fallback reproduces the sibling output', identity.fallbacks[0].tokens, ['Keep', 'var a=1;']);

    // -------------------------------------------------------------- 3. Intl
    // Intl is a common source of cross-runtime drift, and plural selection feeds
    // user-visible copy.
    check('canonicalizeLocale', canonicalizeLocale('en_gb'), 'en-GB');
    check('canonicalizeLocale zh', canonicalizeLocale('zh_hans_cn'), 'zh-Hans-CN');
    const ru = '{n, plural, one {# элемент} few {# элемента} many {# элементов} other {# элемента}}';
    check('ICU plural ru one', interpolate(ru, { n: 1 }, 'ru'), '1 элемент');
    check('ICU plural ru few', interpolate(ru, { n: 3 }, 'ru'), '3 элемента');
    check('ICU plural ru many', interpolate(ru, { n: 8 }, 'ru'), '8 элементов');
    check('simple interpolation', interpolate('Hello {name}', { name: 'Bob' }, 'en'), 'Hello Bob');

    // ---------------------------------------------- 4. AsyncLocalStorage isolation
    // The reason this package exists. Needs an await between write and read, which is
    // what makes it load-dependent and invisible with one user.
    const CATALOGS = {
        it: { __uncategorized__: { Hello: 'Ciao' } },
        de: { __uncategorized__: { Hello: 'Hallo' } },
        fr: { __uncategorized__: { Hello: 'Bonjour' } },
    };

    const fetchImpl = async (url) => {
        const href = String(url);
        if (href.includes('authorize-project')) {
            return new Response(JSON.stringify({ status: true, data: { key_type: 'read' } }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        }
        const locale = new URL(href).searchParams.get('locale');
        // Stagger so the renders genuinely interleave.
        await new Promise((r) => setTimeout(r, { it: 20, de: 5, fr: 12 }[locale] ?? 0));
        return new Response(JSON.stringify({ status: true, data: CATALOGS[locale] ?? {} }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        });
    };

    const langsys = createLangsysServer({
        projectId: 'p',
        apiKey: 'k',
        baseLocale: 'en',
        fetch: fetchImpl,
    });

    const render = (locale) =>
        langsys.run({ locale }, async () => {
            const a = t('Hello');
            await new Promise((r) => setTimeout(r, 8));
            const b = t('Hello');
            await new Promise((r) => setTimeout(r, 3));
            return [a, b, t('Hello')];
        });

    const [it, de, fr] = await Promise.all([render('it'), render('de'), render('fr')]);
    check('ALS isolation it', it.value, ['Ciao', 'Ciao', 'Ciao']);
    check('ALS isolation de', de.value, ['Hallo', 'Hallo', 'Hallo']);
    check('ALS isolation fr', fr.value, ['Bonjour', 'Bonjour', 'Bonjour']);

    // Higher concurrency, since a single trio can pass by luck of scheduling.
    const many = await Promise.all(
        Array.from({ length: 60 }, (_, i) => {
            const locale = ['it', 'de', 'fr'][i % 3];
            return langsys.run({ locale }, async () => {
                await new Promise((r) => setTimeout(r, i % 5));
                return { locale, value: t('Hello') };
            });
        }),
    );
    const expectedFor = { it: 'Ciao', de: 'Hallo', fr: 'Bonjour' };
    check(
        'ALS isolation under 60 interleaved requests',
        many.every((r) => r.value.value === expectedFor[r.value.locale]),
        true,
    );

    // ------------------------------------------------------ 5. harvest scheduling
    // `setImmediate` does not exist on Deno or Workers; the fallback must still fire.
    const drained = await new Promise((resolve) => {
        let seen = false;
        const harvestFetch = async (url, init) => {
            const href = String(url);
            if (href.includes('authorize-project')) {
                return new Response(JSON.stringify({ status: true, data: { key_type: 'write' } }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                });
            }
            if (href.includes('translatable-items')) {
                seen = JSON.parse(String(init.body)).translatable_items.length;
                resolve(seen);
                return new Response(JSON.stringify({ status: true }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                });
            }
            return new Response(JSON.stringify({ status: true, data: {} }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        };
        const harvester = createLangsysServer({
            projectId: 'p',
            apiKey: 'k',
            baseLocale: 'en',
            fetch: harvestFetch,
        });
        harvester.run({ locale: 'it' }, () => {
            t('Alpha');
            t('Beta');
            for (let i = 0; i < 20; i++) t('Alpha'); // dedup
        });
        setTimeout(() => { if (!seen) resolve(-1); }, 3000);
    });
    check('harvest drained after response, deduplicated', drained, 2);

    // ------------------------------------------------------------- 6. audit
    check('audit finds a phrase marker', auditRenderedHtml('<span data-ls-phrase>x</span>').clean, false);
    check('audit reports clean html as clean', auditRenderedHtml('<p>hi</p>').clean, true);

    return {
        runtime,
        failed,
        total: results.length,
        results,
        // Everything identity-bearing, in one string, so the driver can diff runtimes
        // with a single comparison.
        digest: results.filter((r) => r.digest).map((r) => `${r.name}=${r.digest}`).join('|'),
    };
}

export { runtime };
