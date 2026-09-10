# Roadmap

Open items, with what blocks each. Mirrors the convention in `langsys-js-typescript` and
`langsys-php-laravel`.

Entries are written so the next session does not re-litigate a decision from taste. Where
something is blocked on a fact nobody has, the entry says what the fact is and where to get
it — a lookup is cheaper than an argument.

---

## 0.2.0 — `<Phrase>` and `<Translate>` server-side

**Status:** not started. The single largest gap; 0.1.0 states it plainly in the README
capability matrix and `auditRenderedHtml()` reports it per page.

The tokenizer, `custom_id` derivation and marker protocol are already implemented and
conformance-tested. What is missing is the per-framework **child capture** step, and the
three frameworks need three genuinely different mechanisms (measured by the framework
owners, via `langsys-skill`):

| Framework | Mechanism | Sync? |
|---|---|---|
| Svelte 5 | re-entrant `render()` from `svelte/server`, throwaway wrapper component | sync, but **lazy** — `.body` evaluates on access |
| Vue 3 | `async setup()` + throwaway app | **async** — the sync machinery exists but is unexported |
| React 19 | **no renderer at all** — walk the element tree as data | sync |

**The core stays string→string and synchronous.** `(html, category, ctx) → { html, customId, missing[] }`.
Adapters own the children→string step and may be async where the framework demands it, so
Vue's asynchrony never infects the core and one framework's mechanism failing costs an
adapter rather than the model.

Three constraints that reach past the adapter into what users may write:

1. **Component-level `provide()` / React context does not cross a nested render.**
   Confirmed independently in Vue and React. A component inside a `<Translate>` slot that
   injects from an ancestor **silently gets its fallback**. Documentable rule: scope
   `<Translate>` to leaf content — which is what tokenization wants anyway.
2. **Svelte's nested capture re-executes 2^depth** (measured: 8 executions of one leaf at
   capture-depth 3). That is *correctness*, not perf, because `t()` registers misses as a
   side effect. Memoise capture per snippet identity, or suppress registration during
   capture passes.
3. **RSC has two walls.** A Server Component `<Translate>` is hard-impossible
   (`react-dom/server` resolves to a thrower under the `react-server` condition). A Client
   Component with server children is *worse*: nothing throws, capture silently returns the
   Suspense fallback, and the block mis-keys. React's tree-walk removes wall 1 and makes
   wall 2 **detectable** (`$$typeof === Symbol.for('react.lazy')`). **Fail loudly on an
   unwalkable child** — treat that as a core requirement, not an adapter nicety.

**Note the two primitives key by opposite means and must not be conflated.**
`<Translate>` → `tokenizeElement` → `tokens[]` → `generateCustomId`, adjacent text nodes
**not** coalesced, arity *is* identity. `<Phrase>` → `encodeRichText` → a coalesced,
whitespace-collapsed **string**, with `{m0o}`/`{m0c}` slot markers; there is no token array
and no `custom_id`. A rule of "never coalesce adjacent text nodes" is correct for the first
and actively wrong for the second.

---

## Translatable attributes: converge on PHP's 27

**Status:** blocked on the client family, then on a migration count. Decided 2026-08-21.

PHP's list is the contract. The 15 this package ships are byte-identical to
`langsys-js-typescript@0.6.5`'s, in identical order; PHP's extra 12 form one contiguous
appended block, so **nothing already in the list moves** and only blocks carrying one of
the twelve re-key.

**This package must not ship 27 first** — it would disagree with its own hydration partner
on every request, which is a per-request cost against PHP interop's deployment-topology
one. `tests/attribute-list-pin.test.ts` asserts the published base SDK still carries 15 and
**fails with an instruction when it stops**, which is the signal to move.

**The blocker is the migration, and it is a lookup, not a judgement.** A block re-keys only
if its subtree carries one of the twelve *with a non-empty value*; every other block's
`tokens[]` is byte-identical. So the affected set is exactly: content blocks whose stored
`content` HTML contains any of the twelve attribute names. **Get that count out of the
Translation Manager before choosing a mechanism** — "carry a fallback indefinitely" and
"rebase once" have very different prices at 4 blocks than at 4,000, and nobody in the design
discussion had the number.

Read-side support already exists (`derivations.ts`, `converged-27`), so the day it lands is
a no-op for lookups.

---

## `<script>` / `<style>` skip: converge with the siblings

**Status:** this package diverges deliberately; the base SDK has backlogged the same fix.

Neither `langsys-php`'s `HtmlParser::walkNode()` nor `langsys-js-typescript`'s
`_walkForTokens` skips these on the content-block path, so analytics JS and CSS are queued
for **permanent registration in the shared catalog**. Measured by the PHP owner:

```
window.dataLayer.push({event:"view",sku:"ABC-123"});
.plan{color:#fff}
```

`langsys-php`'s `tests/fixtures/tokenizer-reference.json` case **[12]** asserts that output
as the contract, so a correct tokenizer fails it — and that failure is correct. The PHP
owner has corrected their README and asked this package not to reproduce the defect.

This package skips `script`/`style`/`template` and **not** `noscript` (its text renders
whenever scripting is off). Divergence is mitigated by **corrected on write, tolerant on
read**: registration uses the corrected derivation, lookups fall back to the un-skipped one.
`tests/conformance/walker-parity.test.ts` asserts the divergence rather than skipping it, so
the day the base SDK converges the suite goes red and says to delete the fallback.

**Sequencing note from the base SDK owner:** this and the 12-attribute convergence both
change `custom_id` and are blocked on the same migration count, so they should almost
certainly **migrate together as one re-key rather than two**. A chain is harder to retire
than any link in it.

---

## Hydration hand-off: a synchronous `seedCatalog()`

**Status:** proposed to the base SDK, not agreed.

The client SDKs seed inside `init()`, which `await`s `validate()` before writing the
catalog — so the seed lands after a network round-trip and after hydration. Fine when the
server emitted base language; a mismatch when it emitted Italian. Moving the call earlier
does not help: the blocker is the `await`, not the mount hook.

Seeding is only three synchronous operations (stamp `__category__`, inject
`__uncategorized__`, set the two exported signals), and both signals are already public
exports. A `seedCatalog(catalog, locale)` export would be additive, non-breaking, and would
remove the reason to call `init()` early at all.

`normalizeCatalog()` here already produces the correct shape, so this package is ready for
it. **Per-framework hydration timing remains open** and is not this package's to answer.

---

## Client-DOM parity: partially measured

**Status:** verified for the Phrase path and for Svelte hydration generally. **Untested for
a marker-less `<Translate>` host.**

`_dev_/client-dom-parity.js` compares served bytes against the hydrated DOM using the real
tokenizer on both sides. The affsite-platform owner ran it against production:

- **Base locale: clean.** 3 elements, 0 mismatched, 0 unresolved. Svelte does not restructure
  text nodes during hydration — it mutates the same node via `set_text` and never calls
  `splitText`.
- Two defects in the *instrument* were found and fixed in the process (a guaranteed false
  alarm on non-base locales, and four invented marker selectors that made `<Translate>`
  unreachable).

**What remains untested:** a `<Translate>` content block. The SDK stamps **no marker
attribute** on one — verified, `data-ls-contentblock` and `data-langsys-contentblock` occur
zero times in the published dist — so the probe needs an explicit `selector`. The reference
deployment's only production `<Translate>` is on a site whose hostname is not yet assigned.

**Worth requesting upstream:** have the base SDK stamp `data-ls-contentblock` plus the
resolved `custom_id` on the host element. **An identity you cannot observe from the DOM is
an identity nobody can debug**, and it would make this probe work by default.

---

## The single re-key event

**Five three-way divergences all change `custom_id`, and they should land as ONE
migration, not five.** Established jointly with the base SDK and `langsys-php` owners.

| # | Divergence | Who is out of step |
|---|---|---|
| 1 | `&nbsp;` (U+00A0) normalisation | PHP retains it; the JS family collapses it |
| 2 | the 12-attribute convergence | JS carries 15, PHP carries 27 |
| 3 | the `<script>`/`<style>` skip | both siblings harvest them; this package does not |
| 4 | **attribute-value whitespace collapse** | PHP collapses internal whitespace; the JS family only trims |
| 5 | **`%name%` placeholder normalisation** | PHP has no `%name%` concept at all |

4 and 5 were found by the PHP owner while reviewing this package's tokenizer — they went
looking for bugs here, found two candidates, and both turned out to be `langsys-php`
diverging from the JS family. Measured, not reasoned:

```
<img alt="A long⏎     description">   PHP a64d7b6e…   JS/here d4b11bd9…
<p>Hello %name%</p>                   PHP 73b75576…   JS/here 0df96de8…
```

**#4 outranks `&nbsp;` on real-world frequency** — line-wrapping a long `alt` or `title`
is ordinary formatting, and a linter will do it for you. It also exposes an internal
inconsistency in the JS family: the same authored content produces the *same* id in PHP
whether it sits in a text node or an attribute, and *different* ids here, because text
collapses and attributes only trim. So it is a genuine three-way decision rather than
"PHP converges".

**Why one event.** Five separate migrations means five separate windows in which half a
catalog resolves and half falls back, and each one individually looks like "some pages
aren't translated". A chain of fallbacks is also harder to retire than any link in it.

**Two fixes can go early, because neither touches an id:**

- **`%name%` at render time.** `langsys-php` renders the literal `%name%` to end users,
  while this family's own SDK actively instructs people to write it (the vendored
  unmatched-param warning says *"write %name% instead"*). One SDK teaches the convention
  as the fix for template-compiler interference and the other prints it to the page.
  Teaching PHP's `Interpolator` to accept `%name%` fixes the user-visible half and changes
  no ids at all.
- **PHP's `<noscript>` and `<svg>` skips.** `PageTranslator::SKIP_ELEMENTS` skips both, so
  "Enable JavaScript to continue" never registers, and every chart label and accessible
  `<svg><title>` in a PHP page is permanently untranslated. This is *additive* — it
  discovers phrases rather than re-keying existing ones — so it is the cheapest item on
  the list. Same root cause as the `<noscript>` mistake this package made and corrected:
  **it pattern-matches as technical.**

## Smaller items

- **A cache-busting signal from the Translation Manager** would beat any TTL. Translation
  Manager surface, not this package's.
- **Clock skew on the shared expiry.** `expiresAt` is stamped with `Date.now()`, which is
  per-host, so with Redis across machines the stamp is only as good as clock agreement.
  It degrades safely — Redis's own TTL gives a second, skew-free expiry — and the caveat
  is inherited from `time()` in `langsys-php`'s `FileCache` rather than introduced here.
- **A cross-request "already registered" memo.** A phrase missing from the catalog
  re-registers on *every* request; dedup is per-request by design (SPEC §6.1 forbids a
  module-global queue). Registration is an idempotent upsert so this is
  correctness-neutral, but it is avoidable traffic. Trades against holding process state —
  wants a decision, not a silent choice.
- **Ask the base SDK to stamp `data-ls-contentblock` + the resolved `custom_id`** on
  `<Translate>` hosts. Verified: it currently stamps nothing, so a content block's identity
  is unobservable from the DOM — which breaks `auditRenderedHtml` and
  `_dev_/client-dom-parity.js` by default, and more importantly leaves anyone debugging a
  re-keyed block in production with nothing to look at. **An identity you cannot observe
  from the DOM is an identity nobody can debug.** Additive and cannot affect `tokens[]`;
  the base SDK owner measured that it changes only the `content` snapshot, so the stamp
  must be written AFTER `tokenizeElement` returns.
  **The day it lands, two documents become wrong and must be rewritten together:** the
  README capability matrix's detection column (which currently says a `<Translate>` host
  carries no marker, so `auditRenderedHtml()` cannot see it and `contentBlockAttributes`
  is the workaround) and `langsys-skill`'s mirror of that matrix in `core/server-sdk.md`.
  They are two statements of one fact in two repos; fixing one alone leaves the family
  contradicting itself. Note the asymmetry that makes the column subtle in the first
  place: the audit *does* find `<Phrase>`, because that primitive puts its marker in the
  markup — it is only `<Translate>` that is invisible.
- **Shared conformance fixtures.** `langsys-php` owns `tests/fixtures/tokenizer-reference.json`
  and has asked that this package assert against it **in place** rather than moving it
  somewhere neutral. **They will regenerate it against corrected behaviour once the re-key
  above lands, and ping this repo then** — wiring a third consumer in before that would
  make each of the five fixes a three-repo coordination instead of a two-repo one. Adding
  *cases* stays safe in the meantime; the restructure that would put the attribute list in
  the file as normative data is on hold for the same reason.
- **Naming.** ~~Formally Darryl's call until first publish.~~ **Settled 2026-08-22:**
  published as `langsys-js-server@0.1.0`. `-server` rather than `-node` is now *earned* as
  well as decided — the built artifact is executed under Node, Deno, Bun and Workers in CI,
  and the published tarball was installed from the registry into an empty project and run
  through both entry points before this line was written.
- **Trusted publishing is not configured on npm.** `0.1.0` was published by hand because a
  package that does not exist cannot have a trusted publisher registered against it. The
  package exists now, so this is a one-time setup — but until it is done, `publish.sh` will
  tag, release, and then fail at the registry. See `_dev_/PUBLISHING.md`.
