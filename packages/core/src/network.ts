import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { GraphError } from './errors.ts';
export function isLoopback(address: string): boolean {
  const value = address.toLowerCase().replace(/^\[|\]$/g, '');
  return (
    value === '::1' ||
    value === '0:0:0:0:0:0:0:1' ||
    value.startsWith('::ffff:127.') ||
    (isIP(value) === 4 && value.startsWith('127.'))
  );
}
export async function assertLocalUrl(value: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new GraphError(100, 'URL must be an absolute loopback HTTP(S) URL');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash ||
    !(host === 'localhost' || isLoopback(host))
  )
    throw new GraphError(100, 'Only loopback HTTP(S) URLs are allowed');
  const addresses = await lookup(host, { all: true });
  if (!addresses.length || addresses.some((a) => !isLoopback(a.address)))
    throw new GraphError(100, 'URL must resolve only to loopback');
}
export async function localFetch(url: string, init: RequestInit = {}): Promise<Response> {
  await assertLocalUrl(url);
  return fetch(url, {
    ...init,
    redirect: 'manual',
    signal: init.signal ?? AbortSignal.timeout(5000),
  });
}
