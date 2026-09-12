# Conformance — `langsys-js-server`

| | |
|---|---|
| **SDK** | `langsys-js-server` (server-side JS, the Node sibling to `langsys-php`) |
| **Profiles** | `all`, `server` |
| **specVersion** | 8 (published) |
| **Spec revision read** | langsys `c6b08d11`, `docs/sdk-spec.mdx` blob `042dedb5b533499a277b88fc9e2ee39ef30a0b89`. Re-derived with `git -C ~/Documents/dev/langsys2 ls-tree c6b08d11 docs/sdk-spec.mdx` |
| **SDK revision** | `feature/838_write_key_gating` at `27cf7888`, cut from `origin/main` `5f37284` |
| **Core** | `langsys-js-typescript/pure` at `6596faf` (unpublished; resolved through a symlink — see Gaps) |
| **Suite** | 398 passing, 1 skipped, 12 files. Plus 4 runtimes × 26 conformance checks, 15 e2e, 1 tarball acceptance |

<!-- SUMMARY:START -->
```
79 rules across 16 families, in 59 table rows
51 bind this profile · 28 are n/a for it

By status:
   26  n/a
   22  implemented
   18  provisional
    5  provisional (no test)
    4  **gap**
    2  n/a (vacuous)
    1  **partial — server half only**
    1  **not met**

By evidence grade (CONF-2):
   31  n/a
   19  mock
   13  n/a (pure)
    9  none
    4  n/a (contract fixture)
    2  n/a (structural)
    1  n/a (measured)
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
`fetch` stub. The stub is not stateful and cannot say no, so by the spec's own rule the
honest status is `provisional` even where the behaviour is implemented and mutation-tested.
The shared contract fixture CONF-2 depends on does not exist yet; until it does,
`provisional` is the ceiling for every transport-backed rule in all thirteen repos.

Where a rule is **pure** — identity, tokenization, interpolation — there is no transport to
double, so the grade is `n/a (pure)` and the evidence is an execution against a fixture
authored in another lane. Those are the strongest rows here and the only ones claiming
`implemented`.

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
3. **GATE-6 and GATE-7 are satisfied vacuously**, and saying so is the point. Both govern
   the relationship between the register lane and the report lane. HINT-2 means this SDK
   has no report lane, so "mutually exclusive" and "every path feeds exactly one lane" hold
   because one of the two lanes does not exist. A green row that cannot fail is what
   CONF-1 exists to distrust, so they are marked `n/a (vacuous)` rather than `implemented`.

**GATE-3 carve-out, declared here because GATE-3 requires it to be declared.** This SDK
holds `write_enabled` on the server instance across requests, and copies it into each
request's `AsyncLocalStorage` scope. GATE-3's narrow carve-out permits a process-level
value only where capability provably does not vary per session — and it voids the moment a
write grant is configured, because a grant makes capability per-user. **This package
exposes no grant surface**: `grep -rn 'writeGrant\|strategy\|grant' src/types.ts src/index.ts`
returns nothing, and GRANT-1…4 are `browser`-profiled. Capability here depends solely on
this server's own outbound address, which is constant for the process. If a grant surface
is ever added, this carve-out is void and the decision must move fully per-request.

---

## Status

| Rule | Status | Evidence | Test / reason |
|---|---|---|---|
| GATE-1 | provisional | mock | `harvest` "GATE-1 — the decision is the server's write_enabled" — 5 cases covering both failure directions, incl. `ip_write` + `write_enabled: true` registering (the discovery-renderer case) and the flag read off the `/translations` **envelope**. Mutations: ignore-positive → 4 red, ignore-negative → 2 red |
| GATE-2 | provisional (no test) | none | Code: collection is unconditional in `t()`; the lane is chosen at the send site in `drainMissQueue`. No test exercises a miss recorded **before** authorize resolves, which is the window the rule names. Listed as a gap |
| GATE-3 | provisional (no test) | none | **Carve-out taken and declared above.** `write_enabled` is never written to any cache; the instance copy is snapshotted into the request scope and never read at drain time. No test asserts the decision cannot outlive a request |
| GATE-4 | provisional | mock | `authorize()` projects the payload to three fields and drops the body, so no artifact can carry the flag; `/translations` is read off the envelope **before** `normalizeCatalog`, and only the body is cached. Proven negatively by the GATE-8 c5 test below |
| GATE-5 | provisional | mock | Bookkeeping (`missSeen`, `posted`) is request-scoped and dies with the request, so no cross-request false marker is representable. **But `posted` advances before the await**, so within one request a failed send is marked consumed — see REG-8 |
| GATE-6 | n/a (vacuous) | n/a | No report lane exists (HINT-2). Exclusivity holds because one lane is absent, which is not evidence |
| GATE-7 | n/a (vacuous) | n/a | Same. Every detection path feeds the register lane because there is no other lane to feed |
| GATE-8 | provisional | mock | `harvest` "GATE-8 — a missing write_enabled is a version signal" — plain-`write` fallback, `ip_write` refused **with its message asserted**, non-boolean treated as absent (vectors: truthy `"false"` on a read key, `0` on a write key), re-evaluated per response, and **constraint 5** (two instances over one shared cache; a cached payload must not trigger the fallback). Mutations: delete the `ip_write` branch → 1 red; `Boolean()` coercion → 2 red; cache-hit fires the capability callback → `expected 1 to be +0` |
| CAT-1 | implemented | n/a (pure) | `translator` "CAT-1/CAT-2/CAT-3" — present-with-null and present-with-`''` are not re-registered; inherited `Object.prototype` names still ARE. Mutation: `hasOwnProperty` → `in` → 1 red |
| CAT-2 | implemented | n/a (pure) | Same block — `null`, `''` and an object all display source text while no longer registering |
| CAT-3 | implemented | n/a (pure) | Same block — a content block present as an object is not re-POSTed under its raw custom id |
| REG-1 | provisional | mock | `harvest` "write-key gating" + the GATE-1 block; a refused session makes no call at all |
| REG-2 | provisional | mock | Server analogue of debounce: the drain is scheduled on `setImmediate` after the response flush, never on a fixed interval. `harvest` "never in the TTFB path" |
| REG-3 | provisional | mock | `harvest` "flush() for edge runtimes" — `flush(result)` drains the scope that rendered, for `waitUntil` |
| REG-4 | n/a | n/a | Profile `browser`. No teardown event exists on this profile |
| REG-5 | n/a | n/a | Profile `browser` |
| REG-6 | implemented | n/a (structural) | `drainMissQueue` snapshots with `missQueue.slice(posted)` and advances a monotonic index **before** awaiting; the success handler never re-reads the live queue. The defect is unrepresentable rather than tested-against |
| REG-7 | provisional | mock | Chunks are sent in a sequential `await` loop, with `scope.draining` guarding concurrent drains |
| REG-8 | **gap** | none | **Not implemented.** No retry and no backoff. Because `posted` advances pre-await, a failed batch is already consumed and is dropped rather than re-queued. Failure is logged, never retried |
| REG-9 | provisional | mock | `harvest` "REG-9 — batch to the server-provided limit" — chunks to `langsys_settings.translatable_items.batch_limit` on **both** drain paths, defaults to 200, guards `0`/negative/non-numeric. Mutations: no chunking → 9 red; hardcode 200 → 3 red; read one level short → 2 red; drop the `>=1` guard → 3 red; ignore the advertised limit → 2 red |
| REG-10 | provisional | mock | `harvest` "fire-and-forget, but not silent" — never throws into the render path, always logs, returns `Promise<void>` so there is no success-shaped value to be wrong about |
| REG-11 | **gap** | none | **Not implemented.** No ellipsis warning exists anywhere in `src/` |
| REG-12 | provisional (no test) | none | Code: content blocks are distinguished structurally (`t()` treats a non-string value as known), not by string shape. No test asserts the structural path specifically |
| HINT-2 | implemented | n/a (measured) | **Falsifiably met.** Positive control first: `LangsysAppAPI.postDiscoveryHint` is a live function on the core, so the rule is violable in this family. The shipped bundle contains **0** occurrences of `postDiscoveryHint` or `discovery/hint`; its only endpoints are `authorize-project`, `translatable-items`, `translations` |
| HINT-1, 3–12 | n/a | n/a | Profile `browser` |
| ICU-1 | implemented | n/a (pure) | `translator` "interpolation" — a missing argument selects the `other` branch |
| ICU-2 | implemented | n/a (pure) | Same block — `null` counts as missing |
| ICU-3 | implemented | n/a (pure) | Same block — recovery is recursive and `#` becomes the visible argument name |
| ICU-4 | provisional (no test) | none | Recovery is observable in the return value, but nothing asserts it is *reported*. `findUnusedParamKeys` warns on a different condition |
| ICU-5 | implemented | n/a (pure) | Supplied arguments keep CLDR selection; verified through the core's `interpolate` against the same vectors both SDKs run |
| CID-1 | implemented | n/a (contract fixture) | `shared-fixtures` — `langsys-php-sdk`'s `custom-id-reference.json`, blob **`60dc9b33`**, 13 rows, asserting `canonical_json`, `serialized_hex` **and** `custom_id` separately. Covers U+2028/U+2029, non-BMP U+1F600, Cyrillic and slash-bearing categories. The blob hash itself is recomputed and pinned |
| CID-2 | implemented | n/a (pure) | `cid-2` — the `'__uncategorized__'` sentinel is coalesced **at the boundary** in `deriveBlockIdentity`, asserted on the whole derivation set rather than the primary id. `generateLegacyCustomId` deliberately does not coalesce, so the sentinel previously emitted a fallback an empty category never did: equal primaries, unequal fallback sets |
| CID-3 | implemented | n/a (pure) | `derivations` "the two historical LEGACY-token shapes" — pinned to `HISTORICAL_TRANSLATABLE_ATTRIBUTES_15` so they reproduce what was actually stored. Registration always uses the corrected derivation; the legacy ids are read-only |
| CID-4 | provisional (no test) | none | Code: `derivations.ts` dedups by id so a collapsed derivation is not counted twice. No test verifies content before attaching to a legacy match |
| TOK-1 | implemented | n/a (contract fixture) | `walker-parity` "TOK-1 — noscript is EXCLUDED" — no token for a noscript body, **plus the ordinary-markup control the rule names**, plus a control asserting the two pre-exclusion ids genuinely differed. `SKIP_ELEMENTS` is a re-export of the core's `NON_TRANSLATABLE_ELEMENTS`, so it cannot drift |
| TOK-2 | implemented | n/a (pure) | Met for free and deliberately not over-implemented: `tokenizer.ts` uses a plain `/\s+/g`, and JS `\s` already matches U+00A0. The rule forbids adding a redundant character class |
| TOK-3 | implemented | n/a (contract fixture) | `attribute-list-pin` — the 27, **in order**, pinned against a literal transcribed by hand from `langsys-php`'s `HtmlParser.php` rather than sliced from the constant, which since convergence *is* the core's array |
| TOK-4 | implemented | n/a (contract fixture) | Attribute values **and `<option>` text** go through the core's `normalizeTokenText`. Covered by the core's `canonicalization-reference.json`, blob **`e4c1f185`**, 19 rows, 19 pass |
| TOK-5 | implemented | n/a (pure) | `%name%` is accepted as the escape for `{name}`; `normalizeMarkupPlaceholders` comes from the core |
| MARK-1 | **gap** | none | **Not implemented.** Nothing in `src/` emits a marker. `PHRASE_MARKER_ATTRS_EMIT` is defined and re-exported with no call site. 0.2.0 work |
| MARK-2 | implemented | n/a (pure) | `PHRASE_MARKER_ATTRS` carries both `data-ls-*` and `data-langsys-*` on the READ path; `auditRenderedHtml` accepts either |
| SRV-1 | provisional | mock | `e2e/example` — a real SvelteKit build, asserting on the **served bytes** rather than a hydrated DOM, with a control phrase absent from the catalog so "translated" is distinguished from "the catalog happened to be complete" |
| SRV-2 | implemented | n/a (structural) | `isolation` "concurrent requests for different locales" — the catalog lives in the `AsyncLocalStorage` scope. Mutation on record: swapping ALS for a module global turns 4 isolation tests red |
| SRV-3 | provisional | mock | `harvest` "never in the TTFB path" asserts the **order of events**, not the outcome: registration count is `0` immediately after `run()` resolves and `1` only after the drain settles, with a 50 ms artificial delay proving the render did not wait. Read-only half has a write-key positive control on the same render shape |
| SRV-4 | **partial — server half only** | mock | This lane holds the SERVER half: `run()` returns `result.catalog` through `normalizeCatalog`, which is the shape the client seed consumes. **The other two halves are not ours and are named rather than claimed**: exposing a synchronous seed is the browser core's, and calling it before hydration is a binding's. The round-trip test (our output → core seed → `t()` returns the same string) is a gap, blocked on the core's seed landing |
| SRV-5 | **gap** | none | **Not implemented.** Component child capture is 0.2.0. The once-per-subtree half will be measurable here; the fail-loud-on-an-uncapturable-child half belongs to the adapters |
| SSR-1..3 | n/a | n/a | Profile `browser`. These govern what the **browser** SDK does when it happens to run under server rendering; the module instance making those decisions is the browser's. (The families table said `server (JS)` until v8 — corrected after this lane read the row against its own code) |
| BIND-1..6 | n/a | n/a | Profile `binding`. This is a core, not a binding |
| GRANT-1..4 | n/a | n/a | Profile `browser`. A server SDK holds a write key already. **The server posture is testable rather than absent**: this package never sends `X-Write-Grant`, and exposes no grant surface — which is also what makes the GATE-3 carve-out valid |
| CACHE-1 | provisional | mock | `catalog` "CACHE-1 — keys are namespaced by project" — reproduced the defect before fixing (project B served project A's catalog through a shared adapter), with a positive control that one project still reads its own cached copy. Mutations: drop the project id → 4 red; substitute a constant segment → 4 red |
| OBS-1 | provisional | mock | `harvest` "write-key gating" — a capability refusal on a key expected to write warns once per process, unconditionally. The base SDK's `if (debug)` gate is deliberately not copied |
| WIRE-1 | provisional | mock | `api` "request headers" — `x-Authorization` asserted on every request, plus `X-Langsys-Capabilities: icu` (whose absence silently downgrades every plural) |
| WIRE-2 | provisional | mock | `api` "non-200 responses" — a 422 carrying valid JSON is separated from a 500 with a non-JSON body, so the `ok` check cannot pass for the wrong reason |
| WIRE-3 | implemented | n/a (pure) | `api` "WIRE-3: sends lowercase xx-yy on the wire" plus a second assertion that four spellings of one locale collapse to one wire form. Resolved by construction on the `/pure` re-parent; `0.1.0` shipped the cased form |
| WIRE-4 | provisional | mock | Measured against a **dead port** (`127.0.0.1:1`, real connection refusal): `run()`+`t()` and `preloadCatalog()` both degrade without throwing, with a live-stub positive control. **Clause 2 is a gap** — a failed catalog fetch still queues registrations |
| WIRE-5 | provisional | mock | `api` "URL construction" — `apiUrl` is constructor-injected and redirectable to a double; trailing slashes stripped; the default host asserted |
| CONF-1 | **not met** | n/a | Transport assertions here inspect a `fetch` stub, which is what CONF-1 forbids as sole evidence. Honest status pending the shared contract fixture |
| CONF-2 | implemented | n/a | Every row above carries a grade, and `mock` rows record `provisional` rather than `implemented` |
| CONF-3 | implemented | n/a | Mutations are recorded per rule with their red counts, measured full-suite on this tree. **`scriptingEnabled: false` is recorded as an EQUIVALENT MUTANT — 0 red** — rather than claimed as a kill |

---

## Gaps, ranked by cost

1. **WIRE-4 clause 2 — a failed catalog fetch queues registrations.** Measured: a 502 on
   `/translations` with 40 phrases rendered produced 40 queued and 1 POST of 40 items.
   Without a catalog a miss is indistinguishable from a hit, so an outage becomes a write
   storm on exactly the paths already failing. Highest cost here because it fires during an
   incident and makes it worse.
2. **MARK-1 — nothing emits a marker.** Server-rendered hosts carry no resolved id, so the
   client-DOM parity probe cannot key on anything and `auditRenderedHtml` reports clean on
   a page it cannot see into. 0.2.0.
3. **SRV-5 — no component child capture.** 0.2.0, and the piece the roadmap calls the real
   next work.
4. **REG-8 — no retry or backoff.** A failed batch is consumed and dropped.
5. **REG-11 — no ellipsis warning.** Nothing implemented.
6. **SRV-4 round-trip untested.** Blocked on the core's synchronous seed.
7. **GATE-2, GATE-3, CID-4, ICU-4, REG-12 have no test pointing at them.** Each is
   defensible by reading the code, which is exactly the row CONF-1 says to distrust.
8. **CONF-1 unmet fleet-wide** — the shared contract fixture does not exist, which caps
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
