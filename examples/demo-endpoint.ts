import { createServer, type IncomingMessage } from 'node:http';
import {
  constants,
  createCipheriv,
  createDecipheriv,
  createHmac,
  generateKeyPairSync,
  privateDecrypt,
  timingSafeEqual,
} from 'node:crypto';
import { WaFakeClient, type Payload } from '../packages/sdk-js/src/index.ts';

export const demoFlow: Payload = {
  version: '7.3',
  data_api_version: '3.0',
  routing_model: { FORM: ['REVIEW'], REVIEW: [] },
  screens: [
    {
      id: 'FORM',
      title: 'Review demo',
      data: {},
      layout: {
        type: 'SingleColumnLayout',
        children: [
          { type: 'TextHeading', text: 'Everything runs locally' },
          { type: 'TextBody', text: 'Enter synthetic details to test the encrypted Flow.' },
          {
            type: 'Form',
            name: 'form',
            children: [
              { type: 'TextInput', name: 'name', label: 'Fictional name', required: true },
              { type: 'TextInput', name: 'note', label: 'Note', required: false },
              {
                type: 'Footer',
                label: 'Continue',
                'on-click-action': {
                  name: 'data_exchange',
                  payload: { name: '${form.name}', note: '${form.note}' },
                },
              },
            ],
          },
        ],
      },
    },
    {
      id: 'REVIEW',
      title: 'Review details',
      terminal: true,
      success: true,
      data: {
        summary: { type: 'string', __example__: 'Name: Ana (demo)' },
        name: { type: 'string', __example__: 'Ana' },
      },
      layout: {
        type: 'SingleColumnLayout',
        children: [
          { type: 'TextHeading', text: 'Confirm the demo' },
          { type: 'TextBody', text: '${data.summary}' },
          {
            type: 'Footer',
            label: 'Complete',
            'on-click-action': {
              name: 'data_exchange',
              payload: { name: '${data.name}', confirm: true },
            },
          },
        ],
      },
    },
  ],
};

async function rawBody(req: IncomingMessage) {
  const parts: Buffer[] = [];
  for await (const chunk of req) parts.push(Buffer.from(chunk));
  return Buffer.concat(parts);
}

export async function startDemoEndpoint(
  client: WaFakeClient,
  options: { port?: number; appSecret?: string; flowId?: string } = {},
) {
  const secret = options.appSecret ?? 'wa-fake-secret';
  const keys = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const received: Payload[] = [];
  let flowId = options.flowId ?? '';
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/webhook') {
        if (url.searchParams.get('hub.verify_token') !== 'wa-fake-verify') {
          res.writeHead(403).end();
          return;
        }
        res.writeHead(200).end(url.searchParams.get('hub.challenge') ?? '');
        return;
      }
      if (req.method !== 'POST' || !['/webhook', '/flow'].includes(url.pathname)) {
        res.writeHead(404).end();
        return;
      }
      const raw = await rawBody(req);
      const expected = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
      const signature = Buffer.from(String(req.headers['x-hub-signature-256'] ?? ''));
      if (
        signature.length !== expected.length ||
        !timingSafeEqual(signature, Buffer.from(expected))
      ) {
        res.writeHead(url.pathname === '/flow' ? 432 : 401).end();
        return;
      }
      const body: Payload = JSON.parse(raw.toString());
      if (url.pathname === '/flow') {
        const aesKey = privateDecrypt(
          { key: keys.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
          Buffer.from(body.encrypted_aes_key, 'base64'),
        );
        const iv = Buffer.from(body.initial_vector, 'base64');
        const encrypted = Buffer.from(body.encrypted_flow_data, 'base64');
        const decipher = createDecipheriv('aes-128-gcm', aesKey, iv);
        decipher.setAuthTag(encrypted.subarray(-16));
        const request = JSON.parse(
          Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()]).toString(),
        );
        received.push({ kind: 'flow', action: request.action, screen: request.screen });
        let response: Payload;
        if (request.action === 'ping')
          response = { version: request.version ?? '3.0', data: { status: 'active' } };
        else if (request.action === 'INIT' || request.action === 'BACK')
          response = { version: request.version, screen: 'FORM', data: {} };
        else if (request.screen === 'FORM')
          response = {
            version: request.version,
            screen: 'REVIEW',
            data: {
              name: request.data.name,
              summary: `Name: ${request.data.name}\nNote: ${request.data.note ?? ''}\nSynthetic data · no real operation`,
            },
          };
        else if (request.screen === 'REVIEW' && request.data.confirm)
          response = {
            version: request.version,
            screen: 'SUCCESS',
            data: {
              extension_message_response: {
                params: {
                  flow_token: request.flow_token,
                  status: 'completed',
                  name: request.data.name,
                },
              },
            },
          };
        else response = { version: request.version, screen: 'FORM', data: {} };
        const flipped = Buffer.from(iv.map((value) => value ^ 0xff));
        const cipher = createCipheriv('aes-128-gcm', aesKey, flipped);
        const result = Buffer.concat([
          cipher.update(JSON.stringify(response)),
          cipher.final(),
          cipher.getAuthTag(),
        ]);
        res.writeHead(200, { 'Content-Type': 'text/plain' }).end(result.toString('base64'));
        return;
      }
      received.push({ kind: 'webhook', body });
      res.writeHead(200).end('ok');
      // Respond after acknowledging to avoid a callback -> Graph -> status callback deadlock.
      for (const entry of body.entry ?? [])
        for (const change of entry.changes ?? [])
          for (const message of change.value?.messages ?? []) {
            const to = message.from;
            if (message.type === 'text')
              await client.send(to, {
                type: 'interactive',
                interactive: {
                  type: 'button',
                  body: { text: 'Hello! This is the synthetic assistant. Choose a demo.' },
                  action: {
                    buttons: [
                      { type: 'reply', reply: { id: 'review', title: 'Open Flow' } },
                      { type: 'reply', reply: { id: 'menu', title: 'Show options' } },
                    ],
                  },
                },
              });
            else if (message.interactive?.button_reply?.id === 'menu')
              await client.send(to, {
                type: 'interactive',
                interactive: {
                  type: 'list',
                  body: { text: 'What would you like to test?' },
                  action: {
                    button: 'Choose',
                    sections: [
                      {
                        title: 'Demos',
                        rows: [
                          {
                            id: 'flow',
                            title: 'Encrypted Flow',
                            description: 'Two screens with synthetic data',
                          },
                          { id: 'text', title: 'Text message' },
                        ],
                      },
                    ],
                  },
                },
              });
            else if (
              message.interactive?.button_reply?.id === 'review' ||
              message.interactive?.list_reply?.id === 'flow'
            )
              await client.send(to, {
                type: 'interactive',
                interactive: {
                  type: 'flow',
                  body: {
                    text: 'Open the Flow. Exchanges with the local endpoint use RSA and AES-GCM.',
                  },
                  action: {
                    name: 'flow',
                    parameters: {
                      flow_message_version: '3',
                      flow_id: flowId,
                      flow_token: `demo-${message.id}`,
                      flow_cta: 'Review demo',
                      flow_action: 'data_exchange',
                      mode: 'published',
                    },
                  },
                },
              });
            else if (message.interactive?.list_reply?.id === 'text')
              await client.send(to, {
                type: 'text',
                text: {
                  body: 'Text received and answered through a signed webhook. Everything is local.',
                },
              });
            else if (message.interactive?.type === 'nfm_reply')
              await client.send(to, {
                type: 'text',
                text: {
                  body: 'Demo completed! The result arrived as nfm_reply through a signed webhook.',
                },
              });
          }
    } catch (error) {
      if (!res.headersSent) res.writeHead(500).end('Synthetic endpoint error');
      // Deliberately omit raw request, crypto and message contents.
      console.error('Demo request failed:', error instanceof Error ? error.name : 'error');
    }
  });
  await new Promise<void>((resolve) => server.listen(options.port ?? 58992, '127.0.0.1', resolve));
  const address = server.address();
  const url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : options.port}`;
  return {
    url,
    publicKey: keys.publicKey,
    received,
    setFlowId(id: string) {
      flowId = id;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeIdleConnections();
      }),
  };
}

export async function configureDemo(client: WaFakeClient, options: { port?: number } = {}) {
  const endpoint = await startDemoEndpoint(client, options);
  try {
    await client.graph('POST', `${client.phoneId}/whatsapp_business_encryption`, {
      business_public_key: endpoint.publicKey,
    });
    const created = await client.graph('POST', '200000000001/flows', {
      name: `demo_review_${Date.now()}`,
      categories: ['OTHER'],
      endpoint_uri: `${endpoint.url}/flow`,
    });
    const flowId = created.id;
    await client.graph('POST', `${flowId}/assets`, {
      name: 'flow.json',
      asset_type: 'FLOW_JSON',
      flow_json: demoFlow,
    });
    await client.graph('POST', `${flowId}/publish`, {});
    endpoint.setFlowId(flowId);
    await client.configure({
      webhook_url: `${endpoint.url}/webhook`,
      verify_token: 'wa-fake-verify',
      app_secret: 'wa-fake-secret',
    });
    return { endpoint, flowId };
  } catch (error) {
    await endpoint.close();
    throw error;
  }
}
