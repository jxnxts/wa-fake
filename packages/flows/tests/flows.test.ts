import { describe, expect, it } from 'vitest';
import fixture from '../../../fixtures/flows/data-exchange.json';
import { harness, endpoint, phoneId, wabaId, userId } from './harness.ts';
import { createEncryptedEndpoint } from '../src/endpoint.ts';
import type { Json } from '../../core/src/index.ts';

function normal(request: Json): Json {
  if (request.data?.error) return { version: request.version, data: { acknowledged: true } };
  if (request.action === 'ping') return { version: request.version, data: { status: 'active' } };
  if (request.action === 'INIT' || request.action === 'BACK')
    return { version: request.version, screen: 'FORM', data: {} };
  if (request.screen === 'FORM')
    return {
      version: request.version,
      screen: 'REVIEW',
      data: {
        name: request.data.name,
        summary: `Synthetic ${request.data.name} / ${request.data.plan}`,
      },
    };
  return {
    version: request.version,
    screen: 'SUCCESS',
    data: {
      extension_message_response: {
        params: {
          flow_token: request.flow_token,
          status: 'synthetic_complete',
          name: request.data.name,
        },
      },
    },
  };
}
async function setup(handler: (request: Json) => Json | Promise<Json> = normal) {
  const h = harness(),
    e = await endpoint(handler);
  const key = await h.graph('POST', `${phoneId}/whatsapp_business_encryption`, {
    business_public_key: e.publicKey,
  });
  expect(key.status).toBe(200);
  const created = await h.graph('POST', `${wabaId}/flows`, {
    name: 'Synthetic onboarding',
    categories: ['SIGN_UP'],
    endpoint_uri: e.url,
  });
  expect(created.status).toBe(200);
  const id = created.body.id;
  expect(id).toMatch(/^\d+$/);
  const asset = await h.graph('POST', `${id}/assets`, {
    name: 'flow.json',
    asset_type: 'FLOW_JSON',
    flow_json: fixture,
  });
  expect(asset.body.validation_errors).toEqual([]);
  expect((await h.graph('POST', `${id}/publish`, {})).body.success).toBe(true);
  await h.engine.receiveMessage(userId, { type: 'text', text: { body: 'Synthetic start' } });
  const send = await h.graph('POST', `${phoneId}/messages`, {
    messaging_product: 'whatsapp',
    to: userId,
    type: 'interactive',
    interactive: {
      type: 'flow',
      body: { text: 'Synthetic demo' },
      action: {
        name: 'flow',
        parameters: {
          flow_message_version: '3',
          flow_id: id,
          flow_action: 'data_exchange',
          flow_token: 'synthetic-token',
          flow_cta: 'Open',
        },
      },
    },
  });
  expect(send.status).toBe(200);
  return { ...h, e, id, messageId: send.body.messages[0].id };
}
describe('Flows management and encrypted runtime', () => {
  it('validates multipart assets, lifecycle, preview and immutable published flows', async () => {
    const h = harness();
    const created = await h.graph('POST', `${wabaId}/flows`, {
      name: 'Static survey',
      categories: ['SURVEY'],
    });
    const id = created.body.id;
    const flow = {
      version: '7.3',
      screens: [
        {
          id: 'FINISH',
          title: 'Synthetic survey',
          terminal: true,
          success: true,
          data: {},
          layout: {
            type: 'SingleColumnLayout',
            children: [
              { type: 'TextBody', text: 'Only synthetic data' },
              {
                type: 'Footer',
                label: 'Finish',
                'on-click-action': { name: 'complete', payload: { status: 'synthetic_done' } },
              },
            ],
          },
        },
      ],
    };
    const form = new FormData();
    form.set('name', 'flow.json');
    form.set('asset_type', 'FLOW_JSON');
    form.set('file', new Blob([JSON.stringify(flow)], { type: 'application/json' }), 'flow.json');
    const asset = await h.graph('POST', `${id}/assets`, form);
    expect(asset.status).toBe(200);
    expect(asset.body).toEqual({ success: true, validation_errors: [] });
    const assets = await h.graph('GET', `${id}/assets`);
    expect(assets.body.data[0]).toMatchObject({ name: 'flow.json', asset_type: 'FLOW_JSON' });
    const download = new URL(assets.body.data[0].download_url);
    expect((await h.request('GET', download.pathname + download.search)).body).toEqual(flow);
    expect((await h.sim('GET', `flows/${id}/preview`)).body).toEqual(flow);
    expect((await h.graph('GET', `${id}?fields=id,preview`)).body.preview.preview_url).toContain(
      `/?flow=${id}`,
    );
    expect((await h.graph('POST', `${id}/publish`, {})).body.success).toBe(true);
    expect((await h.graph('POST', id, { name: 'Changed' })).status).toBe(400);
    expect((await h.graph('POST', `${id}/assets`, { flow_json: flow })).status).toBe(400);
    expect((await h.graph('DELETE', id)).status).toBe(400);
    expect((await h.graph('POST', `${id}/deprecate`, {})).body.success).toBe(true);
    expect(h.engine.store.flows[id].status).toBe('DEPRECATED');
    const copied = await h.graph('POST', `${wabaId}/flows`, {
      name: 'Copy',
      categories: ['OTHER'],
      clone_flow_id: id,
    });
    expect(h.engine.store.flows[copied.body.id].status).toBe('DRAFT');
    expect(h.engine.store.flows[copied.body.id].json).toEqual(flow);
    expect((await h.graph('DELETE', copied.body.id)).body.success).toBe(true);
    expect((await h.graph('POST', `${wabaId}/migrate_flows`, {})).status).toBe(501);
    expect((await h.graph('GET', `${id}?fields=metric`)).status).toBe(501);
  });
  it('rejects invalid schemas/cycles and explicitly fails unsupported components', async () => {
    const h = harness(),
      created = await h.graph('POST', `${wabaId}/flows`, {
        name: 'Bad schema',
        categories: ['OTHER'],
      });
    const id = created.body.id,
      invalid = structuredClone(fixture);
    invalid.routing_model.REVIEW = ['FORM'] as never;
    const response = await h.graph('POST', `${id}/assets`, { flow_json: invalid });
    expect(response.body.success).toBe(false);
    expect(
      response.body.validation_errors.some(
        (error: Json) => error.error === 'INVALID_ROUTING_MODEL',
      ),
    ).toBe(true);
    expect(response.body.validation_errors[0].pointers[0].path).toBeTruthy();
    expect((await h.graph('POST', `${id}/publish`, {})).status).toBe(400);
    const unsupported = structuredClone(fixture) as Json;
    unsupported.screens[0].layout.children[0].children.unshift({
      type: 'DocumentPicker',
      name: 'file',
      label: 'File',
    });
    expect((await h.graph('POST', `${id}/assets`, { flow_json: unsupported })).status).toBe(501);
    expect((await h.graph('POST', `${id}/publish`, {})).status).toBe(501);
    const external = { ...fixture, data_channel_uri: 'https://example.test/flow' };
    expect((await h.graph('POST', `${id}/assets`, { flow_json: external })).status).toBe(400);
    expect(
      (
        await h.graph('POST', `${wabaId}/flows`, {
          name: 'External',
          categories: ['OTHER'],
          endpoint_uri: 'http://example.test/flow',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await h.graph('POST', `${phoneId}/whatsapp_business_encryption`, {
          business_public_key: 'not a key',
        })
      ).status,
    ).toBe(400);
  });
  it('performs real RSA/OAEP/AES-GCM INIT, validation, exchange, BACK, SUCCESS and signed nfm_reply', async () => {
    const h = await setup();
    try {
      expect(h.e.received[0].action).toBe('ping');
      const key = await h.graph('GET', `${phoneId}/whatsapp_business_encryption`);
      expect(key.body.data[0].business_public_key_signature_status).toBe('VALID');
      h.engine.config.webhookUrl = h.e.url.replace('/flow', '/webhook');
      const opened = await h.sim('POST', `users/${userId}/flows/open`, { message_id: h.messageId });
      expect(opened.status).toBe(200);
      expect(opened.body.screen).toBe('FORM');
      expect(opened.body.renderedScreen.children.some((field: Json) => field.name === 'name')).toBe(
        true,
      );
      expect(opened.body.flow).toEqual(fixture);
      expect(JSON.stringify(opened.body)).not.toContain('synthetic-token');
      const id = opened.body.id;
      const empty = await h.sim('POST', `users/${userId}/flows/${id}/submit`, {});
      expect(empty.body.errors.name).toBe('This field is required');
      expect(empty.body.complete).toBe(false);
      expect(h.e.received.filter((request) => request.action === 'data_exchange')).toHaveLength(0);
      const bad = await h.sim('POST', `users/${userId}/flows/${id}/submit`, {
        data: { name: 'A', plan: 'invalid', confirm: true },
      });
      expect(bad.body.errors.name).toContain('at least 2');
      expect(bad.body.errors.plan).toBe('Choose an available option');
      const reviewed = await h.sim('POST', `users/${userId}/flows/${id}/submit`, {
        data: { name: 'Ana', plan: 'basic', confirm: true },
      });
      expect(reviewed.status).toBe(200);
      expect(reviewed.body.screen).toBe('REVIEW');
      expect(reviewed.body.data.summary).toBe('Synthetic Ana / basic');
      const back = await h.sim('POST', `users/${userId}/flows/${id}/back`, {});
      expect(back.status).toBe(200);
      expect(back.body.screen).toBe('FORM');
      expect(back.body.values.name).toBe('Ana');
      expect(h.e.received.at(-1)?.action).toBe('BACK');
      await h.sim('POST', `users/${userId}/flows/${id}/submit`, {});
      const completed = await h.sim('POST', `users/${userId}/flows/${id}/submit`, {});
      expect(completed.status).toBe(200);
      expect(completed.body.complete).toBe(true);
      expect(completed.body.result.status).toBe('synthetic_complete');
      expect(completed.body.nfm_reply.payload.interactive.type).toBe('nfm_reply');
      expect(
        JSON.parse(completed.body.nfm_reply.payload.interactive.nfm_reply.response_json),
      ).toEqual({ flow_token: 'synthetic-token', status: 'synthetic_complete', name: 'Ana' });
      await h.engine.drain({ advance: true });
      expect(
        h.e.webhooks.some(
          (body) => body.entry[0].changes[0].value.messages?.[0]?.interactive?.type === 'nfm_reply',
        ),
      ).toBe(true);
      const count = h.engine.store.messages.length;
      expect((await h.sim('POST', `users/${userId}/flows/${id}/submit`, {})).status).toBe(400);
      expect(h.engine.store.messages).toHaveLength(count);
      expect(h.e.signatures.every((signature) => /^sha256=[0-9a-f]{64}$/.test(signature))).toBe(
        true,
      );
      expect(JSON.stringify(h.engine.store.logs)).not.toContain('synthetic-token');
      expect(JSON.stringify(h.engine.store.logs)).not.toContain('Synthetic Ana / basic');
    } finally {
      await h.e.close();
    }
  });
  it('restores a session from a snapshot and preserves field values and terminal result', async () => {
    const h = await setup();
    try {
      const opened = await h.sim('POST', `users/${userId}/flows/open`, { message_id: h.messageId });
      const id = opened.body.id;
      const fill = await h.sim('POST', `users/${userId}/flows/${id}/fill`, {
        data: { name: 'Ana', plan: 'pro', confirm: true },
      });
      expect(fill.body.values.name).toBe('Ana');
      const snapshot = h.engine.snapshot();
      await h.engine.restore(snapshot);
      const submit = await h.sim('POST', `users/${userId}/flows/${id}/submit`, {});
      expect(submit.body.screen).toBe('REVIEW');
      expect((await h.sim('POST', `users/${userId}/flows/${id}/submit`, {})).body.complete).toBe(
        true,
      );
    } finally {
      await h.e.close();
    }
  });
  it('accepts versionless health and screen responses used by the official Node examples', async () => {
    const h = await setup((request) => {
      const reply = normal(request);
      delete reply.version;
      return reply;
    });
    try {
      const opened = await h.sim('POST', `users/${userId}/flows/open`, { message_id: h.messageId });
      expect(opened.status).toBe(200);
      expect(opened.body.screen).toBe('FORM');
      expect(
        (
          await h.sim('POST', `users/${userId}/flows/${opened.body.id}/submit`, {
            data: { name: 'Ana', plan: 'basic', confirm: true },
          })
        ).body.screen,
      ).toBe('REVIEW');
      expect(
        (await h.sim('POST', `users/${userId}/flows/${opened.body.id}/submit`, {})).body.complete,
      ).toBe(true);
    } finally {
      await h.e.close();
    }
  });
  it('retries 421 with new crypto, closes on 427 and rejects 432', async () => {
    let rejects = 0,
      rotate = () => {};
    const h = await setup((request) => {
      if (request.action === 'INIT' && rejects++ === 0) {
        rotate();
        return { httpStatus: 421 };
      }
      return normal(request);
    });
    rotate = () => {
      h.e.rotate();
      h.engine.store.phones[phoneId].public_key = h.e.publicKey;
    };
    try {
      const opened = await h.sim('POST', `users/${userId}/flows/open`, { message_id: h.messageId });
      expect({ status: opened.status, error: opened.body.error }).toEqual({
        status: 200,
        error: undefined,
      });
      expect(h.e.received.filter((request) => request.action === 'INIT')).toHaveLength(2);
      expect(h.e.signatures.at(-1)).not.toBe(h.e.signatures.at(-2));
    } finally {
      await h.e.close();
    }
    for (const status of [427, 432]) {
      const h = await setup((request) =>
        request.action === 'INIT' ? { httpStatus: status } : normal(request),
      );
      try {
        const response = await h.sim('POST', `users/${userId}/flows/open`, {
          message_id: h.messageId,
        });
        expect(response.body.error.code).toBe(status);
        if (status === 427) expect(Object.values(h.engine.store.sessions)[0].closed).toBe(true);
      } finally {
        await h.e.close();
      }
    }
  });
  it('refuses unavailable endpoints at publish and checks response version/data/SUCCESS token', async () => {
    const h = harness();
    const e = await endpoint(() => ({ version: '3.0', data: { status: 'inactive' } }));
    try {
      await h.graph('POST', `${phoneId}/whatsapp_business_encryption`, {
        business_public_key: e.publicKey,
      });
      const create = await h.graph('POST', `${wabaId}/flows`, {
        name: 'Unhealthy',
        categories: ['OTHER'],
        endpoint_uri: e.url,
      });
      await h.graph('POST', `${create.body.id}/assets`, { flow_json: fixture });
      expect((await h.graph('POST', `${create.body.id}/publish`, {})).body.error.code).toBe(139002);
      expect(h.engine.store.flows[create.body.id].status).toBe('DRAFT');
      expect(h.engine.store.webhooks.at(-1)?.envelope.entry[0].changes[0].value.event).toBe(
        'ENDPOINT_ERROR',
      );
    } finally {
      await e.close();
    }
    for (const bad of [
      { version: '2.0', screen: 'FORM', data: {} },
      { version: '3.0', screen: 'REVIEW', data: { name: 1 } },
      {
        version: '3.0',
        screen: 'SUCCESS',
        data: { extension_message_response: { params: { flow_token: 'wrong' } } },
      },
    ]) {
      const h = await setup((request) => (request.action === 'INIT' ? bad : normal(request)));
      try {
        expect(
          (await h.sim('POST', `users/${userId}/flows/open`, { message_id: h.messageId })).status,
        ).toBe(502);
        expect(h.e.received.at(-1)?.data?.error).toBe('invalid_response');
      } finally {
        await h.e.close();
      }
    }
  });
  it('enforces the real ten-second endpoint deadline', async () => {
    const h = harness(),
      e = await endpoint(async () => {
        await new Promise((resolve) => setTimeout(resolve, 11_000));
        return { version: '3.0', data: { status: 'active' } };
      });
    try {
      h.engine.store.phones[phoneId].public_key = e.publicKey;
      const transport = createEncryptedEndpoint(
        h.engine,
        { id: 'synthetic_timeout', endpoint_uri: e.url },
        phoneId,
      );
      const started = performance.now();
      await expect(
        transport.exchange({
          version: '3.0',
          action: 'ping',
          data: {},
          flow_token: 'synthetic-timeout',
        }),
      ).rejects.toMatchObject({ kind: 'timeout', status: 504 });
      expect(performance.now() - started).toBeGreaterThanOrEqual(9900);
      expect(performance.now() - started).toBeLessThan(10_800);
    } finally {
      await e.close();
    }
  }, 15_000);
});
