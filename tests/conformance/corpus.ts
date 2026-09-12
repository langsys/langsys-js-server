/**
 * Shared tokenizer corpus.
 *
 * Held as data, not as inline test bodies, so the same cases can be run against
 * (a) this package's string tokenizer, (b) `langsys-js-typescript`'s DOM walker, and
 * eventually (c) `langsys-php`'s `tests/fixtures/tokenizer-reference.json`, which the
 * PHP owner asked be asserted against IN PLACE rather than moved somewhere neutral.
 *
 * Every case is the INNER html of a notional block root.
 *
 * SPEC.md §5 rule: fixtures must be authored so a WRONG implementation fails, not
 * merely so a right one passes. Several cases below exist only as negative controls —
 * without them, "the feature worked" and "the probe never ran" produce the same output.
 */

export interface Case {
    name: string;
    html: string;
    /** Why this case exists. A case whose purpose isn't stated tends to get "fixed". */
    proves: string;
}

export const CORPUS: Case[] = [
    // ---- baseline ----
    { name: 'plain text', html: 'Hello world', proves: 'the simplest possible token' },
    { name: 'nested markup', html: '<p>Based on <strong>5</strong> reviews</p>', proves: 'inline elements split at tag boundaries' },
    {
        name: 'inline adjacency without spaces',
        html: '<p>Hello<b>bold</b>world</p>',
        proves: 'splitting happens at the TAG boundary, not at whitespace — PHP measured the same',
    },
    { name: 'mixed block and inline', html: '<div><h1>Title</h1><p>Body <em>emphasis</em> tail</p></div>', proves: 'depth-first document order' },
    { name: 'deep nesting', html: '<div><div><div><span>deep</span></div></div></div>', proves: 'recursion depth does not reorder' },

    // ---- whitespace ----
    { name: 'whitespace-only text node', html: '<p> </p>', proves: 'normalises to empty and is DROPPED, not emitted as ""' },
    { name: 'whitespace between blocks', html: '<div>\n  <p>A</p>\n  <p>B</p>\n</div>', proves: 'indentation produces no phantom tokens' },
    { name: 'leading and trailing whitespace', html: '<p>   padded   </p>', proves: 'tokens are trimmed' },
    { name: 'internal whitespace run', html: '<p>a     b</p>', proves: 'internal runs collapse to one space' },
    { name: 'newlines and tabs inside a token', html: '<p>a\n\tb</p>', proves: 'all ASCII whitespace collapses, not just spaces' },

    // ---- exclusion ----
    { name: 'translate=no subtree', html: '<div><span translate="no">skip</span><span>keep</span></div>', proves: 'the standard opt-out' },
    { name: 'data-notrans bare', html: '<div><span data-notrans>skip</span><span>keep</span></div>', proves: 'PHP alias for hosts that strip unknown bare attributes' },
    { name: 'data-notrans=false opts back IN', html: '<div><span data-notrans="false">keep</span></div>', proves: 'opt-out-of-the-opt-out; without this the exclusion could be unconditional and still pass' },
    { name: 'data-notrans=0 opts back IN', html: '<div><span data-notrans="0">keep</span></div>', proves: '"0" is the second opt-out-of-opt-out spelling' },
    {
        name: 'excluded element loses its ATTRIBUTES too',
        html: '<div><img translate="no" alt="X"><span>keep</span></div>',
        proves: 'the exclusion check returns BEFORE attribute harvesting — implementing this as "skip children" is wrong only here',
    },
    { name: 'excluded control', html: '<div><img alt="X"><span>keep</span></div>', proves: 'the control for the row above; without it "marker worked" and "probe never ran" are identical output' },

    // ---- phrase markers ----
    { name: 'data-ls-phrase kept whole', html: '<div><span data-ls-phrase>Based on <b>5</b> reviews</span><span>after</span></div>', proves: 'JS marker spelling is skipped by the block walker' },
    { name: 'data-langsys-phrase kept whole', html: '<div><span data-langsys-phrase>Based on <b>5</b> reviews</span><span>after</span></div>', proves: 'PHP marker spelling is recognised identically' },
    { name: 'both marker spellings at once', html: '<div><span data-ls-phrase data-langsys-phrase>Whole</span><span>after</span></div>', proves: 'emitting both costs nothing — this package emits both' },
    { name: 'phrase marker control', html: '<div><span>Based on <b>5</b> reviews</span><span>after</span></div>', proves: 'the control — an unmarked span DOES split, so the marker cases prove the marker' },
    { name: 'data-ls-phrase=false opts back in', html: '<div><span data-ls-phrase="false">Based on <b>5</b> reviews</span></div>', proves: 'marker opt-out semantics match the exclusion predicate' },
    { name: 'phrase-marked element loses attributes too', html: '<div><img data-ls-phrase alt="X"><span>keep</span></div>', proves: 'same early return as exclusion' },

    // ---- attributes ----
    { name: 'attributes precede children', html: '<p title="ATTR">CHILD</p>', proves: 'attribute-before-text ordering — a walker emitting text first fragments every block with an alt' },
    { name: 'nested attribute ordering', html: '<div title="OUTER"><p title="IN">T</p></div>', proves: 'depth-first interleaving of attributes and text' },
    { name: 'source attribute order A', html: '<img title="T" alt="A">', proves: 'iterating the CONSTANT, not element.attrs' },
    { name: 'source attribute order B', html: '<img alt="A" title="T">', proves: 'must produce the IDENTICAL array to order A — an author reordering two attributes must not re-key' },
    { name: 'all fifteen translatable attributes', html: '<div placeholder="p" alt="a" title="t" label="l" aria-label="al" aria-placeholder="ap" aria-description="ad" aria-valuetext="av" aria-roledescription="ar" data-error="de" data-error-message="dem" data-validation-message="dvm" data-invalid-message="dim" data-required-message="drm" data-pattern-message="dpm">x</div>', proves: 'EVERY pinned attribute actually produces a token — a pin test passes happily when the walker has stopped consulting the list' },
    { name: 'unlisted attribute produces NO token', html: '<div data-nonsense="nope" title="yes">x</div>', proves: 'the negative control for the row above — without it, a parser that harvests EVERY attribute also passes' },
    { name: 'empty attribute value', html: '<div title="">x</div>', proves: 'falsy values are skipped' },
    { name: 'whitespace-only attribute value', html: '<div title="   ">x</div>', proves: 'attribute values are trimmed before the truthiness test' },
    { name: 'button value after attributes', html: '<button value="VAL" title="TIT">TXT</button>', proves: 'value sorts AFTER the constant loop — PHP measured ["TIT","VAL","TXT"]' },
    { name: 'input submit value', html: '<input type="submit" value="Go" title="T">', proves: 'input type=submit value is harvested' },
    { name: 'input text value NOT harvested', html: '<input type="text" value="notme" title="T">', proves: 'the negative control — only submit/button types carry a visible label' },
    { name: 'duplicate attribute keeps first', html: '<div title="A" title="B">x</div>', proves: 'HTML5 first-wins; PHP measured the same' },
    { name: 'uppercase tag and attribute', html: '<P TITLE="T">Body</P>', proves: 'tag and attribute names normalise to lowercase' },

    // ---- structure ----
    { name: 'void elements', html: '<div>a<br>b<hr>c</div>', proves: 'void elements do not swallow siblings' },
    { name: 'self-closed syntax', html: '<div>a<br/>b<img alt="A"/></div>', proves: 'XHTML-style self-closing parses the same' },
    { name: 'comment node dropped', html: '<div><!-- comment -->text</div>', proves: 'comments are neither element nor text and must not tokenize' },
    { name: 'implicit close', html: '<p>one<p>two', proves: 'implicit paragraph closing recovers without phantom tokens' },
    { name: 'implicit list close', html: '<ul><li>a<li>b</ul>', proves: 'implicit li closing' },
    { name: 'crossed tags', html: '<b><i>x</b></i>', proves: 'malformed nesting recovers to a single token' },

    // ---- elements that look technical but are not ----
    {
        name: 'noscript content is NOT harvested',
        html: '<div><p>Keep</p><noscript>Enable JavaScript to continue</noscript></div>',
        proves: 'TOK-1 reversal (spec v8, blob b657b490, 2026-09-11). This case previously asserted the OPPOSITE and is kept rather than deleted: noscript text is genuinely user-visible with scripting off, but no browser SDK runs then, and with scripting on a parser yields the raw MARKUP string as the token. libxml2 has no scripting flag and disagrees with both. Excluding it makes every parser agree by construction',
    },
    {
        name: 'template content is harvested by NEITHER implementation',
        html: '<div><p>Keep</p><template><b>Hidden</b></template></div>',
        proves: 'template content lives in a separate DocumentFragment in a DOM, and parse5 models it the same way — so both find nothing without either skipping it',
    },

    // ---- text-node SEPARATION (React isomorphism) ----
    // React emits `<!-- -->` PRECISELY where it has adjacent text children, so those
    // comments are an exact isomorphism of the client's text-node structure. The base
    // SDK's walker does NOT coalesce adjacent text nodes — each is its own token. A
    // tokenizer that strips comments as STRINGS before parsing merges the text either
    // side and re-keys every interpolated sentence React renders.
    //
    // Measured by the langsys-skill agent for `<span>Hello {name}!<br/><b>bold</b></span>`:
    //   client               ["Hello","Bob","!","bold"]
    //   renderToStaticMarkup ["Hello Bob!","bold"]      <- wrong
    //   renderToString       ["Hello","Bob","!","bold"] <- correct
    {
        name: 'comment separates adjacent text nodes',
        html: '<span>Hello <!-- -->Bob<!-- -->!</span>',
        proves: 'THE React case — must be three tokens, not one. Comments are skipped as NODES while still separating the text either side',
    },
    {
        name: 'comment separation control — no comments coalesces',
        html: '<span>Hello Bob!</span>',
        proves: 'the control: without a comment this IS one token, so the case above proves separation rather than accidental splitting',
    },
    {
        name: 'React interpolation isomorphism, full shape',
        html: '<span>Hello <!-- -->Bob<!-- -->!<br/><b>bold</b></span>',
        proves: 'the exact measured shape — four tokens',
    },
    {
        name: 'empty comment between text',
        html: '<p>a<!---->b</p>',
        proves: 'a zero-length comment still separates',
    },
    {
        name: 'comment at block edges',
        html: '<p><!-- lead -->text<!-- trail --></p>',
        proves: 'leading/trailing comments contribute no token of their own',
    },

    // ---- identity edge cases ----
    { name: 'hyphenated token', html: '<p>e-mail</p>', proves: 'the case that motivated the JSON.stringify hash-input fix' },
    { name: 'markup placeholder normalisation', html: '<p>Hello %name%</p>', proves: '%name% rewrites to {name} before hashing' },
    { name: 'unicode and emoji', html: '<p>café 日本語 👍🏽</p>', proves: 'UTF-8 survives tokenizing and hashing' },
    { name: 'select options', html: '<select><option>One</option><option>Two</option></select>', proves: 'option text harvested once by the recursive descent' },
];

/**
 * Cases where this package KNOWINGLY differs from the base SDK's DOM walker.
 *
 * These are asserted to DIVERGE, not skipped. A skipped test produces no signal, and a
 * check that produces no signal reads as a pass (SPEC.md §10). If the base SDK adopts
 * the skip list, these tests fail and tell us to delete them — which is the point.
 */
export const KNOWN_DIVERGENCES: Case[] = [
    {
        name: 'script content is NOT harvested here',
        html: '<div><p>Keep</p><script>window.dataLayer.push({event:"view"});</script></div>',
        proves: 'this package excludes code-bearing subtrees. The base SDK and PHP BOTH did queue analytics JS for permanent registration when this case was written; both have since fixed it (core 6596faf, php e28972c, re-measured by execution). Kept because the exclusion still has to hold, not because the others still get it wrong',
    },
    {
        name: 'style content is NOT harvested here',
        html: '<div><p>Keep</p><style>.plan{color:#fff}</style></div>',
        proves: 'same defect, style path',
    },
];
