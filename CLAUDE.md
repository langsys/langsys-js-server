# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repository.

## Project overview

`langsys-js-server` is the **server-side** Langsys SDK — the Node sibling to `langsys-php`.
It renders translated, crawler-visible HTML during SSR.

```
server family     langsys-php   ·   langsys-js-server      <- renders translated HTML
client family     langsys-js-typescript / -react / -vue / -svelte
                                                            <- renders translated DOM
interop           the marker protocol (SPEC.md §4)
```

`SPEC.md` is the build specification and is authoritative. **Read it before changing
anything in `src/`.** Its provenance tags are load-bearing: `[VERIFIED]` claims cite an
artifact and line, `[PROPOSED]` are decisions open to argument, `[OPEN]` are unresolved.
Do not promote a `[PROPOSED]` to settled by implementing it.

## The one invariant

**No module-level mutable state. Anything that differs between two concurrent requests
lives inside the `AsyncLocalStorage` scope.**

This is the entire reason the package exists separately from the client SDKs. Under a
long-lived server one process serves every concurrent request, so a single shared mutable
field is a cross-request data race. The race needs an `await` between write and read —
which every async `load` function provides — so **it is load-dependent and cannot
reproduce in development with one user.**

If you are about to add a module-scoped `let`, a cache, or a memo: don't, unless it is
immutable or provably not request-varying. There is exactly one deliberate exception
(`emittedOnce` in `src/logger.ts`) and it is commented as such.

## Layout

```
src/
    index.ts         # Public exports + LangsysServer. Keep curated.
    context.ts       # AsyncLocalStorage request scope. The foundation.
    translator.ts    # t() — the ONE user-facing translator (SPEC §3.4)
    tokenizer.ts     # String-based content-block tokenizer. THE identity path.
    derivations.ts   # custom_id + read-side fallback derivations
    constants.ts     # Identity-bearing constants. No runtime setters, ever.
    catalog.ts       # Fetch, single-flight, absolute expiry, optional shared tier
    harvest.ts       # Request-scoped miss queue, drained after response flush
    api.ts           # Stateless HTTP client — one instance per server, never mutated
    audit.ts         # Partial-coverage detection for rendered HTML
    logger.ts        # Per-instance logger; warnings are unconditional
    types.ts
    vendor/pure.ts   # VENDORED verbatim from the published base SDK. Do not hand-edit.

_dev_/
    vendor-pure.sh              # Re-extract vendored functions from the npm tarball
    runtime-conformance.{sh,mjs}# Node/Deno/Bun/Workers, with cross-runtime digest diff
    runtime-conformance-workers.mjs
    client-dom-parity.js        # Browser probe: served bytes vs hydrated DOM
    tarball-acceptance.sh       # Pack, install into an empty project, run the smoke
    tarball-smoke.mjs           # The acceptance smoke, run against the INSTALLED package
    check-externals.mjs         # Shipped bundle's imports vs the shipped manifest
    publish.sh                  # Release script (see _dev_/PUBLISHING.md)

example/            # Runnable SvelteKit app + mock API. Not published.
tests/              # Unit, conformance, e2e
```

## Commands

```bash
npm test              # unit + conformance (vitest)
npm run typecheck
npm run build         # tsup -> dist/
npm run test:runtimes # Node/Deno/Bun/Workers against the BUILT dist
npm run test:e2e      # builds the example, runs SPEC §13 acceptance tests
npm run test:tarball  # packs, installs into an empty project, runs the smoke
npm run test:all      # everything
```

## Rules specific to this repo

**1. Never hand-edit `src/vendor/pure.ts`.** It is extracted verbatim from the published
`langsys-js-typescript` tarball by `_dev_/vendor-pure.sh`, which then *executes* it against
the real package and requires matching digests. Transcription is where silent divergence
enters, and a divergent `md5` re-keys every catalog entry this package writes. To update:
run the script with a version argument.

**2. Identity constants have no runtime setters.** `langsys-php` exposes
`setTranslatableAttributes()`, which makes `custom_id` a function of host *configuration* —
two apps configured differently disagree with each other. Do not repeat that here.

**3. The attribute list is 15, not 27, on purpose.** SPEC §9 decides convergence on PHP's
27, but the published client SDK still ships 15 and this package must not go first — it
would disagree with its own hydration partner on every request. `tests/attribute-list-pin.ts`
fails when the base SDK ships the twelve, which is the signal to move.

**4. Diverge only with a read-side fallback.** The `<script>`/`<style>` skip diverges from
both siblings. The pattern that makes that safe is **corrected on write, tolerant on read**:
registration uses the corrected derivation, lookups fall back to the sibling's. See
`src/derivations.ts`.

**5. Warnings are unconditional.** The base SDK gates its read-only-key refusal behind
`if (debug)`. Do not copy that. A log nobody sees by default is the same as no log.

## How this project verifies things

> **A check that produces no signal reads as a pass.**

This is not boilerplate — SPEC §10 records real instances from every participant. Adopted
rules, in the form they matter here:

1. **Verify against the published artifact at a pinned version**, never a sibling working
   tree. (It led the registry by nine commits when this package was built.)
2. **A check must come from a different source than the claim.** Tests written from the
   same memory as the code inherit its errors.
3. **Execute rather than read**, wherever execution is possible.
4. **Before believing a negative result, prove the code path ran.** Assert positive
   evidence, never absence of output.
5. **A fixture set of one proves nothing about a parser.**
6. **Inherited premises are the least-verified thing in any report.** Re-run the claims you
   are building *on top of*, not the ones being argued *for*.
7. **Tests should be majority-negative.** Fixtures must be authored so a wrong
   implementation fails, not merely so a right one passes.
8. **A cited line number is not evidence until something reads it back** — including your
   own, and especially the ones written while thinking about something else.
9. **A grep hit is not a reading.** One sentence of context is the difference between a real
   finding and a fabricated defect report.
10. **The artifact under test must be the artifact that ships.** The e2e suite drove a
    bundle that had inlined `dist/` at *its* last build, so neutering `t()` left all
    twelve tests green. `npm run test:tarball` packs and installs into an empty project
    for the same reason — the working tree has every devDependency present and every
    source file readable regardless of the `files` allowlist, so it cannot see what a
    consumer sees.
11. **A green typecheck over vendored code is not evidence of anything.** `@ts-nocheck` is
    required over verbatim vendored JS, and `tsc` reports clean over a region it was told
    not to look at. Found here as a renamed function whose callers were not renamed — a
    guaranteed `ReferenceError` that typechecked fine.

**Mutation-test anything load-bearing.** A suite that has never been shown to fail has not
been shown to work. Existing precedents: swapping `AsyncLocalStorage` for a module global
(4 isolation tests go red), emitting attributes after children (40 red), removing the
`langsys.run()` wrapper from the example (5 e2e red), injecting a runtime-varying digest
(caught on 3 runtimes while all 4 still pass their own checks); and five mutations against
`test:tarball` (a `files` entry removed, an `exports` condition pointed at a missing file,
an undeclared external import, a neutered `t()`, and a bundle with no imports at all).

That last suite is also where a mutation **survived** and the check was wrong rather than
the code: demoting `parse5` to a devDependency kept everything green, because `tsup` has no
explicit `external` and derives it from `dependencies` — so the demotion made tsup *bundle*
parse5 and the package still worked. The manifest and the artifact are re-derived together
on every build, which meant the original "no devDependency leaked" assertion **could not
fail by construction**. It was replaced with one that compares the shipped bundle's imports
against the shipped manifest, and that one goes red.

## The failure mode everything guards against

> **A re-keyed content block does not error. It renders in the base language and
> re-registers.** That is indistinguishable from a phrase that was never translated — no
> exception, no warning, no failed request. The catalog quietly grows a duplicate and the
> page quietly loses its translation.

When checking a deployment: **verify in a browser and by inspecting served bytes — never
with `curl | grep` alone.** Because client-side translation happens after hydration, a
`curl` check shows base language on a working page *and* on a broken one.

## Cross-repo coordination

Sibling repos are checked out beside this one and have their own agents. Open items live in
`ROADMAP.md`. Decisions that cross repos (the attribute convergence, the `<script>` skip,
the `seedCatalog` export) are **not** this repo's to make alone — flag them rather than
implementing ahead of the dependency.
