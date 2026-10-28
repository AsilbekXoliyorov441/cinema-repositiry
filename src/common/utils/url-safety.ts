import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { z } from 'zod';
import { env, isProduction } from '../../config/env.js';
import { AppError } from '../errors/app-error.js';

const BLOCKED_HOSTNAMES = new Set(['localhost', 'localhost.localdomain', 'metadata.google.internal', 'metadata']);

/** True for loopback, private, link-local, CGNAT, multicast, reserved and unique-local addresses. */
export function isPrivateAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) {
    const parts = ip.split('.').map(Number) as [number, number, number, number];
    const [a, b] = parts;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (version === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::' || lower === '::1') return true;
    if (lower.startsWith('::ffff:')) return isPrivateAddress(lower.slice(7));
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(lower);
  }
  return true;
}

function hostIsBlockedLiteral(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (BLOCKED_HOSTNAMES.has(host) || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) return true;
  return isIP(host) !== 0 && isPrivateAddress(host);
}

/**
 * Zod validator for externally hosted media URLs entered by admins.
 * https only (http allowed outside production for local testing), no embedded credentials,
 * no private/loopback hosts, optional host allowlist.
 */
export const externalMediaUrl = z
  .url()
  .max(2048)
  .superRefine((value, ctx) => {
    const url = new URL(value);
    const allowedProtocols = isProduction ? ['https:'] : ['https:', 'http:'];
    if (!allowedProtocols.includes(url.protocol)) ctx.addIssue({ code: 'custom', message: 'URL must use https' });
    if (url.username || url.password) ctx.addIssue({ code: 'custom', message: 'URL must not contain credentials' });
    if (hostIsBlockedLiteral(url.hostname)) ctx.addIssue({ code: 'custom', message: 'URL host is not allowed' });
    if (env.VIDEO_ALLOWED_HOSTS.length && !env.VIDEO_ALLOWED_HOSTS.includes(url.hostname.toLowerCase())) {
      ctx.addIssue({ code: 'custom', message: 'URL host is not in VIDEO_ALLOWED_HOSTS' });
    }
  });

/** Iframe/embed URL — host must be on EMBED_ALLOWED_HOSTS. Raw HTML/JS embeds are never accepted. */
export const embedUrl = z
  .url()
  .max(2048)
  .superRefine((value, ctx) => {
    const url = new URL(value);
    if (url.protocol !== 'https:') ctx.addIssue({ code: 'custom', message: 'Embed URL must use https' });
    if (!env.EMBED_ALLOWED_HOSTS.includes(url.hostname.toLowerCase())) {
      ctx.addIssue({ code: 'custom', message: `Embed host must be one of: ${env.EMBED_ALLOWED_HOSTS.join(', ')}` });
    }
  });

/** Trailer: either an allowlisted embed or a direct external media URL. */
export const trailerUrl = z.union([embedUrl, externalMediaUrl]);

/** Resolves DNS and rejects hosts that point to private networks (DNS-rebinding aware per request). */
export async function assertPublicHost(url: URL): Promise<void> {
  if (hostIsBlockedLiteral(url.hostname)) throw AppError.badRequest('URL host is not allowed');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
  if (!addresses.length) throw AppError.badRequest('URL host could not be resolved');
  if (addresses.some((a) => isPrivateAddress(a.address))) throw AppError.badRequest('URL resolves to a private network address');
}

/**
 * SSRF-safe availability probe (HEAD, falls back to ranged GET). Follows at most 3 redirects,
 * re-validating every hop, with a short timeout. Never returns the body.
 */
export async function probeUrl(rawUrl: string): Promise<{ status: number; contentType: string | null; finalUrl: string }> {
  let current = new URL(rawUrl);
  for (let hop = 0; hop <= 3; hop++) {
    if (!['https:', 'http:'].includes(current.protocol)) throw AppError.badRequest('Unsupported protocol');
    await assertPublicHost(current);
    let res = await fetch(current, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(5000) });
    if (res.status === 405 || res.status === 501) {
      res = await fetch(current, { method: 'GET', headers: { Range: 'bytes=0-0' }, redirect: 'manual', signal: AbortSignal.timeout(5000) });
      await res.body?.cancel();
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) break;
      current = new URL(location, current);
      continue;
    }
    return { status: res.status, contentType: res.headers.get('content-type'), finalUrl: current.toString() };
  }
  throw AppError.badRequest('Too many redirects');
}
