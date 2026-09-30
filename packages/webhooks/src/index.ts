import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Json } from '../../core/src/contracts.ts';
export function signWebhook(raw: string | Uint8Array, secret: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex');
}
export function verifyWebhook(
  raw: string | Uint8Array,
  signature: string,
  secret: string,
): boolean {
  const a = Buffer.from(signWebhook(raw, secret)),
    b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function webhookEnvelope(waba: string, phone: Json, field: string, value: Json): Json {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: waba,
        changes: [
          {
            field,
            value:
              field === 'messages'
                ? {
                    messaging_product: 'whatsapp',
                    metadata: {
                      display_phone_number: phone.display_phone_number,
                      phone_number_id: phone.id,
                    },
                    ...value,
                  }
                : value,
          },
        ],
      },
    ],
  };
}
export function retryDelay(attempt: number): number {
  return Math.min(1000 * 2 ** Math.max(0, attempt - 1), 24 * 60 * 60 * 1000);
}
