import { describe, it, expect } from 'vitest';
import { topicMatches, isWildcard } from '@/lib/mqtt';

describe('topicMatches', () => {
  it('treats + as exactly one level', () => {
    expect(topicMatches('factory/+/temp', 'factory/line1/temp')).toBe(true);
    expect(topicMatches('factory/+/temp', 'factory/line1/cell2/temp')).toBe(false);
    expect(topicMatches('factory/+/temp', 'factory/temp')).toBe(false);
  });

  it('treats # as the remainder including zero levels', () => {
    expect(topicMatches('a/#', 'a/b/c')).toBe(true);
    expect(topicMatches('a/#', 'a')).toBe(true);
    expect(topicMatches('a/#', 'ab')).toBe(false);
  });

  it('treats a bare # as match-everything (the most common subscription)', () => {
    expect(topicMatches('#', 'plant/line1/temp')).toBe(true);
    expect(topicMatches('#', 'a')).toBe(true);
    expect(topicMatches('#', 'spBv1.0/g/NDATA/e/d')).toBe(true);
  });

  it('falls back to case-insensitive substring for plain queries', () => {
    expect(topicMatches('TEMP', 'factory/line1/temperature')).toBe(true);
    expect(topicMatches('pressure', 'factory/line1/temperature')).toBe(false);
  });

  it('detects wildcards', () => {
    expect(isWildcard('a/+/b')).toBe(true);
    expect(isWildcard('a/#')).toBe(true);
    expect(isWildcard('a/b')).toBe(false);
  });
});
