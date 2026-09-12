# Conformance — `langsys-js-server`

| | |
|---|---|
| **SDK** | `langsys-js-server` (server-side JS, the Node sibling to `langsys-php`) |
| **Profiles** | `all`, `server` |
| **specVersion** | 8 (published) |
| **Spec revision read** | `docs/sdk-spec.mdx` blob **`8e2527b9f30e4e8a38121eeb7c401d4db60dfa6c`**, specVersion **8.0.1**. Re-derived with `git -C ~/Documents/dev/langsys2 ls-tree origin/feature/838_write_key_gating docs/sdk-spec.mdx` at this write, not carried from the previous revision — six spec hashes have reached this lane and five are superseded |
| **SDK revision** | `feature/838_write_key_gating` at this commit, cut from `origin/main` `5f37284` |
| **Core** | `langsys-js-typescript/pure` at **`5c5e7d3`** — the exact sibling commit the numbers below were measured against. Unpublished and resolved through a symlink, so this pin is load-bearing: an earlier revision of this file named `6596faf` while the symlink had already moved, which is the release precondition at the foot of this file happening to the file itself |
| **Suite** | 416 passing, 1 skipped, 12 files. Plus 4 runtimes × 26 conformance checks, 15 e2e, 1 tarball acceptance |
| **Reproducing the suite** | Two preconditions, neither obvious from `npm test`: run **`npm run build` first** (several tests are dist-gated and silently skip without it), and have **`../langsys-php-sdk` checked out** (`shared-fixtures.test.ts` hard-fails without it, by design — see CONF-2 on absence versus agreement). Without both, a clean archive reports 393 passing / 6 skipped / 1 failed |

<!-- SUMMARY:START -->
```
79 rules across 16 families, in 59 table rows — each id exactly once
53 bind all/server · 26 are another profile's

By profile:
   47  all
   20  browser
    6  server
    6  binding

By status (binding rules only):
   20  provisional
   20  implemented
    4  provisional (no test)
    4  **gap**
    2  **partial**
    1  n/a (architecture: no report lane)
    1  **partial — server half only**
    1  **not met**

By evidence grade, binding rules only (CONF-2):
   21  mock
   13  n/a (pure)
    9  none
    4  n/a
    4  n/a (contract fixture)
    1  n/a (measured)
    1  n/a (structural)
```
<!-- SUMMARY:END -->

Computed from the rows below by `node _dev_/conformance-summary.mjs`; `--check` fails if
the two disagree. A summary typed from memory after editing fifty rows is the part of a
file like this most likely to be wrong.

---

## Read this before the table

**Almost every row says `provisional`, and that is CONF-2 working, not this SDK failing.**
CONF-2 grades evidence, and `mock` — asserting on outgoing payloads or a double that
accepts everything — explicitly does not count. This package's transport tests inject a
`fetch` stub. It *can* refuse — `registerFails` returns `status: false`, and the API suite
drives 422s and 500s — but it is **not stateful**, which is CONF-2's actual bar: a second
read cannot observe what a first write did or did not register. So the honest status is
`provisional` even where the behaviour is implemented and mutation-tested.
The shared contract fixture CONF-2 depends on does not exist yet; until it does,
`provisional` is the ceiling for every transport-backed rule in all thirteen repos.

**Four evidence kinds may claim `implemented`, and they are not interchangeable.**
`n/a (pure)` — identity, tokenization, interpolation: no transport exists to double, and
the evidence is execution against a fixture authored in another lane. `n/a (contract
fixture)` — the two cross-SDK fixtures, which are the strongest evidence in this file
because neither was written here. `n/a (measured)` — HINT-2, where the claim is about the
shipped bundle and is grepped from it with a positive control. `n/a (structural)` — a
property the code shape makes unrepresentable rather than merely untriggered; **this is the
weakest kind and an earlier revision over-used it**, rowing REG-6 `implemented` on
structure alone with no test at all, which is a runtime rule graded above its evidence.
Everything transport-backed is `mock`, and therefore `provisional`, whatever its tests
look like.

**WIRE-4 clause 2 was this file's top-ranked gap and is now closed** — it was fixed as item
0 of 0.2.0 rather than left to rank. A failed catalog fetch used to queue every phrase on
the page, so an API outage became a write storm against the same API. The row below carries
the mutations.

**What surfaced while writing this file.** Three things, in descending order of how much
they cost:

1. **MARK-1 is not implemented, and I would have rowed it green from memory.** The
   constants exist (`PHRASE_MARKER_ATTRS_EMIT`, both spellings, exported), the audit path
   reads markers, and the package talks about marker emission throughout — but nothing in
   `src/` ever *writes* one. `grep` for the emit constant finds its definition and its
   re-export and no call site. A rendered host carries no id today. That is 0.2.0 work and
   it is now a gap rather than a row.
2. **REG-11 has no implementation at all.** No ellipsis warning exists. It is a `all`-profile
   rule and this package silently had nothing behind it.
3. **GATE-6 and GATE-7 both govern the register lane's relationship to the report lane,
   and HINT-2 means this SDK has only one of those lanes.** The first draft of this file
   rowed both `n/a (vacuous)` on that basis. That was wrong twice, and the corrections are
   in their rows: GATE-6 has a half that genuinely binds and is tested — a non-write-enabled
   session must not ATTEMPT to register — which a whole-rule `n/a` hid behind the
   untestable half; and GATE-7's stated reason was false, because for a read-only session
   no path feeds *either* lane, which is the rule's invisible-path case rather than a
   satisfied one. `n/a (vacuous)` is retired as a status: it was neither of the two kinds
   the spec recognises (profile, or architecture), and it let a binding rule read as
   excluded.

**GATE-3 carve-out, declared here because GATE-3 requires it to be declared.** This SDK
holds `write_enabled` on the server instance across requests, and copies it into each
request's `AsyncLocalStorage` scope. GATE-3's narrow carve-out permits a process-level
value only where capability provably does not vary per session — and it voids the moment a
write grant is configured, because a grant makes capability per-user. **This package
exposes no grant surface**: there is no `writeGrant` or `strategy` option in
`LangsysServerConfig`, no grant is ever sent, and GRANT-1…4 are `browser`-profiled. (A
grep for those words is not zero — `src/index.ts` carries the word in a comment — so the
claim is about the config type and the wire, not about a text search.) Capability here depends solely on
this server's own outbound address, which is constant for the process. If a grant surface
is ever added, this carve-out is void and the decision must move fully per-request.

---

## Status

| Rule | Profile | Status | Evidence | Test / reason |
|---|---|---|---|---|
| GATE-1 | all | provisional | mock | `harvest` "GATE-1 — the decision is the server's write_enabled" — 5 cases covering both failure directions, incl. `ip_write` + `write_enabled: true` registering (the discovery-renderer case) and the flag read off the `/translations` **envelope**. Mutations: ignore-positive → 4 red, ignore-negative → 2 red |
| GATE-2 | all | **partial** | none | Collection is unconditional in `t()` and the lane is chosen at the send site, which is the rule's first half. **The second half is not met and the row must say so:** the send site COLLAPSES unknown into refused-and-consumed rather than holding. With authorize failing and no envelope flag, two queued phrases produce 0 POSTs and a "could not be determined" refusal, and the batch is marked consumed. The rule's text is *hold* on unknown. Low cost — the scope dies with the request either way — but it is a divergence, not a gap in testing |
| GATE-3 | all | provisional (no test) | none | **Carve-out taken and declared above.** `write_enabled` is never written to any cache; the instance copy is snapshotted into the request scope and never read at drain time. No test asserts the decision cannot outlive a request |
| GATE-4 | all | provisional | mock | `authorize()` projects the payload to three fields and drops the body, so no artifact can carry the flag; `/translations` is read off the envelope **before** `normalizeCatalog`, and only the body is cached. Proven negatively by the GATE-8 c5 test below |
| GATE-5 | all | provisional | mock | Bookkeeping (`missSeen`, `posted`) is request-scoped and dies with the request, so no cross-request false marker is representable. **But `posted` advances before the await**, so within one request a failed send is marked consumed — see REG-8 |
| GATE-6 | all | provisional | mock | **Half of this rule binds and is tested.** Sentence 2 — a non-write-enabled session must not ATTEMPT to register — is exercised by `harvest` "write-key gating" and the GATE-1 block (`write_enabled: false` → 0 POSTs; `true` → 1). The mutual-exclusion half is architecturally unreachable here: there is no report lane to be exclusive with (HINT-2). Rowed on the half that can fail, with the other half named — an earlier revision rowed the whole rule `n/a (vacuous)`, which hid a tested obligation behind an untestable one |
| GATE-7 | all | n/a (architecture: no report lane) | n/a | **The earlier reason here was false.** It said every detection path feeds the register lane; for a READ-ONLY session no path feeds either lane — registration is refused and reporting does not exist by HINT-2 design. That is precisely the rule's "invisible path" case, and this SDK has it structurally: a read-only server render discovers content and does nothing with it. Not a defect to fix locally (HINT-2 forbids the other lane) but it must be stated, not rowed green |
| GATE-8 | all | provisional | mock | `harvest` "GATE-8 — a missing write_enabled is a version signal" — plain-`write` fallback, `ip_write` refused **with its message asserted**, non-boolean treated as absent (vectors: truthy `"false"` on a read key, `0` on a write key), re-evaluated per response, and **constraint 5** (two instances over one shared cache; a cached payload must not trigger the fallback). Mutations: delete the `ip_write` branch → 1 red; `Boolean()` coercion → 2 red; cache-hit fires the capability callback → `expected 1 to be +0` |
| CAT-1 | all | implemented | n/a (pure) | `translator` "CAT-1/CAT-2/CAT-3" — present-with-null and present-with-`''` are not re-registered; inherited `Object.prototype` names still ARE. Mutation: `hasOwnProperty` → `in` → 1 red |
| CAT-2 | all | implemented | n/a (pure) | Same block — `null`, `''` and an object all display source text while no longer registering |
| CAT-3 | all | implemented | n/a (pure) | Same block — a content block present as an object is not re-POSTed under its raw custom id |
| REG-1 | all | provisional | mock | `harvest` "write-key gating" + the GATE-1 block; a refused session makes no call at all |
| REG-2 | all | provisional | mock | Server analogue of debounce: the drain is scheduled on `setImmediate` after the response flush, never on a fixed interval. `harvest` "never in the TTFB path" |
| REG-3 | all | provisional | mock | `harvest` "flush() for edge runtimes" — `flush(result)` drains the scope that rendered, for `waitUntil` |
| REG-4 | browser | n/a | n/a | Profile `browser`. No teardown event exists on this profile |
| REG-5 | browser | n/a | n/a | Profile `browser` |
| REG-6 | all | provisional | mock | `harvest` "REG-6 — the batch that was SENT is what gets marked" — one scope, a late miss arriving via ALS propagation while that scope's own POST is in flight, plus a control that a phrase is not duplicated. **The first version of this test was worthless**: it called `run()` twice, which is two scopes with two queues, so nothing could be lost between them — the mutation turned it 0 red. Rewritten. Mutation now: mark the LIVE queue post-await instead of the snapshot → 1 red |
| REG-7 | all | provisional | mock | Chunks are sent in a sequential `await` loop, with `scope.draining` guarding concurrent drains |
| REG-8 | all | **gap** | none | **Not implemented.** No retry and no backoff. Because `posted` advances pre-await, a failed batch is already consumed and is dropped rather than re-queued. Failure is logged, never retried |
| REG-9 | all | provisional | mock | `harvest` "REG-9 — batch to the server-provided limit" — chunks to `langsys_settings.translatable_items.batch_limit` on **both** drain paths, defaults to 200, guards `0`/negative/non-numeric. Mutations: no chunking → 9 red; hardcode 200 → 3 red; read one level short → 2 red; drop the `>=1` guard → 3 red; ignore the advertised limit → 2 red |
| REG-10 | all | provisional | mock | `harvest` "fire-and-forget, but not silent" — never throws into the render path, always logs, returns `Promise<void>` so there is no success-shaped value to be wrong about |
| REG-11 | all | **gap** | none | **Not implemented.** No ellipsis warning exists anywhere in `src/` |
| REG-12 | all | provisional (no test) | none | Code: content blocks are distinguished structurally (`t()` treats a non-string value as known), not by string shape. No test asserts the structural path specifically |
| HINT-2 | server | implemented | n/a (measured) | **Falsifiably met.** Positive control first: `LangsysAppAPI.postDiscoveryHint` is a live function on the core, so the rule is violable in this family. The shipped bundle contains **0** occurrences of `postDiscoveryHint` or `discovery/hint`; its only endpoints are `authorize-project`, `translatable-items`, `translations` |
| HINT-1, 3–12 | browser | n/a | n/a | Profile `browser` |
| ICU-1 | all | implemented | n/a (pure) | `translator` "interpolation" — a missing argument selects the `other` branch |
| ICU-2 | all | implemented | n/a (pure) | Same block — `null` counts as missing |
| ICU-3 | all | implemented | n/a (pure) | Same block — recovery is recursive and `#` becomes the visible argument name |
| ICU-4 | all | provisional (no test) | none | Recovery is observable in the return value, but nothing asserts it is *reported*. `findUnusedParamKeys` warns on a different condition |
| ICU-5 | all | implemented | n/a (pure) | Supplied arguments keep CLDR selection; verified through the core's `interpolate` against the same vectors both SDKs run |
| CID-1 | all | implemented | n/a (contract fixture) | `shared-fixtures` — `langsys-php-sdk`'s `custom-id-reference.json`, blob **`60dc9b33`**, 13 rows, asserting `canonical_json`, `serialized_hex` **and** `custom_id` separately. Covers U+2028/U+2029, non-BMP U+1F600, Cyrillic and slash-bearing categories. The blob hash itself is recomputed and pinned |
| CID-2 | all | implemented | n/a (pure) | `cid-2` — the `'__uncategorized__'` sentinel is coalesced **at the boundary** in `deriveBlockIdentity`, asserted on the whole derivation set rather than the primary id. `generateLegacyCustomId` deliberately does not coalesce, so the sentinel previously emitted a fallback an empty category never did: equal primaries, unequal fallback sets |
| CID-3 | all | implemented | n/a (pure) | `derivations` "the two historical LEGACY-token shapes" — pinned to `HISTORICAL_TRANSLATABLE_ATTRIBUTES_15` so they reproduce what was actually stored. Registration always uses the corrected derivation; the legacy ids are read-only |
| CID-4 | all | provisional (no test) | none | Code: `derivations.ts` dedups by id so a collapsed derivation is not counted twice. No test verifies content before attaching to a legacy match |
| TOK-1 | all | **partial** | n/a (contract fixture) | Met for `script`/`style`/`template`/`noscript`, with the ordinary-markup control the rule names. **`<math>` is NOT excluded and 8.0.1 requires it.** Measured: this package gives `['Area','x','+','2','units']` where the rule and `langsys-php` (already conformant at `e28972c`, verified by executing `extractPhrases`) give `['Area','units']`. Not fixed unilaterally — `SKIP_ELEMENTS` re-exports the core's list, and overriding it would split ids with our own hydration partner on every block containing a `<math>`. Core first, then here, exactly as noscript went. A test flips red when the core ships it |
| TOK-2 | all | implemented | n/a (pure) | Met for free and deliberately not over-implemented: `tokenizer.ts` uses a plain `/\s+/g`, and JS `\s` already matches U+00A0. The rule forbids adding a redundant character class |
| TOK-3 | all | implemented | n/a (contract fixture) | `attribute-list-pin` — the 27, **in order**, pinned against a literal transcribed by hand from `langsys-php`'s `HtmlParser.php` rather than sliced from the constant, which since convergence *is* the core's array |
| TOK-4 | all | implemented | n/a (contract fixture) | Attribute values **and `<option>` text** go through the core's `normalizeTokenText`. Covered by the core's `canonicalization-reference.json`, blob **`e4c1f185`**, 19 rows, 19 pass |
| TOK-5 | all | implemented | n/a (pure) | `%name%` is accepted as the escape for `{name}`; `normalizeMarkupPlaceholders` comes from the core |
| MARK-1 | all | **gap** | none | **Not implemented.** Nothing in `src/` emits a marker. `PHRASE_MARKER_ATTRS_EMIT` is defined and re-exported with no call site. 0.2.0 work |
| MARK-2 | all | implemented | n/a (pure) | `PHRASE_MARKER_ATTRS` carries both `data-ls-*` and `data-langsys-*` on the READ path; `auditRenderedHtml` accepts either |
| SRV-1 | server | provisional | mock | `e2e/example` — a real SvelteKit build, asserting on the **served bytes** rather than a hydrated DOM, with a control phrase absent from the catalog so "translated" is distinguished from "the catalog happened to be complete" |
| SRV-2 | server | implemented | n/a (structural) | `isolation` "concurrent requests for different locales" — the catalog lives in the `AsyncLocalStorage` scope. Mutation on record: swapping ALS for a module global turns 4 isolation tests red |
| SRV-3 | server | provisional | mock | `harvest` "never in the TTFB path" asserts the **order of events**, not the outcome: registration count is `0` immediately after `run()` resolves and `1` only after the drain settles, with a 50 ms artificial delay proving the render did not wait. Read-only half has a write-key positive control on the same render shape |
| SRV-4 | server | **partial — server half only** | mock | This lane holds the SERVER half: `run()` returns `result.catalog` through `normalizeCatalog`, which is the shape the client seed consumes. **The other two halves are not ours and are named rather than claimed**: exposing a synchronous seed is the browser core's, and calling it before hydration is a binding's. The round-trip test (our output → core seed → `t()` returns the same string) is a gap, blocked on the core's seed landing |
| SRV-5 | server | **gap** | none | **Not implemented.** Component child capture is 0.2.0. The once-per-subtree half will be measurable here; the fail-loud-on-an-uncapturable-child half belongs to the adapters |
| SSR-1..3 | browser | n/a | n/a | Profile `browser`. These govern what the **browser** SDK does when it happens to run under server rendering; the module instance making those decisions is the browser's. (The families table said `server (JS)` until v8 — corrected after this lane read the row against its own code) |
| BIND-1..6 | binding | n/a | n/a | Profile `binding`. This is a core, not a binding |
| GRANT-1..4 | browser | n/a | n/a | Profile `browser`. A server SDK holds a write key already. **The server posture is testable rather than absent**: this package never sends `X-Write-Grant`, and exposes no grant surface — which is also what makes the GATE-3 carve-out valid |
| CACHE-1 | all | provisional | mock | `catalog` "CACHE-1 — keys are namespaced by project" — reproduced the defect before fixing (project B served project A's catalog through a shared adapter), with a positive control that one project still reads its own cached copy. Mutations: drop the project id → 4 red; substitute a constant segment → 4 red |
| OBS-1 | all | provisional | mock | `harvest` "write-key gating" — a capability refusal on a key expected to write warns once per process, unconditionally. The base SDK's `if (debug)` gate is deliberately not copied |
| WIRE-1 | all | provisional | mock | `api` "request headers" — `x-Authorization` asserted on every request, plus `X-Langsys-Capabilities: icu` (whose absence silently downgrades every plural) |
| WIRE-2 | all | provisional | mock | `api` "non-200 responses" — a 422 carrying valid JSON is separated from a 500 with a non-JSON body, so the `ok` check cannot pass for the wrong reason |
| WIRE-3 | all | implemented | n/a (pure) | `api` "WIRE-3: sends lowercase xx-yy on the wire" plus a second assertion that four spellings of one locale collapse to one wire form. Resolved by construction on the `/pure` re-parent; `0.1.0` shipped the cased form |
| WIRE-4 | all | provisional | mock | **Clause 1** — `harvest` "WIRE-4 clause 1", checked in rather than cited from a scratch run: a real connection refusal at `127.0.0.1:1`, with `run()`+`t()` and `preloadCatalog()` both degrading, and a reachable-stub control. The row previously cited a measurement that existed only in a transcript, which CONF-2 grades as a memory. **Clause 2** — met on BOTH paths. The inline fetch was fixed first and the row claimed the clause outright while `preloadCatalog()` → `run({ catalog })` — the shape `example/src/hooks.server.ts` actually uses — still produced the identical pre-fix numbers, 40 queued and one POST of 40. `preloadCatalog` now marks a failed result with a non-enumerable Symbol and `run()` honours it; `catalogAvailable` is also accepted explicitly. Mutations below |
| WIRE-5 | all | provisional | mock | `api` "URL construction" — `apiUrl` is constructor-injected and redirectable to a double; trailing slashes stripped; the default host asserted |
| CONF-1 | all | **not met** | n/a | Transport assertions here inspect a `fetch` stub, which is what CONF-1 forbids as sole evidence. Honest status pending the shared contract fixture |
| CONF-2 | all | implemented | n/a | Every row above carries a grade, and `mock` rows record `provisional` rather than `implemented` |
| CONF-3 | all | implemented | n/a | Mutations are recorded per rule with their red counts, measured full-suite on this tree. **`scriptingEnabled: false` is recorded as an EQUIVALENT MUTANT — 0 red** — rather than claimed as a kill |

---

## Mutation record — WIRE-4 clause 2

CONF-3 wants the exact edit and its observed count, not a summary. An earlier revision of
this file recorded three mutations by description ("force it false → 2 red") and none of
them reproduced, because "force it false" names two different edits with different
results. Full suite, this tree:

| # | Edit | Red |
|---|---|---|
| A | `src/translator.ts:103` — delete `scope.catalogAvailable && ` from the registration guard | 3 |
| B | `src/index.ts:273` — `let catalogAvailable = true` → `false` | **0 — EQUIVALENT** |
| C | `src/index.ts:282` — `!(CATALOG_FAILED in options.catalog)` → `true` (the preload bug, exactly as shipped) | 1 |
| D | `src/index.ts:294` — `catalogAvailable = resolved.ok` → `= true` | 1 |
| E | `src/index.ts:387` — `preloadCatalog` returns `resolved.catalog` unmarked | 1 |
| F | `src/catalog.ts:238` — the `status:false` branch returns `ok: true` | 1 |
| G | `src/catalog.ts:242` — the `throw` branch returns `ok: true` | 1 |
| H | F **and** G together | 2 |

**B is an equivalent mutant and is recorded as one.** The initializer is read by exactly
one path — the base locale, which never queues a miss because a base-locale miss is not a
miss — so flipping it is unobservable. Every other path assigns before use. Recording it as
a kill would have been the easy wrong answer; recording it as equivalent is the useful one,
because it says the initializer is not load-bearing and a reader should not add a test for
it.

F and G separately are 1 red each and together 2, which is worth stating rather than
folding into one number: the two failure branches are covered by different tests, so a
single-branch regression is caught by exactly one of them.

## Gaps, ranked by cost

1. **TOK-1 `<math>` — required by 8.0.1, not excluded here.** Blocked on the core rather
   than on effort: the exclusion list is a re-export, and going first splits ids with the
   client SDK we hydrate over. PHP already ships it, so this is the last of the three
   implementations to move.
2. **GATE-2 — unknown is collapsed into refused, not held.** The rule says hold; the send
   site consumes the batch and refuses. Cheap to fix and cheap in consequence (the scope
   dies with the request either way), but it is a real divergence from the rule's text
   rather than a missing test, and it was rowed as the latter until a review caught it.
3. **MARK-1 — nothing emits a marker.** Server-rendered hosts carry no resolved id, so the
   client-DOM parity probe cannot key on anything and `auditRenderedHtml` reports clean on
   a page it cannot see into. 0.2.0.
4. **SRV-5 — no component child capture.** 0.2.0, and the piece the roadmap calls the real
   next work.
5. **REG-8 — no retry or backoff.** A failed batch is consumed and dropped.
6. **REG-11 — no ellipsis warning.** Nothing implemented.
7. **SRV-4 round-trip untested.** Blocked on the core's synchronous seed.
8. **GATE-3, CID-4, ICU-4, REG-12 have no test pointing at them.** Each is defensible by
   reading the code, which is exactly the row CONF-1 says to distrust. (REG-6 was on this
   list and now has one; GATE-2 moved up as a real divergence rather than a test gap.)
9. **CONF-1 unmet fleet-wide** — the shared contract fixture does not exist, which caps
   every transport row at `provisional`.

## Release-wave preconditions

Not conformance gaps, but they block a publish and are recorded here because this is the
file a releaser reads. Both are written up in `ROADMAP.md` with their evidence.

- **A clean checkout does not build.** The core is a *devDependency* pinned `^0.6.5`, the
  lockfile resolves the registry tarball, and published `0.6.5` exposes no `./pure`. So
  `npm ci` succeeds and `tsc --noEmit` fails with nine `TS2307`. CI stays red until the
  core publishes a version carrying the subpath.
- **Never publish from a tree that resolves the core through a symlink.** `tsup` bundles
  the core (it is a devDependency), so a publish from a developer tree would ship a
  snapshot of an *uncommitted working tree* with no revision recorded in the tarball.
  There is no path leak — `dist/` contains no absolute paths, sourcemaps included — the
  hazard is provenance, not disclosure. `_dev_/publish.sh` should refuse when
  `node_modules/langsys-js-typescript` is a symlink.
- **CI needs the core pinned to an immutable artifact.** The symlink couples this suite to
  a live sibling working tree; the same `npm test` has given different answers ten minutes
  apart with no change in this repo.
