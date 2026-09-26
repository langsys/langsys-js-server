# Conformance — `langsys-js-server`

| | |
|---|---|
| **SDK** | `langsys-js-server` (server-side JS, the Node sibling to `langsys-php`) |
| **Profiles** | all, server |
| **specVersion** | 8.2.18 (unpublished) |
| **Spec revision read** | langsys2 a95af2c2…, docs/sdk-spec.mdx blob 5d7e6890b733a50fb6f5f5c30e0056c6ef7bcf45 (specVersion 8.2.18, 113 rule ids). Re-derived with `git -C ~/Documents/dev/langsys2 ls-tree a95af2c2 docs/sdk-spec.mdx` at this write. The ids are pinned to this blob in `_dev_/conformance-summary.mjs`, which exits 2 if this line cites a different one |
| **SDK revision** | `feature/838_write_key_gating` at this commit |
| **Core** | `langsys-js-typescript/pure` at **`a924759c`**, resolved through a `node_modules` symlink to the sibling checkout, whose tree is clean at that commit and whose `dist` is byte-identical to a clean build of a `git archive` of it. Mutation batteries run against that clean build |
| **Contract double** | `contract-fixture/`, vendored byte-exact from `langsys-js-typescript` `be6ccd72`, tree `542f57f5ffcb9038db1b7411152b7e31b96cb269`, recomputed by `tests/contract-fixture.test.ts` |
| **Shared fixtures** | canonicalization-reference.json `34034931` (32 rows); mig-vectors.json `20f2bdd6` (70 rows); snapshot-vectors.json `594bd77a` (8 rows, 4 refusals, 1 load); interpolation-reference.json `017bffdd` (25 rows); server-message-vectors.json `c8125549`; custom-id-reference.json `633a09d9` (13 rows). Each is asserted by blob |
| **Suite** | 806 passing, 1 skipped, 29 files, plus 4 runtimes × 26 checks with identity agreeing, the singleton-graph guard, and tarball acceptance with digest `1f284758e5ac3f6dbbb31a642252ca8c` — measured in a git worktree whose core is a clean build of committed `a924759c`. The 20 e2e tests (1 skipped by design) ran in the main tree, whose core symlink points at the sibling working tree; that tree carries uncommitted edits (the core is re-authoring `server-message-vectors.json` for this revision), so its message-vector pins read red there until that lane commits and this one re-pins |
| **Reproducing the suite** | Run **`npm run build` first** (the exit-drain, command and build-output tests drive `dist/`, and a named test fails if it is missing), and have **`../langsys-php-sdk` checked out** (`shared-fixtures.test.ts` reads two fixtures from it) |

<!-- SUMMARY:START -->
```
113 rules across 19 families, one row each — each id exactly once
84 bind all/server · 29 are another profile's

By profile (first clause):
   58  all
   21  browser
   16  server
    8  browser, server
    6  binding
    2  browser, binding
    1  browser, binding (reading)
    1  server, binding

By status (binding rules only):
   78  implemented
    3  n/a (architecture: a framework-agnostic core has no validator, label or redirect)
    1  n/a (architecture: no report lane)
    1  not implemented
    1  partial

By tier, binding rules only (CONF-2):
   62  n/a (pure)
   17  contract
    5  -
```
<!-- SUMMARY:END -->

Computed from the rows below by `node _dev_/conformance-summary.mjs`; `--check` fails if the two
disagree, and the script refuses the table outright (exit 2) on a row naming more than one id, a
duplicated id, an id missing from or foreign to the pinned spec, a status or tier outside the
canonical vocabulary, or a header citing a different spec blob than its id list came from.

---

## Read this before the table

**Tiers.** `contract` rows are asserted on what the vendored API double accepted, read back from
its state. `n/a (pure)` rows govern what this package computes — identity, tokenization,
rendering, locale choice, message building — or a property the double cannot observe: a request
that was never sent, or an isolation boundary. `-` marks a row with no test.

**Absence is evidence only where the double would have accepted.** The double refuses what the
server refuses, so a test that expects nothing to land runs in a world where the write would be
accepted: GATE-1 widens the allow-list after the SDK has learned it may not write, WIRE-4's outage
test uses a write key the double accepts, and GATE-8 uses an allow-listed `ip_write` key. A
never-attempt clause — REG-1, GATE-6's non-writer half, SRV-3's read-only half — is proven at the
transport seam, because accepted state cannot tell "never sent" from "sent and refused".

**Instance state.** Nothing request-varying lives outside the request scope. The `LangsysServer`
instance holds facts that are identical for every request to it: the key type, the write
capability, the batch limit, the served locales, the registration failure clock, the catalog
failure windows, the set of message templates already queued, and the retained queue, which
holds each request's unsent items on that request's own scope and never pools them.

**GATE-3 carve-out, declared here because GATE-3 requires it to be declared.** `write_enabled` is
held on the server instance across requests and copied into each request's scope. The carve-out
applies because this package exposes no grant surface — no `writeGrant` option, no
`X-Write-Grant` sent, which `build-output` asserts on the shipped bundle — so capability depends
only on this server's own outbound address. A grant surface would void it.

**What this revision changed.** Content blocks now register as one `content_block` item under
their `custom_id` (TOK-6); before, each token registered as a loose phrase and a block the server
discovered never translated. Failed and skipped registrations are retained per request and
retried (REG-8), held on an unknown decision (GATE-2), and drained on exit (REG-3). A failed
catalog fetch is remembered (CACHE-2). New surface: `resolveLocale()`, `resolvedRootAttributes()`,
`message()`, `attachMessages()`, `registerTemplates()`, `exportSnapshot()` and `parseSnapshot()` over the fleet's one snapshot format, the
`langsys-messages` and `langsys-snapshot` commands, and `hostAttributes` on every rendered block. The legacy-key mode (MIG) runs
on the core's `/pure` resolver and converter.

---

## Status

| Rule | Status | Tier | Evidence | Profile |
|---|---|---|---|---|
| GATE-1 | implemented | contract | `contract-rows` "GATE-1 — the server-computed write_enabled decides, never key_type", against the vendored double: an `ip_write` key outside the allow-list registers nothing; the double's allow-list is then widened so it WOULD accept, and a render past any backoff window and inside the catalog TTL still registers nothing; a new session in that drifted world learns `write_enabled: true` and registers (the drift control CONF-2 requires). A plain write key registers. Mutation D1 (decide by key type: `ip_write` always sends) → 3 red there; in-process, `harvest` "GATE-1 …": ignore the positive answer → 4 red, the negative → 2 red. | all |
| GATE-2 | implemented | contract | `contract-rows` "GATE-2 …": with authorization failing and the catalog envelope carrying no `write_enabled` (the double's legacy mode), a miss is held, nothing lands, and once authorization answers the held phrase is accepted beside the next one. Collection is unconditional in `t()`; the lane is chosen at the send site, where unknown holds (`canHarvest` → `hold`) and the held request re-reads the decision on retry. In-process, `harvest` "GATE-2 …". Mutations: unknown collapses to refused → 1 red (D3, and H1 in-process); the held request never re-reads → 1 red (H2). | all |
| GATE-3 | implemented | n/a (pure) | Carve-out taken and declared above. `rows-closing` "GATE-3 — the write decision never reaches a cache": everything written to the shared cache is asserted free of `write_enabled`, with a positive check that the catalog was cached at all. The decision is copied into each request scope at `run()`; the drain reads the scope. An isolation property the stateful double cannot observe (CONF-2). | all |
| GATE-4 | implemented | n/a (pure) | `authorize()` projects its payload to the key type, the capability and the batch limit, and drops the body; `/translations` is read off the envelope before `normalizeCatalog`, and only the body is cached. `harvest` "constraint 5 — never applies the fallback from a CACHED payload" runs two instances over one shared cache with the server saying `write_enabled: false`, and the cache-served instance still refuses. Mutation: the cache-hit path fires the capability callback → `expected 1 to be +0`. What the cache holds does not depend on what the API accepts. | all |
| GATE-5 | implemented | contract | `contract-rows` "GATE-5 and REG-8 …": the double's seeded fault refuses the first write, the second read shows nothing landed, and once the endpoint recovers the phrase the failed write did not land is accepted — it was never marked registered. Bookkeeping (`missSeen`, `posted`, `retryItems`) is request-scoped. Mutation D4 (a failed send not kept) → 1 red. | all |
| GATE-6 | implemented | n/a (pure) | Split row, graded by its answer-dependent half (CONF-2). "A writer does not report" is unreachable here: this SDK has no report lane (HINT-2). "A non-writer never attempts to register" is an attempt property, proven at the transport seam: `harvest` "refuses locally under a read-only key and never makes the call", with the write key as the control that does call. Mutation S2 (a read key pushes) → 4 red in-process; against the double the same mutant stays green because the double refuses the read key (403), which is why this half is not graded on accepted state. | all |
| GATE-7 | n/a (architecture: no report lane) | - | For a read-only session no path feeds either lane: registration is refused, and reporting does not exist by HINT-2's design. That is the rule's invisible-path case, present structurally, and stated rather than rowed green; the lane that would close it is the one HINT-2 forbids. | all |
| GATE-8 | implemented | contract | `contract-rows` "GATE-8 …" against the double in its legacy mode, which omits `write_enabled`: an `ip_write` key the double would accept (allow-listed) still registers nothing, and a plain write key under the same server falls back and registers. In-process, `harvest` "GATE-8 …": non-boolean treated as absent, re-evaluated per response, never applied from a cached payload. Mutations: D1 and D2 (absent field inferred as permission for `ip_write`) → red; in-process: `ip_write` branch deleted 1, `Boolean()` coercion 2, cache-hit capability callback 1. | all |
| GATE-9 | n/a (profile: browser) | - | Profile `browser`. | browser |
| GATE-10 | implemented | n/a (pure) | The producing half, which is this profile's. `langsys.resolvedRootAttributes(locale)`: `srv-6-locale` "a non-base render marks its root resolved, in canonical lowercase", with the base-locale control unmarked; e2e "a non-base render marks its root resolved; the base render does not" on the served bytes (`<html lang="it" data-ls-resolved="it">`, `/` unmarked). Mutation G1 (base render marked) → 1 red. The reading half is the browser's and the bindings'. | browser, binding (reading); server (producing) |
| CAT-1 | implemented | n/a (pure) | `translator` "CAT-1/CAT-2/CAT-3 — presence decides registration, the value decides display": present-with-null and present-with-`''` are not re-registered; inherited `Object.prototype` names still are. Mutation: `hasOwnProperty` → `in` → 1 red. `renderTranslateBlock` applies the same own-property presence test. | all |
| CAT-2 | implemented | n/a (pure) | Same block: `null`, `''` and an object all display source text. On the block path, `blocks` "CAT-2: a null translation renders SOURCE text, not blank" and "CAT-2: an empty-string translation renders source text too"; loosening the guard to any non-undefined value → 2 red (M11). | all |
| CAT-3 | implemented | n/a (pure) | Same block: a content block present as an object is not re-POSTed under its raw custom id. | all |
| REG-1 | implemented | n/a (pure) | A never-attempt clause, proven at the transport seam (CONF-2): `harvest` "write-key gating" — a refused session makes no call, and the write-key control on the same render does. Mutation S2 (a read key pushes) → 4 red. | all |
| REG-2 | implemented | n/a (pure) | No interval exists to be the only path: misses drain on `setImmediate` after the response flushes, so one render's burst is one send per batch-limit chunk. `harvest` "never in the TTFB path" asserts the order of events: 0 registrations when `run()` resolves, 1 after the drain settles. When a send goes out does not depend on what the API answers. | all |
| REG-3 | implemented | contract | All three halves (checked by the Reviewer lane against the text at `b0474afb`). Request completion: the drain runs after `run()` returns (`harvest` "never in the TTFB path"). Manual flush: `flush(result)`, public, drains the scope that rendered (`harvest` "flush() for edge runtimes"). Worker shutdown: a best-effort drain of held registrations on `beforeExit` and SIGTERM/SIGINT, bounded at 2s, forced past the backoff window, never throwing, re-raising the signal when no other listener remains, and not relied on — `flushOnExit` is documented beside `flush(result)`. `reg-3-shutdown`, in real child processes on the built `dist` against the double: the phrase the double refused is accepted after a natural exit and after SIGTERM (which still terminates the process by that signal); control, `flushOnExit: false`, lands nothing. Mutations: no beforeExit hook 1 red, no SIGTERM hook 1, signal not re-raised 1, exit drain not forced 2. | all |
| REG-4 | n/a (profile: browser) | - | Profile `browser`. No teardown event exists on this profile. | browser |
| REG-5 | n/a (profile: browser) | - | Profile `browser`. | browser |
| REG-6 | implemented | n/a (pure) | `harvest` "REG-6 — the batch that was SENT is what gets marked, not the queue as it stands": one scope, a late miss arriving through ALS while that scope's own POST is in flight, plus a control that a phrase is sent once. The first version called `run()` twice — two scopes, two queues — and went 0 red under its own mutation; rewritten. Mutation: mark the live queue after the await → 1 red. | all |
| REG-7 | implemented | n/a (pure) | The rule is a title with no body at this revision, so the server reading is stated in the test: one QUEUE never has two sends in flight. Queues are per request, so two concurrent requests to an instance can each have one — the REG-8 in-flight test depends on that. `harvest` "REG-7 — one send in flight at a time, per queue": a chunked queue never overlaps (three chunks, at most one in flight), and a `flush()` while the queue is still sending waits rather than overlapping. Mutations: remove the per-queue draining guard → 1 red (R1); fire chunks without awaiting → 1 red (R2). | all |
| REG-8 | implemented | contract | Backoff: one failure clock per `LangsysServer` (never per process), 3s doubling to 300s, reset on the first success; `harvest` "REG-8 — a failed send backs off, per instance", mutations B1–B11. Retention: items that did not go out — a failed send, a drain inside the window — stay on the request that collected them and are retried in that request's own drain when the window ends or the next send succeeds; never merged into another request's send, as the rule's server clause requires; bounded at 2,000 per server object. `contract-rows` "GATE-5 and REG-8 …" against the double, and `harvest` "REG-8 retention …". Mutations: failed send not kept 3 red, in-window batch not kept 2, no wake 4, no cap 1, retained merged into the next request's send 4. | all |
| REG-9 | implemented | contract | `contract-rows` "REG-9 …": five phrases against a double enforcing a batch limit of two all land (an over-limit batch is refused whole with 422). The limit is read from `langsys_settings.translatable_items.batch_limit` on both drain paths; `harvest` "REG-9 …". Mutation D5 (no chunking) → 1 red against the double; in-process mutations recorded under REG-9 earlier: no chunking 9, hardcoded 200 3, read one level short 2, `>=1` guard dropped 3, advertised limit ignored 2. | all |
| REG-10 | implemented | contract | `contract-rows` "REG-10 …": the double drops the registration connection, the render still returns its text, and nothing lands. In-process, `harvest` "fire-and-forget, but not silent": failed and throwing registrations log and never reach the render. Drains return `Promise<void>`, so there is no success-shaped value to be wrong about. | all |
| REG-11 | implemented | n/a (pure) | `rows-closing` "REG-11 …", two-sided: with the full sentence in the catalog, its ellipsis-truncated forms (`…` and `...`) are not registered, while `Loading…` in the same set registers and is noted at debug level; without debug nothing is printed and the phrase still registers; a longer entry in another category is not a second signal. Mutations: blanket skip 3 red, never suppressed 1, no debug note 1, prefix matched across categories 1. | all |
| REG-12 | implemented | n/a (pure) | `rows-closing` "REG-12 …": a string colliding with a block id is known on `t()` and on the block path, and registers nowhere — both paths decide by structure (a non-string catalog value is a block), so they agree. | all |
| REG-13 | implemented | n/a (pure) | Met by construction: `run()` awaits the catalog before the render starts, so no miss is decided while the first read is in flight. `harvest` "REG-13 …": a first catalog slower than the drain, already holding the phrase, registers nothing. Mutation Q1 (render against an empty catalog while the read is in flight) → 13 red. | all |
| HINT-1 | n/a (profile: browser) | - | Profile `browser`. | browser |
| HINT-2 | implemented | n/a (pure) | `build-output` asserts the shipped bundle carries none of the core graph's string markers, `discovery/hint` among them, and `_dev_/singleton-guard.sh` proves that guard can fail: the same build with the core graph imported carries every marker. The bundle's only endpoints are `authorize-project`, `translatable-items` and `translations`. | server |
| HINT-3 | n/a (profile: browser) | - | Profile `browser`. | browser |
| HINT-4 | n/a (profile: browser) | - | Profile `browser`. | browser |
| HINT-5 | n/a (profile: browser) | - | Profile `browser`. | browser |
| HINT-6 | n/a (profile: browser) | - | Profile `browser`. | browser |
| HINT-7 | n/a (profile: browser) | - | Profile `browser`. | browser |
| HINT-8 | n/a (profile: browser) | - | Profile `browser`. | browser |
| HINT-9 | n/a (profile: browser) | - | Profile `browser`. | browser |
| HINT-10 | n/a (profile: browser) | - | Profile `browser`. | browser |
| HINT-11 | n/a (profile: browser) | - | Profile `browser`. | browser |
| HINT-12 | n/a (profile: browser) | - | Profile `browser`. | browser |
| HINT-13 | n/a (profile: browser, binding) | - | Profile `browser, binding`. | browser, binding |
| ICU-1 | implemented | n/a (pure) | Graded on this package's `t()` and block path, not on the core's function (CONF-1). Through `t()`: `shared-fixtures` renders all 25 rows of langsys-php-sdk's `interpolation-reference.json` (blob `017bffdd`) through `run()` + `t()` in each row's locale, calling `t()` with no argument where a row omits params — "select: no params at all falls to other", "select: empty params falls to other" — and `translator` covers no params in scope, the category overload, a catalog hit, out of scope, and an empty map. Through `renderTranslateBlock`: `blocks` "ICU-1 on the block path" — single-token and multi-token blocks at the base locale, an ICU attribute, a catalog hit, an untranslated registered token, out of scope, and two controls (a no-ICU block byte-identical; plain text beside ICU keeps its whitespace). Mutations: the in-scope short-circuit restored → 6 red (X1); out of scope → 1 (X2); an empty map short-circuiting too → 9 (P1); block slots never rendering ICU → 7 (B1). **Moved in the same wave as the client core** (`langsys-js-typescript` `ff57476`), because either side alone mismatches hydration. | all |
| ICU-2 | implemented | n/a (pure) | Through `t()`: `shared-fixtures` rows "select: null argument treated as missing", "plural: NULL is missing, not zero" and "simple: null value left verbatim", and `translator` "ICU-2: a null argument is absent on the t() path, not the string "null"". Mutation: coerce `null` to `''` before `interpolate` → 2 red (N1), the plural and plain rows. The select vectors stay green under it, because an empty string also selects `other` — recorded so the count is not read as covering them. | all |
| ICU-3 | implemented | n/a (pure) | Through `t()`: `shared-fixtures` rows "nested: missing arg inside satisfied branch" (`{n} amigos`), "nested: unsatisfied branch never evaluated", "plural: argument missing keeps sentence, shows gap", and the no-params and empty-map plural rows (`{count} mensajes`); `translator` "ICU-1 + ICU-3: a plural with no params keeps the sentence and shows {count}, not a number". On the block path, `blocks` "a multi-token block at the base locale renders the recovered plural". Recursion itself is the core function's; this path's obligation is to reach it on every call, and restoring either short-circuit turns the no-params plural tests red (X1, B1). | all |
| ICU-4 | implemented | n/a (pure) | The core reports defaulted arguments through `interpolate`'s `onDefaulted` (langsys-js-typescript `a924759c`), and this package notes them through each server object's own logger: only under `debug`, naming every argument and the locale, once per (template, locale), on `t()` and the block path. The core's own notice sits behind its process-wide logger, which a server instance's `debug` cannot reach, so the hook is the path. `icu-4`: every argument and the locale named; one notice however often it renders, a second for another locale; the block path; per server object; controls — `debug` off, and every argument supplied, are silent. Mutations: notice ignores `debug` 1 red, no dedupe 1, `t()` not passing the hooks 3, block path not passing them 1, dedupe ignoring the locale 1. ICU-6's warning takes the same route through `onFormatterFailure`, so it too is deduplicated per server object. | all |
| ICU-5 | implemented | n/a (pure) | Through `t()`: `translator` "ICU-5: a supplied plural keeps CLDR selection beside a missing select (ru, n=3 is few)", with a distinct word per branch; `shared-fixtures` rows "russian plural: few", "russian plural: 21 is one", "russian plural: 111 is many" and "simple: integer formatted per locale"; and the recovered literal surviving a present-and-null argument, "plural: NULL is missing, not zero". Mutations: the request locale not passed to `interpolate` → 6 red (L1); `null` coerced to `''` → the null-literal row red (N1). | all |
| ICU-6 | implemented | n/a (pure) | The fallback is the core's `interpolate`; this row grades this package's paths into it. `shared-fixtures` renders the vector rows natively through `t()`. `icu-formatter-failure`: with the formatter forced to fail, `t()` and `renderTranslateBlock` render the vector through branch selection (`You have 3 cars`, `You have 1 car`, an unsupplied value as `{count}`), and the warning fires with debug off, naming the phrase, locale and error, once per template and locale; control: the unforced formatter renders natively and nothing warns. The suite formats with the `intl-messageformat` copy the shipped bundle uses (vitest inlines the core and dedupes it); before that, the forced failure never reached the core and the two warning tests were red. | all |
| CID-1 | implemented | n/a (pure) | `shared-fixtures` against `langsys-php-sdk`'s `custom-id-reference.json`, blob **`633a09d9`**, 13 rows, each asserting `canonical_json`, `serialized_hex` and `custom_id` separately; the blob hash is recomputed and pinned. Covers U+2028/U+2029, non-BMP U+1F600, Cyrillic and slash-bearing categories. Authored in another lane. | all |
| CID-2 | implemented | n/a (pure) | `conformance/cid-2`: the `'__uncategorized__'` sentinel is coalesced at the boundary in `deriveBlockIdentity`, asserted on the whole derivation set rather than the primary id — `generateLegacyCustomId` deliberately does not coalesce, so the sentinel once emitted a fallback an empty category never did. | all |
| CID-3 | implemented | n/a (pure) | `derivations` "the two historical LEGACY-token shapes", pinned to `HISTORICAL_TRANSLATABLE_ATTRIBUTES_15` so they reproduce what was actually stored. Registration always uses the primary derivation; the legacy ids are read-only, and `renderTranslateBlock` reads under them. | all |
| CID-4 | implemented | n/a (pure) | `rows-closing` "CID-4 …": a historical id whose stored block holds this block's phrases renders from it; one holding other phrases is not attached, so the block stays unknown and registers under its own id. Compared as sets, as the rule permits where the catalog keys a block by phrase. Mutation K2 (content check removed) → 1 red. | all |
| TOK-1 | implemented | n/a (pure) | `script`, `style`, `template`, `noscript` and `math` are excluded through `SKIP_ELEMENTS`, a re-export of the core's `NON_TRANSLATABLE_ELEMENTS`. Proven per path (CONF-1). Tokenize: `walker-parity` "excludes math content — the spec vector, arriving through the re-export" (`['Area','units']`, the vector `langsys-php` produced by executing `extractPhrases`) and the `<noscript>` cases, with the ordinary-markup control. Render: `blocks` "math content is not translated, and the text around it is", and "inline svg keeps the parent text, translates svg <text> in place, and leaves <path> intact"; tokenize and render share one walk. `<Phrase>`: `phrase` "script and style bodies contribute nothing", and asserted for `math` by the same constant. Core fixture: 26 rows against this blob. The math gap closed when the core shipped it (`105943f`), and the test recording the gap went red as designed. | all |
| TOK-2 | implemented | n/a (pure) | The 28 C0 controls are stripped before collapse on text nodes and attributes alike, through the core's `normalizeTokenText`. `blocks` "TOK-2 …": U+001C and VT removed (not mapped to a space) in text and in an attribute, TAB still collapsing, U+007F and U+0085 kept, and the stripped key looking up on render. The core fixture's rows `fs-in-text`, `vt-in-text` and the attribute row pass (canonicalization blob `9027a603`, 32 rows). Mutation T2 (text collapse without the strip) → 5 red. | all |
| TOK-3 | implemented | n/a (pure) | `attribute-list-pin` "is array-identical to PHP's list, INCLUDING order": the 27 against a literal transcribed by hand from `langsys-php`'s `HtmlParser.php`, since the constant now is the core's array. The spec's own vector, proven on both paths (CONF-1): `blocks` "TOK-3 — the spec vector, proven on both paths" — three listed and two unlisted attributes, authored out of list order, give three phrases in list order and render each in place with the unlisted two untouched; plus "TOK-3 order decides the token sequence, but location decides where each lands". Mutations: walk the element's own attributes instead of the constant → 1 red (T1); attribute write ignores the name → 3 red (M3); attribute write a no-op → 9 red (M2). Attribute translations never rendered before this revision — see "What surfaced", item 1. | all |
| TOK-4 | implemented | n/a (pure) | Attribute values and `<option>` text go through the core's `normalizeTokenText`: the core's `canonicalization-reference.json`, 32 rows, blob `9027a603`, measured against spec blob `e22dad18`, every row asserting tokens and id. On the render path, the line-break, doubled-space and NBSP placeholder tests assert the key registers and looks up the same. | all |
| TOK-5 | implemented | n/a (pure) | Capture: the core fixture rows `percent-name-in-markup` and `brace-name-in-markup` reach one id. Interpolation, through this package's `t()`: `translator` "TOK-5 — `%name%` is accepted as the escape for `{name}`" — both forms give the same output, and a control that percent prose with no matching key is left alone. `interpolate` itself is the core's. | all |
| TOK-6 | implemented | n/a (pure) | `blocks` "TOK-6 …", the spec's vectors on the render path: `<p>Hello</p>` one phrase; `<p title="Tooltip">Hello</p>` one content block `[Tooltip, Hello]` under its `custom_id`; `<img alt="Logo">` a block; the svg `<text>` unit a phrase; control `<p>Hello <b>bold</b></p>` a block. A block registers as ONE `content_block` item and is known on the next render. Mutations: every one-token unit a phrase 1 red, every unit a block 5, blocks as loose phrases 4, phrase shape ignoring the flat catalog 2. | all |
| MARK-1 | implemented | n/a (pure) | This package renders a host's inner HTML; the host is the adapter's. Every render returns `hostAttributes` — `data-ls-contentblock` with the id it resolved under (a historical id when a fallback resolved) — for the adapter to spread. `rows-closing` "MARK-1 …": the value equals the id the tokenizer derives independently from the same inner HTML, for block- and phrase-shaped units and outside a request. Mutation K1 (host carries nothing) → 3 red. | all |
| MARK-2 | implemented | n/a (pure) | Both spellings accepted on read: `translator` "recognises the PHP marker spelling too" on the audit path (`data-langsys-phrase`), and `CONTENT_BLOCK_MARKER_ATTRS` carries `data-langsys-contentblock` beside `data-ls-contentblock`, asserted in `blocks`. | all |
| MARK-3 | implemented | n/a (pure) | `blocks` "MARK-3/MARK-4 …": bare, empty, `true`, `1` and ` YES ` declare (the host is excised from the enclosing unit); `false`, `0` and ` FALSE ` opt out and fold into it; a stamped id is an identity and is excised. Mutation T3 (opt-out ignored) → 1 red. Nothing here walks a page for declared blocks: a declaration is read where a walk meets it. | all |
| MARK-4 | implemented | n/a (pure) | `blocks` "MARK-3/MARK-4 …": a nested stamped host, a bare host and a phrase host contribute no tokens; the enclosing render does not write into an excised host; an excised host's text does not stop the unit's own text node being its only one. Mutations: excision removed 4 red, single-text-node counting excised text 2. | all |
| SSR-1 | n/a (profile: browser) | - | Profile `browser`: governs what the browser SDK does under server rendering, in the browser's module instance. | browser |
| SSR-2 | n/a (profile: browser) | - | Profile `browser`. | browser |
| SSR-3 | n/a (profile: browser) | - | Profile `browser`. | browser |
| SRV-1 | implemented | n/a (pure) | The property is rendering what the catalog holds into the served bytes; no acceptance or refusal is involved, so the tier is `n/a (pure)` (CONF-2). `e2e/example` "SPEC §13.1 — the acceptance test" on a production SvelteKit build: Italian body copy, `<title>`, meta description, `og:title` and a translatable `alt` present, the English absent, the base locale as the negative control, and a phrase missing from the catalog falling back and registering. On the block path, translations land where their tokens were read, attributes included (`blocks`). | server; and a binding for any render it performs inside a server request scope |
| SRV-2 | implemented | n/a (pure) | `isolation` "concurrent requests for different locales": renders interleaved across awaits, repeated, and miss queues kept per request. Mutation on record: swapping `AsyncLocalStorage` for a module global → 4 red. `e2e` "holds under 120 interleaved requests across four locales" on the built app. | server; and a binding for any render it performs inside a server request scope |
| SRV-3 | implemented | contract | `srv-3` against the double: nothing is accepted when `run()` returns and the phrase is accepted once the response has flushed; a read-only key leaves nothing accepted and a write key on the same render registers. The read-only half is an attempt property, proven at the seam (`harvest` "refuses locally under a read-only key and never makes the call"), per CONF-2. Mutations: collection inline 2 red, read key pushes 4 in-process. | server; and a binding for any render it performs inside a server request scope |
| SRV-4 | implemented | n/a (pure) | **The server half, which is this lane's.** `e2e/example` "SRV-4 — the client is handed the catalog the server rendered with": the served `/it` page's hydration payload carries the Italian catalog and `langsysLocale` `it`, and `/de` carries its own locale and not the Italian. Mutation: delete `langsysCatalog: locals.langsysCatalog,` from `example/src/routes/+layout.server.ts` and rebuild → 2 red (L1). `run()` and `preloadCatalog()` return that catalog through `normalizeCatalog` on every path. **Not this lane's, named rather than claimed:** the synchronous seed is the browser core's, and calling it before hydration is a binding's; the example calls no seed yet, so the round trip is untested here. | server; browser core for the synchronous seed it exposes; and a binding for any |
| SRV-5 | partial | n/a (pure) | **Once per subtree: met.** `blocks` ".missing is a record of phrases, not of token positions": a depth-3 block holding `Repeat` four times posts it once, counted, and the returned `.missing` lists it once — it listed it four times until this revision, while registration was already right. **Fail loudly on an uncapturable child: not met.** `UncapturableChildError` is defined and exported and nothing throws it; the framework adapters that would capture children are not built. | server; and a binding for any render it performs inside a server request scope |
| SRV-6 | implemented | n/a (pure) | `langsys.resolveLocale(request, { resolved })`. A locale the framework or app already resolved is served, mapped to the project's form (`es-ES`, `es_ES` → `es-es`; a bare `es` → `default_locales` from authorization), validated, falling back to the base, with no `Vary`. Otherwise the URL, then the cookie, then `Accept-Language`, with `Vary` naming what the choice depended on. Offline, a seeded snapshot's `base_locale` and `locales` are the served set and its `base_locale` the fallback, until authorization's answer replaces them. `srv-6-locale`: the framework cases, the four-request vector, validation, q=0, the knobs; `snap-seed`: offline `es-es` served from the snapshot, a locale it lacks falling to its `base_locale`, and authorization's set replacing it; e2e on the served response. Mutations: framework locale ignored 4 red, bare language not mapped 1, Vary added to it 2, not validated 1, offline set ignoring the snapshot 1, offline fallback the configured base 2; earlier, cookie before URL 1, no validation 7, no Vary on a negotiated locale 1, q=0 as a preference 1, no language fallback 2. | server; and a binding for any render it performs inside a server request scope |
| MSG-1 | implemented | n/a (pure) | An entry is `template` and `params`, with `message` the fill and the framework's own field path and identifier passed through. `langsys.attachMessages(body, entries, { key })` leaves the framework's error body exactly as it was and adds the entries under a configurable key (default `langsys_messages`); this package introduces no envelope. `msg`: a Laravel-shaped and a NestJS-shaped native body each come back unchanged apart from the attached entries, which resolve back through the same key; only template and params are required. The committed `server-message-vectors.json` (`c8125549`) canonical entries are rebuilt exactly; the core is re-authoring that file for this revision, and it is re-pinned by blob when committed. Mutation: attach replacing the body 2 red. | all |
| MSG-2 | implemented | n/a (pure) | `code` is whatever the framework reports, passed through unchanged, and absent when the caller passes none; this package exports no vocabulary and maps no rule to a code. `msg` "MSG-2 …": a framework identifier (`isEmail`) comes back as given, an entry without one has no `code`, and neither the vocabulary nor an envelope is exported; the same failure keeps its code across locales. Nothing reads the code: the lookup key is the template. Mutation: a code imposed when absent 2 red. | all |
| MSG-3 | implemented | n/a (pure) | The template is the framework's own unfilled sentence with the label written in, which the caller (a binding's normalizer) supplies; this package never rewords it. `msg`: two fields failing one rule are two phrases, registered separately; a template with no marker equals its `message`. Checking for a label left unwritten is MSG-11's check 1. | server |
| MSG-4 | implemented | n/a (pure) | `message` is the core's `fillTemplate` over the template: `msg` — numeric params stay JSON numbers, a missing or null param stays its marker, params are omitted when the template has none; the vector file's `fill` and `markers` rows pass. Mutations: message not filled 2 red, params on a marker-less template 1. | server |
| MSG-5 | n/a (profile: browser, binding) | - | Profile `browser, binding`. | browser, binding |
| MSG-6 | implemented | n/a (pure) | Templates register under `messageCategory` (default `Errors`, the core's `DEFAULT_SERVER_MESSAGE_CATEGORY`); `msg` "the category is configurable: registration uses the configured one", and a template listed under the category is not registered. Mutation: category hard-coded 1 red. | all |
| MSG-7 | implemented | contract | `langsys.registerTemplates()` and the `langsys-messages` command list and register the templates an app declares; walking a framework's validators and labels is the binding's (MSG-9, MSG-10). A template it cannot register is reported with where it came from and why, and the command still exits 0; `--strict` makes it exit 1. `msg-7-command`, the real command against the double: three templates registered under `Errors`; a second run registers none; a `$property` template reported and not registered, exit 0, and exit 1 under `--strict`; without `--register` nothing lands. Mutations: listed templates re-registered 1 red, refused templates registered 1, `--strict` ignored 1. | server |
| MSG-8 | implemented | n/a (pure) | `message()` inside `run()` queues a template its catalog does not list on the ordinary drain, after the response and under the write gate, once per server object (including at the base locale, where no catalog is fetched). `msg` "MSG-6/MSG-8 …": registered after `run()` returns and not before, not when listed, nothing from a write-disabled session. Mutations: never registered 5 red, listing ignored 1, no per-server memo 1. | server |
| MSG-9 | n/a (architecture: a framework-agnostic core has no validator, label or redirect) | - | The normalizer that builds entries from the failed rule and its unfilled message lives in the Express/Hono/NestJS binding, built on this core's `message()`, `attachMessages()` and `checkTemplate()`. | server |
| MSG-10 | n/a (architecture: a framework-agnostic core has no validator, label or redirect) | - | The label source lives in the Express/Hono/NestJS binding, built on this core's `message()`, `attachMessages()` and `checkTemplate()`. | server |
| MSG-11 | implemented | n/a (pure) | Check 1: `checkTemplate()` refuses a template still holding one of this ecosystem's validator label placeholders — class-validator `$property`, yup `${path}` and `${label}`, joi `{{#label}}` and `{{#key}}` — while a label written in and a `{min}` marker pass (`msg`). Check 2: `message()` warns once per template and marker when a marker is filled with a catalogued phrase, and stays silent otherwise. The proper-noun case is the rule's residue. Mutations: no placeholder refused 5 red, the catalogued-marker warning every time 1, never 1. | server |
| MSG-12 | n/a (architecture: a framework-agnostic core has no validator, label or redirect) | - | The redirect hand-off lives in the Express/Hono/NestJS binding, built on this core's `message()`, `attachMessages()` and `checkTemplate()`. | server, binding |
| MIG-1 | implemented | n/a (pure) | Off by default: with no `legacyKeys` the resolver is never built and `t()` does no key lookup — `mig` "with nothing configured, a key-shaped argument is literal source text", asserted with nothing having configured the mode, and its control with the mode on. Mutation G1 (mode never consulted) → 21 red. | browser, server |
| MIG-2 | implemented | n/a (pure) | In the mode `t()` resolves its argument as a key first through the core's `createLegacyKeys` (from `/pure`): a hit registers the converted value, a miss the argument. A literal miss converts under the entry point that received it — `t()` nothing, `langsys.bridge('i18next')` or `langsys.bridge('vue-i18n')` its own syntax — through the core's `convertLegacyCall`. `mig-vectors.json` (blob `20f2bdd6`) `calls` rows for `t`, `i18next` and `vue-i18n` (the fixture's `core_entry_points.js`), and the `same_phrase_as` tie of `Hello {{name}}` to `t('Hello {name}')`; rows for other ecosystems' entry points are `n/a (format)`. Mutations: a bridge converts nothing 3 red, `t()` converting a miss 1. | browser, server |
| MIG-3 | implemented | n/a (pure) | A hit registers the resolved value, never the key: every `resolution` row asserts the registered phrase and that the key string is not registered. | browser, server |
| MIG-4 | implemented | n/a (pure) | The conversion is the core's; this row grades that `t()` registers its result. Every `value_conversion` row in this core's formats (23) resolved through `t()` from a file holding the value, and the `i18next` `plural_forms` rows as suffix-paired keys; an unrecognised value registers as written and warns once per file and key at every level. Other formats' rows are `n/a (format)`. Mutation: unrecognised value not warned 1 red. | browser, server |
| MIG-5 | implemented | n/a (pure) | The key's namespace is the category unless the call passes one: the `resolution` rows `flat-dotted-key-names-its-category` and `explicit-category-wins`, among others. Mutation G2 (namespace wins over the call) → 1 red. | browser, server |
| MIG-6 | implemented | n/a (pure) | `mig` "MIG-6 …": a key absent from the files registers its argument and is noted at debug; a changed value is a new phrase. Mutation: miss not noted 1 red. | browser, server |
| MIG-7 | implemented | n/a (pure) | `legacyKeys` is built at construction, so a file in a format outside `i18next`, `vue-i18n` and `plain` — or named `.php`, `.yml`, `.po`, `.mo` — is refused at load with the core's `LegacyFormatError`, naming the format and the file (a `.mo` names its `.po`): every `refusals` row. Nested paths, file order and duplicates are the `resolution` rows; `langsys.legacyKeyReport()` lists duplicates and problems. `readLegacyKeyFiles()` reads JSON files from disk for a server. Mutation G7 (built lazily) → 28 red. | browser, server |
| MIG-8 | implemented | n/a (pure) | This profile's entry point is `t()` in migrate mode, beside the i18next and vue-i18n bridges over the same resolver. Per ecosystem, as the rule's test reads at this revision: `mig` "t() and a bridge over one resolver register the same phrase, id and category" — a `vue-i18n` plural key through `t()` and through the vue-i18n bridge render the same text and register one phrase under the key's namespace. Across ecosystems, the `same_phrase_as` rows. | browser, server |
| MIG-9 | not implemented | - | Held until the 907 merge lands the `translations` map on `POST /translatable-items`. | server |
| SNAP-1 | implemented | contract | One format, `langsys-catalog-snapshot` v1, built by the core's `buildSnapshot` from `/pure`, so the canonical serialisation and checksum are one implementation for the JavaScript family. `langsys.exportSnapshot(locales, categories?)` and the `langsys-snapshot` command read each locale's `GET /translations` and filter it by category, with no export endpoint. `snap`: all rows of `snapshot-vectors.json` (blob `594bd77a`) — 8 exact-bytes rows, 4 refusals by reason, 1 reordered load; the canonical bytes and checksum also equal an oracle from a different implementation (Python's `json.dumps(sort_keys=True, ensure_ascii=False, separators=(',', ':'))`) over the spec's cases; against the double, the exported catalog equals the API's `/translations` for the chosen categories and loads, and the command's file loads. Before taking the core's module this package's own serialiser agreed with all 13 vector rows. Mutations on this package's wiring: chosen categories ignored 2 red, failed fetch exporting an empty locale 1; locale casing is equivalent (the core lowercases). | server |
| SNAP-2 | implemented | n/a (pure) | The seam is this core's; the decision to seed is the app's or its binding's. The `snapshot` option is verified with the core's `parseSnapshot` at construction and refused by name. `snap-seed`: the first render reads the snapshot with no catalog fetch in front of it; the live catalog outranks it once fetched; a phrase the snapshot lacks renders as source with the network unavailable; registration is decided only against the live catalog, never the snapshot; the offline served set comes from it (SRV-6); control, no snapshot, waits for the fetch. Mutations: seed never read 4 red, seed answered as live 1, no background fetch 2, not verified at construction 1. | all |
| SNAP-3 | implemented | n/a (pure) | `parseSnapshot()` (the core's) recomputes the checksum and refuses, naming the reason, an edited file, a different `format`, an unsupported `version` and a missing member (`snap` and the vector file's refusal rows); the README documents re-export as the only refresh. Nothing in this package reads a snapshot as authoritative over the catalog. | all |
| BIND-1 | n/a (profile: binding) | - | Profile `binding`. This package is a server SDK, not a framework binding. | binding |
| BIND-2 | n/a (profile: binding) | - | Profile `binding`. | binding |
| BIND-3 | n/a (profile: binding) | - | Profile `binding`. | binding |
| BIND-4 | n/a (profile: binding) | - | Profile `binding`. | binding |
| BIND-5 | n/a (profile: binding) | - | Profile `binding`. | binding |
| BIND-6 | n/a (profile: binding) | - | Profile `binding`. | binding |
| GRANT-1 | n/a (profile: browser) | - | Profile `browser`. The server posture is testable rather than absent: `build-output` asserts the shipped bundle never carries `X-Write-Grant`, and no grant surface exists, which is what keeps the GATE-3 carve-out valid. | browser |
| GRANT-2 | n/a (profile: browser) | - | Profile `browser`. | browser |
| GRANT-3 | n/a (profile: browser) | - | Profile `browser`. | browser |
| GRANT-4 | n/a (profile: browser) | - | Profile `browser`. | browser |
| CACHE-1 | implemented | n/a (pure) | `catalog` "CACHE-1 — keys are namespaced by project": reproduced first (project B served project A's catalog through a shared adapter), with a control that a project still reads its own copy. Mutations: drop the project id → 4 red; a constant segment → 4 red. The REG-8 clock is per instance for the same reason (B9). | all |
| CACHE-2 | implemented | contract | Per server object and locale, on REG-8's clock: 3s doubling to 5 minutes, cleared on the first success. `cache-2` against the double, a one-shot `/translations` fault with the catalog behind it: the first lookup renders source, a lookup inside the window still renders source (it would render the translation had the SDK fetched again), one after it translates; the window doubles; it resets on success; it is per locale and per server object. Request sharing is the existing single-flight. Mutations: window never consulted 2 red, not cleared on success 1, never doubles 1. | all |
| OBS-1 | implemented | contract | `contract-rows` "OBS-1 …": an `ip_write` key the double refuses (`write_enabled: false` computed from the allow-list) warns once across two renders, naming the allow-list, with debug off. Mutation D8 (warning removed) → 1 red. | all |
| WIRE-1 | implemented | contract | The double authenticates by `X-Authorization` only (401 without it, 403 for an unknown key), and every accepted write in `contract-rows`, `srv-3`, `cache-2` and `snap` was made through it; `api` "request headers" asserts the header on GET and POST and that no cookie or query parameter carries the key. | all |
| WIRE-2 | implemented | contract | `contract-rows` "WIRE-2 …": after the double answers a registration with an empty `204`, the next phrase is accepted at once — no failure was recorded, so no backoff window opened. `api` and `harvest` "WIRE-2 …" in-process. Mutation D6 (204 parsed as JSON) → 1 red. | all |
| WIRE-3 | implemented | n/a (pure) | `api` "WIRE-3: sends lowercase xx-yy on the wire, whatever casing it was handed", and four spellings of one locale reach the wire identically. Resolved by construction on the `/pure` re-parent; `0.1.0` shipped the cased form. | all |
| WIRE-4 | implemented | contract | `contract-rows` "WIRE-4 …": clause 2, a 500 on the catalog renders source and nothing lands although the double would accept the write, with the same miss registering when the catalog answers as the control; clause 1, a dropped catalog connection does not throw into the render. In-process, `harvest` "WIRE-4 clause 1/2" on the preload path too. Mutation D7 (guard removed) → 1 red; the A–H record below. | all |
| WIRE-5 | implemented | n/a (pure) | `apiUrl` is a constructor option, typed on `LangsysServerConfig` and listed in the README configuration table; `api` "URL construction" asserts the configured base is used, a trailing slash stripped, and the published host otherwise. The e2e suite points the built app at a separate mock API process and requests arrive there. The too-late failure mode is unrepresentable: there is no setter, so nothing can redirect after construction. | all |
| CONF-1 | implemented | contract | Transport-backed rows are asserted on what the vendored double accepted, read back from `/__fixture/state`, never on what the SDK sent. Every path is proven where a rule has several: TOK-1, TOK-2, TOK-3, TOK-4 on tokenize and render; ICU on `t()` and the block path; REG-3 on request completion, manual flush and worker exit. | all |
| CONF-2 | implemented | n/a (pure) | Every row carries a tier from the canonical set; hold-back rows drift the double's world so it would accept (GATE-1) or run where it accepts (WIRE-4, GATE-8's control), never on an absence the double would produce anyway; never-attempt clauses are proven at the seam (REG-1, GATE-6, SRV-3's read-only half). The double is vendored byte-exact as tree `542f57f5` (`contract-fixture` test recomputes it). `_dev_/conformance-summary.mjs` refuses off-vocabulary statuses and tiers, collapsed, duplicated, missing or foreign ids, and a header citing another blob. | all |
| CONF-3 | implemented | n/a (pure) | Mutations are recorded below with the exact edit, the red count, and the suite each was measured on; since the ICU battery they run in a git worktree against a clean build of the core commit, never by rewriting `src/` in place. Equivalent mutants are recorded as such, and survivors with the test added to kill them. | all |

---

## Mutation records

CONF-3 wants the exact edit and its observed count, not a summary. Each table names the
suite it was measured on, because the same edit gives different counts on different suites.

### `<Translate>` — one shared walk (`tests/blocks.test.ts`, 34 tests)

Red-first: the pre-fix applier failed 13 of the new tests. Identity: the pre-fix tokenizer
executed against the shared walk over 21 inputs × 4 option sets — 84 comparisons, 0 differ.

| # | Edit | Red |
|---|---|---|
| M2 | `src/tokenizer.ts` `attributeSlot` — `apply: (t) => setAttribute(element, name, t)` → `apply: () => {}` | 9 |
| M3 | `setAttribute` — `element.attrs.find((a) => a.name === name)` → `element.attrs[0]` | 3 |
| M4 | `walkSlots` — delete `if (isTranslationExcluded(node)) continue;` | 3 |
| M5 | `walkSlots` — delete `if (isPhraseMarked(node)) continue;` | 1 |
| M6 | text slot `apply` — keep the node's own whitespace → `text.value = translated` | 12 |
| M7 | option duplicates — drop the duplicate slots | 1 — **0 at first**: the pin compared the walk's tokens with `tokenizeHtml`, which reads them off the same walk; re-pinned to a measured literal |
| M8 | `<button>` `value` slot not emitted | 1 |
| M9 | `<input type=submit>` / `type=button` `value` slot not emitted | 1 |
| M10 | `renderTranslateBlock` — `serialize(fragment)` → the untouched `innerHtml` | 19 |
| M11 | CAT-2 guard — `typeof translated === 'string' && translated.length > 0` → `translated !== undefined` | 2 |
| T1 | `tokenizeAttributes` — walk the element's own attributes (author order) instead of the constant; measured at 40 tests | 1 |

### REG-8 — backoff (`tests/harvest.test.ts`, 66 tests)

| # | Edit | Red |
|---|---|---|
| B1 | `RegistrationBackoff.failed` — drop the `Math.min(…, REGISTRATION_BACKOFF_CEILING_MS)` ceiling | 1 |
| B2 | `failed` — `INITIAL_MS * 2 ** this.failures` → `INITIAL_MS` (no doubling) | 2 |
| B3 | `succeeded` — delete the reset of `failures` and `until` | 1 |
| B4 | `failed` — delete the in-flight guard `if (this.failures > 0 && sendToken !== this.episode) return …` | 1 |
| B5 | `drainMissQueue` — `if (waitMs > 0)` → `if (false && waitMs > 0)` | 8 |
| B6 | `drainMissQueue` catch — a thrown send records no failure | 1 |
| B7 | `shouldAnnounce` — announce every skipped drain | 1 |
| B8 | `drainMissQueue` — never announce | 1 |
| B9 | `src/index.ts` — one process-global clock (`globalThis.__lsBackoff ??= new RegistrationBackoff()`) | 17 |
| B10 | `flush()` — drain with a fresh `new RegistrationBackoff()` | 1 |
| B11 | `remainingMs` — the window ends 1ms late | 6 |

### REG-7 (`tests/harvest.test.ts`, 68 tests)

| # | Edit | Red |
|---|---|---|
| R1 | `drainMissQueue` — delete `if (scope.draining) return;` | 1 |
| R2 | the chunk loop — fire every chunk but the last without awaiting it | 1 |

### SRV-4 (`tests/e2e`, 18 tests, 1 skipped by design)

| # | Edit | Red |
|---|---|---|
| L1 | `example/src/routes/+layout.server.ts` — delete `langsysCatalog: locals.langsysCatalog,`, rebuild the example | 2 |

### ICU-1 flip (full unit suite, 545 passing / 6 skipped at measurement; git worktree, against a clean build of `ff57476`)

The battery runs in an isolated copy, against a clean build of a `git archive` of the core
commit the flip depends on, so neither this tree nor the live core was read mid-mutation.
Before the flip, the same edits gap-recorded the defect: the fix itself turned exactly the 7
gap tests red (5 `translator`, 2 fixture rows), and nothing else.

| # | Edit | Red |
|---|---|---|
| X1 | `src/translator.ts` — `if (!params) return interpolate(translated, {}, scope.locale);` → `return translated;` (the short-circuit restored) | 6 |
| X2 | out of scope — `interpolate(phrase, params ?? {}, undefined)` → `params ? interpolate(…) : phrase` | 1 |
| P1 | in scope — an empty map short-circuits too (PHP's measured shape) | 9 |
| N1 | `interpolate(translated, params, scope.locale)` — coerce `null` values to `''` first | 2 |
| L1 | the same call — pass `undefined` instead of `scope.locale` | 6 |
| O1 | out of scope — `interpolate(phrase, params ?? {}, undefined)` → `phrase` | 2 |
| B1 | `src/blocks.ts` `renderSlots` — never render ICU (`text = raw`) | 7 |
| B2 | `renderSlots` — write every slot back, changed or not | 1 |
| B3 | a miss or the base locale — return the source even when the block carries ICU | 4 |
| B4 | out of scope — return the source even when the block carries ICU | 1 |
| B5 | `renderSlots` — drop the `isICU` gate and interpolate every slot | **0 — EQUIVALENT.** `interpolate(prose, {})` already returns prose unchanged, so the gate is defensive and no test pins it |

### WIRE-4 clause 2 (full unit suite, 501 passing / 1 skipped at measurement)

Re-measured on this tree. The previous record cited line numbers the file had moved away
from and counts from an older suite (A 3, D 1, F 1, G 1, H 2); a record that does not
reproduce is a memory.

| # | Edit | Red |
|---|---|---|
| A | `src/translator.ts:102` — delete `scope.catalogAvailable && ` from the registration guard | 4 |
| B | `src/index.ts:289` — `let catalogAvailable = true` → `false` | **0 — EQUIVALENT** |
| C | `src/index.ts:298` — `!(CATALOG_FAILED in options.catalog)` → `true` (the preload bug, exactly as shipped) | 1 |
| D | `src/index.ts:310` — `catalogAvailable = resolved.ok` → `true` | 3 |
| E | `src/index.ts:403` — `preloadCatalog` returns `resolved.catalog` unmarked | 1 |
| F | `src/catalog.ts:238` — the `status: false` branch returns `ok: true` | 4 |
| G | `src/catalog.ts:242` — the `throw` branch returns `ok: true` | 2 |
| H | F **and** G together | 6 |

**B is an equivalent mutant and is recorded as one.** The initializer is read by exactly one
path — the base locale, which never queues a miss because a base-locale miss is not a miss —
so flipping it is unobservable. Every other path assigns before use.

### 8.2.12 push, measured in a git worktree against a clean build of core `be6ccd72`

Each table names the tests it ran. Every new behaviour test was red against the commit before
it first.

**Units and shape** (`tests/blocks.test.ts`, full suite):

| # | Edit | Red |
|---|---|---|
| T1 | `walkSlots` — delete `if (isContentBlockMarked(node)) continue;` | 4 |
| T2 | text slot — `node.value.replace(/\s+/g, ' ').trim()` instead of `normalizeTokenText` | 5 |
| T3 | `isContentBlockMarked` — ignore the `false`/`0` opt-out | 1 |
| T4 | `hasSingleTextNode` — count text inside an excised host | 2 |
| S1 | `phraseShaped = tokens.length === 1` | 1 |
| S2 | `phraseShaped = false` | 5 |
| S3 | a block's tokens queued as loose phrases | 4 |
| S4 | phrase shape ignores the flat catalog | 2 |
| Q1 | block queue never drained | 4 |
| Q2 | block dedupe removed | 1 (0 before a test was added) |
| Q3 | dedupe keyed on id alone | **0 — EQUIVALENT**: `custom_id` already hashes the category |

**Retention, hold and exit** (`harvest`, `cache-2`, `catalog`; `reg-3-shutdown` on a rebuilt `dist`):

| # | Edit | Red |
|---|---|---|
| C1 | CACHE-2 window never consulted | 2 |
| C2 | window not cleared on success | 1 (0 before a test was added) |
| C3 | window never doubles | 1 |
| R1 | failed send not kept | 3 |
| R2 | in-window batch not kept | 2 |
| R3 | no wake on success | 4 |
| R4 | no cap | 1 |
| R5 | retained items merged into the next request's send | 4 |
| H1 | unknown collapses to refused | 1 |
| H2 | held request never re-reads the decision | 1 |
| Q1 | render against an empty catalog while the first read is in flight | 13 |
| X1 | no `beforeExit` hook | 1 |
| X2 | no SIGTERM hook | 1 |
| X3 | signal not re-raised | 1 (the child is bounded and killed at 8s) |
| X4 | exit drain not forced past the window | 2 |

**Locale, producer marker, collection** (`srv-6-locale`, `srv-3`, `harvest`):

| # | Edit | Red |
|---|---|---|
| L1 | cookie consulted before the URL | 1 |
| L2 | candidates not validated | 7 |
| L3 | no `Vary` on a header-negotiated locale | 1 |
| L4 | `q=0` treated as a preference | 1 (0 before the vector was sharpened) |
| L5 | no language fallback | 2 |
| G1 | base render marked resolved | 1 |
| S1 | collection inline, before `run()` returns | 2 |
| S2 | a read key pushes | 4 in-process; 0 against the double, which refuses it (see GATE-6) |

**Server messages** (`msg`; `msg-7-command` on a rebuilt `dist`):

| # | Edit | Red |
|---|---|---|
| M1 | `message` not filled | 2 |
| M2 | params kept on a marker-less template | 1 |
| M3 | an emitted template never registered | 5 |
| M4 | registration ignores the catalog listing | 1 |
| M5 | category hard-coded | 1 |
| M6 | no per-server memo | 1 |
| M7 | label markers not refused | 1 |
| M8 | framework placeholders not refused | 1 |
| M9 | catalogued-marker warning every time | 1 |
| M10 | catalogued-marker warning never | 1 |
| C1 | the command re-registers listed templates | 1 |
| C2 | the command registers refused templates | 1 |

**Snapshots, contract rows, closing rows** (`snap`, `contract-rows`, `rows-closing`):

| # | Edit | Red |
|---|---|---|
| N1 | snapshot category filter removed | 1 |
| N2 | failed fetch returns an empty snapshot | 1 |
| D1 | decide by key type: `ip_write` always sends | 3 |
| D2 | an absent `write_enabled` inferred as permission for `ip_write` | 1 |
| D3 | unknown collapses to refused | 1 |
| D4 | failed send not kept | 1 |
| D5 | no chunking | 1 |
| D6 | a 204 parsed as JSON | 1 |
| D7 | WIRE-4 registration guard removed | 1 |
| D8 | OBS-1 refusal warning removed | 1 |
| E1 | every ellipsis suppressed | 3 |
| E2 | ellipsis never suppressed | 1 |
| E3 | no debug note | 1 |
| E4 | prefix matched across categories | 1 |
| K1 | host attributes empty | 3 |
| K2 | CID-4 content check removed | 1 |

### The summary script (`_dev_/conformance-summary.mjs`)

Run on scratch copies of the script and this file, never on the real file. Each edit is the
smallest one that should trip exactly one check.

| Edit to the copy | Flag | Exit | First line of output |
|---|---|---|---|
| none | `--check` | 0 | CONFORMANCE.md summary matches its rows. |
| HINT-3's id → `HINT-3..4`, HINT-4's row deleted | — | 2 | Rows naming more than one rule id — the canonical format is one id per row: |
| CACHE-2's row deleted | — | 2 | Rule ids MISSING from CONFORMANCE.md: CACHE-2 |
| REG-5's row duplicated | — | 2 | Duplicate rule ids in CONFORMANCE.md — the totals below would be meaningless: |
| a `FOO-1` row added | — | 2 | Rows for ids NOT in the pinned spec: FOO-1 |
| MIG-9's status → `waiting` | — | 2 | Status or tier outside the canonical vocabulary: |
| CID-1's tier → `n/a (contract fixture)` | — | 2 | Status or tier outside the canonical vocabulary: |
| the header's blob → `b9fd4b5b…` (8.2.15) | — | 2 | The "Spec revision read" header does not cite blob 5d7e6890…, which is the revision this script's id list was extracted from. |
| ICU-4's status → `not implemented`, summary left as it was | `--check` | 1 | CONFORMANCE.md summary is STALE. Recompute: |

## Gaps, ranked by cost

1. **SRV-5 — the fail-loud half.** `UncapturableChildError` exists and nothing throws it; the
   framework adapters that capture children are not built.
2. **MIG-9 — the one-time import.** Held until the 907 merge lands the `translations` map on
   `POST /translatable-items`.

## Release-wave preconditions

Not conformance gaps; they block a publish and are recorded where a releaser reads.

- **The core must be consumed from a published artifact.** It resolves through a symlink to a
  sibling checkout, so a clean checkout of this repo does not build, and CI needs the core pinned
  to an immutable version carrying `/pure` at `be6ccd72` or later.
- **Never publish from a tree that resolves the core through a symlink.** `tsup` bundles the core,
  so a publish from a developer tree ships a snapshot of a working tree with no recorded revision.
  `_dev_/publish.sh` should refuse when `node_modules/langsys-js-typescript` is a symlink.
