import { afterEach, describe, expect, it, vi } from 'vitest';
import { localUrl, redactEvidence, SimClient, validateToken } from '../src/client.ts';
afterEach(() => vi.unstubAllGlobals());
describe('inspector boundaries', () => {
  it('refuses production-looking and non-synthetic credentials before a request', () => {
    for (const token of ['EAAproduction', 'eaaProduction', 'Bearer secret', 'real-secret', ''])
      expect(() => new SimClient(token)).toThrow();
    expect(validateToken(' wa-fake-sim ')).toBe('wa-fake-sim');
  });
  it('keeps attachment URLs on the same origin, refusing credentials and empty URLs', () => {
    vi.stubGlobal('location', { origin: 'http://127.0.0.1:58991' });
    expect(localUrl('/_wa/media/synthetic')).toBe('http://127.0.0.1:58991/_wa/media/synthetic');
    for (const url of [
      '',
      'https://example.com/media',
      'http://127.0.0.1:9000/media',
      'http://user:pass@127.0.0.1:58991/x',
      'javascript:alert(1)',
    ])
      expect(localUrl(url)).toBeNull();
  });
  it('redacts nested content and custom synthetic secrets while preserving status evidence', () => {
    const scrubbed = redactEvidence({
      headers: { Authorization: 'Bearer real-secret' },
      payload: { contacts: [{ name: 'Synthetic private name' }] },
      flow_token: 'private',
      data: { name: 'private' },
      url: '/_wa/events?token=wa-fake-custom',
      signature_valid: true,
      status: 200,
      message_id: 'wamid.local.1',
    });
    const text = JSON.stringify(scrubbed);
    expect(text).not.toContain('private');
    expect(text).not.toContain('real-secret');
    expect(text).not.toContain('wa-fake-custom');
    expect(scrubbed).toMatchObject({
      signature_valid: true,
      status: 200,
      message_id: 'wamid.local.1',
    });
  });
});
