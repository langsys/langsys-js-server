# langsys-js-server

Request-scoped server-side translation for Langsys. Renders **translated, crawler-visible
HTML** during SSR on Node, Deno, Bun and Cloudflare Workers.

---

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

---

## Capability matrix — read this before adopting

**v0.1.0 does not translate everything.** Staged shipping is fine; silent partial
coverage is not, so here is exactly what works.

| Primitive | Server-rendered translation | Notes |
|---|---|---|
| `t(phrase, category?, params?)` | ✅ **Yes** | Full ICU plurals and interpolation |
| `<title>`, meta, OG, `alt` — anything built from `t()` | ✅ **Yes** | This is the indexed copy that motivated the package |
| `<Phrase>` | ❌ **Not in 0.1.0** | Renders base language server-side; translated on hydration |
| `<Translate>` | ❌ **Not in 0.1.0** | Same |

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

---

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

---

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

---

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

---

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

---

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

---

## Harvesting

Runtime phrase discovery is the core product mechanic — the phrase *is* the key. A server
SDK that did not harvest would mean the strings most worth translating (indexed body copy,
titles, meta) are the ones that never self-register.

- **Request-scoped queue.** Never pooled across requests.
- **Never in the TTFB path.** Drained after the response flushes.
- **Deduplicated.** A page rendering the same missing phrase 50 times posts it once.
- **Write key only**, and it says so out loud.

> **Harvesting requires a write key, which belongs in development.** A production
> deployment should run a **read-only** key. A write key in production registers phrases
> from live user traffic, and the catalog pollution is permanent and shared.

Under a read-only key the SDK refuses locally, never makes the call, and leaves the render
completely unaffected — a read-only key is correct production configuration, not an error.
It logs the refusal **once per process, unconditionally**. (The base SDK gates the
equivalent log behind `if (debug)`; that is deliberately not copied. A log nobody sees by
default is the same as no log.)

---

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

---

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

---

## How this package is verified

The Langsys SDK family has a documented, recurring failure class:

> **A check that produces no signal reads as a pass.**

Concretely, in this repo:

- **The vendored pure functions are extracted, not transcribed.** `_dev_/vendor-pure.sh`
  pulls `md5`, `md5Legacy`, `canonicalizeLocale` and the whole ICU interpolation cluster
  verbatim out of the published npm tarball at a pinned version, then **executes** them
  against the real package and requires the outputs to match. (`generateCustomId` is the
  one-line `md5(JSON.stringify([category, tokens]))` wrapper, written in the script's
  footer rather than extracted — it is asserted against the published package like
  everything else.) A divergent `md5` would re-key every catalog entry this package
  writes, and hand-transcribing 117 lines of bit manipulation is exactly where that
  divergence would enter. `tests/conformance/vendor-parity.test.ts` re-checks all of it
  against the installed package on every run.
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

---

## API

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
| `fetch` | `typeof fetch` | global | Inject a fetch implementation (tests, proxies, edge runtimes) |

### Exports

| Export | Purpose |
|---|---|
| `createLangsysServer(config)` | Create a server instance. No module state; safe to create more than one. |
| `LangsysServer` | The class `createLangsysServer` returns, exported for typing. |
| `langsys.run(options, fn)` | Run `fn` with a request-scoped translation context. Returns `{ value, catalog, locale, missing }`. |
| `langsys.preloadCatalog(locale)` | Resolve a catalog without rendering — for hosts that must publish it to the client *before* the render reads it. |
| `langsys.flush(result)` | Drain the miss queue now, returning the promise. For `ctx.waitUntil`. Safe alongside the drain `run()` schedules. |
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

---

## License

MIT
