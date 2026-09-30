import { describe, expect, it } from 'vitest';
import fixture from '../../../fixtures/templates/utility.json';
import { harness, phoneId, wabaId, userId } from '../../flows/tests/harness.ts';

describe('message templates', () => {
  it('creates, reviews, renders, edits and deletes with real engine wire', async () => {
    const h = harness();
    const created = await h.graph('POST', `${wabaId}/message_templates`, fixture);
    expect(created).toMatchObject({
      status: 200,
      body: { status: 'PENDING', category: 'UTILITY' },
    });
    const id = created.body.id;
    expect(id).toMatch(/^\d+$/);
    const send = {
      messaging_product: 'whatsapp',
      to: userId,
      type: 'template',
      template: {
        name: fixture.name,
        language: { code: 'en_US' },
        components: [
          { type: 'header', parameters: [{ type: 'text', text: 'SYN-007' }] },
          {
            type: 'body',
            parameters: [
              { type: 'text', text: 'Ana' },
              {
                type: 'currency',
                currency: { fallback_value: '$15.00', code: 'USD', amount_1000: 15000 },
              },
            ],
          },
          {
            type: 'button',
            sub_type: 'quick_reply',
            index: '0',
            parameters: [{ type: 'payload', payload: 'confirm-synthetic' }],
          },
          {
            type: 'button',
            sub_type: 'url',
            index: '1',
            parameters: [{ type: 'text', text: 'SYN-007' }],
          },
        ],
      },
    };
    expect((await h.graph('POST', `${phoneId}/messages`, send)).body.error.code).toBe(132001);
    expect((await h.sim('POST', `templates/${id}/review`, { status: 'APPROVED' })).status).toBe(
      200,
    );
    expect(h.engine.store.webhooks.at(-1)?.field).toBe('message_template_status_update');
    expect((await h.graph('POST', `${phoneId}/messages`, send)).status).toBe(200);
    const message = h.engine.store.messages.at(-1)!;
    expect(message.render).toMatchObject({
      header: { text: 'Order SYN-007' },
      body: { text: 'Hello Ana, your synthetic order costs $15.00.' },
      footer: 'Synthetic data only',
    });
    expect(message.render.buttons[1].url).toBe('http://127.0.0.1/order/SYN-007');
    const tap = await h.sim('POST', `users/${userId}/tap`, {
      message_id: message.id,
      button_id: '0',
    });
    expect(tap.body.payload.button.payload).toBe('confirm-synthetic');
    expect((await h.sim('POST', `templates/${id}/review`, { status: 'PAUSED' })).status).toBe(200);
    expect((await h.graph('POST', `${phoneId}/messages`, send)).body.error.code).toBe(132001);
    await h.sim('POST', `templates/${id}/review`, { status: 'APPROVED' });
    expect((await h.graph('POST', id, { category: 'MARKETING' })).status).toBe(200);
    expect(h.engine.store.templates[id].status).toBe('PENDING');
    expect(h.engine.store.webhooks.at(-1)?.field).toBe('template_category_update');
    expect(
      (await h.graph('DELETE', `${wabaId}/message_templates?name=${fixture.name}`)).body.success,
    ).toBe(true);
    expect(h.engine.store.templates[id]).toBeUndefined();
  });
  it('validates placeholders, examples, boundaries, categories and unsupported components', async () => {
    const invalid = [
      { ...fixture, name: 'Upper' },
      { ...fixture, category: 'OTHER' },
      { ...fixture, language: 'en-us' },
      { ...fixture, parameter_format: 'BAD' },
      { ...fixture, components: [] },
      {
        ...fixture,
        components: [{ type: 'BODY', text: 'Hi {{2}}', example: { body_text: [['Ana']] } }],
      },
      { ...fixture, components: [{ type: 'BODY', text: 'Hi {{1}}' }] },
      {
        ...fixture,
        components: [
          { type: 'BODY', text: 'Hi {{1}}', example: { body_text: [['Ana', 'Extra']] } },
        ],
      },
      {
        ...fixture,
        components: [
          { type: 'HEADER', format: 'TEXT', text: 'x'.repeat(61) },
          { type: 'BODY', text: 'Hi' },
        ],
      },
      { ...fixture, components: [{ type: 'BODY', text: 'x'.repeat(1025) }] },
      {
        ...fixture,
        components: [
          { type: 'BODY', text: 'Hi' },
          { type: 'FOOTER', text: 'x'.repeat(61) },
        ],
      },
      {
        ...fixture,
        components: [
          { type: 'BODY', text: 'Hi' },
          { type: 'FOOTER', text: '{{1}}' },
        ],
      },
      {
        ...fixture,
        components: [
          { type: 'BODY', text: 'Hi' },
          { type: 'BODY', text: 'again' },
        ],
      },
      {
        ...fixture,
        components: [
          { type: 'BODY', text: 'Hi' },
          {
            type: 'BUTTONS',
            buttons: [
              {
                type: 'URL',
                text: 'Open',
                url: 'https://example.test/{{1}}/suffix',
                example: ['sample'],
              },
            ],
          },
        ],
      },
      {
        ...fixture,
        components: [
          { type: 'BODY', text: 'Hi' },
          { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'x'.repeat(26) }] },
        ],
      },
      {
        ...fixture,
        components: [
          { type: 'HEADER', format: 'IMAGE' },
          { type: 'BODY', text: 'Hi' },
        ],
      },
    ];
    for (const payload of invalid)
      expect((await harness().graph('POST', `${wabaId}/message_templates`, payload)).status).toBe(
        400,
      );
    const unsupported = await harness().graph('POST', `${wabaId}/message_templates`, {
      ...fixture,
      components: [{ type: 'CAROUSEL' }],
    });
    expect(unsupported.status).toBe(501);
    const boundary = await harness().graph('POST', `${wabaId}/message_templates`, {
      ...fixture,
      components: [{ type: 'BODY', text: '😀'.repeat(1024) }],
    });
    expect(boundary.status).toBe(200);
  });
  it('returns distinct outbound errors 132000/132012 and renders named parameters by name', async () => {
    const h = harness(),
      created = await h.graph('POST', `${wabaId}/message_templates`, {
        name: 'named_demo',
        language: 'en_US',
        category: 'UTILITY',
        parameter_format: 'NAMED',
        components: [
          {
            type: 'BODY',
            text: 'Hello {{name}}, value {{amount}}',
            example: {
              body_text_named_params: [
                { param_name: 'name', example: 'Ana' },
                { param_name: 'amount', example: '10' },
              ],
            },
          },
        ],
      });
    await h.sim('POST', `templates/${created.body.id}/review`, { status: 'APPROVED' });
    const send = (params: any[]) =>
      h.graph('POST', `${phoneId}/messages`, {
        messaging_product: 'whatsapp',
        to: userId,
        type: 'template',
        template: {
          name: 'named_demo',
          language: { code: 'en_US' },
          components: [{ type: 'body', parameters: params }],
        },
      });
    expect(
      (await send([{ type: 'text', parameter_name: 'name', text: 'Ana' }])).body.error.code,
    ).toBe(132000);
    expect(
      (
        await send([
          { type: 'image', parameter_name: 'name', image: { id: 'bad' } },
          { type: 'text', parameter_name: 'amount', text: '10' },
        ])
      ).body.error.code,
    ).toBe(132012);
    expect(
      (
        await send([
          { type: 'text', parameter_name: 'amount', text: '10' },
          { type: 'text', parameter_name: 'name', text: 'Ana' },
        ])
      ).status,
    ).toBe(200);
    expect(h.engine.store.messages.at(-1)!.render.body.text).toBe('Hello Ana, value 10');
    expect(
      (
        await send([
          { type: 'text', parameter_name: 'name', text: 'A' },
          { type: 'text', parameter_name: 'name', text: 'B' },
        ])
      ).body.error.code,
    ).toBe(132000);
  });
  it('rejects duplicate name-language, paginates and restricts review transitions', async () => {
    const h = harness();
    const first = await h.graph('POST', `${wabaId}/message_templates`, { ...fixture, name: 'one' });
    expect(
      (await h.graph('POST', `${wabaId}/message_templates`, { ...fixture, name: 'one' })).body.error
        .error_subcode,
    ).toBe(2388024);
    const second = await h.graph('POST', `${wabaId}/message_templates`, {
      ...fixture,
      name: 'two',
    });
    const page = await h.graph('GET', `${wabaId}/message_templates?limit=1`);
    expect(page.body.data[0].id).toBe(first.body.id);
    expect(page.body.paging.next).toContain('after=');
    const next = await h.request(
      'GET',
      new URL(page.body.paging.next).pathname + new URL(page.body.paging.next).search,
    );
    expect(next.body.data[0].id).toBe(second.body.id);
    expect(
      (await h.sim('POST', `templates/${first.body.id}/review`, { status: 'DISABLED' })).status,
    ).toBe(400);
    await h.sim('POST', `templates/${first.body.id}/review`, {
      status: 'REJECTED',
      reason: 'SYNTHETIC_REVIEW',
    });
    expect(
      (await h.sim('POST', `templates/${first.body.id}/review`, { status: 'APPROVED' })).status,
    ).toBe(400);
  });
  it('renders authentication OTP and prevents sending after disable', async () => {
    const h = harness();
    const created = await h.graph('POST', `${wabaId}/message_templates`, {
      name: 'auth_demo',
      language: 'en_US',
      category: 'AUTHENTICATION',
      components: [
        { type: 'BODY', add_security_recommendation: true },
        { type: 'FOOTER', code_expiration_minutes: 5 },
        { type: 'BUTTONS', buttons: [{ type: 'OTP', otp_type: 'COPY_CODE', text: 'Copy code' }] },
      ],
    });
    expect(created.status).toBe(200);
    await h.sim('POST', `templates/${created.body.id}/review`, { status: 'APPROVED' });
    const send = {
      messaging_product: 'whatsapp',
      to: userId,
      type: 'template',
      template: {
        name: 'auth_demo',
        language: { code: 'en_US' },
        components: [
          { type: 'body', parameters: [{ type: 'text', text: '123456' }] },
          {
            type: 'button',
            sub_type: 'url',
            index: '0',
            parameters: [{ type: 'text', text: '123456' }],
          },
        ],
      },
    };
    expect((await h.graph('POST', `${phoneId}/messages`, send)).status).toBe(200);
    expect(h.engine.store.messages.at(-1)!.render.body.text).toContain(
      '123456 is your verification code',
    );
    expect(h.engine.store.messages.at(-1)!.render.buttons[0].code).toBe('123456');
    await h.sim('POST', `templates/${created.body.id}/review`, { status: 'DISABLED' });
    expect((await h.graph('POST', `${phoneId}/messages`, send)).body.error.code).toBe(132001);
  });
  it('checks media ownership/type and renders named text headers', async () => {
    const h = harness();
    const created = await h.graph('POST', `${wabaId}/message_templates`, {
      name: 'named_header',
      language: 'en_US',
      category: 'UTILITY',
      parameter_format: 'NAMED',
      components: [
        {
          type: 'HEADER',
          format: 'TEXT',
          text: 'Order {{order}}',
          example: { header_text_named_params: [{ param_name: 'order', example: 'SYN-001' }] },
        },
        { type: 'BODY', text: 'Synthetic receipt' },
      ],
    });
    await h.sim('POST', `templates/${created.body.id}/review`, { status: 'APPROVED' });
    const send = {
      messaging_product: 'whatsapp',
      to: userId,
      type: 'template',
      template: {
        name: 'named_header',
        language: { code: 'en_US' },
        components: [
          {
            type: 'header',
            parameters: [{ type: 'text', parameter_name: 'order', text: 'SYN-002' }],
          },
        ],
      },
    };
    expect((await h.graph('POST', `${phoneId}/messages`, send)).status).toBe(200);
    expect(h.engine.store.messages.at(-1)!.render.header.text).toBe('Order SYN-002');
    const media = await h.graph('POST', `${wabaId}/message_templates`, {
      name: 'media_header',
      language: 'en_US',
      category: 'UTILITY',
      components: [
        {
          type: 'HEADER',
          format: 'IMAGE',
          example: { header_handle: ['synthetic-upload-handle'] },
        },
        { type: 'BODY', text: 'Synthetic image' },
      ],
    });
    await h.sim('POST', `templates/${media.body.id}/review`, { status: 'APPROVED' });
    h.engine.store.media['synthetic_media'] = {
      id: 'synthetic_media',
      mime_type: 'image/png',
      phone_number_id: '100000000999',
    };
    const image = {
      ...send,
      template: {
        name: 'media_header',
        language: { code: 'en_US' },
        components: [
          { type: 'header', parameters: [{ type: 'image', image: { id: 'synthetic_media' } }] },
        ],
      },
    };
    expect((await h.graph('POST', `${phoneId}/messages`, image)).body.error.code).toBe(132012);
    h.engine.store.media.synthetic_media.phone_number_id = phoneId;
    expect((await h.graph('POST', `${phoneId}/messages`, image)).status).toBe(200);
    h.engine.store.media.synthetic_media.mime_type = 'video/mp4';
    expect((await h.graph('POST', `${phoneId}/messages`, image)).body.error.code).toBe(132012);
  });
  it('opens a named template Flow button and completes a real local runtime', async () => {
    const h = harness();
    const created = await h.graph('POST', `${wabaId}/flows`, {
      name: 'Synthetic template survey',
      categories: ['SURVEY'],
    });
    const flowId = created.body.id;
    const json = {
      version: '7.3',
      screens: [
        {
          id: 'FORM',
          title: 'Synthetic survey',
          terminal: true,
          success: true,
          data: {},
          layout: {
            type: 'SingleColumnLayout',
            children: [
              { type: 'TextInput', name: 'name', label: 'Synthetic name', required: true },
              {
                type: 'Footer',
                label: 'Finish',
                'on-click-action': { name: 'complete', payload: { name: '${form.name}' } },
              },
            ],
          },
        },
      ],
    };
    await h.graph('POST', `${flowId}/assets`, { flow_json: json });
    expect((await h.graph('POST', `${flowId}/publish`, {})).status).toBe(200);
    const template = await h.graph('POST', `${wabaId}/message_templates`, {
      name: 'flow_invitation',
      language: 'en_US',
      category: 'UTILITY',
      components: [
        { type: 'body', text: 'Complete a synthetic survey' },
        {
          type: 'BUTTONS',
          buttons: [
            {
              type: 'FLOW',
              text: 'Open survey',
              flow_name: 'Synthetic template survey',
              flow_action: 'navigate',
              navigate_screen: 'FORM',
            },
          ],
        },
      ],
    });
    expect(template.status).toBe(200);
    await h.sim('POST', `templates/${template.body.id}/review`, { status: 'APPROVED' });
    const sent = await h.graph('POST', `${phoneId}/messages`, {
      messaging_product: 'whatsapp',
      to: userId,
      type: 'template',
      template: {
        name: 'flow_invitation',
        language: { code: 'en_US' },
        components: [
          {
            type: 'button',
            sub_type: 'flow',
            index: '0',
            parameters: [{ type: 'action', action: { flow_token: 'synthetic-survey' } }],
          },
        ],
      },
    });
    expect(sent.status).toBe(200);
    const opened = await h.sim('POST', `users/${userId}/flows/open`, {
      message_id: sent.body.messages[0].id,
    });
    expect(opened.body.screen).toBe('FORM');
    const complete = await h.sim('POST', `users/${userId}/flows/${opened.body.id}/submit`, {
      data: { name: 'Ana' },
    });
    expect(complete.body.complete).toBe(true);
    expect(complete.body.result.name).toBe('Ana');
    expect(complete.body.nfm_reply.type).toBe('interactive');
    const invalid = await h.graph('POST', `${phoneId}/messages`, {
      messaging_product: 'whatsapp',
      to: userId,
      type: 'template',
      template: {
        name: 'flow_invitation',
        language: { code: 'en_US' },
        components: [
          {
            type: 'button',
            sub_type: 'flow',
            index: '0',
            parameters: [{ type: 'action', action: 'invalid' }],
          },
        ],
      },
    });
    expect(invalid.body.error.code).toBe(132012);
  });
  it('uses the correct WABA for domain status webhooks and rejects inherited resource keys', async () => {
    const h = harness(),
      secondPhone = '100000000002',
      secondWaba = '200000000002';
    h.engine.store.phones[secondPhone] = {
      ...h.engine.store.phones[phoneId],
      id: secondPhone,
      waba_id: secondWaba,
    };
    h.engine.config.tokens = [
      {
        token: 'wa-fake-token',
        scopes: ['whatsapp_business_management', 'whatsapp_business_messaging'],
        phoneIds: [phoneId, secondPhone],
        wabaIds: [wabaId, secondWaba],
      },
    ];
    const template = await h.graph('POST', `${secondWaba}/message_templates`, {
      ...fixture,
      name: 'second_waba',
    });
    expect(template.status).toBe(200);
    expect(
      (await h.sim('POST', `templates/${template.body.id}/review`, { status: 'APPROVED' })).status,
    ).toBe(200);
    expect(h.engine.store.webhooks.at(-1)!.envelope.entry[0].id).toBe(secondWaba);
    const flow = await h.graph('POST', `${secondWaba}/flows`, {
      name: 'Second WABA survey',
      categories: ['SURVEY'],
    });
    await h.graph('POST', `${flow.body.id}/assets`, {
      flow_json: {
        version: '7.3',
        screens: [
          {
            id: 'DONE',
            title: 'Done',
            terminal: true,
            success: true,
            data: {},
            layout: {
              type: 'SingleColumnLayout',
              children: [
                {
                  type: 'Footer',
                  label: 'Finish',
                  'on-click-action': { name: 'complete', payload: {} },
                },
              ],
            },
          },
        ],
      },
    });
    expect((await h.graph('POST', `${flow.body.id}/publish`, {})).status).toBe(200);
    expect(h.engine.store.webhooks.at(-1)!.envelope.entry[0].id).toBe(secondWaba);
    for (const key of ['__proto__', 'constructor', 'toString']) {
      expect((await h.graph('GET', `${key}/whatsapp_business_encryption`)).status).toBe(404);
      expect((await h.sim('POST', `templates/${key}/review`, { status: 'APPROVED' })).status).toBe(
        404,
      );
      expect((await h.sim('POST', `users/${userId}/flows/${key}/fill`, { data: {} })).status).toBe(
        404,
      );
      expect((await h.sim('GET', `flows/${key}/preview`)).status).toBe(404);
    }
  });
});
