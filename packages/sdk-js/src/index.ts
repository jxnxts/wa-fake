import http from 'node:http';
import https from 'node:https';
import { readFileSync } from 'node:fs';

export type Payload = Record<string, any>;
export interface ClientOptions {
  url?: string;
  token?: string;
  graphToken?: string;
  phoneId?: string;
  caFile?: string;
  timeout?: number;
}
export class WaFakeError extends Error {
  code: number;
  constructor(
    public status: number,
    public response: Payload,
  ) {
    super(response.error?.message ?? `wa-fake HTTP ${status}`);
    this.code = response.error?.code ?? status;
  }
}

export class WaFakeClient {
  readonly url: string;
  readonly phoneId: string;
  private readonly options: ClientOptions;
  constructor(options: ClientOptions = {}) {
    this.options = options;
    this.url = (options.url ?? 'http://127.0.0.1:58991').replace(/\/$/, '');
    const hostname = new URL(this.url).hostname;
    if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(hostname))
      throw new Error('wa-fake SDK requires a loopback URL');
    this.phoneId = options.phoneId ?? '100000000001';
  }
  async request(method: string, path: string, body?: Payload, graph = false): Promise<any> {
    const url = new URL(this.url + path);
    const data = body === undefined ? undefined : JSON.stringify(body);
    const token = graph
      ? (this.options.graphToken ?? 'wa-fake-token')
      : (this.options.token ?? 'wa-fake-sim');
    return new Promise((resolve, reject) => {
      const transport = url.protocol === 'https:' ? https : http;
      const req = transport.request(
        url,
        {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            ...(data
              ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
              : {}),
          },
          ...(this.options.caFile ? { ca: readFileSync(this.options.caFile) } : {}),
          timeout: this.options.timeout ?? 15000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            let result: any;
            try {
              result = JSON.parse(Buffer.concat(chunks).toString() || '{}');
            } catch {
              reject(new Error('Invalid JSON from wa-fake'));
              return;
            }
            if ((res.statusCode ?? 500) >= 400)
              reject(new WaFakeError(res.statusCode ?? 500, result));
            else resolve(result);
          });
        },
      );
      req.on('timeout', () => req.destroy(new Error('wa-fake request timed out')));
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  }
  user(waId: string, options: { name?: string } = {}) {
    return new VirtualUser(this, waId, options.name);
  }
  state() {
    return this.request('GET', '/_wa/state');
  }
  configure(options: Payload) {
    return this.request('POST', '/_wa/config', options);
  }
  advance(duration: string | number) {
    return this.request('POST', '/_wa/clock', { advance: duration });
  }
  fault(rule: Payload) {
    return this.request('POST', '/_wa/faults', rule);
  }
  drain(options: { advance?: boolean } = {}) {
    return this.request('POST', '/_wa/webhooks/drain', options);
  }
  snapshot() {
    return this.request('POST', '/_wa/snapshot', {});
  }
  restore(snapshot: Payload) {
    return this.request('POST', '/_wa/restore', { snapshot });
  }
  reset() {
    return this.request('POST', '/_wa/reset', {});
  }
  send(to: string, payload: Payload) {
    return this.request(
      'POST',
      `/v23.0/${this.phoneId}/messages`,
      { messaging_product: 'whatsapp', recipient_type: 'individual', to, ...payload },
      true,
    );
  }
  reviewTemplate(id: string, status = 'APPROVED') {
    return this.request('POST', `/_wa/templates/${encodeURIComponent(id)}/review`, { status });
  }
  graph(method: string, path: string, payload?: Payload) {
    return this.request(method, `/v23.0/${path}`, payload, true);
  }
}

export class VirtualUser {
  private ready?: Promise<unknown>;
  private seen = new Set<string>();
  constructor(
    public readonly client: WaFakeClient,
    public readonly waId: string,
    private name?: string,
  ) {}
  async ensure() {
    this.ready ??= this.client.request('POST', '/_wa/users', {
      wa_id: this.waId,
      name: this.name ?? this.waId,
    });
    await this.ready;
    return this;
  }
  async send(payload: Payload) {
    await this.ensure();
    return this.client.request('POST', `/_wa/users/${encodeURIComponent(this.waId)}/send`, {
      phone_number_id: this.client.phoneId,
      ...payload,
    });
  }
  sendText(body: string) {
    return this.send({ type: 'text', text: { body } });
  }
  tapButton(message: Payload | string, buttonId: string) {
    return this.client.request('POST', `/_wa/users/${this.waId}/tap`, {
      message_id: typeof message === 'string' ? message : message.id,
      button_id: buttonId,
    });
  }
  selectRow(message: Payload | string, rowId: string) {
    return this.client.request('POST', `/_wa/users/${this.waId}/select`, {
      message_id: typeof message === 'string' ? message : message.id,
      row_id: rowId,
    });
  }
  react(message: Payload | string, emoji: string) {
    return this.client.request('POST', `/_wa/users/${this.waId}/react`, {
      message_id: typeof message === 'string' ? message : message.id,
      emoji,
    });
  }
  async expectMessage(
    filter: {
      type?: string;
      interactive?: string;
      timeout?: number;
      predicate?: (message: Payload) => boolean;
    } = {},
  ): Promise<Payload> {
    const deadline = Date.now() + (filter.timeout ?? 10000);
    do {
      const result = await this.client.request(
        'GET',
        `/_wa/outbox?to=${this.waId}&wait=${Math.max(1, Math.min(1000, deadline - Date.now()))}`,
      );
      const messages: Payload[] = Array.isArray(result)
        ? result
        : (result.messages ?? result.data ?? []);
      const found = messages.find(
        (message) =>
          !this.seen.has(message.id) &&
          (!filter.type || message.type === filter.type) &&
          (!filter.interactive || message.payload?.interactive?.type === filter.interactive) &&
          (!filter.predicate || filter.predicate(message)),
      );
      if (found) {
        this.seen.add(found.id);
        return found;
      }
      if (Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    } while (Date.now() < deadline);
    throw new Error(`Expected message for ${this.waId} did not arrive`);
  }
  async expectStatus(messageId: string, status: string) {
    await this.client.drain({ advance: true });
    const state = await this.client.state();
    const message = state.messages.find((item: Payload) => item.id === messageId);
    if (message?.status !== status)
      throw new Error(`Expected ${status}, got ${message?.status ?? 'missing'}`);
    return message;
  }
  async openFlow(message: Payload | string) {
    const session = await this.client.request('POST', `/_wa/users/${this.waId}/flows/open`, {
      message_id: typeof message === 'string' ? message : message.id,
    });
    return new VirtualFlow(this, session.session ?? session);
  }
}

export class VirtualFlow {
  constructor(
    public readonly user: VirtualUser,
    public session: Payload,
  ) {}
  private path(action: string) {
    return `/_wa/users/${this.user.waId}/flows/${this.session.id}/${action}`;
  }
  async fill(data: Payload) {
    const result = await this.user.client.request('POST', this.path('fill'), { data });
    this.session = result.session ?? result;
    return this;
  }
  async submit(data?: Payload) {
    const result = await this.user.client.request(
      'POST',
      this.path('submit'),
      data ? { data } : {},
    );
    this.session = result.session ?? result;
    return this.session;
  }
  async back() {
    const result = await this.user.client.request('POST', this.path('back'), {});
    this.session = result.session ?? result;
    return this.session;
  }
}

export async function createWaFake(options: Payload = {}) {
  const { createWaFake: startServer } = await import('../../server/src/index.ts');
  const server = await startServer({ port: 0, ...options });
  const client = new WaFakeClient({
    url: server.baseUrl ?? server.url,
    token: options.simToken,
    graphToken: options.graphToken,
    phoneId: options.phoneNumberId,
    caFile: options.caFile,
  });
  return Object.assign(client, {
    engine: server.engine,
    app: server.app,
    close: server.close,
    clock: { advance: (value: string | number) => client.advance(value) },
  });
}
