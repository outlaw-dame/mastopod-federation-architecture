import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractHashtagsFromActivityPubTags,
  extractHashtagsFromText,
  normalizeHashtag,
} from '../../utils/hashtags.js';

type NormalizeCase = {
  input: string;
  expected: string | null;
};

type ExtractTextCase = {
  input: string;
  expected: string[];
};

type ExtractApTagsCase = {
  input: Array<{ type: string; name: string }>;
  expected: string[];
};

type ConformanceFixture = {
  normalizeStrict: NormalizeCase[];
  normalizeAllowMissingHash: NormalizeCase[];
  extractFromText: ExtractTextCase[];
  extractFromActivityPubTags: ExtractApTagsCase[];
};

const thisDir = dirname(fileURLToPath(import.meta.url));
const conformancePath = resolve(thisDir, '../../../../shared/hashtag-conformance-matrix.json');
const conformanceFixture = JSON.parse(
  readFileSync(conformancePath, 'utf8'),
) as ConformanceFixture;

describe('FEP-eb48 hashtag parsing rules', () => {
  it('parses hashtags from text using shared conformance fixtures', () => {
    for (const testCase of conformanceFixture.extractFromText) {
      expect(extractHashtagsFromText(testCase.input)).toEqual(testCase.expected);
    }
  });

  it('accepts only valid hashtag grammar when normalizing', () => {
    for (const testCase of conformanceFixture.normalizeStrict) {
      expect(normalizeHashtag(testCase.input) ?? null).toBe(testCase.expected);
    }
  });

  it('can normalize query input with or without #', () => {
    for (const testCase of conformanceFixture.normalizeAllowMissingHash) {
      expect(normalizeHashtag(testCase.input, { allowMissingHash: true }) ?? null).toBe(
        testCase.expected,
      );
    }
  });

  it('extracts valid hashtag tags from AP tag objects', () => {
    for (const testCase of conformanceFixture.extractFromActivityPubTags) {
      expect(extractHashtagsFromActivityPubTags(testCase.input)).toEqual(testCase.expected);
    }
  });
});
