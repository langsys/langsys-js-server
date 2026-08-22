# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.1.0 - 2026-08-22

First release. Request-scoped `t()` that renders translated, crawler-visible HTML during
server rendering.

### Added

- `createLangsysServer()` / `langsys.run()` — request-scoped translation context backed by
  `AsyncLocalStorage`. Nothing request-varying lives outside that scope: the only
  module-scoped mutable state in the package is a once-per-process warning latch in
  `logger.ts` (add-only, never read for behaviour, never carrying tenant data), and
  `LangsysServer` holds the discovered key type as instance state, which is a property of
  the API key rather than of a request.
- `t(phrase, category?, params?)` — signature-compatible with the client SDKs, with full
  ICU plural and interpolation support.
- Fire-and-forget harvesting: request-scoped queue, deduplicated, drained after the
  response flushes, write-key only, and unconditionally logged when refused.
- Catalog caching with single-flight coalescing, absolute expiry stamped at write time,
  and an optional `SharedCache` tier for multi-worker deployments.
- `tokenizeHtml()` — string-based content-block tokenizer, differentially tested against
  `langsys-js-typescript@0.6.5`'s DOM walker over 60+ cases.
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
