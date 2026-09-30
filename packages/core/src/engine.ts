import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { EngineHost, GraphExtension, Json, EngineStore as SharedStore } from './contracts.ts';
import { GraphError, unsupported } from './errors.ts';
import { assertLocalUrl, localFetch } from './network.ts';
import { mediaRecord, mimeMatches } from './media.ts';
import { redactEvidence } from './redact.ts';
import { parseDuration, validateWire, validateInboundReply } from './validation.ts';
import { retryDelay, signWebhook, webhookEnvelope } from '../../webhooks/src/index.ts';
export interface WaStore extends SharedStore {
  users: Record<string, Json>;
  phones: Record<string, Json>;
  media: Record<string, Json>;
  templates: Record<string, Json>;
  flows: Record<string, Json>;
  sessions: Record<string, Json>;
  messages: Json[];
  webhooks: Json[];
  logs: Json[];
  faults: Json[];
  windows: Record<string, number>;
  subscriptions: Record<string, Json>;
  [key: string]: any;
}
export interface EngineOptions extends Json {
  graphToken?: string;
  simToken?: string;
  appSecret?: string;
  webhookUrl?: string;
  verifyToken?: string;
  phoneNumberId?: string;
  wabaId?: string;
  appId?: string;
  seed?: string | number;
  namespace?: string;
  now?: number;
  autoDrain?: boolean;
}
export class WaEngine implements EngineHost {
  store!: WaStore;
  config: Json;
  extensions: GraphExtension[] = [];
  private time: number;
  private initialTime: number;
  private counter = 0;
  private namespace: string;
  private listeners = new Set<(event: { type: string; data: unknown }) => void>();
  private draining = false;
  constructor(options: EngineOptions = {}) {
    for (const token of [options.graphToken, options.simToken])
      if (token?.startsWith('EAA'))
        throw new GraphError(190, 'Production-looking EAA tokens are refused', 401);
    this.initialTime = options.now ?? Date.UTC(2026, 8, 29);
    this.time = this.initialTime;
    if (!Number.isFinite(this.initialTime) || this.initialTime < 0)
      throw new GraphError(100, 'Initial clock must be a non-negative millisecond timestamp');
    this.namespace = options.namespace ?? randomUUID().slice(0, 8);
    this.config = {
      graphToken: 'wa-fake-token',
      simToken: 'wa-fake-sim',
      appSecret: 'wa-fake-secret',
      verifyToken: 'wa-fake-verify',
      phoneNumberId: '100000000001',
      wabaId: '200000000001',
      appId: '300000000001',
      autoDrain: true,
      statusDelays: [0, 1000, 2000],
      maxWebhookAttempts: 20,
      rateLimitPerSecond: 80,
      ...options,
    };
    this.reset();
  }
  now() {
    return this.time;
  }
  id(prefix: string) {
    return `${prefix}.${this.namespace}.${String(this.config.seed ?? 'local').replace(/[^a-zA-Z0-9_-]/g, '_')}.${(++this.counter).toString(36)}`;
  }
  graphError(code: number, message: string, status = 400, subcode?: number) {
    return new GraphError(code, message, status, subcode);
  }
  assertLocalUrl(url: string) {
    return assertLocalUrl(url);
  }
  onEvent(listener: (event: { type: string; data: unknown }) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(type: string, data: unknown) {
    for (const listener of this.listeners) {
      try {
        listener({ type, data });
      } catch {}
    }
  }
  log(action: string, data: Json = {}) {
    const safe = redactEvidence(data),
      secrets = [
        this.config.graphToken,
        this.config.simToken,
        this.config.appSecret,
        this.config.verifyToken,
        ...(this.config.tokens ?? []).map((t: Json) => t.token),
      ].filter((value: unknown) => typeof value === 'string' && value.length > 0);
    for (const [key, value] of Object.entries(safe))
      if (typeof value === 'string')
        safe[key] = secrets.reduce(
          (text: string, secret: string) => text.split(secret).join('[REDACTED]'),
          value,
        );
    const knownActions = ['http', 'send', 'receive', 'fault', 'webhook_attempt', 'webhook_config'];
    const entry = {
      id: `log.${this.namespace}.${this.store.logs.length + 1}`,
      at: this.now(),
      action: knownActions.includes(action) ? action : 'event',
      ...safe,
    };
    this.store.logs.push(entry);
    this.emit('log', entry);
    return entry;
  }
  state(): Json {
    return structuredClone({
      now: this.now(),
      users: Object.values(this.store.users),
      phones: Object.values(this.store.phones),
      messages: this.store.messages,
      templates: Object.values(this.store.templates),
      flows: Object.values(this.store.flows),
      sessions: Object.values(this.store.sessions),
      media: Object.values(this.store.media).map(({ data, ...m }) => m),
      webhooks: this.store.webhooks,
      logs: this.store.logs,
    });
  }
  reset() {
    if (this.draining)
      throw new GraphError(100, 'Drain is in progress; reset after delivery completes', 409);
    this.time = this.initialTime;
    this.store = {
      wabas: { [this.config.wabaId]: { id: this.config.wabaId, name: 'Synthetic WABA' } },
      users: {},
      phones: {
        [this.config.phoneNumberId]: {
          id: this.config.phoneNumberId,
          waba_id: this.config.wabaId,
          display_phone_number: '+15550000001',
          verified_name: 'Synthetic business',
          registered: true,
          quality_rating: 'GREEN',
          code_verification_status: 'VERIFIED',
          name_status: 'APPROVED',
          messaging_limit_tier: 'TIER_1K',
          profile: {
            about: 'Synthetic local simulator',
            address: 'Local only',
            description: 'wa-fake',
            email: 'synthetic@example.test',
            websites: [],
            vertical: 'OTHER',
          },
        },
      },
      media: {},
      templates: {},
      flows: {},
      sessions: {},
      messages: [],
      webhooks: [],
      logs: [],
      faults: [],
      windows: {},
      subscriptions: {},
    };
    this.emit('reset', { now: this.now() });
  }
  snapshot(): Json {
    return {
      format: 'wa-fake/v1',
      now: this.time,
      counter: this.counter,
      namespace: this.namespace,
      seed: this.config.seed ?? 'local',
      store: structuredClone(this.store),
    };
  }
  async restore(snapshot: Json) {
    if (this.draining)
      throw new GraphError(100, 'Drain is in progress; restore after delivery completes', 409);
    if (
      snapshot?.format !== 'wa-fake/v1' ||
      !Number.isFinite(snapshot.now) ||
      !Number.isInteger(snapshot.counter) ||
      snapshot.counter < 0 ||
      typeof snapshot.namespace !== 'string' ||
      !snapshot.store
    )
      throw new GraphError(100, 'Invalid wa-fake snapshot');
    const s = snapshot.store;
    for (const key of [
      'users',
      'phones',
      'media',
      'templates',
      'flows',
      'sessions',
      'windows',
      'subscriptions',
    ])
      if (!s[key] || typeof s[key] !== 'object' || Array.isArray(s[key]))
        throw new GraphError(100, 'Invalid snapshot collection ' + key);
    for (const key of ['messages', 'webhooks', 'logs', 'faults'])
      if (!Array.isArray(s[key])) throw new GraphError(100, 'Invalid snapshot collection ' + key);
    for (const sub of Object.values(s.subscriptions) as Json[])
      if (sub.callback_url) await this.assertLocalUrl(sub.callback_url);
    for (const flow of Object.values(s.flows) as Json[])
      for (const endpoint of [flow.endpoint_uri, flow.json?.data_channel_uri])
        if (endpoint) await this.assertLocalUrl(endpoint);
    this.store = structuredClone(s);
    this.time = snapshot.now;
    this.counter = snapshot.counter;
    this.namespace = snapshot.namespace;
    this.config.seed = snapshot.seed;
    const logs = this.store.logs;
    this.store.logs = [];
    for (const log of logs) {
      const restored = this.log(log.action, log);
      if (Number.isFinite(log.at)) restored.at = log.at;
    }
    this.emit('restore', { now: this.time });
    return this.state();
  }
  async advance(duration: string | number) {
    const next = this.time + parseDuration(duration);
    if (!Number.isFinite(next)) throw new GraphError(100, 'Clock overflow');
    this.time = next;
    for (const phone of Object.values(this.store.phones))
      if (phone.typing_until <= this.time) delete phone.typing_until;
    this.emit('clock', { now: this.time });
    await this.drain();
    return { now: this.time };
  }
  auth(
    token: string | undefined,
    plane: 'graph' | 'sim',
    phoneId?: string,
    scope = 'whatsapp_business_messaging',
  ) {
    if (!token || token.startsWith('EAA'))
      throw new GraphError(
        190,
        token?.startsWith('EAA')
          ? 'Production-looking EAA tokens are refused'
          : 'Invalid OAuth access token',
        401,
      );
    if (plane === 'sim') {
      if (token !== this.config.simToken)
        throw new GraphError(190, 'Invalid Sim access token', 401);
      return;
    }
    const tokens: Json[] = this.config.tokens ?? [
      {
        token: this.config.graphToken,
        scopes: ['whatsapp_business_messaging', 'whatsapp_business_management'],
        phoneIds: Object.keys(this.store.phones),
        wabaIds: [this.config.wabaId],
      },
    ];
    const entry = tokens.find((t) => t.token === token);
    if (!entry) throw new GraphError(190, 'Invalid OAuth access token', 401);
    if (!(entry.scopes ?? []).includes(scope))
      throw new GraphError(200, 'Token lacks required permission', 403);
    if (phoneId && entry.phoneIds && !entry.phoneIds.includes(phoneId))
      throw new GraphError(200, 'Token lacks access to this phone number', 403);
    return entry;
  }
  phone(id = this.config.phoneNumberId): Json {
    const phone = this.store.phones[id];
    if (!phone) throw new GraphError(100, 'Unknown phone_number_id', 404, 33);
    return phone;
  }
  user(waId: string, options: Json = {}): Json {
    waId = waId.replace(/^\+/, '');
    if (!/^\d{5,20}$/.test(waId)) throw new GraphError(100, 'wa_id must contain 5–20 digits');
    const previous = this.store.users[waId];
    const value: Json = {
      ...(previous ?? {
        wa_id: waId,
        name: 'Synthetic user',
        exists: true,
        blocked: false,
        marketing_opt_out: false,
      }),
      ...Object.fromEntries(
        Object.entries(options).filter(([k]) =>
          ['name', 'exists', 'blocked', 'marketing_opt_out'].includes(k),
        ),
      ),
      wa_id: waId,
    };
    if (
      typeof value.name !== 'string' ||
      ['exists', 'blocked', 'marketing_opt_out'].some((k) => typeof value[k] !== 'boolean')
    )
      throw new GraphError(100, 'Invalid persona fields');
    this.store.users[waId] = value;
    this.emit('user', value);
    return value;
  }
  addFault(rule: Json) {
    if (
      !rule ||
      !Number.isInteger(rule.times ?? 1) ||
      (rule.times ?? 1) < 1 ||
      !rule.error ||
      !Number.isInteger(rule.error.code)
    )
      throw new GraphError(100, 'Fault requires positive times and error.code');
    const unknown = Object.keys(rule).filter(
      (k) => !['match', 'times', 'error', 'phase'].includes(k),
    );
    if (unknown.length) throw unsupported('fault options ' + unknown.join(','));
    if (
      rule.match &&
      (!rule.match ||
        typeof rule.match !== 'object' ||
        Array.isArray(rule.match) ||
        Object.keys(rule.match).some((k) => !['path', 'to', 'type'].includes(k)))
    )
      throw unsupported('fault matcher');
    if (rule.phase && !['graph', 'status', 'webhook'].includes(rule.phase))
      throw unsupported('fault phase');
    if (Object.keys(rule.error).some((k) => !['code', 'status', 'error_subcode'].includes(k)))
      throw unsupported('fault error option');
    if (
      rule.error.status !== undefined &&
      (!Number.isInteger(rule.error.status) || rule.error.status < 400 || rule.error.status > 599)
    )
      throw new GraphError(100, 'Fault HTTP status must be 400–599');
    const fault = {
      id: this.id('fault'),
      match: rule.match ?? {},
      times: rule.times ?? 1,
      error: rule.error,
      phase: rule.phase ?? 'graph',
    };
    this.store.faults.push(fault);
    return fault;
  }
  consumeFault(path: string, to?: string, type?: string, phase = 'graph'): Json | undefined {
    const fault = this.store.faults.find(
      (f) =>
        f.times > 0 &&
        f.phase === phase &&
        Object.entries(f.match).every(([key, value]) =>
          key === 'path' ? path.includes(String(value)) : ({ to, type } as Json)[key] === value,
        ),
    );
    if (fault) {
      fault.times--;
      this.log('fault', { path, code: fault.error.code });
    }
    return fault;
  }
  async configure(config: Json) {
    const allowed = [
      'webhook_url',
      'webhookUrl',
      'verify_token',
      'verifyToken',
      'app_secret',
      'appSecret',
    ];
    if (Object.keys(config).some((k) => !allowed.includes(k)))
      throw new GraphError(100, 'Unknown config property');
    const url = config.webhook_url ?? config.webhookUrl;
    const verify = config.verify_token ?? config.verifyToken ?? this.config.verifyToken;
    const secret = config.app_secret ?? config.appSecret ?? this.config.appSecret;
    if (typeof verify !== 'string' || typeof secret !== 'string' || !secret)
      throw new GraphError(100, 'Invalid synthetic webhook credentials');
    if (url) {
      await this.assertLocalUrl(url);
      const target = new URL(url);
      target.searchParams.set('hub.mode', 'subscribe');
      target.searchParams.set('hub.verify_token', verify);
      const challenge = this.id('challenge');
      target.searchParams.set('hub.challenge', challenge);
      let response: Response;
      try {
        response = await localFetch(target.toString());
      } catch {
        throw new GraphError(100, 'Webhook verification request failed');
      }
      if (response.status !== 200 || (await response.text()) !== challenge)
        throw new GraphError(100, 'Webhook verification challenge failed');
    }
    this.config.webhookUrl = url ?? this.config.webhookUrl;
    this.config.verifyToken = verify;
    this.config.appSecret = secret;
    this.log('webhook_config', { status: 200 });
    return { success: true };
  }
  async enqueueWebhook(field: string, value: Json, phoneId = this.config.phoneNumberId) {
    return this.queueWebhook(field, value, phoneId, this.now());
  }
  private async queueWebhook(
    field: string,
    value: Json,
    phoneId: string,
    at: number,
    effect?: Json,
  ) {
    const phone = this.phone(phoneId);
    const envelope = webhookEnvelope(phone.waba_id, phone, field, value);
    const record = {
      id: this.id('webhook'),
      field,
      phone_number_id: phoneId,
      envelope,
      raw: JSON.stringify(envelope),
      created_at: this.now(),
      due_at: at,
      status: 'pending',
      attempts: [] as Json[],
      effect,
      applied: false,
    };
    this.store.webhooks.push(record);
    this.emit('webhook', record);
    if (this.config.autoDrain) await this.drain();
    return record;
  }
  async drain(options: { advance?: boolean; limit?: number } = {}) {
    if (
      (options.advance !== undefined && typeof options.advance !== 'boolean') ||
      (options.limit !== undefined &&
        (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 1000))
    )
      throw new GraphError(100, 'Invalid drain options');
    if (this.draining)
      return {
        delivered: 0,
        pending: this.store.webhooks.filter((w) => w.status === 'pending' || w.status === 'retry')
          .length,
      };
    this.draining = true;
    let delivered = 0,
      processed = 0;
    const limit = options.limit ?? 1000;
    try {
      while (processed < limit) {
        const next = this.store.webhooks
          .filter((w) => ['pending', 'retry'].includes(w.status))
          .sort((a, b) => a.due_at - b.due_at)
          .find((w) => w.due_at <= this.now() || options.advance);
        if (!next) break;
        if (next.due_at > this.now()) this.time = next.due_at;
        if (!next.applied && next.effect) {
          const message = this.store.messages.find((m) => m.id === next.effect.message_id);
          if (message) {
            message.status = next.effect.status;
            this.emit('status', { message_id: message.id, status: message.status });
          }
          next.applied = true;
        }
        const phone = this.phone(next.phone_number_id),
          sub = this.store.subscriptions[phone.waba_id];
        const url = sub?.callback_url ?? this.config.webhookUrl;
        if (!url) {
          next.status = 'unconfigured';
          this.emit('webhook', next);
          processed++;
          continue;
        }
        let status = 0;
        let error: string | undefined;
        const fault = this.consumeFault('/webhooks', undefined, 'webhook', 'webhook');
        try {
          if (fault) status = fault.error.status ?? 500;
          else {
            const response = await localFetch(url, {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                'x-hub-signature-256': signWebhook(next.raw, this.config.appSecret),
              },
              body: next.raw,
            });
            status = response.status;
            await response.body?.cancel();
          }
        } catch {
          error = 'loopback_delivery_failed';
        }
        next.attempts.push({ at: this.now(), status, ...(error ? { error } : {}) });
        processed++;
        if (status >= 200 && status < 300) {
          next.status = 'delivered';
          delivered++;
        } else if (
          next.attempts.length >= this.config.maxWebhookAttempts ||
          this.now() - next.created_at >= 7 * 86400000
        ) {
          next.status = 'dead';
        } else {
          next.status = 'retry';
          next.due_at = this.now() + retryDelay(next.attempts.length);
        }
        this.log('webhook_attempt', {
          webhook_id: next.id,
          status,
          attempt: next.attempts.length,
          next_at: next.due_at,
        });
        this.emit('webhook', next);
      }
    } finally {
      this.draining = false;
    }
    return {
      delivered,
      processed,
      pending: this.store.webhooks.filter((w) => ['pending', 'retry'].includes(w.status)).length,
    };
  }
  async redeliver(id: string) {
    const record = this.store.webhooks.find((w) => w.id === id);
    if (!record) throw new GraphError(100, 'Unknown webhook', 404);
    record.status = 'pending';
    record.due_at = this.now();
    return this.drain();
  }
  private validateContext(payload: Json, phoneId: string, waId: string) {
    const ref = payload.context?.message_id ?? payload.reaction?.message_id;
    if (
      ref &&
      !this.store.messages.some(
        (m) => m.id === ref && m.phone_number_id === phoneId && (m.from === waId || m.to === waId),
      )
    )
      throw new GraphError(100, 'Referenced message does not belong to this conversation');
  }
  async validateMedia(payload: Json, phoneId: string) {
    for (const type of ['image', 'audio', 'video', 'document', 'sticker'])
      if (payload.type === type || payload.interactive?.header?.type === type) {
        const media = payload.type === type ? payload[type] : payload.interactive.header[type];
        if (media.link) {
          await this.assertLocalUrl(media.link);
          throw unsupported('send media by link; upload synthetic media first');
        }
        const record = this.store.media[media.id];
        if (!record || record.phone_number_id !== phoneId || !mimeMatches(type, record.mime_type))
          throw new GraphError(131053, 'Unknown media or MIME incompatible with message type');
      }
  }
  async sendMessage(
    payload: Json,
    phoneId = this.config.phoneNumberId,
    path = `/v23.0/${phoneId}/messages`,
  ): Promise<Json> {
    const phone = this.phone(phoneId);
    validateWire(payload);
    if (!phone.registered) throw new GraphError(133010, 'Phone number is not registered');
    if (payload.status === 'read') {
      const inbound = this.store.messages.find(
        (m) =>
          m.id === payload.message_id && m.direction === 'inbound' && m.phone_number_id === phoneId,
      );
      if (!inbound) throw new GraphError(100, 'Unknown inbound message_id');
      inbound.status = 'read';
      if (payload.typing_indicator) phone.typing_until = this.now() + 25000;
      this.emit('status', {
        message_id: inbound.id,
        status: 'read',
        typing_until: phone.typing_until,
      });
      return { success: true };
    }
    const waId = payload.to.replace(/^\+/, '');
    const user = this.store.users[waId];
    const fault = this.consumeFault(path, waId, payload.type);
    if (fault)
      throw new GraphError(
        fault.error.code,
        'Injected synthetic Graph failure',
        fault.error.status ?? 400,
        fault.error.error_subcode,
      );
    if (!user || !user.exists || user.blocked)
      throw new GraphError(131026, 'Message undeliverable to this synthetic user');
    const window = this.store.windows[`${phoneId}:${waId}`];
    if (payload.type !== 'template' && (window === undefined || this.now() - window >= 86400000))
      throw new GraphError(
        131047,
        'Re-engagement message requires an approved template outside the 24-hour window',
      );
    if (
      this.store.messages.filter(
        (m) =>
          m.direction === 'outbound' &&
          m.phone_number_id === phoneId &&
          this.now() - m.created_at < 1000,
      ).length >= this.config.rateLimitPerSecond
    )
      throw new GraphError(130429, 'Synthetic throughput limit reached', 429);
    if (
      this.config.pairRateLimitMs &&
      this.store.messages.some(
        (m) =>
          m.direction === 'outbound' &&
          m.to === waId &&
          m.phone_number_id === phoneId &&
          this.now() - m.created_at < this.config.pairRateLimitMs,
      )
    )
      throw new GraphError(131056, 'Synthetic pair rate limit reached', 429);
    this.validateContext(payload, phoneId, waId);
    await this.validateMedia(payload, phoneId);
    let render: Json | undefined;
    for (const extension of this.extensions) {
      const result = await extension.validateMessage?.(payload, phone);
      if (result !== undefined) render = result;
    }
    if ((payload.type === 'template' || payload.interactive?.type === 'flow') && !render)
      throw unsupported(payload.type === 'template' ? 'templates extension' : 'flows extension');
    if (payload.type === 'template' && user.marketing_opt_out && render?.category === 'MARKETING')
      throw new GraphError(131049, 'Synthetic user opted out of marketing');
    const id = this.id('wamid'),
      message = {
        id,
        direction: 'outbound',
        from: phoneId,
        to: waId,
        phone_number_id: phoneId,
        type: payload.type,
        timestamp: String(Math.floor(this.now() / 1000)),
        created_at: this.now(),
        status: 'accepted',
        payload: structuredClone(payload),
        ...(render ? { render } : {}),
      };
    this.store.messages.push(message);
    this.emit('message', message);
    this.log('send', { message_id: id, type: payload.type, status: 200 });
    const statusFault = this.consumeFault(path, waId, payload.type, 'status');
    const statuses = statusFault ? ['failed'] : ['sent', 'delivered', 'read'];
    const category =
      payload.type === 'template' ? (render?.category?.toLowerCase() ?? 'utility') : 'service';
    const conversation = {
      id: this.id('conversation'),
      origin: { type: category },
      expiration_timestamp: String(Math.floor(((window ?? this.now()) + 86400000) / 1000)),
    };
    for (let i = 0; i < statuses.length; i++) {
      const status = statuses[i]!,
        at = this.now() + Number(this.config.statusDelays[i] ?? 0);
      await this.queueWebhook(
        'messages',
        {
          statuses: [
            {
              id,
              status,
              timestamp: String(Math.floor(at / 1000)),
              recipient_id: waId,
              conversation,
              pricing: {
                billable: payload.type === 'template',
                pricing_model: 'PMP',
                category,
                type: payload.type === 'template' ? 'regular' : 'free_customer_service',
              },
              ...(payload.biz_opaque_callback_data
                ? { biz_opaque_callback_data: payload.biz_opaque_callback_data }
                : {}),
              ...(statusFault
                ? {
                    errors: [
                      {
                        code: statusFault.error.code,
                        title: 'Injected synthetic delivery failure',
                        message: 'Injected synthetic delivery failure',
                      },
                    ],
                  }
                : {}),
            },
          ],
        },
        phoneId,
        at,
        { message_id: id, status },
      );
    }
    return {
      messaging_product: 'whatsapp',
      contacts: [{ input: payload.to, wa_id: waId }],
      messages: [{ id }],
    };
  }
  async receiveMessage(
    waId: string,
    payload: Json,
    phoneId = this.config.phoneNumberId,
  ): Promise<Json> {
    waId = waId.replace(/^\+/, '');
    const user = this.store.users[waId];
    if (!user) throw new GraphError(100, 'Create synthetic user before receiving', 404);
    const phone = this.phone(phoneId);
    if (!user.exists || user.blocked) throw new GraphError(131026, 'Synthetic user cannot send');
    const wire = structuredClone(payload);
    delete wire.phone_number_id;
    delete wire.messaging_product;
    delete wire.to;
    if (['button', 'interactive'].includes(wire.type)) {
      if (
        wire.type === 'interactive' &&
        !['button_reply', 'list_reply', 'nfm_reply'].includes(wire.interactive?.type)
      )
        throw unsupported('inbound interactive type');
      validateInboundReply(wire);
    } else {
      if (wire.type === 'template' || wire.status !== undefined)
        throw unsupported('inbound ' + (wire.type ?? 'read status'));
      validateWire({ ...wire, messaging_product: 'whatsapp', to: waId });
      await this.validateMedia(wire, phoneId);
    }
    this.validateContext(wire, phoneId, waId);
    const id = this.id('wamid'),
      timestamp = String(Math.floor(this.now() / 1000));
    const message = {
      id,
      direction: 'inbound',
      from: waId,
      to: phoneId,
      phone_number_id: phoneId,
      type: wire.type,
      timestamp,
      created_at: this.now(),
      status: 'sent',
      payload: wire,
    };
    this.store.messages.push(message);
    this.store.windows[`${phoneId}:${waId}`] = this.now();
    this.emit('message', message);
    this.log('receive', { message_id: id, type: wire.type, status: 200 });
    const envelopeWire = structuredClone(wire);
    if (envelopeWire.context) {
      const referenced = this.store.messages.find((m) => m.id === envelopeWire.context.message_id)!;
      envelopeWire.context = {
        from:
          referenced.direction === 'outbound'
            ? phone.display_phone_number.replace(/\D/g, '')
            : waId,
        id: referenced.id,
      };
    }
    if (['image', 'audio', 'video', 'document', 'sticker'].includes(wire.type)) {
      const media = this.store.media[wire[wire.type].id]!;
      envelopeWire[wire.type] = {
        ...wire[wire.type],
        mime_type: media.mime_type,
        sha256: media.sha256,
        ...(wire.type === 'document' ? { filename: wire.document.filename ?? media.filename } : {}),
      };
    }
    await this.enqueueWebhook(
      'messages',
      {
        contacts: [{ profile: { name: user.name }, wa_id: waId }],
        messages: [{ from: waId, id, timestamp, ...envelopeWire }],
      },
      phone.id,
    );
    return message;
  }
  async tap(waId: string, messageId: string, buttonId: string) {
    const message = this.store.messages.find(
      (m) => m.id === messageId && m.direction === 'outbound' && m.to === waId,
    );
    if (!message) throw new GraphError(100, 'Unknown outbound message for this user', 404);
    if (message.payload.interactive?.type === 'button') {
      const button = message.payload.interactive.action.buttons.find(
        (b: Json) => b.reply.id === buttonId || b.reply.title === buttonId,
      );
      if (!button) throw new GraphError(100, 'Unknown reply button');
      return this.receiveMessage(
        waId,
        {
          type: 'interactive',
          interactive: { type: 'button_reply', button_reply: button.reply },
          context: { message_id: messageId },
        },
        message.phone_number_id,
      );
    }
    if (message.type === 'template') {
      const buttons =
        message.render?.buttons ??
        message.render?.components?.find((c: Json) => c.type === 'BUTTONS')?.buttons;
      const button = buttons?.find(
        (b: Json, i: number) => b.id === buttonId || b.text === buttonId || String(i) === buttonId,
      );
      if (!button || !['QUICK_REPLY', 'quick_reply'].includes(button.type))
        throw new GraphError(100, 'Unknown template quick reply');
      return this.receiveMessage(
        waId,
        {
          type: 'button',
          button: { text: button.text, payload: button.payload ?? button.id ?? buttonId },
          context: { message_id: messageId },
        },
        message.phone_number_id,
      );
    }
    throw new GraphError(100, 'Message has no reply buttons');
  }
  async select(waId: string, messageId: string, rowId: string) {
    const message = this.store.messages.find(
      (m) => m.id === messageId && m.direction === 'outbound' && m.to === waId,
    );
    const row = message?.payload.interactive?.action?.sections
      ?.flatMap((s: Json) => s.rows)
      .find((r: Json) => r.id === rowId);
    if (!row) throw new GraphError(100, 'Unknown list row');
    return this.receiveMessage(
      waId,
      {
        type: 'interactive',
        interactive: {
          type: 'list_reply',
          list_reply: {
            id: row.id,
            title: row.title,
            ...(row.description ? { description: row.description } : {}),
          },
        },
        context: { message_id: messageId },
      },
      message!.phone_number_id,
    );
  }
  uploadMedia(
    bytes: Uint8Array,
    mime: string,
    filename: string,
    phoneId = this.config.phoneNumberId,
  ) {
    this.phone(phoneId);
    const record = mediaRecord(this.id('media'), bytes, mime, filename, phoneId, this.now());
    this.store.media[record.id] = record;
    this.emit('media', { id: record.id });
    return record;
  }
  mediaUrl(id: string, baseUrl: string) {
    const media = this.store.media[id];
    if (!media) throw new GraphError(100, 'Unknown media', 404);
    const expires = this.now() + 300000;
    const signature = createHmac('sha256', this.config.appSecret)
      .update(`${id}:${expires}`)
      .digest('hex');
    return {
      url: `${baseUrl}/_wa/media/${encodeURIComponent(id)}?expires=${expires}&signature=${signature}`,
      mime_type: media.mime_type,
      sha256: media.sha256,
      file_size: media.file_size,
      id,
    };
  }
  downloadMedia(id: string, expires: string | null, signature: string | null) {
    const expected = createHmac('sha256', this.config.appSecret)
      .update(`${id}:${expires}`)
      .digest('hex');
    const a = Buffer.from(expected),
      b = Buffer.from(signature ?? '');
    if (
      !expires ||
      !/^\d+$/.test(expires) ||
      Number(expires) <= this.now() ||
      Number(expires) > this.now() + 300000 ||
      a.length !== b.length ||
      !timingSafeEqual(a, b)
    )
      throw new GraphError(190, 'Expired or invalid media download signature', 401);
    const media = this.store.media[id];
    if (!media) throw new GraphError(100, 'Unknown media', 404);
    return media;
  }
}
export const createEngine = (options: EngineOptions = {}) => new WaEngine(options);
