import { describe, expect, it } from 'vitest';
import { WaEngine, validateWire, GraphError } from '../src/index.ts';
const waId = '5511900000001';
const wire = (type: string, value: any) => ({
  messaging_product: 'whatsapp',
  to: waId,
  type,
  [type]: value,
});
describe('synthetic wire and state rules', () => {
  it('validates and records every supported basic send type and real inbound media/location/contact envelopes', async () => {
    const engine = new WaEngine({ namespace: 'fixtures' });
    engine.user(waId);
    await engine.receiveMessage(waId, { type: 'text', text: { body: 'Open' } });
    const media = [
      ['image', 'image/png'],
      ['audio', 'audio/ogg'],
      ['video', 'video/mp4'],
      ['document', 'application/pdf'],
      ['sticker', 'image/webp'],
    ];
    for (const [type, mime] of media) {
      const asset = engine.uploadMedia(Buffer.from('synthetic ' + type), mime!, 'fixture');
      const outbound = await engine.sendMessage(wire(type!, { id: asset.id }));
      expect(outbound.messages[0].id).toMatch(/^wamid\./);
      await engine.receiveMessage(waId, { type, [type!]: { id: asset.id } });
      const inbound = engine.store.webhooks.at(-1)!.envelope.entry[0].changes[0].value.messages[0];
      expect(inbound[type!].mime_type).toBe(mime);
      expect(inbound[type!].sha256).toBe(asset.sha256);
    }
    const location = {
      latitude: -15.8,
      longitude: -47.9,
      name: 'Synthetic location',
      address: 'Local',
    };
    const contacts = [
      {
        name: { formatted_name: 'Synthetic Person', first_name: 'Synthetic' },
        phones: [{ phone: '+5511900000002', wa_id: '5511900000002', type: 'CELL' }],
      },
    ];
    for (const [type, value] of [
      ['location', location],
      ['contacts', contacts],
    ] as const) {
      await engine.sendMessage(wire(type, value));
      await engine.receiveMessage(waId, { type, [type]: value });
      expect(
        engine.store.webhooks.at(-1)!.envelope.entry[0].changes[0].value.messages[0][type],
      ).toEqual(value);
    }
    await engine.sendMessage(
      wire('interactive', {
        type: 'cta_url',
        body: { text: 'Local instructions' },
        action: {
          name: 'cta_url',
          parameters: { display_text: 'Open', url: 'http://localhost:58991/' },
        },
      }),
    );
    const target = engine.store.messages.find((m) => m.direction === 'outbound')!;
    await engine.receiveMessage(waId, {
      type: 'reaction',
      reaction: { message_id: target.id, emoji: '🇧🇷' },
    });
    await engine.receiveMessage(waId, {
      type: 'text',
      text: { body: 'Quoted reply' },
      context: { message_id: target.id },
    });
    expect(
      engine.store.webhooks.at(-1)!.envelope.entry[0].changes[0].value.messages[0].context,
    ).toEqual({ id: target.id, from: '15550000001' });
  });
  it('rejects invalid coordinate ranges, duplicate/overlong choices, mixed payloads, links and unsupported capabilities', async () => {
    expect(() => validateWire(wire('location', { latitude: 91, longitude: 0 }))).toThrow(
      GraphError,
    );
    expect(() => validateWire({ ...wire('text', { body: 'x' }), image: { id: 'x' } })).toThrow(
      GraphError,
    );
    expect(() => validateWire(wire('text', { body: 'x'.repeat(4097) }))).toThrow(GraphError);
    expect(() =>
      validateWire(wire('contacts', [{ name: { formatted_name: 'Missing structured name' } }])),
    ).toThrow(GraphError);
    expect(() =>
      validateWire(
        wire('interactive', {
          type: 'button',
          body: { text: 'choose' },
          action: {
            buttons: [
              { type: 'reply', reply: { id: 'x', title: 'One' } },
              { type: 'reply', reply: { id: 'x', title: 'Two' } },
            ],
          },
        }),
      ),
    ).toThrow(GraphError);
    expect(() =>
      validateWire(
        wire('interactive', {
          type: 'list',
          body: { text: 'choose' },
          action: {
            button: 'Open',
            sections: [
              { rows: Array.from({ length: 10 }, (_, i) => ({ id: String(i), title: 'Row' })) },
              { rows: [{ id: 'other', title: 'Row' }] },
            ],
          },
        }),
      ),
    ).toThrow(GraphError);
    expect(() =>
      validateWire(
        wire('interactive', {
          type: 'cta_url',
          body: { text: 'x' },
          action: {
            name: 'cta_url',
            parameters: { display_text: 'X', url: 'javascript:alert(1)' },
          },
        }),
      ),
    ).toThrow(GraphError);
    expect(() =>
      validateWire(wire('interactive', { type: 'product', action: { catalog_id: 'synthetic' } })),
    ).toThrowError(expect.objectContaining({ status: 501 }));
    const engine = new WaEngine();
    engine.user(waId);
    await engine.receiveMessage(waId, { type: 'text', text: { body: 'Open' } });
    await expect(
      engine.sendMessage(wire('image', { link: 'https://example.com/media' })),
    ).rejects.toMatchObject({ code: 100 });
    await expect(
      engine.sendMessage(wire('image', { link: 'http://localhost:58991/media' })),
    ).rejects.toMatchObject({ status: 501 });
    await expect(
      engine.receiveMessage(waId, { type: 'system', system: { body: 'synthetic' } }),
    ).rejects.toMatchObject({ status: 501 });
    await expect(
      engine.receiveMessage(waId, {
        type: 'interactive',
        interactive: {
          type: 'nfm_reply',
          nfm_reply: { name: 'flow', body: 'Sent', response_json: 'broken' },
        },
      }),
    ).rejects.toMatchObject({ code: 100 });
    expect(() =>
      engine.addFault({ match: { unsupported: 'x' }, error: { code: 100 } }),
    ).toThrowError(expect.objectContaining({ status: 501 }));
  });
  it('refuses unresolved flow capability and validates required Flow wire fields', async () => {
    const payload = wire('interactive', {
      type: 'flow',
      body: { text: 'Synthetic flow' },
      action: {
        name: 'flow',
        parameters: {
          flow_message_version: '3',
          flow_id: 'flow.synthetic',
          flow_cta: 'Open',
          flow_token: 'local-session',
          flow_action: 'navigate',
          flow_action_payload: { screen: 'START', data: { synthetic: true } },
        },
      },
    });
    expect(() => validateWire(payload)).not.toThrow();
    const engine = new WaEngine();
    engine.user(waId);
    await engine.receiveMessage(waId, { type: 'text', text: { body: 'Open' } });
    await expect(engine.sendMessage(payload)).rejects.toMatchObject({ status: 501 });
    payload.interactive.action.parameters.flow_name = 'duplicate locator';
    expect(() => validateWire(payload)).toThrow();
  });
  it('preserves monotonic ids on reset and rejects external Flow endpoints in snapshots', async () => {
    const engine = new WaEngine({
      namespace: 'stable',
      graphToken: 'custom-graph-secret',
      appSecret: 'custom-hmac-secret',
    });
    const id = engine.id('wamid');
    engine.reset();
    expect(engine.id('wamid')).not.toBe(id);
    engine.log('http', { path: '/v23.0/custom-graph-secret', status: 501 });
    expect(JSON.stringify(engine.store.logs)).not.toContain('custom-graph-secret');
    const snapshot = engine.snapshot();
    snapshot.store.flows.external = { id: 'external', endpoint_uri: 'http://example.com' };
    await expect(engine.restore(snapshot)).rejects.toThrow();
    expect(engine.config.graphToken).toBe('custom-graph-secret');
  });
});
