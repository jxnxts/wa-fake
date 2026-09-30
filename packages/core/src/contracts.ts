export type Json = Record<string, any>;
export interface EngineStore extends Json {
  users: Record<string, Json>;
  phones: Record<string, Json>;
  media: Record<string, Json>;
  templates: Record<string, Json>;
  flows: Record<string, Json>;
  sessions: Record<string, Json>;
  messages: Json[];
  webhooks: Json[];
  logs: Json[];
}
export interface EngineConfig extends Json {
  appSecret?: string;
  graphToken?: string;
  simToken?: string;
  webhookUrl?: string;
  phoneNumberId?: string;
  wabaId?: string;
  appId?: string;
}
export interface RouteContext {
  method: string;
  id: string;
  edge: string;
  version: string;
  path: string;
  request: Request;
  baseUrl: string;
  engine: EngineHost;
}
export interface GraphExtension {
  graph(context: RouteContext): Promise<Response | null>;
  sim(context: RouteContext): Promise<Response | null>;
  validateMessage?(payload: Json, phone: Json): Promise<Json | undefined>;
}
export interface EngineHost {
  store: EngineStore;
  config: EngineConfig;
  now(): number;
  id(prefix: string): string;
  emit(type: string, data: unknown): void;
  enqueueWebhook(field: string, value: Json, phoneId?: string): Promise<unknown> | unknown;
  receiveMessage(waId: string, payload: Json, phoneId?: string): Promise<Json>;
  graphError(code: number, message: string, status?: number, subcode?: number): Error;
  assertLocalUrl(url: string): Promise<void>;
}
