import Ajv from 'ajv';
import type { Json } from './contracts.ts';
import { GraphError, unsupported } from './errors.ts';
const str = (max = 4096, min = 1) => ({ type: 'string', minLength: min, maxLength: max });
const obj = (properties: Json, required: string[] = [], extra = false): Json => ({
  type: 'object',
  properties,
  required,
  additionalProperties: extra,
});
const arr = (items: Json, min = 1, max = 10) => ({
  type: 'array',
  items,
  minItems: min,
  maxItems: max,
});
const media = obj({ id: str(), link: str(), caption: str(1024, 0), filename: str(240) }, [], false);
media.oneOf = [
  { required: ['id'], not: { required: ['link'] } },
  { required: ['link'], not: { required: ['id'] } },
];
const location = obj(
  {
    latitude: { type: 'number', minimum: -90, maximum: 90 },
    longitude: { type: 'number', minimum: -180, maximum: 180 },
    name: str(1000),
    address: str(1000),
  },
  ['latitude', 'longitude'],
);
const contact = obj(
  {
    name: obj(
      {
        formatted_name: str(256),
        first_name: str(256),
        last_name: str(256),
        middle_name: str(256),
        suffix: str(256),
        prefix: str(256),
      },
      ['formatted_name'],
    ),
    birthday: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    addresses: arr(
      obj(
        {
          street: str(),
          city: str(),
          state: str(),
          zip: str(),
          country: str(),
          country_code: str(2),
          type: str(32),
        },
        [],
      ),
      1,
      100,
    ),
    emails: arr(obj({ email: str(), type: str(32) }, ['email']), 1, 100),
    org: obj({ company: str(), department: str(), title: str() }),
    phones: arr(obj({ phone: str(), type: str(32), wa_id: str() }, ['phone']), 1, 100),
    urls: arr(obj({ url: str(), type: str(32) }, ['url']), 1, 100),
  },
  ['name'],
);
const body = obj({ text: str(1024) }, ['text']),
  footer = obj({ text: str(60) }, ['text']);
const header = {
  oneOf: [
    obj({ type: { const: 'text' }, text: str(60) }, ['type', 'text']),
    ...['image', 'video', 'document'].map((t) =>
      obj({ type: { const: t }, [t]: media }, ['type', t]),
    ),
  ],
};
const interactive = (type: string, action: Json, requiredAction: string[], allowHeader = true) =>
  obj(
    {
      type: { const: type },
      body,
      footer,
      ...(allowHeader ? { header } : {}),
      action: obj(action, requiredAction),
    },
    ['type', 'body', 'action'],
  );
const button = interactive(
  'button',
  {
    buttons: arr(
      obj(
        { type: { const: 'reply' }, reply: obj({ id: str(256), title: str(20) }, ['id', 'title']) },
        ['type', 'reply'],
      ),
      1,
      3,
    ),
  },
  ['buttons'],
);
const list = interactive(
  'list',
  {
    button: str(20),
    sections: arr(
      obj(
        {
          title: str(24),
          rows: arr(
            obj({ id: str(200), title: str(24), description: str(72) }, ['id', 'title']),
            1,
            10,
          ),
        },
        ['rows'],
      ),
      1,
      10,
    ),
  },
  ['button', 'sections'],
  false,
);
const cta = interactive(
  'cta_url',
  {
    name: { const: 'cta_url' },
    parameters: obj({ display_text: str(20), url: str(2048) }, ['display_text', 'url']),
  },
  ['name', 'parameters'],
);
const flow = interactive(
  'flow',
  {
    name: { const: 'flow' },
    parameters: obj(
      {
        flow_message_version: { const: '3' },
        flow_token: str(),
        flow_id: str(),
        flow_name: str(),
        flow_cta: str(30),
        mode: { enum: ['draft', 'published'] },
        flow_action: { enum: ['navigate', 'data_exchange'] },
        flow_action_payload: obj({
          screen: str(),
          data: { type: 'object', additionalProperties: true },
        }),
      },
      ['flow_message_version', 'flow_cta'],
    ),
  },
  ['name', 'parameters'],
);
(flow.properties.action.properties.parameters as Json).oneOf = [
  { required: ['flow_id'], not: { required: ['flow_name'] } },
  { required: ['flow_name'], not: { required: ['flow_id'] } },
];
const wireProperties: Json = {
  messaging_product: { const: 'whatsapp' },
  recipient_type: { const: 'individual' },
  to: { type: 'string', pattern: '^\\+?\\d{5,20}$' },
  type: {
    enum: [
      'text',
      'image',
      'audio',
      'video',
      'document',
      'sticker',
      'location',
      'contacts',
      'reaction',
      'interactive',
      'template',
    ],
  },
  context: obj({ message_id: str() }, ['message_id']),
  biz_opaque_callback_data: str(512, 0),
  text: obj({ body: str(4096), preview_url: { type: 'boolean' } }, ['body']),
  image: media,
  video: media,
  document: media,
  audio: obj({ id: str(), link: str() }, []),
  sticker: obj({ id: str(), link: str() }, []),
  location,
  contacts: arr(contact, 1, 100),
  reaction: obj({ message_id: str(), emoji: str(32, 0) }, ['message_id', 'emoji']),
  interactive: { oneOf: [button, list, cta, flow] },
  template: obj(
    {
      name: str(512),
      language: obj({ code: str(20), policy: { const: 'deterministic' } }, ['code']),
      components: { type: 'array', items: { type: 'object', additionalProperties: true } },
    },
    ['name', 'language'],
  ),
};
wireProperties.audio.oneOf = media.oneOf;
wireProperties.sticker.oneOf = media.oneOf;
export const messageSchema: Json = {
  ...obj(wireProperties, ['messaging_product', 'to', 'type']),
  allOf: Object.keys(wireProperties)
    .filter((t) =>
      [
        'text',
        'image',
        'audio',
        'video',
        'document',
        'sticker',
        'location',
        'contacts',
        'reaction',
        'interactive',
        'template',
      ].includes(t),
    )
    .map((t) => ({
      if: { properties: { type: { const: t } }, required: ['type'] },
      then: {
        required: [t],
        not: {
          anyOf: Object.keys(wireProperties)
            .filter(
              (k) =>
                [
                  'text',
                  'image',
                  'audio',
                  'video',
                  'document',
                  'sticker',
                  'location',
                  'contacts',
                  'reaction',
                  'interactive',
                  'template',
                ].includes(k) && k !== t,
            )
            .map((k) => ({ required: [k] })),
        },
      },
    })),
};
export const readSchema = obj(
  {
    messaging_product: { const: 'whatsapp' },
    status: { const: 'read' },
    message_id: str(),
    typing_indicator: obj({ type: { const: 'text' } }, ['type']),
  },
  ['messaging_product', 'status', 'message_id'],
);
export const inboundReplySchema = obj(
  {
    type: { enum: ['button', 'interactive'] },
    context: obj({ message_id: str() }, ['message_id']),
    button: obj({ text: str(256), payload: str(256) }, ['text', 'payload']),
    interactive: {
      oneOf: [
        obj(
          {
            type: { const: 'button_reply' },
            button_reply: obj({ id: str(256), title: str(20) }, ['id', 'title']),
          },
          ['type', 'button_reply'],
        ),
        obj(
          {
            type: { const: 'list_reply' },
            list_reply: obj({ id: str(200), title: str(24), description: str(72) }, [
              'id',
              'title',
            ]),
          },
          ['type', 'list_reply'],
        ),
        obj(
          {
            type: { const: 'nfm_reply' },
            nfm_reply: obj({ response_json: str(100000), name: str(100), body: str(1024) }, [
              'response_json',
              'name',
              'body',
            ]),
          },
          ['type', 'nfm_reply'],
        ),
      ],
    },
  },
  ['type'],
);
inboundReplySchema.oneOf = [
  {
    properties: { type: { const: 'button' } },
    required: ['button'],
    not: { required: ['interactive'] },
  },
  {
    properties: { type: { const: 'interactive' } },
    required: ['interactive'],
    not: { required: ['button'] },
  },
];
const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(messageSchema),
  validateRead = ajv.compile(readSchema);
const validateReply = ajv.compile(inboundReplySchema);
export function validateInboundReply(payload: Json) {
  if (!validateReply(payload))
    throw new GraphError(100, 'Invalid inbound reply: ' + ajv.errorsText(validateReply.errors));
  if (payload.interactive?.type === 'nfm_reply') {
    let response: unknown;
    try {
      response = JSON.parse(payload.interactive.nfm_reply.response_json);
    } catch {
      throw new GraphError(100, 'nfm_reply.response_json must be JSON');
    }
    if (!response || typeof response !== 'object' || Array.isArray(response))
      throw new GraphError(100, 'nfm_reply.response_json must encode an object');
  }
}
export function validateWire(payload: Json): void {
  if (payload.status !== undefined) {
    if (!validateRead(payload))
      throw new GraphError(
        100,
        'Invalid read/typing payload: ' + ajv.errorsText(validateRead.errors),
      );
    return;
  }
  if (!wireProperties.type.enum.includes(payload.type))
    throw unsupported('message type ' + String(payload.type));
  if (
    payload.type === 'interactive' &&
    !['button', 'list', 'flow', 'cta_url'].includes(payload.interactive?.type)
  )
    throw unsupported('interactive ' + String(payload.interactive?.type));
  if (!validate(payload))
    throw new GraphError(100, 'Invalid message payload: ' + ajv.errorsText(validate.errors));
  const interactive = payload.interactive;
  if (interactive?.type === 'button') {
    const ids = interactive.action.buttons.map((b: Json) => b.reply.id);
    if (new Set(ids).size !== ids.length) throw new GraphError(100, 'Button IDs must be unique');
  }
  if (interactive?.type === 'list') {
    const rows = interactive.action.sections.flatMap((s: Json) => s.rows);
    if (rows.length > 10 || new Set(rows.map((r: Json) => r.id)).size !== rows.length)
      throw new GraphError(100, 'List must contain at most 10 rows with unique IDs');
  }
  if (
    payload.type === 'contacts' &&
    payload.contacts.some(
      (c: Json) =>
        !['first_name', 'last_name', 'middle_name', 'suffix', 'prefix'].some((k) => c.name[k]),
    )
  )
    throw new GraphError(100, 'Contact name needs at least one structured name field');
  if (
    payload.type === 'reaction' &&
    payload.reaction.emoji &&
    ([...new Intl.Segmenter().segment(payload.reaction.emoji)].length !== 1 ||
      !/[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u.test(payload.reaction.emoji))
  )
    throw new GraphError(100, 'Reaction must be one emoji or empty to remove');
  if (interactive?.type === 'cta_url') {
    let url: URL;
    try {
      url = new URL(interactive.action.parameters.url);
    } catch {
      throw new GraphError(100, 'CTA URL must be absolute HTTP(S)');
    }
    if (!['http:', 'https:'].includes(url.protocol))
      throw new GraphError(100, 'CTA URL must be HTTP(S)');
  }
}
export function parseDuration(value: string | number): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0)
      throw new GraphError(100, 'Duration must be non-negative');
    return value;
  }
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/.exec(value);
  if (!match) throw new GraphError(100, 'Duration must use ms, s, m, h or d');
  const duration =
    Number(match[1]) * { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 }[match[2]!]!;
  if (!Number.isFinite(duration))
    throw new GraphError(100, 'Duration is outside the supported range');
  return duration;
}
