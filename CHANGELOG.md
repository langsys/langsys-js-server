# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.2.0 - unreleased

Closes the five conformance defects the 838 intake measured, and replaces the vendored
copy of the core's identity functions with the core's own `/pure` subpath.

**Content-block ids change for some blocks.** Every id-affecting change is listed under
*Changed* below. The hash itself is untouched — `md5(JSON.stringify([category, tokens]))`
as before — so every moved id moved because the TOKENS changed, not the hashing. Blocks
whose markup carries none of the listed constructs keep the ids they had.

### Fixed

- **Catalog cache keys carry the project id** (CACHE-1). `langsys:catalog:<locale>` had no
  project in it, so two projects sharing a Redis served each other's catalogs — reproduced
  before fixing. Now `langsys:catalog:<projectId>:<locale>`.
- **A catalog miss is decided by key presence, not truthiness** (CAT-1, CAT-3). A phrase
  present-with-`null` re-registered on every render for the whole machine-translation
  window, and a registered content block — which arrives as an object — was re-POSTed
  under its raw custom id on every visit. Display still falls back to source text for
  `null`, `''` and objects (CAT-2); only the registration decision changed.
- **The write decision comes from the server's `write_enabled`, never from `key_type`**
  (GATE-1, GATE-8). It previously failed in both directions: `write_enabled: false` still
  registered, and a `read` or `ip_write` key with `write_enabled: true` refused — which
  disables discovery entirely, since the renderer runs a customer's page on an `ip_write`
  key. The flag is read from both locations the API uses (inside `data` on
  `authorize-project`, envelope level on `/translations`) and captured per request.
- **Registrations are chunked to the server's advertised batch limit** (REG-9).
  `langsys_settings.translatable_items.batch_limit` was never read and batches went out
  whole — 430 phrases in a single POST, which the server rejects outright.
- **A failed catalog fetch no longer queues registrations, on BOTH paths** (WIRE-4
  clause 2). The first version of this fix guarded only the fetch inside `run()`. The
  documented integration shape — `preloadCatalog(locale)` then `run({ locale, catalog })`,
  which is what `example/src/hooks.server.ts` does, because SvelteKit reads `event.locals`
  during `resolve(event)` — bypassed it entirely and produced the identical pre-fix
  numbers. `preloadCatalog()` now marks a failed result and `run()` honours the mark;
  `run({ catalogAvailable: false })` is also accepted for a host that fetches its own.
  Without a
  catalog a miss cannot be told from a hit, so the previous behaviour re-registered every
  phrase on the page — turning an API outage into a write storm against the same API,
  sized by how much copy the page carries. Measured before the fix: a 502 with 40 phrases
  rendered queued 40 and POSTed all of them. The render still degrades to source text, and
  the failure is still logged. A genuinely empty catalog (a new project answering 200 with
  no translations) is unaffected and still registers — that distinction is the whole fix.
- **Locales go out lowercase** (WIRE-3). `0.1.0` sent `locale=de-DE` and cached under
  `langsys:catalog:es-CR`; the contract is `de-de`. Came in with the `/pure` swap.

### Changed

Everything here can move a `custom_id`:

- **Translatable attributes: 15 → 27**, matching `langsys-php` in its order, consumed from
  the core rather than restated. The twelve are APPENDED and nothing already in the list
  moved, so a block re-keys only if its subtree carries one of: `data-confirm`,
  `data-tooltip`, `data-title`, `data-content`, `data-original-title`, `data-bs-title`,
  `data-bs-content`, `data-loading-text`, `data-success-message`, `data-warning-message`,
  `data-empty-message`, `data-placeholder`.
- **`<noscript>` is no longer tokenized** (TOK-1, reversed in spec v8). With scripting
  enabled — the HTML default — a parser yields the noscript body as a raw MARKUP string,
  so harvesting it sent markup to machine translation; and libxml2, which has no scripting
  flag, disagreed with both a browser and parse5 about the token. Blocks containing a
  `<noscript>` re-key. The fallback text stays in the base language, which no client SDK
  could ever have translated.
- **Attribute values and `<option>` text now collapse internal whitespace** exactly as
  text nodes do (TOK-4), via the core's `normalizeTokenText`. They were previously only
  trimmed, so a multiline `alt` derived a different id from the same sentence in a `<p>`.
  Blocks whose attribute values or option text contain a newline, tab or run of spaces
  re-key.
- **`'__uncategorized__'` is normalised to `''` before hashing** (CID-2). It is a
  cache-lookup namespace and was never a hash input on any shipping path here, but a
  caller passing it explicitly now gets the same id — and the same fallback set — as an
  empty category.
- **Cache-key format changed**, which orphans every existing `langsys:catalog:<locale>`
  entry. Harmless: catalogs are TTL'd and re-fetched, nothing durable is keyed on them.
- `KeyType` gains `ip_write`, so a refusal on that key type can say something true instead
  of reporting an undetermined key.

### Removed

- `src/vendor/pure.ts` and `_dev_/vendor-pure.sh`. Identity now comes from
  `langsys-js-typescript/pure`. The vendored copy was pinned at `0.6.5` while the core
  moved on, which is where the WIRE-3 defect came from.
- The two read-side DIVERGENCE derivations (`sibling-no-skip`, `converged-27`). Both
  existed for disagreements with the sibling SDKs that have since ended. The two
  HISTORICAL legacy-token derivations are kept, pinned to the fifteen attributes that
  actually produced those ids (CID-3).

## 0.1.0 - 2026-08-22

First release. Request-scoped `t()` that renders translated, crawler-visible HTML during
server rendering.

### Added

- `createLangsysServer()` / `langsys.run()` — request-scoped translation context backed by
  `AsyncLocalStorage`. Nothing request-varying lives outside that scope: the only
  module-scoped mutable state in the package is a once-per-process warning latch in
  `logger.ts` (a set of warning keys, read only to suppress a duplicate log — it never
  reaches translation output, never varies per request, never carries tenant data), and
  `LangsysServer` holds the discovered key type as instance state, which is a property of
  the API key rather than of a request.
- `t(phrase, category?, params?)` — signature-compatible with the client SDKs, with full
  ICU plural and interpolation support.
- Fire-and-forget harvesting: request-scoped queue, deduplicated, drained after the
  response flushes, write-key only, and unconditionally logged when refused.
- Catalog caching with single-flight coalescing, absolute expiry stamped at write time,
  and an optional `SharedCache` tier for multi-worker deployments.
- `tokenizeHtml()` — string-based content-block tokenizer, differentially tested against
  `langsys-js-typescript@0.6.5`'s DOM walker over a 52-case corpus, plus 2 cases that
  assert a deliberate divergence rather than skipping it.
- `deriveBlockIdentity()` — `custom_id` plus read-side fallback derivations, so blocks
  registered under a sibling's or a historical derivation still resolve.
- `auditRenderedHtml()` — reports primitives this version does not translate server-side,
  so partial coverage produces a signal instead of silently serving base language.
- `_dev_/vendor-pure.sh` — extracts the pure functions verbatim from the published npm
  artifact and executes them against it, rather than transcribing them.
- `_dev_/runtime-conformance.sh` — runs an identical 26-check suite against the built
  dist under Node, Deno, Bun and Cloudflare Workers (via `miniflare`/`workerd`), then
  requires the identity digests to match across all four. Uninstalled runtimes report
  SKIPPED, never a pass.
- `tests/build-output.test.ts` — assertions about the built artifact rather than the
  source, because a build step can silently falsify a claim the source makes correctly.
- `_dev_/tarball-acceptance.sh` — packs the tarball, installs it into an empty project
  resolving only the DECLARED dependencies, and runs an acceptance smoke through both the
  ESM and CJS entry points. Every other suite drives the working tree, where every
  devDependency is present and every source file is readable regardless of the `files`
  allowlist. Paired with `_dev_/check-externals.mjs`, which compares the shipped bundle's
  imports against the shipped manifest — the check that catches a consumer's
  `ERR_MODULE_NOT_FOUND` before the consumer does.
- `example/` — a runnable SvelteKit app with a mock Langsys API, and `tests/e2e/` which
  boots its built adapter-node output and asserts SPEC §13's definition of done:
  Italian body copy in the served bytes, Russian plurals, 120 interleaved requests
  without cross-contamination, and harvesting outside the TTFB path. Not published.

### Fixed (pre-release)

- **The built dist did not run on Deno or Cloudflare Workers.** `src/context.ts` imports
  `node:async_hooks` correctly, but tsup 8 defaults `removeNodeProtocol` to true and
  emitted bare `async_hooks`. Node and Bun tolerate that; Deno rejects it and Workers
  require the prefix under `nodejs_compat`. The package claimed four runtimes in its
  README, `engines` field and name while running on two. Caught by executing the built
  artifact under Deno; no source-level test could have found it.

### Not included

- **`<Phrase>` and `<Translate>` are not translated server-side.** They need per-framework
  child-capture adapters and land in 0.2.0. See the capability matrix in the README.

### Known divergences

- `<script>` / `<style>` / `<template>` content is skipped; both sibling SDKs harvest
  `<script>`/`<style>`. Read-side fallback covers existing entries. The base SDK has
  backlogged the same fix, at which point this divergence closes. `<noscript>` is
  deliberately NOT skipped — its text is user-visible whenever scripting is off.
- 15 translatable attributes, matching the client family. PHP carries 27; the convergence
  is decided but not yet shipped by the client SDKs, and shipping it first would disagree
  with our own hydration partner on every request.
- `&nbsp;` is collapsed, matching the client family. `langsys-php` retains it.
