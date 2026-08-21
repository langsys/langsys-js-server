/**
 * Acceptance smoke run against the EXTRACTED TARBALL.
 *
 * Every other suite in this repo drives the working tree. This one drives what `npm pack`
 * produces, installed into an empty project that resolves only the package's DECLARED
 * dependencies. The two artifacts are not the same thing, and the ways they differ are
 * invisible from the working tree:
 *
 *   - a source directory missing from the `files` allowlist (crash on first require)
 *   - a runtime import that is only in devDependencies (unresolvable for a consumer)
 *   - an `exports` map whose `require` or `import` condition points at a file not shipped
 *
 * `langsys-skill` shipped a version that crashed on first run for exactly the first
 * reason, past a suite that was green against its working tree.
 *
 * Run via `_dev_/tarball-acceptance.sh`, which does the pack/install and passes the
 * package name in. Invoked directly it will fail to resolve the import, which is correct.
 */
import {
    createLangsysServer,
    t,
    tokenizeHtml,
    generateCustomId,
    auditRenderedHtml,
    TRANSLATABLE_ATTRIBUTES,
} from 'langsys-js-server';

let failures = 0;

function check(name, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) {
        console.log(`  ok   ${name}`);
    } else {
        failures++;
        console.log(`  FAIL ${name}`);
        console.log(`       expected ${JSON.stringify(expected)}`);
        console.log(`       actual   ${JSON.stringify(actual)}`);
    }
}

const catalog = { __uncategorized__: { Hello: 'Ciao', 'Hi {n}': 'Ciao {n}' } };
const fetchImpl = async (url) =>
    String(url).includes('authorize-project')
        ? new Response(JSON.stringify({ status: true, data: { key_type: 'read' } }), { status: 200 })
        : new Response(JSON.stringify({ status: true, data: catalog }), { status: 200 });

const langsys = createLangsysServer({ projectId: 'p', apiKey: 'k', baseLocale: 'en', fetch: fetchImpl });

// A real render through the AsyncLocalStorage scope — the whole reason this package exists
// separately, and the thing a missing shim or unresolvable import breaks first.
const hit = await langsys.run({ locale: 'it' }, () => t('Hello'));
check('run() resolves a translation', hit.value, 'Ciao');
check('RenderResult carries the locale', hit.locale, 'it');
check('RenderResult carries the catalog', hit.catalog.__uncategorized__.Hello, 'Ciao');

const interpolated = await langsys.run({ locale: 'it' }, () => t('Hi {n}', { n: 3 }));
check('interpolates through the scope', interpolated.value, 'Ciao 3');

const missed = await langsys.run({ locale: 'it' }, () => t('Unregistered copy'));
check('a miss falls back to the phrase', missed.value, 'Unregistered copy');
check('a miss is queued for harvest', missed.missing.map((m) => m.phrase), ['Unregistered copy']);

// Request isolation. A module-global would make these two agree.
const [it, de] = await Promise.all([
    langsys.run({ locale: 'it' }, async () => {
        await new Promise((r) => setTimeout(r, 10));
        return t('Hello');
    }),
    langsys.run({ locale: 'de' }, () => t('Hello')),
]);
check('concurrent scopes do not leak locale', [it.locale, de.locale], ['it', 'de']);

// The identity path. Printed rather than pinned to a literal: the value is asserted
// against the published base SDK by tests/conformance/vendor-parity.test.ts, and pinning
// it twice from the same memory would only assert this file agrees with itself.
const tokens = tokenizeHtml('<p>Based on <b>5</b> reviews</p>');
check('tokenizer discriminates arity', tokens.length > 1, true);
console.log(`  DIGEST ${generateCustomId('__uncategorized__', tokens)}`);

// Documented audit behaviour: <Translate> stamps no marker, so it is invisible by default.
check('audit finds no content block by default', auditRenderedHtml('<div data-ls-contentblock>x</div>').clean, true);
check(
    'audit finds one the caller names',
    auditRenderedHtml('<div data-b>x</div>', undefined, { contentBlockAttributes: ['data-b'] }).clean,
    false,
);

check('ships the 15-attribute list', TRANSLATABLE_ATTRIBUTES.length, 15);

console.log(failures === 0 ? 'TARBALL SMOKE PASS' : `TARBALL SMOKE FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
