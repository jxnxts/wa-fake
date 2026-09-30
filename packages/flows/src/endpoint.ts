import { createHmac } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { encryptRequest, decryptResponse } from 'flowso/endpoint';
import type { EngineHost, Json } from '../../core/src/contracts.ts';

export class FlowEndpointError extends Error {
  constructor(
    readonly kind:
      | 'decrypt'
      | 'flow_token'
      | 'signature'
      | 'timeout'
      | 'network'
      | 'http'
      | 'invalid_response',
    readonly status = 502,
  ) {
    super(`Flow endpoint ${kind}${kind === 'http' ? ` (HTTP ${status})` : ''}`);
    this.name = 'FlowEndpointError';
  }
}

function post(
  url: string,
  body: string,
  signature: string,
  signal: AbortSignal,
): Promise<{ status: number; body: string }> {
  // Native HTTP makes 421 observable: fetch can replay it before we rotate AES material.
  return new Promise((resolve, reject) => {
    const request = new URL(url).protocol === 'https:' ? httpsRequest : httpRequest;
    const req = request(
      url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          'x-hub-signature-256': signature,
        },
        signal,
      },
      (res) => {
        const parts: Buffer[] = [];
        let size = 0;
        res.on('data', (part: Buffer) => {
          size += part.length;
          if (size > 2_000_000) {
            res.destroy();
            reject(new FlowEndpointError('invalid_response'));
          } else parts.push(part);
        });
        res.on('error', () => reject(new FlowEndpointError('network')));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 502, body: Buffer.concat(parts).toString('utf8') }),
        );
      },
    );
    req.on('error', () => reject(new FlowEndpointError('network')));
    req.end(body);
  });
}

/** Only encrypted transport is supported. Every request gets a new AES key and IV. */
export function createEncryptedEndpoint(engine: EngineHost, flow: Json, phoneId: string) {
  async function exchange(payload: Json, notify = true): Promise<Json> {
    if (!flow.endpoint_uri) throw new FlowEndpointError('network');
    await engine.assertLocalUrl(flow.endpoint_uri);
    const phone = engine.store.phones[phoneId];
    if (!phone?.public_key) throw new FlowEndpointError('decrypt', 421);
    const secret = engine.config.appSecret ?? engine.config.app_secret;
    if (typeof secret !== 'string' || !secret.length) throw new FlowEndpointError('signature', 432);
    for (let attempt = 0; attempt < 2; attempt++) {
      // Read again after 421, so a key registered while the endpoint is rotating is used.
      const encrypted = encryptRequest({
        publicKeyPem: engine.store.phones[phoneId].public_key,
        payload: payload as any,
      });
      const body = JSON.stringify(encrypted.body);
      const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new FlowEndpointError('timeout', 504));
          controller.abort();
        }, 10_000);
      });
      try {
        const result = await Promise.race([
          timeout,
          (async () => {
            const response = await post(flow.endpoint_uri, body, signature, controller.signal);
            if (response.status === 421) throw new FlowEndpointError('decrypt', 421);
            if (response.status === 427) throw new FlowEndpointError('flow_token', 427);
            if (response.status === 432) throw new FlowEndpointError('signature', 432);
            if (response.status < 200 || response.status >= 300)
              throw new FlowEndpointError('http', response.status);
            const raw = response.body;
            try {
              const result = decryptResponse({
                body: raw,
                aesKey: encrypted.aesKey,
                iv: encrypted.iv,
              });
              if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error();
              return result as Json;
            } catch {
              throw new FlowEndpointError('invalid_response');
            }
          })(),
        ]);
        engine.emit('flow.exchange', {
          flow_id: flow.id,
          action: payload.action,
          status: 'ok',
          attempt: attempt + 1,
        });
        return result;
      } catch (cause) {
        const error = cause instanceof FlowEndpointError ? cause : new FlowEndpointError('network');
        engine.emit('flow.exchange', {
          flow_id: flow.id,
          action: payload.action,
          status: error.kind,
          attempt: attempt + 1,
        });
        if (error.kind === 'decrypt' && attempt === 0) continue;
        if (notify && error.kind === 'invalid_response')
          await notification(payload, 'invalid_response');
        throw error;
      } finally {
        clearTimeout(timer);
      }
    }
    throw new FlowEndpointError('decrypt', 421);
  }
  async function notification(request: Json, kind: string): Promise<void> {
    // Meta sends an error acknowledgment request through the data-exchange channel.
    try {
      await exchange(
        {
          version: request.version,
          action: 'data_exchange',
          screen: request.screen,
          flow_token: request.flow_token,
          data: { error: kind, error_message: 'Flow endpoint returned invalid response' },
        },
        false,
      );
    } catch {
      /* Original error remains authoritative; no raw response enters logs. */
    }
  }
  return { exchange, notification };
}
