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
    params.ts        # findUnusedParamKeys — the one core helper /pure does not export

_dev_/
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

**1. Identity comes from `langsys-js-typescript/pure`. Never reimplement it here.**
`generateCustomId`, `canonicalizeLocale`, `interpolate`, `normalizeTokenText`,
`TRANSLATABLE_ATTRIBUTES` and `NON_TRANSLATABLE_ELEMENTS` are IMPORTED from the core's
side-effect-free subpath. A local copy is a second source of truth for values whose whole
purpose is being identical across SDKs, and it fails as a silent re-key rather than an
error.

*This replaces a vendored copy.* `src/vendor/pure.ts` held functions extracted verbatim
from the published tarball, because importing the core's main entry instantiated its whole
singleton graph inside the server process. That copy was pinned to `0.6.5` and it DID
drift: its `canonicalizeLocale` preserved case, so `0.1.0` shipped `locale=de-DE` on the
wire and cached under `langsys:catalog:es-CR` while the core had moved to lowercase. The
subpath removed the reason to vendor, so the file and `_dev_/vendor-pure.sh` are gone.

The one exception is `src/params.ts` (`findUnusedParamKeys`), which the subpath does not
export. It is safe to hold locally in a way none of the others would be: it feeds a
warning and never the id.

**2. Identity constants have no runtime setters.** `langsys-php` exposes
`setTranslatableAttributes()`, which makes `custom_id` a function of host *configuration* —
two apps configured differently disagree with each other. Do not repeat that here.

**3. The attribute list is 27, consumed from the core, and ORDER IS IDENTITY.**
`TRANSLATABLE_ATTRIBUTES` is a re-export from `langsys-js-typescript/pure`, matching
`langsys-php`'s list in `langsys-php`'s order. Never restate it locally and never reorder
it: `custom_id` hashes the token array, so the same set in a different order agrees on
every single-attribute element and diverges on exactly the ones nobody notices.

This package shipped 15 until the core converged. `tests/attribute-list-pin.test.ts` pins
the 27 against a literal transcribed by hand from `langsys-php`'s `HtmlParser.php` — NOT
sliced from the constant, which since convergence IS the core's array and would compare a
value to itself. `HISTORICAL_TRANSLATABLE_ATTRIBUTES_15` is read-side only: it records
what was actually stored, so it is pinned as a literal rather than sliced from the 27.

**4. The divergences are gone; the HISTORICAL tolerance is not, and the difference
matters.** This package used to skip `<script>`/`<style>` while both siblings tokenized
them, and carried read-side fallbacks so a block registered by either sibling still
resolved. The core now ships the same exclusion list, so that divergence ended and its
fallbacks (`sibling-no-skip`, `converged-27`) are deleted — a fallback for a divergence
that no longer exists returns the same id as the primary and reports coverage it does not
have.

The two LEGACY-token derivations in `src/derivations.ts` REMAIN, and are pinned to the
historical fifteen so they reproduce what was actually stored rather than a hybrid shape
no version ever emitted. They are not a disagreement between implementations; they are a
record of this package's own past, and CID-3 requires tolerating those on lookup. Deleting
them orphans real catalog entries.

Before adding a new divergence, read `src/tokenizer.ts`'s note on `scriptingEnabled`: the
agreement with the browser is a property this package now states explicitly rather than
inherits from a parser default.

**5. Warnings are unconditional.** The base SDK gates its read-only-key refusal behind
`if (debug)`. Do not copy that. A log nobody sees by default is the same as no log.

*Restored after being deleted by accident.* A rewrite of rule 4 during the /pure
convergence swallowed this rule, and nothing failed — no test asserts the rule text, and
the behaviour it governs was never changed. The review caught it. Worth recording: the
rules file is the one artifact here with no check behind it, so a mechanical edit can
silently remove a decision that every reviewer afterwards assumes is still written down.

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
11. **A green typecheck over code the checker was told to skip is not evidence.** Kept as
    a finding rather than deleted with the code that produced it: `src/vendor/pure.ts`
    carried `@ts-nocheck`, and `tsc` reported clean over a region it had been told not to
    read — a renamed function whose callers were not renamed, a guaranteed `ReferenceError`
    that typechecked fine. The vendored file is gone and the subpath is fully typed, so the
    specific hole is closed; the general one reopens the moment anything here is exempted
    from a check for convenience.

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
