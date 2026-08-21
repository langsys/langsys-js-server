# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - unreleased

First release. Request-scoped `t()` that renders translated, crawler-visible HTML during
server rendering.

### Added

- `createLangsysServer()` / `langsys.run()` — request-scoped translation context backed by
  `AsyncLocalStorage`, with no module-level mutable state anywhere in the package.
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
