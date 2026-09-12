/**
 * `findUnusedParamKeys` — which supplied params matched no placeholder.
 *
 * Warning-only, never identity, which is why it is safe to hold locally while the core's
 * `/pure` export lands. It is not safe to hold DIVERGENTLY: this tells an integrator what
 * to change about their template, and two SDKs giving different advice about the same
 * template is a cost even when neither can re-key anything.
 *
 * The predicate and the interpolator are two halves of one question — "is this key a
 * placeholder in this text" — and they must answer it identically. Where they disagree the
 * failure is silent in the direction that matters: a false NEGATIVE suppresses a warning
 * that was correct, hiding a real mistake rather than misdirecting one.
 */

import { describe, expect, it } from 'vitest';
import { interpolate } from 'langsys-js-typescript/pure';
import { findUnusedParamKeys } from '../src/params.js';

describe('the two placeholder spellings', () => {
    it('accepts {key}', () => {
        expect(findUnusedParamKeys(['Hello {name}'], { name: 'x' })).toEqual([]);
    });

    it('accepts an ICU {key, plural, ...}', () => {
        expect(findUnusedParamKeys(['{n, plural, one {#} other {#}}'], { n: 1 })).toEqual([]);
    });

    it('accepts %key% — which the core version did not', () => {
        expect(findUnusedParamKeys(['Hello %name%'], { name: 'x' })).toEqual([]);
    });

    it('reports a key that appears in neither spelling', () => {
        expect(findUnusedParamKeys(['Hello {name}'], { other: 'x' })).toEqual(['other']);
    });
});

describe('the percent spelling is gated on the key being an IDENTIFIER', () => {
    /**
     * `%name%` is adopted only for identifiers — `normalizeMarkupPlaceholders` matches
     * `[A-Za-z_][A-Za-z0-9_]*`. A dotted key is never rewritten, so it never resolves, so
     * a param supplied under it IS unused and the warning is correct.
     *
     * Accepting it here would suppress that warning. This is the direction that hides a
     * mistake rather than misdirecting one, and it is the reason the predicate has to
     * match the interpolator exactly rather than approximately.
     */
    it('PROOF: the interpolator does not substitute a dotted percent key', () => {
        // Evidence from the other half of the rule, not from this file's own assumption.
        expect(interpolate('%a.b%', { 'a.b': 'X' }, 'en-us')).toBe('%a.b%');
        expect(interpolate('%name%', { name: 'X' }, 'en-us')).toBe('X');
    });

    it('so a dotted key in percent form is reported as unused', () => {
        expect(findUnusedParamKeys(['%a.b%'], { 'a.b': 'x' })).toEqual(['a.b']);
    });

    it('but a dotted key in brace form is NOT — braces take any key', () => {
        // The control. Without it, "dotted keys are unused" would pass against an
        // implementation that rejects every dotted key in both spellings.
        expect(findUnusedParamKeys(['{a.b}'], { 'a.b': 'x' })).toEqual([]);
    });

    it('a key starting with a digit is not an identifier either', () => {
        expect(findUnusedParamKeys(['%1st%'], { '1st': 'x' })).toEqual(['1st']);
        expect(findUnusedParamKeys(['{1st}'], { '1st': 'x' })).toEqual([]);
    });

    it('underscores and digits after the first character ARE identifiers', () => {
        expect(findUnusedParamKeys(['%user_2%'], { user_2: 'x' })).toEqual([]);
    });
});

describe('edges', () => {
    it('no params means nothing unused', () => {
        expect(findUnusedParamKeys(['anything'], undefined)).toEqual([]);
    });

    it('no texts means every key is unused', () => {
        expect(findUnusedParamKeys([], { a: 1, b: 2 }).sort()).toEqual(['a', 'b']);
    });

    it('a regex-special key is matched literally, not as a pattern', () => {
        // `a+b` as a regex would match "ab", "aab"... The key must be escaped.
        expect(findUnusedParamKeys(['{a+b}'], { 'a+b': 'x' })).toEqual([]);
        expect(findUnusedParamKeys(['{aab}'], { 'a+b': 'x' })).toEqual(['a+b']);
    });

    it('a placeholder cannot be formed accidentally across two texts', () => {
        // The texts are NUL-joined; `{` at the end of one and `name}` at the start of the
        // next must not read as `{name}`.
        expect(findUnusedParamKeys(['prefix {', 'name} suffix'], { name: 'x' })).toEqual(['name']);
    });
});
