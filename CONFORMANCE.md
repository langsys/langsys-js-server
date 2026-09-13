# Conformance — `langsys-js-server`

| | |
|---|---|
| **SDK** | `langsys-js-server` (server-side JS, the Node sibling to `langsys-php`) |
| **Profiles** | all, server |
| **specVersion** | 8.0.1 (a correction to v8, not a new release; unpublished) |
| **Spec revision read** | langsys2 5cff03a1…, docs/sdk-spec.mdx blob 5c5c0723f88fb8e6b13f58876c7adca8b6b35691 (specVersion 8.0.1). Re-derived with `git -C ~/Documents/dev/langsys2 ls-tree 5cff03a1 docs/sdk-spec.mdx` at this write. The 79 rule ids are pinned to this blob in `_dev_/conformance-summary.mjs`, which exits 2 if this line cites a different one |
| **SDK revision** | `feature/838_write_key_gating` at this commit, cut from `origin/main` `5f37284` |
| **Core** | `langsys-js-typescript/pure` from the sibling checkout at **`a18e4a3`**, resolved through a `node_modules` symlink. Its `/pure` import graph (`identity`, `locale`, `interpolate`, `utils`) is unchanged since `4eac870`: the two commits between touch `src/translate.ts` only, and the uncommitted `src/translations.ts` in that tree is not reachable from `src/pure.ts`. Checked with `git diff --stat 4eac870..a18e4a3 -- src`, not assumed — an earlier revision of this file named a core commit the symlink had already left |
| **Suite** | 538 passing, 1 skipped, 14 files (`npm test`, after `npm run build`). Plus 4 runtimes × 26 checks with identity agreeing, the singleton-graph guard, 17 e2e passing with 1 skipped by design, and tarball acceptance, whose digest `1f284758e5ac3f6dbbb31a642252ca8c` is unchanged by the shared walk — all from one `npm run test:all` on this tree |
| **Reproducing the suite** | Two preconditions, neither obvious from `npm test`: run **`npm run build` first** (several tests are dist-gated and silently skip without it), and have **`../langsys-php-sdk` checked out** (`shared-fixtures.test.ts` hard-fails without it, by design — see CONF-2 on absence versus agreement) |

<!-- SUMMARY:START -->
```
79 rules across 16 families, one row each — each id exactly once
53 bind all/server · 26 are another profile's

By profile:
   47  all
   20  browser
    6  binding
    6  server

By status (binding rules only):
   26  implemented
   14  provisional
    8  partial
    3  not implemented
    1  held (strip ruling)
    1  n/a (architecture: no report lane)

By tier, binding rules only (CONF-2):
   30  n/a (pure)
   16  mock
    7  -
```
<!-- SUMMARY:END -->

Computed from the rows below by `node _dev_/conformance-summary.mjs`; `--check` fails if
the two disagree. The script also refuses the table outright — exit 2 — on a row naming
more than one id, a duplicated id, an id missing from or foreign to the pinned spec, a
status or tier outside the canonical vocabulary, or a header citing a different spec blob
than the one its id list came from. Controls for each are recorded at the foot of this file.

---

## Read this before the table

**The Tier column records whether the property depends on what the API accepts, refuses or
holds.** `n/a (pure)` means it does not — identity, tokenization, substitution, scheduling,
cache keys — so the evidence is execution and the row can be `implemented`. `mock` means it
does, and this suite's doubles cannot hold state across calls, so those rows are
`provisional` however strong their tests are (CONF-2). `-` means no test points at the row.
The previous revision graded by how a test was built rather than by what the property
depends on, and rowed seven pure properties — GATE-4, REG-2, REG-3, REG-6, REG-7, CACHE-1,
WIRE-5 — `provisional` because their tests happened to inject a `fetch` stub that never
needed to say no.

**What surfaced in this revision.** In descending order of cost:

1. **`<Translate>` put translations in the wrong places, in pushed code, with every test
   green.** The tokenizer and the applier walked the tree separately and disagreed. The
   applier consumed translations by position and mirrored only the code-element skip; the
   tokenizer also skips translation-excluded and phrase-marked subtrees, and takes attribute
   and value tokens before an element's text. Measured on the old applier: an `<img alt>`
   before some text moved every later text node onto the translation meant for the token
   before it, a phrase-marked span and a `translate="no"` span were overwritten, and no
   attribute translation ever rendered. No fixture carried an attribute or a marker. Fixed
   with one walk that yields each token with a write-back bound to where it was read
   (`collectSlots`), so registration and substitution cannot drift; identity is unchanged
   (84 comparisons against the pre-fix tokenizer, 0 differ; four runtimes agree). Found by
   the TypeScript lane's attribute probe, not by this lane — TOK-3 and SRV-1 were graded
   above their evidence until then.
2. **WIRE-2 was rowed on the wrong test, and the defect was live.** The row cited the
   non-200 suite; WIRE-2 is about empty *success* responses. Executed: a `204` with no body
   threw `SyntaxError: Unexpected end of JSON input` out of `send()`, so a registration the
   server accepted was logged as failed — and, with REG-8's backoff now built, would have
   opened a backoff window on a success. Fixed by branching on status before parsing.
3. **CID-4 and ICU-1…5 were rowed on evidence that is not theirs — and grading ICU on
   this package's own path found a live defect.** CID-4 cited derivation de-duplication; the
   rule is a content check before attaching to a legacy match, and nothing performs one.
   ICU-1…3 and 5 cited tests that do not exercise recovery, and `35000f7` then rowed them
   `delegated`, which the canonical format reserves for bindings. Graded instead on tests
   through `t()` — the path where two sibling server cores broke over a correct renderer —
   they found that `t()` with **no params at all** returns raw ICU source on every path, while
   an empty map works. The client core has the same short-circuit, executed, so the fix waits
   for the core. See ICU-1.
4. **A test that could not fail, found by mutation.** The option-duplicate pin compared the
   shared walk's tokens with `tokenizeHtml` — which now reads its tokens off that same walk,
   so dropping the duplicates moved both sides together and 0 went red. Re-pinned to a
   literal measured by executing the pre-fix tokenizer.
5. **Two reds that proved nothing.** The REG-8 in-flight test first failed on code with no
   backoff at all, because it asserted 20ms into a 50ms send; and the WIRE-2 red-first run
   selected no tests, because `zsh` does not word-split an unquoted variable, so vitest
   received one filter matching no file. Both were caught before being counted, and both
   reds were re-established: the in-flight test now goes red only under the mutation it
   exists for (B4), and the WIRE-2 red was reconstructed by removing the fix.

**REG-8's backoff is built; its retention half is held.** A failing endpoint now gets one
probe per window per instance rather than a send per request. Keeping failed phrases queued
needs a queue that outlives the request, which bends this package's one invariant, and is
held for the operator's ruling together with GATE-2's hold-on-unknown.

**Instance state, declared.** The invariant is that nothing request-varying lives outside
the request scope. Four facts live on the `LangsysServer` instance and are identical for
every request to it: `keyType`, `writeEnabled`, `batchLimit`, and — new in this revision —
the REG-8 failure clock. The first three are copied into each request's scope at `run()`.
The clock is read at drain time instead, deliberately: it exists to react to a failure that
landed after the request started rendering. It is per instance, never per module — a
module-level clock lets one project's failing key silence every other project in the
process, and the mutation that makes it process-global (B9) turns 17 tests red.

**GATE-3 carve-out, declared here because GATE-3 requires it to be declared.** This SDK
holds `write_enabled` on the server instance across requests and copies it into each
request's `AsyncLocalStorage` scope. GATE-3's narrow carve-out permits a process-level value
only where capability provably does not vary per session, and it voids the moment a write
grant is configured, because a grant makes capability per-user. **This package exposes no
grant surface**: there is no `writeGrant` or `strategy` option in `LangsysServerConfig`, no
grant is ever sent — `build-output` asserts the shipped bundle carries no `X-Write-Grant` —
and GRANT-1…4 are `browser`-profiled. Capability here depends solely on this server's own
outbound address, which is constant for the process. If a grant surface is ever added, this
carve-out is void and the decision must move fully per-request.

---

## Status

| Rule | Status | Tier | Evidence | Profile |
|---|---|---|---|---|
| GATE-1 | provisional | mock | `harvest` "GATE-1 — the decision is the server's write_enabled, never the key type": both failure directions, `ip_write` + `write_enabled: true` registering (the discovery renderer), and the flag read off the `/translations` envelope. Mutations: ignore the positive answer → 4 red; ignore the negative → 2 red. The property is the server's answer, and these doubles hold no state. Waits on: CONF-2 shared contract fixture. | all |
| GATE-2 | partial | mock | Collection is unconditional in `t()` and the lane is chosen at the send site, which is the rule's first half. **Not met: unknown is collapsed into refused-and-consumed rather than held.** Measured, not checked in: authorize HTTP 500 → 1 queued, 0 POSTs, a "could not be determined" refusal, the batch consumed, and no re-authorize inside `AUTHORIZE_RETRY_MS`. Holding needs the queue to outlive the request; held for the operator's ruling with REG-8 retention. | all |
| GATE-3 | partial | - | Carve-out taken and declared above. `write_enabled` is never written to any cache and is snapshotted into each request scope at `run()`; the drain reads the scope, never the instance. Missing: a test that the decision cannot outlive a request. | all |
| GATE-4 | implemented | n/a (pure) | `authorize()` projects its payload to the key type, the capability and the batch limit, and drops the body; `/translations` is read off the envelope before `normalizeCatalog`, and only the body is cached. `harvest` "constraint 5 — never applies the fallback from a CACHED payload" runs two instances over one shared cache with the server saying `write_enabled: false`, and the cache-served instance still refuses. Mutation: the cache-hit path fires the capability callback → `expected 1 to be +0`. What the cache holds does not depend on what the API accepts. | all |
| GATE-5 | provisional | mock | Bookkeeping (`missSeen`, `posted`) is request-scoped and dies with the request, so no cross-request false marker is representable. `posted` advances before the await, so a failed send within one request is consumed rather than marked registered; REG-8 now backs off after it, and keeping it queued is held. Acceptance is the property, and proving it needs a double that refuses and a second read. Waits on: CONF-2 shared contract fixture. | all |
| GATE-6 | provisional | mock | Split row. Sentence 2 binds and is tested: a non-write-enabled session never attempts to register (`harvest` "write-key gating" and the GATE-1 block: `write_enabled: false` → 0 POSTs, `true` → 1). Sentence 1 is unreachable here: there is no report lane to be exclusive with (HINT-2). Waits on: CONF-2 shared contract fixture. | all |
| GATE-7 | n/a (architecture: no report lane) | - | For a read-only session no path feeds either lane: registration is refused, and reporting does not exist by HINT-2's design. That is the rule's invisible-path case, present structurally, and stated rather than rowed green; the lane that would close it is the one HINT-2 forbids. | all |
| GATE-8 | provisional | mock | `harvest` "GATE-8 — a missing write_enabled is a version signal, never permission": plain-`write` fallback; `ip_write` refused with its message asserted; non-boolean treated as absent (a truthy `"false"` on a read key, `0` on a write key); re-evaluated per response; and constraint 5 over a shared cache. Mutations: delete the `ip_write` branch → 1 red; `Boolean()` coercion → 2 red; the cache-hit capability callback → `expected 1 to be +0`. Waits on: CONF-2 shared contract fixture. | all |
| CAT-1 | implemented | n/a (pure) | `translator` "CAT-1/CAT-2/CAT-3 — presence decides registration, the value decides display": present-with-null and present-with-`''` are not re-registered; inherited `Object.prototype` names still are. Mutation: `hasOwnProperty` → `in` → 1 red. `renderTranslateBlock` applies the same own-property presence test. | all |
| CAT-2 | implemented | n/a (pure) | Same block: `null`, `''` and an object all display source text. On the block path, `blocks` "CAT-2: a null translation renders SOURCE text, not blank" and "CAT-2: an empty-string translation renders source text too"; loosening the guard to any non-undefined value → 2 red (M11). | all |
| CAT-3 | implemented | n/a (pure) | Same block: a content block present as an object is not re-POSTed under its raw custom id. | all |
| REG-1 | provisional | mock | `harvest` "write-key gating" and the GATE-1 block: a refused session makes no call at all, asserted as a stub that saw none (see CONF-1). Waits on: CONF-2 shared contract fixture. | all |
| REG-2 | implemented | n/a (pure) | No interval exists to be the only path: misses drain on `setImmediate` after the response flushes, so one render's burst is one send per batch-limit chunk. `harvest` "never in the TTFB path" asserts the order of events: 0 registrations when `run()` resolves, 1 after the drain settles. When a send goes out does not depend on what the API answers. | all |
| REG-3 | implemented | n/a (pure) | A public manual flush exists and drains the scope that rendered: `harvest` "flush() for edge runtimes" — drains when awaited, for `waitUntil`; no double-post in either order with the scheduled drain; loud when handed a value `run()` did not produce. The automatic path is not treated as reliable. On the REG-3/REG-8 shutdown conflict the spec leaves open, a failed flush is logged with what was not registered, never silent. | all |
| REG-4 | n/a (profile: browser) | - | Profile `browser`. No teardown event exists on this profile. | browser |
| REG-5 | n/a (profile: browser) | - | Profile `browser`. | browser |
| REG-6 | implemented | n/a (pure) | `harvest` "REG-6 — the batch that was SENT is what gets marked, not the queue as it stands": one scope, a late miss arriving through ALS while that scope's own POST is in flight, plus a control that a phrase is sent once. The first version called `run()` twice — two scopes, two queues — and went 0 red under its own mutation; rewritten. Mutation: mark the live queue after the await → 1 red. | all |
| REG-7 | implemented | n/a (pure) | The rule is a title with no body at this revision, so the server reading is stated in the test: one QUEUE never has two sends in flight. Queues are per request, so two concurrent requests to an instance can each have one — the REG-8 in-flight test depends on that. `harvest` "REG-7 — one send in flight at a time, per queue": a chunked queue never overlaps (three chunks, at most one in flight), and a `flush()` while the queue is still sending waits rather than overlapping. Mutations: remove the per-queue draining guard → 1 red (R1); fire chunks without awaiting → 1 red (R2). | all |
| REG-8 | partial | mock | **Backoff: built.** One failure clock per `LangsysServer`; 3s doubling to a 300s ceiling, reset on the first success; a drain inside the window sends nothing and warns once per window with what it dropped; a send already in flight when an earlier failure opened the window does not escalate it; a thrown send counts; the `flush()` path obeys it. `harvest` "REG-8 — a failed send backs off, per instance", 10 tests; mutations B1–B11 below, every one red. **Retention: not built, held** for the operator's ruling — a failed or skipped phrase is not re-queued, and registers the next time it renders after the window. Depends on the server refusing. Waits on: the retention ruling, and CONF-2 shared contract fixture. | all |
| REG-9 | provisional | mock | `harvest` "REG-9 — batch to the server-provided limit, on every path": chunks to `langsys_settings.translatable_items.batch_limit` on both drain paths, defaults to 200, guards `0`, negative and non-numeric. Mutations: no chunking → 9 red; hardcode 200 → 3 red; read one level short → 2 red; drop the `>=1` guard → 3 red; ignore the advertised limit → 2 red. Depends on the limit the server advertises and enforces. Waits on: CONF-2 shared contract fixture. | all |
| REG-10 | provisional | mock | `harvest` "fire-and-forget, but not silent": a failed and a throwing registration both log without failing the render. Drains return `Promise<void>`, so no success-shaped value exists to be wrong about, and a refused session consumes its batch without reporting success. Waits on: CONF-2 shared contract fixture. | all |
| REG-11 | not implemented | - | No ellipsis warning exists in `src/`. Held by the operator with this round's other behaviour changes. | all |
| REG-12 | partial | - | No test. In code, `t()` branches on structure: a non-string catalog value is known and never queued. Missing: a test that text colliding with a block id is not re-registered, on both `t()` and the block path. | all |
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
| ICU-1 | partial | n/a (pure) | Graded on this package's `t()`, not on the core's function: importing `interpolate` proves the function, not the call path into it (CONF-1). **Met with params, an empty map included:** `shared-fixtures` "langsys-php-sdk interpolation-reference.json, through this package's t()" renders all 19 rows (blob `d369bd18`) through `run()` + `t()` in each row's own locale — "select: argument missing falls to other" — and `translator` "ICU-1: an EMPTY params map renders its other branch"; PHP's empty-map short-circuit → 1 red (P1). **Not met with no params at all:** `t()` returns the raw ICU source in scope, with the category overload, on a catalog hit and out of scope, recorded by `translator` "ICU-1 GAP — with NO params, t() skips interpolation, matching the client core until both move". The client core does the same, executed at `langsys-js-typescript` `a18e4a3`, so fixing this side first would mismatch hydration on every such string: held core-first and reported to the TypeScript lane. The two-line fix turns exactly those five red (F1). | all |
| ICU-2 | implemented | n/a (pure) | Through `t()`: `shared-fixtures` rows "select: null argument treated as missing", "plural: NULL is missing, not zero" and "simple: null value left verbatim", and `translator` "ICU-2: a null argument is absent on the t() path, not the string "null"". Mutation: coerce `null` to `''` before `interpolate` → 2 red (N1), the plural and plain rows. The select vectors stay green under it, because an empty string also selects `other` — recorded so the count is not read as covering them. | all |
| ICU-3 | partial | n/a (pure) | **Met with params:** recursion into a satisfied branch and `#` rendering `{argName}` hold through `t()` — `shared-fixtures` rows "nested: missing arg inside satisfied branch" (`{n} amigos`), "nested: unsatisfied branch never evaluated" and "plural: argument missing keeps sentence, shows gap" (`{count} items`). No mutation on this package's path isolates recursion: it is the core function's behaviour, and this path only has to reach it. **Not met with no params:** the ICU-1 gap skips interpolation entirely, so `t()` on a plural returns its source instead of `{count} items` — `translator` "a plural with no params returns the source (fixed: {count} items)", red under the fix (F1). | all |
| ICU-4 | partial | - | No test. `interpolate` is the core's, whose defaulted-argument notice is asserted in the core's suite behind the core's own logger. Missing: evidence that the notice fires, and names the argument, under this package's `debug` option. | all |
| ICU-5 | implemented | n/a (pure) | Through `t()`: `translator` "ICU-5: a supplied plural keeps CLDR selection beside a missing select (ru, n=3 is few)", with a distinct word per branch; `shared-fixtures` rows "russian plural: few", "russian plural: 21 is one", "russian plural: 111 is many" and "simple: integer formatted per locale"; and the recovered literal surviving a present-and-null argument, "plural: NULL is missing, not zero". Mutations: the request locale not passed to `interpolate` → 6 red (L1); `null` coerced to `''` → the null-literal row red (N1). | all |
| CID-1 | implemented | n/a (pure) | `shared-fixtures` against `langsys-php-sdk`'s `custom-id-reference.json`, blob **`633a09d9`** (was `60dc9b33`), 13 rows, each asserting `canonical_json`, `serialized_hex` and `custom_id` separately; the blob hash is recomputed and pinned. Covers U+2028/U+2029, non-BMP U+1F600, Cyrillic and slash-bearing categories. Authored in another lane. | all |
| CID-2 | implemented | n/a (pure) | `conformance/cid-2`: the `'__uncategorized__'` sentinel is coalesced at the boundary in `deriveBlockIdentity`, asserted on the whole derivation set rather than the primary id — `generateLegacyCustomId` deliberately does not coalesce, so the sentinel once emitted a fallback an empty category never did. | all |
| CID-3 | implemented | n/a (pure) | `derivations` "the two historical LEGACY-token shapes", pinned to `HISTORICAL_TRANSLATABLE_ATTRIBUTES_15` so they reproduce what was actually stored. Registration always uses the primary derivation; the legacy ids are read-only, and `renderTranslateBlock` reads under them. | all |
| CID-4 | not implemented | - | After a historical-id lookup resolves, `renderTranslateBlock` attaches on id presence alone and does not compare the found block's `(category, phrases)` with the current block's, so a collision would attach the wrong text. The previous revision rowed this on derivation de-duplication, which is a different property. A behaviour change, so not built under this round's cheap-fix ruling. | all |
| TOK-1 | implemented | n/a (pure) | `script`, `style`, `template`, `noscript` and `math` are excluded through `SKIP_ELEMENTS`, a re-export of the core's `NON_TRANSLATABLE_ELEMENTS`. Proven per path (CONF-1). Tokenize: `walker-parity` "excludes math content — the spec vector, arriving through the re-export" (`['Area','units']`, the vector `langsys-php` produced by executing `extractPhrases`) and the `<noscript>` cases, with the ordinary-markup control. Render: `blocks` "math content is not translated, and the text around it is", and "inline svg keeps the parent text, translates svg <text> in place, and leaves <path> intact"; tokenize and render share one walk. `<Phrase>`: `phrase` "script and style bodies contribute nothing", and asserted for `math` by the same constant. Core fixture: 26 rows against this blob. The math gap closed when the core shipped it (`105943f`), and the test recording the gap went red as designed. | all |
| TOK-2 | held (strip ruling) | n/a (pure) | Held: the C0 control-character clause (U+0001–U+0008, U+000B, U+000C, U+000E–U+001F), pending the operator's strip ruling; nothing built. The rest is met through the core's `normalizeTokenText` on attributes and `/\s+/g` on text nodes: the core fixture's collapse-set rows (26 rows, this blob, including `feff-in-text`, `nel-in-text` and `mvs-in-text`), and on the render path `blocks` "a placeholder with an NBSP registers and LOOKS UP under the same key", with the line-break and doubled-space vectors. | all |
| TOK-3 | implemented | n/a (pure) | `attribute-list-pin` "is array-identical to PHP's list, INCLUDING order": the 27 against a literal transcribed by hand from `langsys-php`'s `HtmlParser.php`, since the constant now is the core's array. The spec's own vector, proven on both paths (CONF-1): `blocks` "TOK-3 — the spec vector, proven on both paths" — three listed and two unlisted attributes, authored out of list order, give three phrases in list order and render each in place with the unlisted two untouched; plus "TOK-3 order decides the token sequence, but location decides where each lands". Mutations: walk the element's own attributes instead of the constant → 1 red (T1); attribute write ignores the name → 3 red (M3); attribute write a no-op → 9 red (M2). Attribute translations never rendered before this revision — see "What surfaced", item 1. | all |
| TOK-4 | implemented | n/a (pure) | Attribute values and `<option>` text go through the core's `normalizeTokenText`: the core's `canonicalization-reference.json`, 26 rows against spec blob `5c5c0723`, every row asserting tokens and id. On the render path, the line-break, doubled-space and NBSP placeholder tests assert the key registers and looks up the same. | all |
| TOK-5 | implemented | n/a (pure) | Capture: the core fixture rows `percent-name-in-markup` and `brace-name-in-markup` reach one id. Interpolation, through this package's `t()`: `translator` "TOK-5 — `%name%` is accepted as the escape for `{name}`" — both forms give the same output, and a control that percent prose with no matching key is left alone. `interpolate` itself is the core's. | all |
| MARK-1 | not implemented | - | Held by the operator. `stampContentBlock()` returns the attribute pair and no render path writes it onto a host, so a rendered `<Translate>` host carries no id. | all |
| MARK-2 | implemented | n/a (pure) | Both spellings accepted on read: `translator` "recognises the PHP marker spelling too" on the audit path (`data-langsys-phrase`), and `CONTENT_BLOCK_MARKER_ATTRS` carries `data-langsys-contentblock` beside `data-ls-contentblock`, asserted in `blocks`. | all |
| SSR-1 | n/a (profile: browser) | - | Profile `browser`: governs what the browser SDK does under server rendering, in the browser's module instance. | browser |
| SSR-2 | n/a (profile: browser) | - | Profile `browser`. | browser |
| SSR-3 | n/a (profile: browser) | - | Profile `browser`. | browser |
| SRV-1 | provisional | mock | `e2e/example` "SPEC §13.1 — the acceptance test", on a production SvelteKit build and the served bytes: Italian body copy, `<title>`, meta description, `og:title` and a translatable `alt` present, the English absent, the base locale as the negative control, and a phrase missing from the catalog falling back and registering. On the block path, translations land where their tokens were read — attributes included — only as of this revision ("What surfaced", item 1). The example's API is a mock server. Waits on: CONF-2 shared contract fixture. | server |
| SRV-2 | implemented | n/a (pure) | `isolation` "concurrent requests for different locales": renders interleaved across awaits, repeated, and miss queues kept per request. Mutation on record: swapping `AsyncLocalStorage` for a module global → 4 red. `e2e` "holds under 120 interleaved requests across four locales" on the built app. | server |
| SRV-3 | provisional | mock | `harvest` "never in the TTFB path" asserts the order of events, not the outcome: 0 registrations immediately after `run()` resolves and 1 only after the drain settles, with a 50ms delay proving the render did not wait. The read-only half has a write-key positive control on the same render shape. Waits on: CONF-2 shared contract fixture. | server |
| SRV-4 | implemented | n/a (pure) | **The server half, which is this lane's.** `e2e/example` "SRV-4 — the client is handed the catalog the server rendered with": the served `/it` page's hydration payload carries the Italian catalog and `langsysLocale` `it`, and `/de` carries its own locale and not the Italian. Mutation: delete `langsysCatalog: locals.langsysCatalog,` from `example/src/routes/+layout.server.ts` and rebuild → 2 red (L1). `run()` and `preloadCatalog()` return that catalog through `normalizeCatalog` on every path. **Not this lane's, named rather than claimed:** the synchronous seed is the browser core's, and calling it before hydration is a binding's; the example calls no seed yet, so the round trip is untested here. | server |
| SRV-5 | partial | n/a (pure) | **Once per subtree: met.** `blocks` ".missing is a record of phrases, not of token positions": a depth-3 block holding `Repeat` four times posts it once, counted, and the returned `.missing` lists it once — it listed it four times until this revision, while registration was already right. **Fail loudly on an uncapturable child: not met.** `UncapturableChildError` is defined and exported and nothing throws it; the framework adapters that would capture children are not built. | server |
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
| OBS-1 | provisional | mock | `harvest` "write-key gating" and the GATE-8 block: a capability refusal on a key expected to write warns once per instance, unconditionally, with the message asserted; the base SDK's `if (debug)` gate is not copied. Depends on the server answering `write_enabled: false`. Waits on: CONF-2 shared contract fixture. | all |
| WIRE-1 | provisional | mock | `api` "request headers": `x-Authorization` on every request, GET and POST alike, plus `X-Langsys-Capabilities: icu`; never a cookie or a query parameter. Asserted on outgoing requests (see CONF-1). Waits on: CONF-2 shared contract fixture. | all |
| WIRE-2 | provisional | mock | `api` "WIRE-2 — an empty success response is a success, not a parse error": a `204` with no body resolves `status: true`, with an empty `500` as the control; `harvest` "WIRE-2 on the drain path — a 204 from registration is a success": no failure logged and no REG-8 window opened. `send()` branches on status before parsing. Red-first, reconstructed by removing the branch: 2 red (the `api` 204 test and the drain-path test), with the empty-`500` control green. Which endpoints answer empty is the API's answer. Waits on: CONF-2 shared contract fixture. | all |
| WIRE-3 | implemented | n/a (pure) | `api` "WIRE-3: sends lowercase xx-yy on the wire, whatever casing it was handed", and four spellings of one locale reach the wire identically. Resolved by construction on the `/pure` re-parent; `0.1.0` shipped the cased form. | all |
| WIRE-4 | provisional | mock | **Clause 1:** `harvest` "WIRE-4 clause 1 — the translation call must never throw", checked in: a real connection refusal at `127.0.0.1:1`, `run()` + `t()` and `preloadCatalog()` both degrading, with a reachable-stub control. **Clause 2:** `harvest` "WIRE-4 clause 2 — a failed catalog fetch registers NOTHING", on the inline fetch and the preload path (`preloadCatalog()` → `run({ catalog })`, the shape `example/src/hooks.server.ts` uses), with positive controls that the same phrases do register when the catalog loads. Mutations A–H below, re-measured on this tree. Waits on: CONF-2 shared contract fixture. | all |
| WIRE-5 | implemented | n/a (pure) | `apiUrl` is a constructor option, typed on `LangsysServerConfig` and listed in the README configuration table; `api` "URL construction" asserts the configured base is used, a trailing slash stripped, and the published host otherwise. The e2e suite points the built app at a separate mock API process and requests arrive there. The too-late failure mode is unrepresentable: there is no setter, so nothing can redirect after construction. | all |
| CONF-1 | provisional | mock | Every `mock` row above asserts on a `fetch` stub, which CONF-1 forbids as sole evidence: GATE-1, GATE-2, GATE-5, GATE-6, GATE-8, REG-1, REG-8, REG-9, REG-10, SRV-1, SRV-3, OBS-1, WIRE-1, WIRE-2, WIRE-4. The every-path clause: TOK-1, TOK-3 and TOK-4 name the paths they were proven on, and ICU-1…3 and 5 are graded on this package's `t()` rather than the core's function — which is how ICU-1's no-params gap surfaced. Waits on: CONF-2 shared contract fixture. | all |
| CONF-2 | implemented | n/a (pure) | Every row carries a tier from the canonical set, and `_dev_/conformance-summary.mjs` refuses a status or tier outside the vocabulary, a collapsed, duplicated, missing or foreign id, and a header citing a blob other than the one its id list came from. Controls below. | all |
| CONF-3 | implemented | n/a (pure) | Mutations are recorded below with the exact edit, the red count, and the suite each was measured on. Equivalent mutants are recorded as such (WIRE-4 B; `scriptingEnabled: false`), and survivors with what they exposed (M7; the first REG-6 test). From the ICU battery on, mutations run in a git worktree rather than rewriting `src/` in place, which voided symlinked consumers' counts during the earlier runs. | all |

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
| M7 | option duplicates — drop the duplicate slots | 1 — **0 at first**, see "What surfaced", item 4 |
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

### ICU through `t()` (`tests/translator.test.ts` + `tests/conformance/shared-fixtures.test.ts`, 111 tests; git worktree)

The first battery run in an isolated copy rather than in place. P1, N1, L1 and O1 were measured
while the five no-params tests still asserted the fixed behaviour, so each count is the red
beyond those five. F1 was measured after they became gap tests, on the worktree's full suite.

| # | Edit | Red |
|---|---|---|
| P1 | `src/translator.ts` — `if (!params) return translated;` → also return early on an empty map (PHP's measured shape) | 1 |
| N1 | `return interpolate(translated, params, scope.locale)` — coerce `null` values to `''` first | 2 |
| L1 | the same call — pass `undefined` instead of `scope.locale` | 6 |
| O1 | out of scope — `params ? interpolate(phrase, params, undefined) : phrase` → `phrase` | 1 |
| F1 | the fix itself, `params ?? {}` on both returns (539 tests) | 5 — exactly the ICU-1 gap tests, nothing else |

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

### The summary script (`_dev_/conformance-summary.mjs`)

Run on scratch copies of the script and this file — never on the real file. Each edit is
the smallest one that should trip exactly one check.

| Edit to the copy | Flag | Exit | First line of output |
|---|---|---|---|
| none | `--check` | 0 | CONFORMANCE.md summary matches its rows. |
| none | — | 0 | 79 rules across 16 families, one row each — each id exactly once |
| HINT-3's id → `HINT-3..4`, HINT-4's row deleted | — | 2 | Rows naming more than one rule id — the canonical format is one id per row: |
| CACHE-1's row deleted | — | 2 | Rule ids MISSING from CONFORMANCE.md: CACHE-1 |
| REG-5's row duplicated | — | 2 | Duplicate rule ids in CONFORMANCE.md — the totals below would be meaningless: |
| a `FOO-1` row added | — | 2 | Rows for ids NOT in the pinned spec: FOO-1 |
| REG-11's status → `gap` | — | 2 | Status or tier outside the canonical vocabulary: |
| CID-1's tier → `n/a (contract fixture)` | — | 2 | Status or tier outside the canonical vocabulary: |
| the header's blob → `8e2527b9…` | — | 2 | The "Spec revision read" header does not cite blob 5c5c0723…, which is the revision this script's id list was extracted from. |
| REG-12's status → `not implemented`, summary left as it was | `--check` | 1 | CONFORMANCE.md summary is STALE. Recompute: |

Before this revision the script exited non-zero only on a duplicate, on no rows at all, or on a
stale `--check`: a deleted row printed "78 rules" and exited 0, and a collapsed row was expanded
rather than refused.

## Gaps, ranked by cost

1. **MARK-1 — nothing writes a marker.** Held by the operator. Server-rendered hosts carry no
   resolved id, so the client-DOM parity probe cannot key on anything and
   `auditRenderedHtml` reports clean on a page it cannot see into.
2. **GATE-2 hold-on-unknown and REG-8 retention — one decision.** Both need a queue that
   outlives the request, which bends this package's one invariant. Held together for the
   operator's ruling on per-request server SDKs.
3. **ICU-1 and ICU-3 — `t()` with no params renders raw ICU source.** A page calling `t()` on
   a `select` or `plural` without params shows the syntax. The client core does the same, so
   this side waits for the core's fix and flips in the same wave; five gap tests go red when it
   does. No lane's shared interpolation fixture has a no-params row, which is why none caught it.
4. **CID-4 — a legacy match is attached on id presence alone.** A collision attaches the
   wrong block's text, and the failure looks like a translation. A behaviour change, so not
   built this round.
5. **SRV-5 — the fail-loud half.** `UncapturableChildError` exists and nothing throws it;
   the framework adapters are not built.
6. **REG-11 — no ellipsis warning.** Held.
7. **TOK-2 — the C0 control characters.** Held for the strip ruling.
8. **GATE-3, ICU-4 and REG-12 have no test pointing at them.** Each is defensible by reading
   the code, which is exactly the row CONF-1 says to distrust.
9. **CONF-1 is unmet fleet-wide.** The shared contract fixture does not exist, which caps
   every transport row at `provisional`.

## Release-wave preconditions

Not conformance gaps, but they block a publish and are recorded here because this is the
file a releaser reads. Both are written up in `ROADMAP.md` with their evidence.

- **A clean checkout does not build.** The core is a *devDependency* pinned `^0.6.5` and the
  lockfile resolves the registry tarball, whose published `0.6.5` exposes no `./pure`, so
  `tsc --noEmit` fails on every `/pure` import. Still pinned `^0.6.5` at this write; the
  compile failure itself was not re-measured in this revision. CI stays red until the core
  publishes a version carrying the subpath.
- **Never publish from a tree that resolves the core through a symlink.** `tsup` bundles the
  core (it is a devDependency), so a publish from a developer tree would ship a snapshot of
  an *uncommitted working tree* with no revision recorded in the tarball — the core tree
  this was measured against has an uncommitted `src/translations.ts` right now. There is no
  path leak; the hazard is provenance, not disclosure. `_dev_/publish.sh` still does not
  refuse when `node_modules/langsys-js-typescript` is a symlink.
- **CI needs the core pinned to an immutable artifact.** The symlink couples this suite to a
  live sibling working tree; the same `npm test` has given different answers ten minutes
  apart with no change in this repo.
