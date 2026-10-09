// lib/url.js must match the backend's worker/src/lib/url.ts byte-for-byte or
// "already saved" detection silently breaks. fixtures/url-vectors.json is the
// shared contract: copy it into the backend repo and run the same assertions
// there, so drift on either side fails a test instead of shipping.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { normalizeUrl, hashUrl, isTrackableUrl } from '../lib/url.js';

const vectors = JSON.parse(
  await readFile(new URL('./fixtures/url-vectors.json', import.meta.url), 'utf8'),
);

for (const { input, normalized, hash } of vectors) {
  test(`normalizes and hashes ${input}`, async () => {
    assert.equal(normalizeUrl(input), normalized);
    assert.equal(await hashUrl(normalized), hash);
  });
}

test('isTrackableUrl accepts only http(s)', () => {
  assert.equal(isTrackableUrl('https://example.com'), true);
  assert.equal(isTrackableUrl('http://localhost:8787'), true);
  assert.equal(isTrackableUrl('chrome://extensions'), false);
  assert.equal(isTrackableUrl('file:///tmp/a.html'), false);
  assert.equal(isTrackableUrl('not a url'), false);
  assert.equal(isTrackableUrl(undefined), false);
});
