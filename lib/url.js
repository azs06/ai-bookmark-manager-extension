// Mirrors worker/src/lib/url.ts byte-for-byte. Keep the TRACKING_PARAMS list
// and normalizeUrl body identical to the backend so the SHA-256 hashes match
// on both sides — any drift silently breaks the "already saved" detection.

const TRACKING_PARAMS = [
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'gclid', 'fbclid', 'mc_cid', 'mc_eid', '_hsenc', '_hsmi',
];

export function normalizeUrl(raw) {
  const url = new URL(raw);
  for (const p of TRACKING_PARAMS) url.searchParams.delete(p);
  url.hash = '';
  if ((url.protocol === 'http:' && url.port === '80') ||
      (url.protocol === 'https:' && url.port === '443')) {
    url.port = '';
  }
  return url.toString();
}

export async function hashUrl(url) {
  const data = new TextEncoder().encode(url);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function isTrackableUrl(raw) {
  if (!raw) return false;
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}
