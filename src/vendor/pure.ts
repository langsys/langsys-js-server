/**
 * VENDORED from langsys-js-typescript@0.6.5 — do NOT edit by hand.
 * Regenerate with `_dev_/vendor-pure.sh 0.6.5`.
 *
 * Extracted verbatim from the published npm artifact's `dist/index.mjs`, not
 * transcribed. Transcription is where silent divergence enters, and a divergent `md5`
 * re-keys every catalog entry this package writes.
 *
 * Why vendored rather than imported: `langsys-js-typescript` declares a single `"."`
 * export and no `"sideEffects"` field, and its `src/index.ts` reads through `LangsysApp`
 * at module scope — so importing ANY function from it instantiates the whole singleton
 * graph (shared catalog, shared miss queue, shared auth header) inside the server
 * process. See SPEC.md §3.1.
 *
 * The base SDK owner confirmed (2026-08-21) that a `langsys-js-typescript/pure` subpath
 * export is feasible but NOT promised, and advised vendoring rather than blocking on it.
 * They also identified the exact module set that is closed under these functions and
 * never reaches the singleton — `content-block`, `interpolate`, `locale`, `utils` — which
 * is what is extracted here. If the subpath ships it will export this same set, and only
 * the import line changes.
 *
 * `tests/conformance/vendor-parity.test.ts` asserts these produce byte-identical output
 * to the real published package over a fixture corpus. That test is why this file is
 * safe: it sources its expectations from the package, not from this code (SPEC.md §10
 * rule 2 — a check must come from a different source than the claim).
 *
 * @ts-nocheck is deliberate and scoped: the bodies below are the published artifact's
 * own JavaScript, extracted verbatim by `sed` rather than retyped. Two mechanical
 * changes are applied and are the ONLY ones: declarations that need their clean name
 * freed for a typed wrapper are renamed to `...Impl`, and `canonicalizeLocale`'s
 * `if (logger.debugEnabled) logger.warn(...)` branch is dropped (this package has no
 * module-global debug flag; the RETURN VALUE, which is all `custom_id` depends on, is
 * untouched). Nothing else is edited. Annotating them would mean EDITING vendored
 * code, which defeats the point of extracting it. The typed, checked surface is the
 * wrapper set at the bottom of this file — that is what the rest of the package
 * imports, and it is fully checked.
 */

// @ts-nocheck
/* eslint-disable */
// prettier-ignore-start

import { IntlMessageFormat } from 'intl-messageformat';

/**
 * Inert stand-in for the base SDK's logger singleton, which `warnUnmatchedParams`
 * reads. The real singleton carries process-wide `debugEnabled`, which is module-global
 * mutable state this package does not have. The unmatched-param warning is genuinely
 * useful, so it is NOT dropped — it is re-issued from `translator.ts` against the
 * REQUEST's logger, using the vendored `findUnusedParamKeys` below.
 */
const logger = { debugEnabled: false, warn() {}, log() {}, error() {} };

/* canonicalizeLocale — dist/index.mjs:35,52 */
function canonicalizeLocaleImpl(locale) {
  if (!locale || typeof locale !== "string") return locale;
  const cleaned = locale.trim().replace(/_/g, "-");
  try {
    const [canonical] = Intl.getCanonicalLocales(cleaned);
    return canonical ?? cleaned;
  } catch {
    return cleaned.split("-").map((part, i) => {
      if (i === 0) return part.toLowerCase();
      if (part.length === 4) return part[0].toUpperCase() + part.slice(1).toLowerCase();
      if (part.length === 2 || /^\d{3}$/.test(part)) return part.toUpperCase();
      return part.toLowerCase();
    }).join("-");
  }
}

/* interpolation cluster (isICU .. simpleInterpolate) — dist/index.mjs:265,385 */
/* Contiguous in the published bundle. Includes normalizeMarkupPlaceholders,
   findUnusedParamKeys and the ICU node-type constants. */
function isICU(template) {
  return ICU_PATTERN.test(template);
}
var ICU_PATTERN = /\{[^{}]+,\s*(plural|select|selectordinal|number|date|time)\s*[,}]/;
function normalizeMarkupPlaceholdersImpl(text) {
  return text.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, "{$1}");
}
function escapeForRegExp(key) {
  return key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function findUnusedParamKeysImpl(texts, params) {
  if (!params) return [];
  const keys = Object.keys(params);
  if (!keys.length || !texts.length) return keys;
  const haystack = texts.join("\0");
  return keys.filter((key) => !new RegExp(`\\{\\s*${escapeForRegExp(key)}\\s*[,}]`).test(haystack));
}
function warnUnmatchedParams(source, texts, params, context) {
  if (!logger.debugEnabled) return;
  const unused = findUnusedParamKeys(texts, params);
  if (!unused.length) return;
  const keyList = unused.map((key) => `%${key}%`).join(", ");
  logger.warn(
    `${source} received params with no matching placeholder in its content: ${keyList}. If you wrote {${unused[0]}} or {{ ${unused[0]} }} in markup, your framework's template compiler substituted it before Langsys saw the text \u2014 write %${unused[0]}% instead.` + (context ? ` [${context}]` : "")
  );
}
function interpolateImpl(template, params, locale) {
  if (isICU(template)) {
    const resolved = locale || "en";
    const hasNullParam = !!params && Object.values(params).some((value) => value === null);
    if (!hasNullParam) {
      try {
        return new IntlMessageFormat(template, resolved).format(params);
      } catch {
      }
    }
    {
      try {
        const ast = new IntlMessageFormat(template, resolved).ast;
        if (!Array.isArray(ast)) return simpleInterpolate(template, params, locale);
        const recovered = _recoverMissingArgs(JSON.parse(JSON.stringify(ast)), params);
        return new IntlMessageFormat(recovered, resolved).format(params);
      } catch {
        return simpleInterpolate(template, params, locale);
      }
    }
  }
  return simpleInterpolate(template, params, locale);
}
var ICU_LITERAL = 0;
var ICU_ARGUMENT = 1;
var ICU_NUMBER = 2;
var ICU_DATE = 3;
var ICU_TIME = 4;
var ICU_SELECT = 5;
var ICU_PLURAL = 6;
var ICU_POUND = 7;
var ICU_TAG = 8;
function _recoverMissingArgs(nodes, params) {
  const out = [];
  for (const node of nodes) {
    const name = node.value;
    const value = name !== void 0 && name in params ? params[name] : void 0;
    const supplied = value !== void 0 && value !== null;
    if (node.type === ICU_TAG) {
      out.push({ ...node, children: _recoverMissingArgs(node.children ?? [], params) });
      continue;
    }
    if (node.type === ICU_SELECT || node.type === ICU_PLURAL) {
      if (supplied) {
        const options = {};
        for (const [key, branch2] of Object.entries(node.options ?? {})) {
          options[key] = { value: _recoverMissingArgs(branch2.value, params) };
        }
        out.push({ ...node, options });
        continue;
      }
      const other = node.options?.other;
      if (!other) {
        out.push(node);
        continue;
      }
      const branch = _recoverMissingArgs(other.value, params);
      out.push(
        ...branch.map(
          (child) => child.type === ICU_POUND ? { type: ICU_LITERAL, value: `{${name}}` } : child
        )
      );
      continue;
    }
    if (!supplied && (node.type === ICU_ARGUMENT || node.type === ICU_NUMBER || node.type === ICU_DATE || node.type === ICU_TIME)) {
      out.push({ type: ICU_LITERAL, value: `{${name}}` });
      continue;
    }
    out.push(node);
  }
  return out;
}
function simpleInterpolate(template, params, locale) {
  return template.replace(/\{([^{},]+)\}/g, (match, rawKey) => {
    const key = rawKey.trim();
    if (!(key in params)) return match;
    const value = params[key];
    if (value === void 0 || value === null) return match;
    if (value instanceof Date) {
      try {
        return new Intl.DateTimeFormat(locale || "en", { dateStyle: "medium" }).format(value);
      } catch {
        return value.toISOString();
      }
    }
    if (typeof value === "number" || typeof value === "bigint") {
      try {
        return new Intl.NumberFormat(locale || "en").format(value);
      } catch {
        return String(value);
      }
    }
    return String(value);
  });
}

/* toUtf8ByteString — dist/index.mjs:1003,1010 */
function toUtf8ByteString(input) {
  const bytes = new TextEncoder().encode(input);
  let out = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    out += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return out;
}

/* md5 — dist/index.mjs:1011,1014 */
function md5Impl(inputString) {
  if (typeof inputString !== "string") inputString = JSON.stringify(inputString);
  return md5Core(toUtf8ByteString(inputString));
}

/* md5Legacy — dist/index.mjs:1015,1018 */
function md5LegacyImpl(inputString) {
  if (typeof inputString !== "string") inputString = JSON.stringify(inputString);
  return md5Core(inputString);
}

/* md5Core — dist/index.mjs:1019,1135 */
function md5Core(inputString) {
  const hc = "0123456789abcdef";
  function rh(n) {
    let j, s = "";
    for (j = 0; j <= 3; j++) s += hc.charAt(n >> j * 8 + 4 & 15) + hc.charAt(n >> j * 8 & 15);
    return s;
  }
  function ad(x2, y) {
    const l = (x2 & 65535) + (y & 65535);
    const m = (x2 >> 16) + (y >> 16) + (l >> 16);
    return m << 16 | l & 65535;
  }
  function rl(n, c2) {
    return n << c2 | n >>> 32 - c2;
  }
  function cm(q, a2, b2, x2, s, t2) {
    return ad(rl(ad(ad(a2, q), ad(x2, t2)), s), b2);
  }
  function ff(a2, b2, c2, d2, x2, s, t2) {
    return cm(b2 & c2 | ~b2 & d2, a2, b2, x2, s, t2);
  }
  function gg(a2, b2, c2, d2, x2, s, t2) {
    return cm(b2 & d2 | c2 & ~d2, a2, b2, x2, s, t2);
  }
  function hh(a2, b2, c2, d2, x2, s, t2) {
    return cm(b2 ^ c2 ^ d2, a2, b2, x2, s, t2);
  }
  function ii(a2, b2, c2, d2, x2, s, t2) {
    return cm(c2 ^ (b2 | ~d2), a2, b2, x2, s, t2);
  }
  function sb(x2) {
    let i2;
    const nblk = (x2.length + 8 >> 6) + 1;
    const blks = new Array(nblk * 16);
    for (i2 = 0; i2 < nblk * 16; i2++) blks[i2] = 0;
    for (i2 = 0; i2 < x2.length; i2++) blks[i2 >> 2] |= x2.charCodeAt(i2) << i2 % 4 * 8;
    blks[i2 >> 2] |= 128 << i2 % 4 * 8;
    blks[nblk * 16 - 2] = x2.length * 8;
    return blks;
  }
  let i, x = sb("" + inputString), a = 1732584193, b = -271733879, c = -1732584194, d = 271733878, olda, oldb, oldc, oldd;
  for (i = 0; i < x.length; i += 16) {
    olda = a;
    oldb = b;
    oldc = c;
    oldd = d;
    a = ff(a, b, c, d, x[i + 0], 7, -680876936);
    d = ff(d, a, b, c, x[i + 1], 12, -389564586);
    c = ff(c, d, a, b, x[i + 2], 17, 606105819);
    b = ff(b, c, d, a, x[i + 3], 22, -1044525330);
    a = ff(a, b, c, d, x[i + 4], 7, -176418897);
    d = ff(d, a, b, c, x[i + 5], 12, 1200080426);
    c = ff(c, d, a, b, x[i + 6], 17, -1473231341);
    b = ff(b, c, d, a, x[i + 7], 22, -45705983);
    a = ff(a, b, c, d, x[i + 8], 7, 1770035416);
    d = ff(d, a, b, c, x[i + 9], 12, -1958414417);
    c = ff(c, d, a, b, x[i + 10], 17, -42063);
    b = ff(b, c, d, a, x[i + 11], 22, -1990404162);
    a = ff(a, b, c, d, x[i + 12], 7, 1804603682);
    d = ff(d, a, b, c, x[i + 13], 12, -40341101);
    c = ff(c, d, a, b, x[i + 14], 17, -1502002290);
    b = ff(b, c, d, a, x[i + 15], 22, 1236535329);
    a = gg(a, b, c, d, x[i + 1], 5, -165796510);
    d = gg(d, a, b, c, x[i + 6], 9, -1069501632);
    c = gg(c, d, a, b, x[i + 11], 14, 643717713);
    b = gg(b, c, d, a, x[i + 0], 20, -373897302);
    a = gg(a, b, c, d, x[i + 5], 5, -701558691);
    d = gg(d, a, b, c, x[i + 10], 9, 38016083);
    c = gg(c, d, a, b, x[i + 15], 14, -660478335);
    b = gg(b, c, d, a, x[i + 4], 20, -405537848);
    a = gg(a, b, c, d, x[i + 9], 5, 568446438);
    d = gg(d, a, b, c, x[i + 14], 9, -1019803690);
    c = gg(c, d, a, b, x[i + 3], 14, -187363961);
    b = gg(b, c, d, a, x[i + 8], 20, 1163531501);
    a = gg(a, b, c, d, x[i + 13], 5, -1444681467);
    d = gg(d, a, b, c, x[i + 2], 9, -51403784);
    c = gg(c, d, a, b, x[i + 7], 14, 1735328473);
    b = gg(b, c, d, a, x[i + 12], 20, -1926607734);
    a = hh(a, b, c, d, x[i + 5], 4, -378558);
    d = hh(d, a, b, c, x[i + 8], 11, -2022574463);
    c = hh(c, d, a, b, x[i + 11], 16, 1839030562);
    b = hh(b, c, d, a, x[i + 14], 23, -35309556);
    a = hh(a, b, c, d, x[i + 1], 4, -1530992060);
    d = hh(d, a, b, c, x[i + 4], 11, 1272893353);
    c = hh(c, d, a, b, x[i + 7], 16, -155497632);
    b = hh(b, c, d, a, x[i + 10], 23, -1094730640);
    a = hh(a, b, c, d, x[i + 13], 4, 681279174);
    d = hh(d, a, b, c, x[i + 0], 11, -358537222);
    c = hh(c, d, a, b, x[i + 3], 16, -722521979);
    b = hh(b, c, d, a, x[i + 6], 23, 76029189);
    a = hh(a, b, c, d, x[i + 9], 4, -640364487);
    d = hh(d, a, b, c, x[i + 12], 11, -421815835);
    c = hh(c, d, a, b, x[i + 15], 16, 530742520);
    b = hh(b, c, d, a, x[i + 2], 23, -995338651);
    a = ii(a, b, c, d, x[i + 0], 6, -198630844);
    d = ii(d, a, b, c, x[i + 7], 10, 1126891415);
    c = ii(c, d, a, b, x[i + 14], 15, -1416354905);
    b = ii(b, c, d, a, x[i + 5], 21, -57434055);
    a = ii(a, b, c, d, x[i + 12], 6, 1700485571);
    d = ii(d, a, b, c, x[i + 3], 10, -1894986606);
    c = ii(c, d, a, b, x[i + 10], 15, -1051523);
    b = ii(b, c, d, a, x[i + 1], 21, -2054922799);
    a = ii(a, b, c, d, x[i + 8], 6, 1873313359);
    d = ii(d, a, b, c, x[i + 15], 10, -30611744);
    c = ii(c, d, a, b, x[i + 6], 15, -1560198380);
    b = ii(b, c, d, a, x[i + 13], 21, 1309151649);
    a = ii(a, b, c, d, x[i + 4], 6, -145523070);
    d = ii(d, a, b, c, x[i + 11], 10, -1120210379);
    c = ii(c, d, a, b, x[i + 2], 15, 718787259);
    b = ii(b, c, d, a, x[i + 9], 21, -343485551);
    a = ad(a, olda);
    b = ad(b, oldb);
    c = ad(c, oldc);
    d = ad(d, oldd);
  }
  return rh(a) + rh(b) + rh(c) + rh(d);
}

// prettier-ignore-end

/* ------------------------------------------------------------------ *
 * Typed surface. Everything above is vendored verbatim and unchecked; *
 * everything below is this package's own, checked code.               *
 * ------------------------------------------------------------------ */

import type { TranslateParams } from '../types.js';

/** Normalize a locale tag to canonical BCP 47 form (`en_gb` -> `en-GB`). */
export const canonicalizeLocale: (locale: string) => string = canonicalizeLocaleImpl;

/** Rewrite `%name%` markup placeholders to `{name}` interpolation syntax. */
export const normalizeMarkupPlaceholders: (text: string) => string = normalizeMarkupPlaceholdersImpl;

/**
 * Substitute `params` into `template`, using ICU MessageFormat when the template is ICU
 * and simple `{name}` replacement otherwise.
 *
 * Omitting this step renders the literal `Hello {name}` server-side and correctly
 * client-side — a hydration mismatch on precisely the strings carrying data.
 */
export const interpolate: (template: string, params?: TranslateParams, locale?: string) => string = interpolateImpl;

/** Param keys with no matching placeholder in any of `texts`. */
export const findUnusedParamKeys: (texts: string[], params?: TranslateParams) => string[] = findUnusedParamKeysImpl;

/** MD5 over the UTF-8 bytes of `input`. The current hash. */
export const md5: (input: string) => string = md5Impl;

/**
 * MD5 over the raw UTF-16 code units of `input`. Differs from `md5` for any non-ASCII
 * input. Lookup-only — never hash a new registration with this.
 */
export const md5Legacy: (input: string) => string = md5LegacyImpl;

/**
 * The identity of a content block: `md5(JSON.stringify([category, tokens]))`.
 *
 * `JSON.stringify` rather than `tokens.join('-')` is load-bearing. The collision is a
 * property of the FINAL hashed string, so the encoding is part of the cross-SDK
 * contract, not an implementation detail: `JSON.stringify` shifts every character's
 * offset, so the same phrase pair can collide standalone and not collide here, and
 * changing `category` moves every character into different lanes.
 */
export function generateCustomId(category: string, tokens: string[]): string {
    return md5Impl(JSON.stringify([category, tokens]));
}

/**
 * Lookup-only fallback for content blocks whose id was hashed before `md5` switched to
 * hashing UTF-8 BYTES.
 *
 * **The difference is the MD5 input encoding, not the JSON encoding.** Both this and
 * `generateCustomId` hash `JSON.stringify([category, tokens])` — verified against the
 * published dist, where `generateLegacyCustomId` is `md5Legacy(JSON.stringify(...))`.
 * `md5Legacy` hashes raw UTF-16 code units, so **it differs from `md5` only for
 * non-ASCII input**, and an all-ASCII block produces the identical id under both.
 *
 * That last property is not a curiosity: it means this derivation legitimately collapses
 * onto another for ASCII content, which is why `derivations.ts` deduplicates by id rather
 * than assuming each derivation is a distinct lookup.
 *
 * NEVER register with this. Registration always uses `generateCustomId`; this exists so
 * older catalog entries can still be READ rather than silently falling back to base
 * language.
 */
export function generateLegacyCustomId(category: string, tokens: string[]): string {
    return md5LegacyImpl(JSON.stringify([category, tokens]));
}
