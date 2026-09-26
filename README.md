# Langsys SDK — Server

[![npm](https://img.shields.io/npm/v/langsys-js-server.svg?style=flat)](https://www.npmjs.com/package/langsys-js-server)
[![build](https://img.shields.io/github/actions/workflow/status/langsys/langsys-js-server/ci.yml?style=flat)](https://github.com/langsys/langsys-js-server/actions)
[![last commit](https://img.shields.io/github/last-commit/langsys/langsys-js-server.svg?style=flat)](https://github.com/langsys/langsys-js-server/commits)
[![commit activity](https://img.shields.io/github/commit-activity/m/langsys/langsys-js-server.svg?style=flat)](https://github.com/langsys/langsys-js-server/pulse)
[![bundle size](https://img.shields.io/bundlejs/size/langsys-js-server?style=flat)](https://bundlejs.com/?q=langsys-js-server)
[![types](https://img.shields.io/npm/types/langsys-js-server.svg?style=flat)](https://www.npmjs.com/package/langsys-js-server)
[![downloads](https://img.shields.io/npm/dm/langsys-js-server.svg?style=flat)](https://www.npmjs.com/package/langsys-js-server)
[![license](https://img.shields.io/npm/l/langsys-js-server.svg?style=flat)](./LICENSE)

Server-side SDK for the [Langsys](https://langsys.dev/) Translation Manager. Renders **translated, crawler-visible HTML** during SSR — request-scoped, with no module-global state — on Node, Deno, Bun and Cloudflare Workers.

This is the Node sibling to `langsys-php`. The client SDKs (`langsys-js-typescript` and its `-react`, `-vue`, `-svelte` bindings) translate the DOM after hydration; this package translates the bytes a crawler receives, and hands its catalog to a client SDK to continue from.

## What's inside

- `createLangsysServer(config)` — one instance per server. Stateless HTTP client, no module-level mutable state, safe to create more than one.
- `langsys.run(options, fn)` — runs a render inside an `AsyncLocalStorage` request scope. Returns `{ value, catalog, locale, missing }`. This is the whole reason the package exists separately from the client SDKs.
- `t(phrase, category?, params?)` — the everyday translation function, ambient inside `run()`. Full ICU plurals and `{placeholder}` interpolation. Same signature as the base SDK's.
- `auditRenderedHtml(html)` — reports primitives this version does not translate server-side, so partial coverage is visible rather than silent.
- `tokenizeHtml` / `deriveBlockIdentity` — the content-block identity path, conformance-tested against the published client SDK so a block keys identically on both sides.
- Two runtime dependencies (`parse5`, `intl-messageformat`). Ships ESM and CJS with types.

## Why this exists

A production SvelteKit deployment measured its own HTML on a page serving Italian:
**5,031 characters of visible SSR body text, 100% English**, with the full Italian catalog
shipped inside a 133 KB inline hydration script. Worst of both — you pay to ship the
catalog and still render the base language.

The client SDKs cannot fix this, and the reason is not a bug. In `langsys-js-react`,
`-vue` and `-svelte` the catalog lives in module-global signals that only
`LangsysApp.init()` writes, and `init()` runs in a client-only lifecycle hook. None of
those execute during server rendering.

Moving `init()` to the server does not fix it — it breaks worse. Under a long-lived
server one process serves every concurrent request, so seeding those globals server-side
is a cross-request data race: an in-flight `/de` render can observe `/it`'s catalog. The
race needs an `await` between write and read, which every async `load` function provides.
**It is therefore load-dependent and cannot reproduce in development with one user.**

The precise problem is not "the singleton is a bug" — it is **there is no request-scoped
translator in the SDK**. A non-singleton class with module-global state races identically.

Module-global state is the *correct* design for a browser: one user, one locale, free
reactivity with no prop-drilling. This is a browser-shaped architecture meeting a server,
which is why this is a separate package rather than a patch.

| | Client SDKs | This package |
|---|---|---|
| State scope | module-global, ambient | **request-scoped, always** |
| Persistence | `localStorage` | none |
| Concurrency | one user | many, interleaved |
| Render target | DOM | string / stream |
| Harvest timing | batched, in-session | **fire-and-forget, after response** |

## Capability matrix — read this before adopting

**v0.1.0 does not translate everything.** Staged shipping is fine; silent partial
coverage is not, so here is exactly what works.

| Primitive | Server-rendered in 0.1.0 | What a crawler receives | How you would notice if it were wrong |
|---|---|---|---|
| `t(phrase, category?, params?)` | ✅ **Yes** | Translated | — |
| `<title>`, meta, OG, `alt` — anything built from `t()` | ✅ **Yes** | Translated | — |
| `<Phrase>` | ❌ **Not in 0.1.0** | **Base language** | `auditRenderedHtml()` lists it; view-source shows the base language |
| `<Translate>` | ❌ **Not in 0.1.0** | **Base language** | **Nothing signals it by default.** The host carries no marker, so the audit cannot see it — view-source, or pass `contentBlockAttributes` if your app marks its own hosts |

`t()` covers full ICU plurals and interpolation, and the `t()`-derived row is the indexed
copy that motivated the package. The right-hand column is the one to read twice: a
limitation you cannot detect is the failure mode this whole family keeps rediscovering,
and `<Translate>` is the row that has no detector.

`<Phrase>` and `<Translate>` need per-framework child-capture adapters, and the three
frameworks require three genuinely different mechanisms (Svelte: re-entrant `render()`;
Vue: async `setup()`; React: walking the element tree as data). They land in 0.2.0. The
tokenizer and `custom_id` derivation they depend on are already here and already
conformance-tested against the published client SDK.

**To find out what a given page is still missing, audit the rendered HTML:**

```ts
import { auditRenderedHtml } from 'langsys-js-server';

const { findings, clean } = auditRenderedHtml(html);
// findings: [{ kind: 'phrase', marker: 'data-ls-phrase', excerpt: 'Based on 5 reviews' }]
```

Run it in development. It is not called automatically — scanning every response would put
a parse in the TTFB path for a check that only matters while you are building.

> **It finds `<Phrase>` only, unless you help it.** A `<Translate>` content block stamps
> **no attribute on its host** — verified against the published SDK, where
> `data-ls-contentblock` and `data-langsys-contentblock` occur zero times and the only
> `setAttribute` calls are `src` on `<img>` and translated-attribute write-back. So
> `clean: true` means "no phrase markers found", not "nothing is untranslated". If your
> app marks its own block hosts, name the attribute:
> `auditRenderedHtml(html, logger, { contentBlockAttributes: ['data-block'] })`.

## Install

```bash
npm install langsys-js-server
```

### Runtime support — executed, not claimed

| Runtime | Status | Notes |
|---|---|---|
| Node ≥18 | ✅ verified | |
| Deno | ✅ verified | 2.7+ |
| Bun | ✅ verified | 1.3+ |
| Cloudflare Workers | ✅ verified | requires the `nodejs_compat` flag |

`npm run test:runtimes` executes an identical 26-check suite against the **built dist**
under every runtime installed locally (Workers via `miniflare`/`workerd`), and then
requires the identity digests to **match across runtimes**.

That last part is the real assertion. Each runtime passing its own checks is the lesser
half — the failure that would actually hurt is one runtime computing a *different*
`custom_id` for the same input, fragmenting catalogs along a line nobody would think to
look for. A runtime that is not installed reports `SKIPPED`, never a pass.

> This suite earned its place immediately. `src/context.ts` imports `node:async_hooks`
> correctly, but tsup 8 defaults `removeNodeProtocol` to true and shipped it as bare
> `async_hooks`. Node and Bun tolerate that; **Deno rejects it outright** and Workers
> require the prefix under `nodejs_compat`. Every source-level test passed. The package
> claimed four runtimes in its README, its `engines` field and its *name*, and ran on
> two. Nothing in the source was wrong, and no source-level test could have caught it —
> only executing the built artifact under Deno did.

## Quick start

```ts
import { createLangsysServer, t } from 'langsys-js-server';

const langsys = createLangsysServer({
    projectId: process.env.LANGSYS_PROJECT_ID!,
    apiKey: process.env.LANGSYS_API_KEY!,
    baseLocale: 'en',
});

// Per request. Everything inside resolves against THIS request's locale.
const { value, catalog, locale } = await langsys.run({ locale: 'it' }, async () => {
    const title = t('Welcome to our store');
    const cta = t('Shop {count} products', { count: 1420 });
    return renderPage({ title, cta });
});
```

`t()` is ambient inside `run()`. It works in `load` functions, in plain utility modules,
and anywhere else with no component context — which is the reason this uses
`AsyncLocalStorage` rather than framework context.

### SvelteKit

```ts
// src/hooks.server.ts
export const handle = async ({ event, resolve }) => {
    const locale = event.params.locale ?? 'en';
    const { value } = await langsys.run({ locale }, () => resolve(event));
    return value;
};
```

### Cloudflare Workers and other edge runtimes

`setImmediate` semantics do not exist there, and a Worker may be torn down the moment the
response is returned. Hand the drain to `waitUntil` instead:

```ts
const result = await langsys.run({ locale }, () => renderPage());
ctx.waitUntil(langsys.flush(result));
return new Response(result.value);
```

## Try it

A runnable SvelteKit example lives in [`example/`](./example), with a mock Langsys API so
it works offline:

```bash
npm run example:install
npm run test:e2e        # boots the built app and runs the SPEC §13 acceptance tests
```

Or run it by hand and look at the served bytes — which is the only place the difference
shows:

```bash
curl -s http://localhost:5570/it | grep '<h1'   # L'idratazione inizia con un'acqua migliore.
curl -s http://localhost:5570/ru | grep bottles # 3 бутылки  (the Russian FEW form)
```

The example is not published — `files` keeps it out of the npm tarball.

## Handing off to a client SDK

`run()` returns the catalog it rendered against. Seed the client with **that same
catalog**, or hydration will disagree:

```ts
const { value, catalog, locale } = await langsys.run({ locale: 'it' }, render);
// serialize `catalog` and `locale` into the page payload, then seed the client SDK
```

This makes deterministic locale resolution a hard requirement, which is a strong argument
for **locale in the URL** rather than content negotiation.

> **Known gap.** The client SDKs seed inside `init()`, which `await`s `validate()` before
> writing the catalog — so the seed lands after a network round-trip and after hydration.
> That is fine when the server emitted base language and a mismatch when it emitted
> Italian. A synchronous `seedCatalog(catalog, locale)` export has been proposed to the
> base SDK. Until it lands, expect a hydration flash on the first paint.

## Caching and freshness

**Server-side rendering does not make translations realtime. It shortens the fuse.**

| Layer | Default |
|---|---|
| In-process catalog memo | 5 minutes (only when no shared cache is configured) |
| Shared cache | your TTL, stamped absolutely at write time |
| Client SDK re-fetch window | 60 seconds |

### The multi-worker problem

Two PM2 instances mean two independent in-process caches. During propagation the same URL
alternates between old and new copy depending on which worker answers. To a non-engineer
that reads as **"my change didn't save."**

`langsys-php` does not have this problem, and the reason does not transfer: its memo is an
ordinary instance property, and under PHP-FPM the object dies with the request, so the
shared tier is the only cross-request tier *by construction*. Node has no such guarantee.

So configure a shared cache in any multi-worker deployment:

```ts
createLangsysServer({
    // ...
    cache: {
        get: (key) => redis.get(key),
        set: (key, value, ttlSeconds) => redis.set(key, value, 'EX', ttlSeconds),
        delete: (key) => redis.del(key),
    },
});
```

With a shared cache configured, **no process-level memo is kept at all**. A five-minute
process-lived memo sitting in front of a shared cache reintroduces exactly the
inconsistency the shared cache was added to remove.

Two properties this implementation guarantees:

- **Expiry is absolute**, stamped into the shared record at write time, so workers expire
  *together* rather than drifting by however long each has been up.
- **Concurrent misses are coalesced.** N concurrent renders missing the same locale make
  one API call, not N. (`langsys-php` does not do this; harmless at FPM's concurrency,
  not harmless at Node's.)

Invalidation targets the shared key, so one worker's invalidation is every worker's:

```ts
await langsys.invalidate('it');
```

## Harvesting

Runtime phrase discovery is the core product mechanic — the phrase *is* the key. A server
SDK that did not harvest would mean the strings most worth translating (indexed body copy,
titles, meta) are the ones that never self-register.

- **Request-scoped queue.** Never pooled across requests.
- **Never in the TTFB path.** Drained after the response flushes.
- **Deduplicated.** A page rendering the same missing phrase 50 times posts it once.
- **Write key only**, and it says so out loud.
- **Retried, not dropped.** A failed send pauses registration for 3s, doubling to 5 minutes; what
  did not go out stays with its request and is sent when the endpoint recovers, and a best-effort
  attempt runs when the process exits (`flushOnExit`). Not a guarantee: `flush(result)` is.

> **Harvesting requires a write key, which belongs in development.** A production
> deployment should run a **read-only** key. A write key in production registers phrases
> from live user traffic, and the catalog pollution is permanent and shared.

Under a read-only key the SDK refuses locally, never makes the call, and leaves the render
completely unaffected — a read-only key is correct production configuration, not an error.
It logs the refusal **once per instance, unconditionally**. (The base SDK gates the
equivalent log behind `if (debug)`; that is deliberately not copied. A log nobody sees by
default is the same as no log.)

> **When these warnings appear, and why silence is not an all-clear.** Neither warning is
> emitted at construction, so they will not be in your boot logs:
>
> - the missing-`cache` warning fires on the **first catalog resolution** — the first
>   `run()` or `preloadCatalog()`;
> - the read-only-key warning fires only when there is **a miss to drain**, and after the
>   response has flushed.
>
> So a page whose copy is fully translated never emits the second one. **Its absence tells
> you nothing about your key** — it means nothing needed registering. To check a key
> deliberately, render a phrase you know is unregistered and watch for it, rather than
> reading a quiet log as confirmation.

## Migrating from the interim `makeCatalogT` helper

If you are running the hand-rolled pure-lookup helper that `langsys-skill` currently
prescribes, migration is: delete the local `ct`/`makeCatalogT` and import `t` instead. Same
signature, same overloads, same fallback semantics.

> ⚠️ **Expect a burst of new registrations on your first deploy.** The interim helper does
> not harvest; `t()` does. Phrases that have been rendering server-side for months without
> ever registering will all register at once. That is the feature working, but unannounced
> it looks like a runaway write loop — and on a write key it is a permanent change to a
> shared catalog. **Do the first deploy with a read-only key** if you want to see the
> volume before committing to it.

## Known divergences

These are stated rather than discovered. Each one is asserted by a test, so if a sibling
SDK changes, the suite says so.

| Area | This package | Siblings | Why |
|---|---|---|---|
| `<script>` / `<style>` content | **Skipped** | Both harvest it | Neither sibling skips these on the content-block path, so analytics JS and CSS get queued for permanent catalog registration. The `langsys-php` owner confirmed the behaviour is a defect and explicitly asked this package not to reproduce it. Blocks are still *read* under the un-skipped derivation, so existing entries resolve. |
| Translatable attributes | **15** | PHP has 27 | The convergence on PHP's 27 is decided but not yet shipped by the client family. Hydration hand-off is a per-request event; PHP interop is a deployment-topology one — so matching the client family is the correct trade while it carries 15. Blocks are read under the 27 derivation too, so the eventual convergence is a no-op for lookups. |
| `&nbsp;` (U+00A0) | **Collapsed** | JS collapses, PHP retains | PHP normalises ASCII whitespace only, so `<p>&nbsp;</p>` is one token there and zero here. This package matches the client family it hydrates over. Unresolved product decision. |
| `content` snapshot | Unstyled, relative `img` URLs | Styled, absolute URLs | The base SDK inlines computed styles and absolutizes `img.src` from a *live mounted* element. With no DOM there is neither. **`tokens[]` and `custom_id` are unaffected** — `style` and `src` are not translatable attributes. `content` is a translator-facing snapshot, not an identity field, and should never be asserted on in a conformance fixture. |

### Marker emission

**0.1.0 emits no HTML at all**, so it emits no markers — `<Phrase>` and `<Translate>` land
in 0.2.0. What ships today is the decision, as the exported `PHRASE_MARKER_ATTRS_EMIT`
constant: when this package does emit, it will emit **both** `data-langsys-phrase` and
`data-ls-phrase`.

`langsys-php` does not recognise `data-ls-phrase` at all. Emitting only the JS spelling is
the single combination that is silently wrong in a topology that ships today — the
reference deployment runs `adapter-node` **behind a PHP proxy**, and a page passing through
a PHP layer calling `translatePage()` would have its kept-whole sentences re-split. The JS
reader accepts either spelling and the marker never enters `tokens[]`, so emitting both is
free.

Reading is live now: `tokenizeHtml` skips subtrees carrying either spelling.

## Migrating from i18n keys

A keyed codebase can move to Langsys without a codemod. Keep only the source-language file,
delete the others, and name it:

```ts
const langsys = createLangsysServer({
    // …
    legacyKeys: readLegacyKeyFiles([{ path: 'locales/en.json', format: 'i18next' }]),
});
```

`t('checkout.submit')` now registers and translates the file's value, `Pay now`, under the category
`checkout`, while `t('Pay now')` written the Langsys way keeps working beside it. The catalog only
ever holds source text, so a later codemod can inline the English and delete the file without any
phrase changing. A key missing from the file registers as literal text and is noted at debug; a
value the conversion cannot read registers as written, with a warning naming the file and key.
Files in formats this package does not read are refused at startup. Leave `legacyKeys` unset once
the migration is done, and `t()` does no key lookup at all.

## Server messages

Validation errors never appear on a page before a user triggers them, so they cannot be discovered
by rendering; the server registers them. What translation needs from a failure is its
**template** — the framework's own sentence before its values are filled, with the field's label
written in (`The password field must be at least {min} characters.`), each non-translatable value
a `{name}` marker — and the **params** that fill it. Everything else stays the framework's: its
error body, its field paths, and its own identifier for the failure as `code`.

```ts
const entry = langsys.message({
    field: 'password',
    code: 'minLength', // the framework's own identifier, passed through; omit it when there is none
    template: 'The password field must be at least {min} characters.',
    params: { min: 12 },
});
// entry.message === 'The password field must be at least 12 characters.'
return json(langsys.attachMessages(frameworkErrorBody, [entry]), { status: 422 });
```

`attachMessages` returns the framework's body unchanged apart from the entries, added under
`langsys_errors` (or a `key` you choose, and piece names of your own through `pieces`); clients
resolve them through the same configuration and render
`t(template, 'Errors', params)`, falling back to `message`. A template the catalog does not list is
registered the first time it is emitted. To register them ahead of time, list them in a module and
run the build-time command; it reports any template it cannot register — one still holding a
validator's label placeholder such as `$property`, `${path}` or `{{#label}}` — and exits non-zero
for that only with `--strict`:

```sh
LANGSYS_PROJECT_ID=… LANGSYS_API_KEY=<write key> npx langsys-messages ./messages.mjs --register
```

## Catalog snapshots

For a setup that should not call the API on the render path — a mobile bundle, first paint, an
air-gapped deploy — export the catalog for a locale and load it as the client's preloaded catalog:

```sh
LANGSYS_PROJECT_ID=… LANGSYS_API_KEY=… npx langsys-snapshot --locale it --locale de --category UI --category Errors --out snapshot.json
```

The file is a `langsys-catalog-snapshot` v1 document, the format every Langsys SDK writes and
loads. A snapshot is a cache of the catalog, not a source: it is refreshed by exporting again,
never by editing, and its checksum makes an edited file fail to load. A server seeds from one with
the `snapshot` option; the live catalog takes over as soon as it has been fetched.

## How this package is verified

The Langsys SDK family has a documented, recurring failure class:

> **A check that produces no signal reads as a pass.**

Concretely, in this repo:

- **The identity functions are imported, not reimplemented.** `md5`, `canonicalizeLocale`,
  `interpolate`, `normalizeTokenText`, `TRANSLATABLE_ATTRIBUTES` and the element exclusion
  list all come from `langsys-js-typescript/pure`, the core's side-effect-free subpath.
  They used to be *vendored* — extracted verbatim from the published tarball by a script,
  because importing the core's main entry instantiated its whole singleton graph inside
  the server process. That copy drifted: it was pinned at `0.6.5` while the core moved on,
  and it is why `0.1.0` sent `locale=de-DE` on the wire where the contract wanted
  `de-de`. A frozen copy of a moving contract is a slow divergence, and the subpath
  removed the reason to keep one. The two cross-SDK fixtures — `langsys-php`'s
  `custom-id-reference.json` and the core's `canonicalization-reference.json` — are
  asserted in place on every run, cited by blob.
- **The tokenizer is differentially tested against the published DOM walker**, not against
  fixtures written from the same memory as the implementation. 52 HTML cases plus 2
  asserted divergences, each checked for both the token *array* (order is identity) and
  the resulting `custom_id`.
- **Known divergences are asserted, not skipped.** A skipped test produces no signal. If
  the base SDK adopts the `<script>` skip, those tests fail and tell us to delete them.
- **The suite is mutation-tested.** Emitting attributes after children, dropping the
  phrase-marker check, reading only the first three attributes, swapping
  `AsyncLocalStorage` for a module global — each was applied and each was caught. A suite
  that has never been shown to fail has not been shown to work.
- **Fixtures carry negative controls.** Without a control, "the marker had an effect" and
  "the probe never ran" produce identical output.
- **The built artifact is asserted separately from the source.** A build step can silently
  falsify a claim the source makes correctly — see the `node:` prefix note above.
- **Cross-runtime identity is compared, not assumed.** Four runtimes, same digests. The
  comparison itself is mutation-tested: injecting a runtime-varying value is caught even
  though every runtime still passes its own checks.
- **The acceptance suite is mutation-tested against the original defect.** Removing the
  `langsys.run()` wrapper from the example's `hooks.server.ts` — reproducing exactly the
  bug this package exists to fix — fails five e2e tests including §13.1. A suite that has
  never been shown to fail has not been shown to work.

### The failure mode all of this exists to prevent

> **A re-keyed content block does not error. It renders in the base language and
> re-registers.** That is indistinguishable from a phrase that was simply never
> translated — no exception, no warning, no failed request. The catalog quietly grows a
> duplicate and the page quietly loses its translation.

And when checking your own deployment: **verify in a browser and by inspecting served
bytes — never with `curl | grep` alone.** Because client-side translation happens after
hydration, a `curl` check shows base language on a correctly working page *and* on a
completely broken one, and cannot distinguish them. That ambiguity is what let the
original defect survive in four documents.

## Full API

### Configuration

```ts
createLangsysServer({ projectId, apiKey, baseLocale, /* ... */ })
```

| Option | Type | Default | Purpose |
|---|---|---|---|
| `projectId` | `string \| number` | **required** | Langsys project |
| `apiKey` | `string` | **required** | Read-only in production; write in development |
| `baseLocale` | `string` | **required** | The language your source phrases are written in. Never fetched or harvested. |
| `apiUrl` | `string` | `https://api.langsys.dev/api` | Override the API host |
| `debug` | `boolean` | `false` | Enables `log()` output. Warnings and errors are **always** emitted. |
| `catalogTtlSeconds` | `number` | `300` | Catalog freshness. Also the TTL written into the shared cache. |
| `cache` | `SharedCache` | none | Cross-worker tier. **Configure this in any multi-worker deployment** — see [Caching and freshness](#caching-and-freshness). |
| `harvest` | `boolean` | `true` | Disable phrase registration outright, regardless of key type |
| `flushOnExit` | `boolean` | `true` | Best-effort send of held phrases when the process exits (`beforeExit`, SIGTERM, SIGINT). Not a guarantee: call `flush(result)` where losing a phrase matters |
| `messageCategory` | `string` | `'Errors'` | The category server message templates are registered and looked up under. Clients rendering the messages must use the same one |
| `legacyKeys` | `LegacyKeyFile[]` | — | Turn on the legacy-key migration mode: your kept source-language files (`i18next`, `vue-i18n` or `plain` JSON). `t()` then resolves its argument as a key first. See "Migrating from i18n keys" |
| `snapshot` | snapshot document or JSON | — | Seed the catalog from a `langsys-catalog-snapshot`: renders read it with no fetch in front of them until the live catalog for a locale arrives, and `resolveLocale` serves its locales while authorization is unavailable. Nothing is registered against it. Refused at startup if invalid |
| `fetch` | `typeof fetch` | global | Inject a fetch implementation (tests, proxies, edge runtimes) |

### Exports

| Export | Purpose |
|---|---|
| `createLangsysServer(config)` | Create a server instance. No module state; safe to create more than one. |
| `LangsysServer` | The class `createLangsysServer` returns, exported for typing. |
| `langsys.run(options, fn)` | Run `fn` with a request-scoped translation context. Returns `{ value, catalog, locale, missing }`. |
| `langsys.preloadCatalog(locale)` | Resolve a catalog without rendering — for hosts that must publish it to the client *before* the render reads it. |
| `langsys.flush(result)` | Drain the miss queue now, returning the promise. For `ctx.waitUntil`. Safe alongside the drain `run()` schedules. |
| `langsys.resolveLocale(request, options?)` | The request's locale. When the framework or app already chose one, pass it as `resolved`: it is mapped to the project's form (`es_ES` → `es-es`, a bare `es` → the project's default Spanish locale), validated, and served with no `Vary`. Otherwise the URL's first path segment or `?locale=`, then a `locale` cookie, then `Accept-Language`, each checked against the project's locales — or, before authorization answers, a seeded snapshot's. Returns `{ locale, source, vary }`; send `vary` in the response's `Vary` header. |
| `langsys.resolvedRootAttributes(locale)` | `{ 'data-ls-resolved': locale }` for a render in a non-base locale, `{}` for the base locale. Spread onto the page's root element so a client SDK records no misses for text the server already translated. |
| `langsys.message({ template, params?, field?, code? })` | A server message entry: `message` is the template filled, `params` present only when it has markers, `field` and `code` the framework's own, passed through. Inside `run()`, a template the catalog does not list is registered after the response, and a marker filled with a catalogued phrase warns once. |
| `langsys.attachMessages(body, entries, { key?, pieces? })` | The framework's own error body with the entries added under `key` (default `langsys_errors`), nothing else changed. `pieces` renames an entry's pieces, for example `{ template: 'sentence', params: 'values' }`. |
| `langsys.registerTemplates(templates, { register? })` | Check every declared template and, with `register`, register the ones the catalog does not list. Returns `{ templates, problems, registered }`. Also available as the `langsys-messages` command. |
| `langsys.exportSnapshot(locales, categories?)` | A `langsys-catalog-snapshot` v1 document: each locale's catalog filtered by category, checksummed, in the format every Langsys SDK loads. Throws on a failed fetch. Also available as the `langsys-snapshot` command. |
| `parseSnapshot(document)` | Load a snapshot (a JSON string or a parsed object): returns it, or throws a `SnapshotError` whose `reason` names why — `checksum` (an edited file), `format`, `version`, `missing-member`, `not-json`. The core's loader. |
| `langsys.bridge('i18next')`, `langsys.bridge('vue-i18n')` | A `t()` whose literal misses convert from that library's syntax, for call sites that still use it. |
| `readLegacyKeyFiles([{ path, format?, namespace? }])` | Read the legacy-key mode's JSON files from disk (Node, Deno, Bun). |
| `checkTemplate(template)` | Why a template may not be declared — a validator's label placeholder still in it (class-validator `$property`, yup `${path}`/`${label}`, joi `{{#label}}`/`{{#key}}`) — or `null`. |
| `fillTemplate`, `templateMarkers`, `resolveServerMessages` | The shared marker grammar, filling, and finding entries in a response body. |
| `langsys.invalidate(locale)` | Drop a locale's cached catalog across every worker sharing the cache. |
| `t(phrase, category?, params?)` | Translate. Ambient inside `run()`. |
| `auditRenderedHtml(html, logger?, options?)` | Find primitives this version does not translate server-side. |
| `tokenizeHtml(innerHtml, options?)` | Content-block tokenizer. Takes **inner** HTML. |
| `deriveBlockIdentity(innerHtml, category)` | `custom_id` plus read-side fallback derivations. |
| `isPhraseMarked(el)` / `isTranslationExcluded(el)` | Marker predicates over a parse5 element. Low-level; mirrored byte-for-byte across the SDK family. |
| `normalizeCatalog(catalog)` | Stamp the `iTranslations` shape a client SDK expects. Does not mutate its argument. |
| `generateCustomId`, `generateLegacyCustomId`, `interpolate`, `canonicalizeLocale` | Re-exported pure functions, byte-identical to the base SDK's. |
| `TRANSLATABLE_ATTRIBUTES`, `PHRASE_MARKER_ATTRS`, `PHRASE_MARKER_ATTRS_EMIT`, `SKIP_ELEMENTS`, `UNCATEGORIZED` | Identity-bearing constants. Read-only by design — there is deliberately no runtime setter. |

Types: `Catalog`, `CatalogCategory`, `KeyType`, `LangsysServerConfig`, `MissingPhrase`,
`RequestScopeOptions`, `RenderResult`, `SharedCache`, `TranslateParams`, `TFunction`,
`TokenizeOptions`, `AuditFinding`, `AuditResult`, `AuditOptions`, `BlockIdentity`,
`Derivation`, `Logger`.

## License

MIT
