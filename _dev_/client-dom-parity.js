/**
 * Client-DOM parity probe.
 *
 * ============================================================================
 * WHAT THIS MEASURES
 * ============================================================================
 *
 * `custom_id` identity has two halves. This repo's conformance suite covers one:
 *
 *     [A] server HTML string   -> tokens   (langsys-js-server's tokenizer)
 *     [B] server HTML in a DOM -> tokens   (langsys-js-typescript's DOM walker)
 *     A == B  ..............................  60+ cases, mutation-tested, green
 *
 * The half nothing covers is what happens after the framework hydrates:
 *
 *     [C] the LIVE, HYDRATED DOM -> tokens
 *     B == C  ..............................  what this probe measures
 *
 * It matters because the block walker does NOT coalesce adjacent text nodes — each is
 * its own token — so a framework that splits or merges a text run during hydration
 * changes the token ARITY, which changes `custom_id`, which silently re-keys the block.
 *
 * ============================================================================
 * TWO MECHANISMS, TWO COMPARISONS — do not conflate them
 * ============================================================================
 *
 * The SDK keys the two primitives by opposite means, deliberately:
 *
 *   <Translate>  tokenizeElement -> tokens[] -> generateCustomId
 *                Adjacent text nodes are NOT coalesced. Arity IS identity.
 *
 *   <Phrase>     encodeRichText  -> { phrase, slots }
 *                Text IS coalesced and whitespace collapsed; the resulting STRING is
 *                the key. There is no token array and no custom_id. Text-node arity is
 *                therefore irrelevant here, and running tokenizeElement over a <Phrase>
 *                measures something the SDK never uses.
 *
 * An earlier version of this probe compared tokens on <Phrase> elements and reported a
 * `custom_id` for them. Both were artifacts. Found by the affsite-platform owner.
 *
 * ============================================================================
 * FINDING <Translate> HOSTS: there is no marker, and you must pass a selector
 * ============================================================================
 *
 * Verified against the published `langsys-js-typescript@0.6.5` dist:
 *
 *     data-langsys-contentblock   0 occurrences      <- does not exist
 *     data-ls-contentblock        0 occurrences      <- does not exist
 *     data-ls-category            0 occurrences      <- does not exist
 *     data-langsys-category       0 occurrences      <- does not exist
 *     data-ls-phrase              2   PHRASE_MARKER_ATTR, written by <Phrase>
 *     data-langsys-phrase         1   RECOGNISED only; langsys-php's spelling, and
 *                                     per content-block.ts:79 it "never appears in DOM
 *                                     our components emit"
 *
 * The only `setAttribute` calls in the whole SDK are `src` on `<img>` and translated
 * attribute write-back. **A `<Translate>` content block carries no marker attribute at
 * all** — it holds `custom_id` in a JS field and never stamps it on the element.
 *
 * So `<Translate>` hosts are NOT findable by marker in a JS deployment. Pass an explicit
 * `selector`. (An earlier version of this probe queried the four non-existent markers
 * above, which meant it could only ever match `<Phrase>` — the one path where token
 * comparison is meaningless — and could not find the construct it was built to test.)
 *
 * ============================================================================
 * WHICH LOCALE TO RUN ON — this is the part that produces false alarms
 * ============================================================================
 *
 * On a NON-BASE locale, the served bytes carry base-language text (the client SDK is
 * inert during SSR) and the live DOM has been rewritten by the SDK. So token VALUES
 * differ on every marked block, on every page, forever — and that is the product
 * working, not a defect.
 *
 * Therefore:
 *   - Run the STRUCTURAL test on the BASE locale, where no translation swap occurs and
 *     any difference at all is real. That is the strongest signal available.
 *   - On a non-base locale, pass `baseLocale` so the probe can classify value-only
 *     divergence as `translated` rather than `MISMATCH`. Structure is still checked.
 *
 * `ok` reflects STRUCTURAL soundness. A page full of `translated` rows is healthy.
 *
 * ============================================================================
 * HOW TO RUN IT
 * ============================================================================
 *
 *     // Get the REAL tokenizer. Do not reimplement it — lifting it out of the
 *     // installed dist is the point; a reimplementation checks this probe against
 *     // itself. Under a Vite dev server:
 *     const sdk = await import('langsys-js-typescript');
 *
 *     // On a production build with no module graph, esbuild the installed
 *     // dist/index.mjs into an IIFE exposing window.__LANGSYS_SDK__ and pass that.
 *
 *     langsysClientDomParitySelfTest({ sdk });          // run this FIRST
 *     await langsysClientDomParity({ sdk, baseLocale: 'en', selector: '[data-block]' });
 *
 * `copy(result)` gives JSON you can paste back.
 */

/* eslint-disable no-console */
globalThis.langsysClientDomParity = async function langsysClientDomParity(options = {}) {
    const { sdk, selector, baseLocale, verbose = false } = options;

    if (!sdk || typeof sdk.tokenizeElement !== 'function' || typeof sdk.encodeRichText !== 'function') {
        throw new Error(
            'Pass the REAL SDK: langsysClientDomParity({ sdk: await import("langsys-js-typescript") }). ' +
                'Needs tokenizeElement and encodeRichText. This probe deliberately does not bundle ' +
                'its own copies — a reimplementation would check the probe against itself.',
        );
    }
    const { tokenizeElement, encodeRichText, generateCustomId } = sdk;

    const pageLocale = document.documentElement.lang || null;
    const isBaseLocale = Boolean(baseLocale && pageLocale && pageLocale.toLowerCase().split('-')[0] === baseLocale.toLowerCase().split('-')[0]);

    // Values are only comparable when no translation swap has occurred. Without a
    // declared baseLocale we cannot know, so we refuse to judge values rather than
    // reporting confident nonsense.
    const valuesComparable = baseLocale ? isBaseLocale : false;

    // ---------------------------------------------------------------- roots
    // Only the two markers that actually exist. `<Translate>` hosts have none, so they
    // arrive via `selector`.
    const PHRASE_MARKERS = '[data-ls-phrase],[data-langsys-phrase]';
    const phraseRoots = Array.from(document.querySelectorAll(PHRASE_MARKERS));
    const blockRoots = selector ? Array.from(document.querySelectorAll(selector)) : [];

    const roots = [
        ...blockRoots.map((el) => ({ el, mechanism: 'content-block' })),
        ...phraseRoots.filter((el) => !blockRoots.includes(el)).map((el) => ({ el, mechanism: 'phrase' })),
    ];

    if (roots.length === 0) {
        return {
            ok: false,
            inconclusive: true,
            reason:
                'Nothing to compare. Note that <Translate> content blocks are NOT findable by ' +
                'marker: the SDK stamps no attribute on them (verified against the 0.6.5 dist — ' +
                'data-ls-contentblock and data-langsys-contentblock occur zero times). Pass an ' +
                'explicit `selector` naming your content-block hosts. Only <Phrase> elements ' +
                'carry a marker, and this page has none of those either.',
            url: location.href,
            pageLocale,
            checked: 0,
            results: [],
        };
    }

    // ------------------------------------------------------- served bytes [B]
    const response = await fetch(location.href, {
        cache: 'reload',
        headers: { Accept: 'text/html' },
    });
    const servedHtml = await response.text();
    const servedDoc = new DOMParser().parseFromString(servedHtml, 'text/html');

    // ------------------------------------------------------ locating the twin
    // Index path from <body>, counting ELEMENT children only. Text-node indices are the
    // thing under test and must not be used to do the locating.
    function elementPath(el) {
        const path = [];
        let node = el;
        while (node && node !== document.body && node.parentElement) {
            path.unshift(Array.prototype.indexOf.call(node.parentElement.children, node));
            node = node.parentElement;
        }
        return node === document.body ? path : null;
    }

    function resolvePath(doc, path) {
        let node = doc.body;
        for (const index of path) {
            if (!node || !node.children[index]) return null;
            node = node.children[index];
        }
        return node;
    }

    // -------------------------------------------------------------- compare
    const results = [];
    const counts = { match: 0, translated: 0, MISMATCH: 0, 'client-only': 0, 'path-drift': 0 };

    for (const { el: liveEl, mechanism } of roots) {
        const path = elementPath(liveEl);
        if (!path) {
            counts['path-drift']++;
            results.push({ status: 'path-drift', note: 'Element is not rooted at <body>; not compared.' });
            continue;
        }

        const servedEl = resolvePath(servedDoc, path);
        if (!servedEl) {
            counts['client-only']++;
            results.push({
                path: path.join('>'),
                mechanism,
                status: 'client-only',
                note: 'Present in the hydrated DOM but absent from the served bytes — this content is not crawler-visible at all.',
                liveTag: liveEl.tagName.toLowerCase(),
                liveText: (liveEl.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80),
            });
            continue;
        }

        if (servedEl.tagName !== liveEl.tagName) {
            counts['path-drift']++;
            results.push({
                path: path.join('>'),
                mechanism,
                status: 'path-drift',
                note: `Resolved to <${servedEl.tagName.toLowerCase()}> in the served bytes but <${liveEl.tagName.toLowerCase()}> live. Not compared.`,
            });
            continue;
        }

        const entry =
            mechanism === 'phrase'
                ? comparePhrase(servedEl, liveEl)
                : compareContentBlock(servedEl, liveEl);

        entry.path = path.join('>');
        entry.mechanism = mechanism;
        entry.tag = liveEl.tagName.toLowerCase();

        counts[entry.status]++;
        if (entry.status !== 'match' || verbose) results.push(entry);
    }

    function classify(structuralMatch, valueMatch) {
        if (!structuralMatch) return 'MISMATCH';
        if (valueMatch) return 'match';
        // Structure holds, values differ. In the base locale that is a real defect; in a
        // translated locale it is the SDK having done its job.
        return valuesComparable ? 'MISMATCH' : 'translated';
    }

    function compareContentBlock(servedEl, liveEl) {
        const servedTokens = tokenizeElement(servedEl).tokens;
        const liveTokens = tokenizeElement(liveEl).tokens;

        // Arity is identity for this path. It is checked separately from values because
        // it is the ONLY signal that survives a locale swap.
        const structuralMatch = servedTokens.length === liveTokens.length;
        const valueMatch =
            structuralMatch && servedTokens.every((tok, i) => tok === liveTokens[i]);

        const out = {
            status: classify(structuralMatch, valueMatch),
            servedTokenCount: servedTokens.length,
            liveTokenCount: liveTokens.length,
            arityChanged: !structuralMatch,
            servedTokens,
            liveTokens,
        };

        // custom_id is only meaningful when the category is known, and nothing in the
        // DOM carries it. Reporting a hash over category "" would be an artifact — an
        // earlier version of this probe did exactly that.
        if (generateCustomId && options.category !== undefined) {
            out.category = options.category;
            out.servedCustomId = generateCustomId(options.category, servedTokens);
            out.liveCustomId = generateCustomId(options.category, liveTokens);
        } else {
            out.customIdNote =
                'Not computed: category is not observable from the DOM, and a hash over the ' +
                'wrong category is an artifact. Pass { category } if you know it.';
        }

        if (!structuralMatch) {
            out.note =
                'TOKEN ARITY CHANGED between the served bytes and the hydrated DOM. This re-keys ' +
                'the block: it will render base language and re-register, which is indistinguishable ' +
                'from a phrase that was never translated.';
        }
        return out;
    }

    function comparePhrase(servedEl, liveEl) {
        // The <Phrase> path coalesces text and collapses whitespace, so arity is
        // irrelevant here by design. The encoded STRING and its slot count are identity.
        const served = encodeRichText(servedEl);
        const live = encodeRichText(liveEl);

        const structuralMatch = served.slots.length === live.slots.length;
        const valueMatch = structuralMatch && served.phrase === live.phrase;

        const out = {
            status: classify(structuralMatch, valueMatch),
            servedPhrase: served.phrase,
            livePhrase: live.phrase,
            servedSlotCount: served.slots.length,
            liveSlotCount: live.slots.length,
            slotCountChanged: !structuralMatch,
        };
        if (!structuralMatch) {
            out.note =
                'MARKUP SLOT COUNT CHANGED. The <Phrase> path keys on the encoded string including ' +
                'its {m0o}/{m0c} slot markers, so a different number of inline elements is a ' +
                'different phrase.';
        }
        return out;
    }

    const summary = {
        // `ok` means STRUCTURALLY sound. Rows classified `translated` are healthy.
        ok: counts.MISMATCH === 0 && counts['path-drift'] === 0,
        url: location.href,
        pageLocale,
        baseLocale: baseLocale ?? null,
        mode: valuesComparable
            ? 'base-locale: token VALUES and structure both compared'
            : baseLocale
              ? 'translated locale: STRUCTURE compared; value differences classified as `translated`'
              : 'no baseLocale supplied: STRUCTURE only; value differences NOT judged (pass baseLocale to enable)',
        checked: roots.length,
        counts,
        results,
    };

    console.log(
        `%clangsys client-DOM parity%c  ${counts.match} match, ${counts.translated} translated, ` +
            `${counts.MISMATCH} MISMATCH, ${counts['client-only']} client-only, ${counts['path-drift']} path-drift ` +
            `(of ${roots.length})`,
        'font-weight:bold',
        '',
    );
    console.log(`  mode: ${summary.mode}`);
    if (!baseLocale) {
        console.warn(
            'No `baseLocale` supplied, so value differences are not judged. On a translated page ' +
                'that is correct; on the base locale it means you are getting a weaker check than ' +
                'you could. Pass baseLocale to enable full comparison.',
        );
    }
    if (counts.MISMATCH > 0) console.table(results.filter((r) => r.status === 'MISMATCH'));

    return summary;
};

/**
 * Self-check. Run BEFORE trusting a clean result.
 *
 * Confirms both mechanisms behave as this probe assumes: that `tokenizeElement`
 * distinguishes text-node arity (so a clean content-block run is meaningful), and that
 * `encodeRichText` does NOT (so the probe is right to ignore arity on the phrase path).
 *
 * The second assertion is the one that matters most — it is the assumption an earlier
 * version of this probe got wrong.
 */
globalThis.langsysClientDomParitySelfTest = function selfTest({ sdk }) {
    const { tokenizeElement, encodeRichText } = sdk;

    const merged = document.createElement('div');
    merged.appendChild(document.createTextNode('Hello Bob!'));

    const split = document.createElement('div');
    for (const chunk of ['Hello ', 'Bob', '!']) split.appendChild(document.createTextNode(chunk));

    const mergedTokens = tokenizeElement(merged).tokens;
    const splitTokens = tokenizeElement(split).tokens;
    const tokensDiscriminate = mergedTokens.length !== splitTokens.length;

    const mergedPhrase = encodeRichText(merged).phrase;
    const splitPhrase = encodeRichText(split).phrase;
    const phraseIsArityBlind = mergedPhrase === splitPhrase;

    console.log('self-test  tokenize merged ->', JSON.stringify(mergedTokens));
    console.log('self-test  tokenize split  ->', JSON.stringify(splitTokens));
    console.log('self-test  encode   merged ->', JSON.stringify(mergedPhrase));
    console.log('self-test  encode   split  ->', JSON.stringify(splitPhrase));

    const pass = tokensDiscriminate && phraseIsArityBlind;
    console.log(
        pass
            ? '%cPASS%c tokenizeElement distinguishes arity; encodeRichText is arity-blind. Both assumptions hold.'
            : '%cFAIL%c ' +
              (!tokensDiscriminate
                  ? 'tokenizeElement did NOT distinguish arity — a clean content-block run proves nothing. '
                  : '') +
              (!phraseIsArityBlind
                  ? 'encodeRichText was NOT arity-blind — the phrase path needs an arity check after all.'
                  : ''),
        pass ? 'color:green;font-weight:bold' : 'color:red;font-weight:bold',
        '',
    );

    return { pass, tokensDiscriminate, phraseIsArityBlind, mergedTokens, splitTokens, mergedPhrase, splitPhrase };
};
