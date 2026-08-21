/**
 * Vendored pure functions vs the published `langsys-js-typescript`.
 *
 * **This file existed as a claim before it existed as a test.** `src/vendor/pure.ts`'s
 * header said "`tests/conformance/vendor-parity.test.ts` asserts these produce
 * byte-identical output to the real published package… **That test is why this file is
 * safe.**" — and the file was not there. `walker-parity.test.ts` covered
 * `generateCustomId` (and therefore `md5` and the JSON encoding) through the corpus, and
 * `_dev_/vendor-pure.sh` runs a one-shot smoke check at re-vendor time, but
 * `interpolate`, `canonicalizeLocale`, `md5Legacy`, `generateLegacyCustomId`,
 * `findUnusedParamKeys` and `normalizeMarkupPlaceholders` were asserted by nothing in the
 * suite.
 *
 * The vendored code turned out to be correct. The safety *argument* was not backed by a
 * running check, which is SPEC §10 rule 2 — a check must come from a different source
 * than the claim, and a claim with no check is worse than either.
 *
 * Expectations come from the real published artifact at a pinned version, imported as a
 * devDependency. Nothing here is a fixture this repo wrote.
 */

import { describe, expect, it } from 'vitest';
import * as sdk from 'langsys-js-typescript';
import {
    canonicalizeLocale,
    findUnusedParamKeys,
    generateCustomId,
    generateLegacyCustomId,
    interpolate,
    md5,
    md5Legacy,
    normalizeMarkupPlaceholders,
} from '../../src/vendor/pure.js';

describe('the harness itself', () => {
    it('imported the real published package', () => {
        // Without this, every assertion below could be comparing undefined to undefined.
        expect(typeof sdk.generateCustomId).toBe('function');
        expect(typeof sdk.interpolate).toBe('function');
        expect(typeof sdk.md5).toBe('function');
        expect(typeof sdk.md5Legacy).toBe('function');
        expect(typeof sdk.canonicalizeLocale).toBe('function');
        expect(typeof sdk.generateLegacyCustomId).toBe('function');
    });

    it('the reference implementations discriminate', () => {
        // If they returned constants, matching them would prove nothing.
        expect(sdk.md5('a')).not.toBe(sdk.md5('b'));
        expect(sdk.interpolate('{x}', { x: 'a' }, 'en')).not.toBe(
            sdk.interpolate('{x}', { x: 'b' }, 'en'),
        );
    });
});

const HASH_INPUTS: string[] = [
    '',
    'a',
    'Hello world',
    'café',
    '日本語',
    '👍🏽',
    'Ünïcödé with ÅÄÖ',
    'a'.repeat(1000),
    '{"category":"x","tokens":["y"]}',
    'line\nbreak\ttab',
    ' non-breaking',
];

describe('md5 — UTF-8 bytes', () => {
    for (const input of HASH_INPUTS) {
        it(`matches for ${JSON.stringify(input.slice(0, 30))}`, () => {
            expect(md5(input)).toBe(sdk.md5(input));
        });
    }

    it('produces a 32-char hex digest', () => {
        expect(md5('anything')).toMatch(/^[0-9a-f]{32}$/);
    });
});

describe('md5Legacy — raw UTF-16 code units', () => {
    for (const input of HASH_INPUTS) {
        it(`matches for ${JSON.stringify(input.slice(0, 30))}`, () => {
            expect(md5Legacy(input)).toBe(sdk.md5Legacy(input));
        });
    }

    it('DIFFERS from md5 on non-ASCII, and agrees on ASCII', () => {
        // This is the whole reason both exist, and it is the property `derivations.ts`
        // relies on when it dedups the two legacy derivations for an ASCII block.
        // `md5Legacy := md5` survived mutation before this test existed.
        expect(md5Legacy('café')).not.toBe(md5('café'));
        expect(md5Legacy('plain ascii')).toBe(md5('plain ascii'));
    });
});

describe('generateCustomId / generateLegacyCustomId', () => {
    const CASES: [string, string[]][] = [
        ['', []],
        ['', ['Hello world']],
        ['marketing', ['Based on', '5', 'reviews']],
        ['', ['café', '日本語', '👍🏽']],
        ['', ['e-mail']],
        ['a-category-with-hyphens', ['token']],
        ['', ['', 'empty first']],
        ['', ['a', 'b']],
    ];

    for (const [category, tokens] of CASES) {
        it(`current id matches for ${JSON.stringify([category, tokens])}`, () => {
            expect(generateCustomId(category, tokens)).toBe(sdk.generateCustomId(category, tokens));
        });

        it(`legacy id matches for ${JSON.stringify([category, tokens])}`, () => {
            expect(generateLegacyCustomId(category, tokens)).toBe(
                sdk.generateLegacyCustomId(category, tokens),
            );
        });
    }

    it('token ORDER is part of the identity', () => {
        expect(generateCustomId('', ['a', 'b'])).not.toBe(generateCustomId('', ['b', 'a']));
    });

    it('category changes the identity', () => {
        expect(generateCustomId('x', ['t'])).not.toBe(generateCustomId('y', ['t']));
    });
});

describe('canonicalizeLocale', () => {
    const LOCALES = [
        'en',
        'en_gb',
        'EN-GB',
        'pt-br',
        'zh_hans_cn',
        'zh-Hant-TW',
        'de-DE',
        'ru',
        'not a locale',
        'x',
        '',
    ];

    for (const locale of LOCALES) {
        it(`matches for ${JSON.stringify(locale)}`, () => {
            expect(canonicalizeLocale(locale)).toBe(sdk.canonicalizeLocale(locale));
        });
    }

    it('actually canonicalizes, rather than returning its input', () => {
        // A pass-through implementation would match the SDK on `en` and nothing else.
        expect(canonicalizeLocale('en_gb')).toBe('en-GB');
        expect(canonicalizeLocale('zh_hans_cn')).toBe('zh-Hans-CN');
    });
});

describe('interpolate', () => {
    const RU_PLURAL = '{n, plural, one {# элемент} few {# элемента} many {# элементов} other {# элемента}}';
    const CASES: [string, Record<string, unknown> | undefined, string][] = [
        ['Hello {name}', { name: 'Bob' }, 'en'],
        ['Hello %name%', { name: 'Bob' }, 'en'],
        ['No placeholders', { unused: 1 }, 'en'],
        ['{n, plural, one {# item} other {# items}}', { n: 1 }, 'en'],
        ['{n, plural, one {# item} other {# items}}', { n: 5 }, 'en'],
        [RU_PLURAL, { n: 1 }, 'ru'],
        [RU_PLURAL, { n: 3 }, 'ru'],
        [RU_PLURAL, { n: 8 }, 'ru'],
        ['{g, select, male {He} female {She} other {They}} arrived', { g: 'female' }, 'en'],
        ['Missing {arg} recovers', {}, 'en'],
        ['Null {arg} recovers', { arg: null }, 'en'],
        ['{count, number} items', { count: 1234.5 }, 'de'],
        ['Two {a} and {b}', { a: 'x', b: 'y' }, 'en'],
    ];

    for (const [template, params, locale] of CASES) {
        it(`matches for ${JSON.stringify(template.slice(0, 40))} @ ${locale}`, () => {
            expect(interpolate(template, params as never, locale)).toBe(
                sdk.interpolate(template, params as never, locale),
            );
        });
    }

    it('renders plural forms that actually differ', () => {
        // Guards against an implementation that returns the template unchanged, which
        // would "match" only if the SDK did the same.
        const one = interpolate(RU_PLURAL, { n: 1 } as never, 'ru');
        const few = interpolate(RU_PLURAL, { n: 3 } as never, 'ru');
        const many = interpolate(RU_PLURAL, { n: 8 } as never, 'ru');
        expect(new Set([one, few, many]).size).toBe(3);
        expect(one).toBe('1 элемент');
    });
});

describe('normalizeMarkupPlaceholders', () => {
    for (const input of ['%name%', 'a %b% c', 'no percent', '%a%%b%', '%1invalid%', '%_ok%']) {
        it(`matches for ${JSON.stringify(input)}`, () => {
            expect(normalizeMarkupPlaceholders(input)).toBe(sdk.normalizeMarkupPlaceholders(input));
        });
    }

    it('actually rewrites, rather than passing through', () => {
        expect(normalizeMarkupPlaceholders('Hello %name%')).toBe('Hello {name}');
    });
});

describe('findUnusedParamKeys', () => {
    const CASES: [string[], Record<string, unknown> | undefined][] = [
        [['Hello {name}'], { name: 'Bob' }],
        [['Hello {name}'], { name: 'Bob', extra: 1 }],
        [['Hello'], { name: 'Bob' }],
        [[], { a: 1 }],
        [['{a} {b}'], { a: 1, b: 2 }],
        [['Hello {name}'], undefined],
    ];

    for (const [texts, params] of CASES) {
        it(`matches for ${JSON.stringify([texts, params])}`, () => {
            expect(findUnusedParamKeys(texts, params as never)).toEqual(
                sdk.findUnusedParamKeys(texts, params as never),
            );
        });
    }

    it('actually detects an unused key', () => {
        expect(findUnusedParamKeys(['Hello'], { name: 'Bob' } as never)).toEqual(['name']);
    });
});
