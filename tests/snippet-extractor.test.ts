import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRerankText, extractAroundHit, truncateMiddle } from '../src/search/SnippetExtractor.ts';

test('extractAroundHit centers snippet around the best matching line', () => {
  const text = [
    'line 1',
    'line 2',
    'const SearchService = 1;',
    'buildContextPack();',
    'line 5',
    'line 6',
  ].join('\n');

  const snippet = extractAroundHit(text, new Set(['searchservice', 'buildcontextpack']), 80, 0.67);

  assert.match(snippet, /SearchService/);
  assert.match(snippet, /buildContextPack/);
  assert.ok(snippet.includes('line 2'));
});

test('extractAroundHit falls back to head-tail truncation when no token matches', () => {
  const text = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const snippet = extractAroundHit(text, new Set(['not-found']), 20, 0.5);

  assert.equal(snippet.length, 20);
  assert.match(snippet, /\.\.\./);
});

test('buildRerankText truncates breadcrumb and focuses code around matched lines', () => {
  const result = buildRerankText(
    {
      breadcrumb:
        'src/search/SearchService.ts > class SearchService > method buildContextPack > nested segment',
      displayCode: [
        'const before = true;',
        'function buildContextPack() {',
        '  return SearchService;',
        '}',
        'const after = false;',
      ].join('\n'),
    },
    new Set(['buildcontextpack', 'searchservice']),
    {
      maxBreadcrumbChars: 32,
      maxRerankChars: 90,
      headRatio: 0.67,
    },
  );

  assert.match(result, /buildContextPack/);
  assert.match(result, /\.\.\./);
});

test('truncateMiddle keeps both ends when shortening long breadcrumbs', () => {
  const truncated = truncateMiddle('abcdefghijklmnopqrstuvwxyz', 11);
  assert.equal(truncated, 'abcd...wxyz');
});
