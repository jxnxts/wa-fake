import type { Json } from './contracts.ts';
export class GraphError extends Error {
  constructor(
    public code: number,
    message: string,
    public status = 400,
    public subcode?: number,
  ) {
    super(message);
    this.name = 'GraphError';
  }
  envelope(trace = 'wa-fake'): Json {
    return {
      error: {
        message: this.message,
        type: this.code === 190 ? 'OAuthException' : 'WhatsAppApiException',
        code: this.code,
        ...(this.subcode ? { error_subcode: this.subcode } : {}),
        error_data: { messaging_product: 'whatsapp', details: this.message },
        fbtrace_id: trace,
      },
    };
  }
}
export const unsupported = (feature: string) =>
  new GraphError(100, `not_implemented: ${feature}`, 501);
export function errorResponse(error: unknown): Response {
  const e = error instanceof GraphError ? error : new GraphError(100, 'Invalid request', 400);
  return Response.json(e.envelope(), { status: e.status });
}
