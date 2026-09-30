import { createServer, type Server } from 'node:http';
import { createHmac, generateKeyPairSync } from 'node:crypto';
import { WaEngine, type Json } from '../../core/src/index.ts';
import { createApp } from '../../server/src/index.ts';
import { createFlows } from '../src/index.ts';
import { createTemplates } from '../../templates/src/index.ts';

export const phoneId = '100000000001',
  wabaId = '200000000001',
  userId = '5511900000001';
export function harness() {
  const engine = new WaEngine({ autoDrain: false, seed: 'domain-tests', namespace: 'fixture' });
  engine.extensions = [createTemplates(engine), createFlows(engine)];
  engine.user(userId, { name: 'Synthetic Ana' });
  const app = createApp(engine);
  async function request(method: string, path: string, body?: Json | FormData) {
    const form = body instanceof FormData;
    const response = await app.request(`http://127.0.0.1${path}`, {
      method,
      headers: {
        authorization: `Bearer ${path.startsWith('/_wa/') ? 'wa-fake-sim' : 'wa-fake-token'}`,
        ...(body && !form ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? (form ? body : JSON.stringify(body)) : undefined,
    });
    return { status: response.status, body: (await response.json()) as Json };
  }
  return {
    engine,
    request,
    graph: (method: string, path: string, body?: Json | FormData) =>
      request(method, `/v23.0/${path}`, body),
    sim: (method: string, path: string, body?: Json) => request(method, `/_wa/${path}`, body),
  };
}

/** This server deliberately uses Meta's unmodified MIT reference implementation, not flowso crypto. */
export async function endpoint(
  handler: (
    request: Json,
  ) => Promise<Json | { httpStatus: number }> | Json | { httpStatus: number },
) {
  const moduleUrl = new URL('../../../fixtures/flows/meta-encryption.mjs', import.meta.url).href;
  const meta = await import(moduleUrl);
  const newKeys = () =>
    generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
  let keys = newKeys();
  const received: Json[] = [];
  const webhooks: Json[] = [];
  const signatures: string[] = [];
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks);
      const expected = `sha256=${createHmac('sha256', 'wa-fake-secret').update(raw).digest('hex')}`;
      if (req.headers['x-hub-signature-256'] !== expected) {
        res.writeHead(432).end();
        return;
      }
      signatures.push(expected);
      const body = JSON.parse(raw.toString());
      if (req.url === '/webhook') {
        webhooks.push(body);
        res.writeHead(200).end('ok');
        return;
      }
      if (Buffer.from(body.initial_vector, 'base64').length !== 16)
        throw new Error('IV is not 16 bytes');
      const { decryptedBody, aesKeyBuffer, initialVectorBuffer } = meta.decryptRequest(
        body,
        keys.privateKey,
      );
      if (aesKeyBuffer.length !== 16) throw new Error('AES key is not 128 bits');
      received.push(decryptedBody);
      const response = await handler(decryptedBody);
      if ('httpStatus' in response) {
        res.writeHead(response.httpStatus as number).end();
        return;
      }
      res
        .writeHead(200, { 'content-type': 'text/plain' })
        .end(meta.encryptResponse(response, aesKeyBuffer, initialVectorBuffer));
    } catch {
      res.writeHead(500).end('Synthetic endpoint failure');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${address.port}/flow`,
    get publicKey() {
      return keys.publicKey;
    },
    rotate() {
      keys = newKeys();
    },
    received,
    webhooks,
    signatures,
    server,
    close: () => close(server),
  };
}
export async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
