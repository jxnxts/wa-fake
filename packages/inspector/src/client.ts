import type { Json } from '../../core/src/contracts.ts';
export interface Persona {
  wa_id: string;
  name: string;
  exists?: boolean;
  blocked?: boolean;
  marketing_opt_out?: boolean;
}
export interface Phone {
  id: string;
  waba_id: string;
  display_phone_number: string;
  registered: boolean;
  typing_until?: number;
}
export interface Message {
  id: string;
  direction: 'inbound' | 'outbound';
  from: string;
  to: string;
  phone_number_id: string;
  type: string;
  timestamp: number | string;
  status: string;
  payload: Json;
  render?: Json;
}
export interface State {
  now: number;
  users: Persona[];
  phones: Phone[];
  messages: Message[];
  templates: Json[];
  flows: Json[];
  sessions: Json[];
  webhooks: Json[];
  logs: Json[];
  typing?: Json[] | Json;
}
export interface FlowSession extends Json {
  id: string;
  screen: string;
  data: Json;
  flow: Json;
  complete: boolean;
  fields?: Json[] | Json;
}
export class SimError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: number,
  ) {
    super(message);
  }
}
export function validateToken(token: string): string {
  const value = token.trim();
  if (!value || /^EAA/i.test(value) || !/^wa-fake[-_][a-zA-Z0-9_-]+$/.test(value))
    throw new SimError('Use only a synthetic wa-fake-… credential for the Sim API.', 400);
  return value;
}
export function localUrl(value: string): string | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value, location.origin);
    return url.origin === location.origin &&
      !url.username &&
      !url.password &&
      ['http:', 'https:'].includes(url.protocol)
      ? url.href
      : null;
  } catch {
    return null;
  }
}
export function redactEvidence(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactEvidence);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /authorization|secret|token|password|^(?:signature|x-hub-signature-256|pin|text|body|caption|response_json|payload|content|data|values|fields|contacts|location|interactive|reaction|template)$/i.test(
          key,
        )
          ? '[redacted]'
          : redactEvidence(item),
      ]),
    );
  if (typeof value === 'string')
    return value.replace(/\bEAA[\w-]+|Bearer\s+\S+|wa-fake[-_][\w-]+/gi, '[redacted]');
  return value;
}
export class SimClient {
  token: string;
  constructor(token = 'wa-fake-sim') {
    this.token = validateToken(token);
  }
  async request<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch('/_wa' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response
      .json()
      .catch(() => ({ error: { message: 'Invalid response from the Sim API.' } }));
    if (!response.ok)
      throw new SimError(
        data.error?.message || data.message || `HTTP error ${response.status}`,
        response.status,
        data.error?.code,
      );
    return data;
  }
  state() {
    return this.request<State>('/state');
  }
  user(wa_id: string, name: string) {
    return this.request<Persona>('/users', { wa_id, name });
  }
  send(user: string, phone: string, payload: Json) {
    return this.request<Message>(`/users/${encodeURIComponent(user)}/send`, {
      ...payload,
      phone_number_id: phone,
    });
  }
  tap(user: string, message: string, button: string) {
    return this.request(`/users/${encodeURIComponent(user)}/tap`, {
      message_id: message,
      button_id: button,
    });
  }
  select(user: string, message: string, row: string) {
    return this.request(`/users/${encodeURIComponent(user)}/select`, {
      message_id: message,
      row_id: row,
    });
  }
  react(user: string, message: string, emoji: string) {
    return this.request(`/users/${encodeURIComponent(user)}/react`, { message_id: message, emoji });
  }
  clock(advance: string) {
    return this.request('/clock', { advance });
  }
  fault(rule: Json) {
    return this.request('/faults', rule);
  }
  review(id: string, status: string) {
    return this.request(`/templates/${encodeURIComponent(id)}/review`, { status });
  }
  snapshot() {
    return this.request<Json>('/snapshot', {});
  }
  restore(snapshot: Json) {
    return this.request('/restore', { snapshot });
  }
  reset() {
    return this.request('/reset', {});
  }
  redeliver(id: string) {
    return this.request(`/webhooks/${encodeURIComponent(id)}/redeliver`, {});
  }
  drain() {
    return this.request('/webhooks/drain', {});
  }
  openFlow(user: string, message: string) {
    return this.request<FlowSession>(`/users/${encodeURIComponent(user)}/flows/open`, {
      message_id: message,
    });
  }
  flow(
    user: string,
    session: string,
    action: 'fill' | 'submit' | 'back',
    data?: Json,
    componentAction?: Json,
  ) {
    return this.request<FlowSession>(
      `/users/${encodeURIComponent(user)}/flows/${encodeURIComponent(session)}/${action}`,
      {
        ...(data === undefined ? {} : { data }),
        ...(componentAction ? { action: componentAction } : {}),
      },
    );
  }
  preview(id: string) {
    return this.request<Json>(`/flows/${encodeURIComponent(id)}/preview`);
  }
  events(onUpdate: () => void, onConnection: (connected: boolean) => void) {
    const source = new EventSource(`/_wa/events?token=${encodeURIComponent(this.token)}`);
    source.onopen = () => onConnection(true);
    source.onerror = () => onConnection(false);
    source.onmessage = onUpdate;
    for (const kind of [
      'state',
      'message',
      'message.created',
      'message.status',
      'status',
      'clock',
      'clock.advanced',
      'user',
      'user.created',
      'template',
      'template.created',
      'template.updated',
      'template.deleted',
      'template.status',
      'flow',
      'flow.session',
      'flow.exchange',
      'flow.created',
      'flow.updated',
      'flow.deleted',
      'flow.status',
      'webhook',
      'reset',
      'restore',
      'typing',
      'snapshot',
      'log',
      'media',
    ])
      source.addEventListener(kind, onUpdate);
    return source;
  }
}
export function messageTime(value: number | string): number {
  const numeric = Number(value);
  return Number.isFinite(numeric)
    ? numeric < 1e12
      ? numeric * 1000
      : numeric
    : Date.parse(String(value));
}
export function summary(message?: Message): string {
  if (!message) return 'No messages yet';
  const p = message.payload;
  return (
    p.text?.body ||
    p.button?.text ||
    message.render?.body?.text ||
    (typeof message.render?.body === 'string' ? message.render.body : '') ||
    p.interactive?.body?.text ||
    p.interactive?.button_reply?.title ||
    p.interactive?.list_reply?.title ||
    p.interactive?.nfm_reply?.body ||
    p[message.type]?.caption ||
    (
      {
        location: 'Location',
        contacts: 'Contact',
        template: `Template · ${p.template?.name || ''}`,
        interactive: 'Interactive message',
        image: 'Image',
        audio: 'Audio',
        video: 'Video',
        document: 'Document',
        reaction: p.reaction?.emoji || 'Reaction',
      } as Record<string, string>
    )[message.type] ||
    message.type
  );
}
