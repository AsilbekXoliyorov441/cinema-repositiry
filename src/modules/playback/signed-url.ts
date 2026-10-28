import { createHmac } from 'node:crypto';

/**
 * Generic HMAC-SHA256 token signing for CDN token authentication.
 *   token = base64url( HMAC_SHA256(secret, `${expires}${path}`) )
 * The CDN/edge must verify the same formula (nginx `secure_link` with a small njs/Lua snippet,
 * BunnyCDN/Cloudflare token auth use comparable schemes — adapt this function to the provider).
 */
export function signPlaybackUrl(rawUrl: string, secret: string, ttlSeconds: number, now = Date.now()) {
  const url = new URL(rawUrl);
  const expires = Math.floor(now / 1000) + ttlSeconds;
  const token = createHmac('sha256', secret).update(`${expires}${url.pathname}`).digest('base64url');
  url.searchParams.set('expires', String(expires));
  url.searchParams.set('token', token);
  return { url: url.toString(), expiresAt: new Date(expires * 1000) };
}

export function verifySignedPlaybackUrl(signedUrl: string, secret: string, now = Date.now()): boolean {
  const url = new URL(signedUrl);
  const expires = Number(url.searchParams.get('expires'));
  const token = url.searchParams.get('token');
  if (!expires || !token || expires * 1000 < now) return false;
  const expected = createHmac('sha256', secret).update(`${expires}${url.pathname}`).digest('base64url');
  return expected === token;
}
