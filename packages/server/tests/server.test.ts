import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWaFake } from '../src/index.ts';
import { main } from '../src/cli.ts';
import { WaEngine } from '../../core/src/index.ts';
import { verifyWebhook } from '../../webhooks/src/index.ts';
const phone = '100000000001',
  user = '5511900000001';
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function start(options: Record<string, any> = {}) {
  const wa = await createWaFake({ port: 0, ...options });
  cleanups.push(wa.close);
  return wa;
}
async function call(
  base: string,
  path: string,
  body?: any,
  token = 'wa-fake-sim',
  method = body === undefined ? 'GET' : 'POST',
) {
  const response = await fetch(base + path, {
    method,
    headers: {
      authorization: 'Bearer ' + token,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, data: await response.json() };
}
const wire = (body = 'Synthetic response') => ({
  messaging_product: 'whatsapp',
  to: user,
  type: 'text',
  text: { body },
});
async function open(base: string) {
  await call(base, '/_wa/users', { wa_id: user, name: 'Ana' });
  return call(base, `/_wa/users/${user}/send`, {
    type: 'text',
    text: { body: 'Synthetic opening' },
  });
}
async function callback(handler: (raw: Buffer, signature: string) => number) {
  const server = createServer(async (req, res) => {
    if (req.method === 'GET') {
      const url = new URL(req.url!, 'http://localhost');
      res.end(url.searchParams.get('hub.challenge'));
      return;
    }
    const bytes: Buffer[] = [];
    for await (const part of req) bytes.push(Buffer.from(part));
    res.statusCode = handler(Buffer.concat(bytes), String(req.headers['x-hub-signature-256']));
    res.end('ok');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return `http://127.0.0.1:${address.port}/callback`;
}
describe('HTTP engine integration', () => {
  it('enforces independent auth, scopes, strict wire, unknown 501 and window boundary', async () => {
    const wa = await start();
    expect((await call(wa.baseUrl, '/_wa/state', undefined, 'wrong')).data.error.code).toBe(190);
    expect(
      (await call(wa.baseUrl, `/v23.0/${phone}/messages`, wire(), 'EAAproduction')).status,
    ).toBe(401);
    await call(wa.baseUrl, '/_wa/users', { wa_id: user });
    expect(
      (await call(wa.baseUrl, `/v23.0/${phone}/messages`, wire(), 'wa-fake-token')).data.error.code,
    ).toBe(131047);
    await open(wa.baseUrl);
    expect(
      (await call(wa.baseUrl, `/v23.0/${phone}/messages`, wire(), 'wa-fake-token')).status,
    ).toBe(200);
    expect(
      (
        await call(
          wa.baseUrl,
          `/v23.0/${phone}/messages`,
          { ...wire(), text: { body: 'x', unknown: true } },
          'wa-fake-token',
        )
      ).data.error.code,
    ).toBe(100);
    expect((await call(wa.baseUrl, `/v23.0/${phone}/calls`, {}, 'wa-fake-token')).status).toBe(501);
    expect((await call(wa.baseUrl, '/v23.0/nonexistent', undefined, 'wa-fake-token')).status).toBe(
      501,
    );
    await call(wa.baseUrl, '/_wa/clock', { advance: '24h' });
    expect(
      (await call(wa.baseUrl, `/v23.0/${phone}/messages`, wire(), 'wa-fake-token')).data.error.code,
    ).toBe(131047);
    wa.engine.config.tokens = [
      { token: 'limited', scopes: ['whatsapp_business_management'], phoneIds: [phone] },
    ];
    expect((await call(wa.baseUrl, `/v23.0/${phone}/messages`, wire(), 'limited')).status).toBe(
      403,
    );
    wa.engine.config.tokens = [
      { token: 'limited', scopes: ['whatsapp_business_messaging'], phoneIds: ['99999'] },
    ];
    expect(
      (await call(wa.baseUrl, `/v23.0/${phone}/messages`, wire(), 'limited')).data.error.code,
    ).toBe(200);
    wa.engine.store.phones.foreign = {
      ...wa.engine.phone(),
      id: 'foreign',
      waba_id: 'foreign-waba',
    };
    wa.engine.config.tokens = [
      { token: 'limited', scopes: ['whatsapp_business_management'], wabaIds: ['200000000001'] },
    ];
    expect(
      (await call(wa.baseUrl, '/v23.0/foreign-waba/message_templates', undefined, 'limited'))
        .status,
    ).toBe(403);
  });
  it('verifies callbacks, signs exact UTF-8 bytes, retries virtually and emits status envelopes', async () => {
    let failures = 1;
    const received: Array<{ raw: Buffer; value: any }> = [];
    const url = await callback((raw, signature) => {
      expect(verifyWebhook(raw, signature, 'wa-fake-secret')).toBe(true);
      expect(
        verifyWebhook(Buffer.concat([raw, Buffer.from(' ')]), signature, 'wa-fake-secret'),
      ).toBe(false);
      received.push({ raw, value: JSON.parse(raw.toString()) });
      return failures-- > 0 ? 500 : 200;
    });
    const wa = await start({ webhookUrl: url });
    await call(wa.baseUrl, '/_wa/users', { wa_id: user, name: 'Ana' });
    const inbound = await call(wa.baseUrl, `/_wa/users/${user}/send`, {
      type: 'text',
      text: { body: 'Hello synthetic 👋' },
    });
    expect(wa.engine.store.webhooks[0]?.status).toBe('retry');
    expect(received).toHaveLength(1);
    await wa.engine.advance(999);
    expect(received).toHaveLength(1);
    await wa.engine.advance(1);
    expect(received).toHaveLength(2);
    expect(received[0]!.raw.equals(received[1]!.raw)).toBe(true);
    const value = received[0]!.value.entry[0].changes[0].value;
    expect(value.metadata.phone_number_id).toBe(phone);
    expect(value.contacts[0].wa_id).toBe(user);
    expect(value.messages[0].id).toBe(inbound.data.id);
    const outbound = await call(
      wa.baseUrl,
      `/v23.0/${phone}/messages`,
      { ...wire('Secret synthetic message'), biz_opaque_callback_data: 'opaque synthetic' },
      'wa-fake-token',
    );
    await call(wa.baseUrl, '/_wa/webhooks/drain', {});
    const statuses = received.flatMap((x) => x.value.entry[0].changes[0].value.statuses ?? []);
    expect(statuses.map((s) => s.status)).toEqual(['sent', 'delivered', 'read']);
    expect(statuses[2].id).toBe(outbound.data.messages[0].id);
    expect(statuses[2].biz_opaque_callback_data).toBe('opaque synthetic');
    const logs = JSON.stringify((await call(wa.baseUrl, '/_wa/log')).data);
    expect(logs).not.toContain('Secret synthetic');
    expect(logs).not.toContain('Hello synthetic');
    expect(logs).not.toContain('wa-fake-secret');
    expect(logs).not.toContain('wa-fake-token');
  });
  it('handles read+typing, fault times, status failure and reply interactions', async () => {
    const wa = await start();
    const inbound = await open(wa.baseUrl);
    expect(
      (
        await call(
          wa.baseUrl,
          `/v23.0/${phone}/messages`,
          {
            messaging_product: 'whatsapp',
            status: 'read',
            message_id: inbound.data.id,
            typing_indicator: { type: 'text' },
          },
          'wa-fake-token',
        )
      ).data.success,
    ).toBe(true);
    expect(wa.engine.phone().typing_until).toBe(wa.engine.now() + 25000);
    await wa.engine.advance('25s');
    expect(wa.engine.phone().typing_until).toBeUndefined();
    await call(wa.baseUrl, '/_wa/faults', {
      match: { to: user, type: 'text' },
      times: 1,
      error: { code: 130429, status: 429 },
    });
    expect(
      (await call(wa.baseUrl, `/v23.0/${phone}/messages`, wire(), 'wa-fake-token')).status,
    ).toBe(429);
    expect(
      (await call(wa.baseUrl, `/v23.0/${phone}/messages`, wire(), 'wa-fake-token')).status,
    ).toBe(200);
    await call(wa.baseUrl, '/_wa/faults', {
      phase: 'status',
      match: { type: 'text' },
      times: 1,
      error: { code: 131026 },
    });
    const failed = await call(wa.baseUrl, `/v23.0/${phone}/messages`, wire(), 'wa-fake-token');
    expect(wa.engine.store.messages.find((m) => m.id === failed.data.messages[0].id)?.status).toBe(
      'failed',
    );
    const reply = await call(
      wa.baseUrl,
      `/v23.0/${phone}/messages`,
      {
        messaging_product: 'whatsapp',
        to: user,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: 'Choose' },
          action: { buttons: [{ type: 'reply', reply: { id: 'pay', title: 'Pay' } }] },
        },
      },
      'wa-fake-token',
    );
    const tapped = await call(wa.baseUrl, `/_wa/users/${user}/tap`, {
      message_id: reply.data.messages[0].id,
      button_id: 'pay',
    });
    expect(tapped.data.payload.interactive.button_reply).toEqual({ id: 'pay', title: 'Pay' });
    const list = await call(
      wa.baseUrl,
      `/v23.0/${phone}/messages`,
      {
        messaging_product: 'whatsapp',
        to: user,
        type: 'interactive',
        interactive: {
          type: 'list',
          body: { text: 'Choose' },
          action: { button: 'Open', sections: [{ rows: [{ id: 'row', title: 'Row' }] }] },
        },
      },
      'wa-fake-token',
    );
    expect(
      (
        await call(wa.baseUrl, `/_wa/users/${user}/select`, {
          message_id: list.data.messages[0].id,
          row_id: 'row',
        })
      ).data.payload.interactive.list_reply.id,
    ).toBe('row');
    expect(
      (
        await call(wa.baseUrl, `/_wa/users/${user}/react`, {
          message_id: list.data.messages[0].id,
          emoji: '👍',
        })
      ).data.type,
    ).toBe('reaction');
  });
  it('uploads synthetic media with hash, auth, size, signed expiry, snapshot persistence and delete', async () => {
    const wa = await start();
    await open(wa.baseUrl);
    const bytes = Buffer.from('synthetic png bytes');
    const form = new FormData();
    form.set('messaging_product', 'whatsapp');
    form.set('file', new Blob([bytes], { type: 'image/png' }), 'synthetic.png');
    const upload = await fetch(wa.baseUrl + `/v23.0/${phone}/media`, {
      method: 'POST',
      headers: { authorization: 'Bearer wa-fake-token' },
      body: form,
    });
    expect(upload.status).toBe(200);
    const { id } = await upload.json();
    const metadata = await call(wa.baseUrl, `/v23.0/${id}`, undefined, 'wa-fake-token');
    expect(metadata.data.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(metadata.data.file_size).toBe(bytes.length);
    expect((await fetch(metadata.data.url)).status).toBe(401);
    expect(
      Buffer.from(
        await (
          await fetch(metadata.data.url, { headers: { authorization: 'Bearer wa-fake-token' } })
        ).arrayBuffer(),
      ),
    ).toEqual(bytes);
    expect(
      (
        await call(
          wa.baseUrl,
          `/v23.0/${phone}/messages`,
          { messaging_product: 'whatsapp', to: user, type: 'image', image: { id } },
          'wa-fake-token',
        )
      ).status,
    ).toBe(200);
    const snapshot = (await call(wa.baseUrl, '/_wa/snapshot', {})).data;
    const nextId = wa.engine.id('probe');
    await wa.engine.advance('5m');
    expect(
      (await fetch(metadata.data.url, { headers: { authorization: 'Bearer wa-fake-token' } }))
        .status,
    ).toBe(401);
    await call(wa.baseUrl, '/_wa/reset', {});
    expect(wa.engine.store.messages).toHaveLength(0);
    await call(wa.baseUrl, '/_wa/restore', { snapshot });
    expect(wa.engine.id('probe')).toBe(nextId);
    expect(wa.engine.store.media[id].data).toBe(bytes.toString('base64'));
    expect(
      (await call(wa.baseUrl, `/v23.0/${id}`, undefined, 'wa-fake-token', 'DELETE')).data.success,
    ).toBe(true);
    expect((await call(wa.baseUrl, `/v23.0/${id}`, undefined, 'wa-fake-token')).status).toBe(501);
    expect(() =>
      wa.engine.uploadMedia(new Uint8Array(5 * 1024 ** 2 + 1), 'image/png', 'x'),
    ).toThrow();
    expect(() => wa.engine.uploadMedia(bytes, 'application/x-executable', 'x')).toThrow();
  });
  it('restricts loopback callbacks, rejects failed handshake and redirects, and streams SSE', async () => {
    const wa = await start();
    expect(
      (await call(wa.baseUrl, '/_wa/config', { webhook_url: 'https://example.com/cb' })).status,
    ).toBe(400);
    await expect(wa.engine.assertLocalUrl('http://127.0.0.1.example.com')).rejects.toThrow();
    await expect(wa.engine.assertLocalUrl('http://user:password@localhost')).rejects.toThrow();
    const invalid = createServer((_req, res) => res.end('invalid challenge'));
    await new Promise<void>((resolve) => invalid.listen(0, '127.0.0.1', resolve));
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          invalid.closeAllConnections();
          invalid.close(() => resolve());
        }),
    );
    expect(
      (
        await call(wa.baseUrl, '/_wa/config', {
          webhook_url: `http://127.0.0.1:${(invalid.address() as any).port}`,
        })
      ).status,
    ).toBe(400);
    const stream = await fetch(wa.baseUrl + '/_wa/events?token=wa-fake-sim');
    expect(stream.status).toBe(200);
    const reader = stream.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('event: ready');
    await call(wa.baseUrl, '/_wa/users', { wa_id: user });
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('event: user');
    await reader.cancel();
    const hostile = await wa.app.request('http://example.com/_wa/state', {
      headers: { authorization: 'Bearer wa-fake-sim' },
    });
    expect(hostile.status).toBe(403);
    let followed = 0;
    const redirects = createServer((req, res) => {
      if (req.method === 'GET' && req.url?.includes('hub.challenge')) {
        res.end(new URL(req.url, 'http://localhost').searchParams.get('hub.challenge'));
      } else if (req.url === '/target') {
        followed++;
        res.end('unexpected');
      } else {
        res.statusCode = 302;
        res.setHeader('location', '/target');
        res.end();
      }
    });
    await new Promise<void>((resolve) => redirects.listen(0, '127.0.0.1', resolve));
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          redirects.closeAllConnections();
          redirects.close(() => resolve());
        }),
    );
    await wa.engine.configure({
      webhook_url: `http://127.0.0.1:${(redirects.address() as any).port}/cb`,
    });
    await open(wa.baseUrl);
    expect(followed).toBe(0);
    expect(wa.engine.store.webhooks.at(-1)!.attempts[0].status).toBe(302);
  });
  it('supports trusted HTTPS with private local keys', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wa-fake-certs-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    await main(['certs', '--dir', dir]);
    expect((await stat(join(dir, 'server.key'))).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, 'ca.key'))).mode & 0o777).toBe(0o600);
    expect(
      execFileSync('openssl', [
        'verify',
        '-x509_strict',
        '-CAfile',
        join(dir, 'ca.pem'),
        join(dir, 'server.pem'),
      ]).toString(),
    ).toContain(': OK');
    const wa = await start({ cert: join(dir, 'server.pem'), key: join(dir, 'server.key') });
    const ca = await readFile(join(dir, 'ca.pem'));
    const status = await new Promise<number>((resolve, reject) => {
      httpsRequest(wa.baseUrl + '/health', { ca }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode!));
      })
        .on('error', reject)
        .end();
    });
    expect(status).toBe(200);
  });
  it('implements basic WABA, phone, profile, subscriptions and debug-token management', async () => {
    const wa = await start();
    const graph = (path: string, body?: any, method?: string) =>
      call(wa.baseUrl, '/v23.0/' + path, body, 'wa-fake-token', method);
    expect((await graph('200000000001?fields=id,message_template_namespace')).data).toEqual({
      id: '200000000001',
      message_template_namespace: 'wa_fake',
    });
    expect((await graph('200000000001/phone_numbers?fields=id,quality_rating')).data.data).toEqual([
      { id: phone, quality_rating: 'GREEN' },
    ]);
    expect((await graph(phone + '?fields=unknown')).status).toBe(501);
    expect(
      (
        await graph(phone + '/whatsapp_business_profile', {
          messaging_product: 'whatsapp',
          about: 'Synthetic profile',
          websites: ['http://localhost/'],
        })
      ).data.success,
    ).toBe(true);
    expect(
      (await graph(phone + '/whatsapp_business_profile?fields=about')).data.data[0].about,
    ).toBe('Synthetic profile');
    await graph(phone + '/deregister', {});
    await open(wa.baseUrl);
    expect((await graph(phone + '/messages', wire())).data.error.code).toBe(133010);
    await graph(phone + '/register', { messaging_product: 'whatsapp', pin: '123456' });
    expect((await graph(phone + '/messages', wire())).status).toBe(200);
    await graph(phone + '/request_code', { code_method: 'SMS', language: 'en_US' });
    expect((await graph(phone + '/verify_code', { code: '000000' })).status).toBe(400);
    expect((await graph(phone + '/verify_code', { code: '123456' })).data.success).toBe(true);
    expect((await graph('200000000001/subscribed_apps', {})).data.success).toBe(true);
    expect(
      (await graph('200000000001/subscribed_apps')).data.data[0].whatsapp_business_api_data.id,
    ).toBe('300000000001');
    await graph('200000000001/subscribed_apps', undefined, 'DELETE');
    expect((await graph('200000000001/subscribed_apps')).data.data).toEqual([]);
    expect((await graph('debug_token?input_token=wa-fake-token')).data.data.is_valid).toBe(true);
    expect((await graph('debug_token?input_token=unknown')).data.data.is_valid).toBe(false);
    expect((await graph('300000000001/uploads', {})).status).toBe(501);
  });
  it('preserves namespace uniqueness between instances and explicit deterministic replay', () => {
    const a = new WaEngine({ seed: 'test' }),
      b = new WaEngine({ seed: 'test' });
    expect(a.id('wamid')).not.toBe(b.id('wamid'));
    const c = new WaEngine({ seed: 'test', namespace: 'stable' }),
      d = new WaEngine({ seed: 'test', namespace: 'stable' });
    expect(c.id('wamid')).toBe(d.id('wamid'));
    expect(() => new WaEngine({ graphToken: 'EAAsynthetic' })).toThrow();
  });
});
