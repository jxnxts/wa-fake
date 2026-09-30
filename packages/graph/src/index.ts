import type { WaEngine, Json, RouteContext } from '../../core/src/index.ts';
import { GraphError, unsupported } from '../../core/src/index.ts';
export function bearer(request: Request): string | undefined {
  return /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') ?? '')?.[1];
}
export async function jsonBody(request: Request, allowEmpty = false): Promise<Json> {
  try {
    const text = await request.text();
    if (allowEmpty && !text.trim()) return {};
    const data = JSON.parse(text);
    if (!data || Array.isArray(data) || typeof data !== 'object') throw new Error();
    return data;
  } catch {
    throw new GraphError(100, 'Request body must be a JSON object');
  }
}
function fields(value: Json, query: string | null): Json {
  if (!query) return value;
  const selected = query.split(',');
  if (selected.some((key) => !(key in value))) throw unsupported('requested Graph fields');
  return Object.fromEntries(selected.map((key) => [key, value[key]]));
}
export async function handleGraph(request: Request, engine: WaEngine): Promise<Response> {
  const url = new URL(request.url),
    match = /^\/(v\d+\.0)\/([^/]+)(?:\/(.*))?$/.exec(url.pathname);
  if (!match) throw unsupported('Graph path');
  const [, version, id, edge = ''] = match,
    method = request.method;
  const context: RouteContext = {
    method,
    id: id!,
    edge,
    version: version!,
    path: url.pathname,
    request,
    baseUrl: engine.config.baseUrl ?? url.origin,
    engine,
  };
  const phone = Object.hasOwn(engine.store.phones, id!) ? engine.store.phones[id!] : undefined,
    media = Object.hasOwn(engine.store.media, id!) ? engine.store.media[id!] : undefined;
  const messaging = ['messages', 'media'].includes(edge) || !!media;
  const credential = engine.auth(
    bearer(request),
    'graph',
    phone?.id ?? media?.phone_number_id,
    messaging ? 'whatsapp_business_messaging' : 'whatsapp_business_management',
  );
  const isWaba =
    id === engine.config.wabaId ||
    !!(engine.store.wabas && Object.hasOwn(engine.store.wabas, id!)) ||
    Object.values(engine.store.phones).some((p) => p.waba_id === id);
  const waba =
    phone?.waba_id ??
    (Object.hasOwn(engine.store.templates, id!)
      ? engine.store.templates[id!]?.waba_id
      : undefined) ??
    (Object.hasOwn(engine.store.flows, id!) ? engine.store.flows[id!]?.waba_id : undefined) ??
    (isWaba ? id : undefined);
  if (waba && credential?.wabaIds && !credential.wabaIds.includes(waba))
    throw new GraphError(200, 'Token lacks access to this WABA', 403);
  if (edge === 'messages' && method === 'POST')
    return Response.json(await engine.sendMessage(await jsonBody(request), id, url.pathname));
  if (edge === 'media' && method === 'POST') {
    engine.phone(id);
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      throw new GraphError(100, 'Media upload requires multipart form-data');
    }
    if (form.get('messaging_product') !== 'whatsapp')
      throw new GraphError(100, 'messaging_product must be whatsapp');
    const file = form.get('file');
    if (!file || typeof file === 'string') throw new GraphError(100, 'Multipart file is required');
    const mime = String(form.get('type') ?? file.type);
    if (
      file.type &&
      file.type !== 'application/octet-stream' &&
      mime.split(';')[0] !== file.type.split(';')[0]
    )
      throw new GraphError(100, 'Declared MIME does not match uploaded file MIME');
    const record = engine.uploadMedia(
      new Uint8Array(await file.arrayBuffer()),
      mime,
      file.name,
      id,
    );
    return Response.json({ id: record.id });
  }
  if (media && !edge) {
    if (method === 'GET') return Response.json(engine.mediaUrl(id!, context.baseUrl));
    if (method === 'DELETE') {
      delete engine.store.media[id!];
      return Response.json({ success: true });
    }
  }
  for (const extension of engine.extensions) {
    const response = await extension.graph(context);
    if (response) return response;
  }
  if (id === 'debug_token' && !edge && method === 'GET') {
    const input = url.searchParams.get('input_token');
    if (input?.startsWith('EAA'))
      throw new GraphError(190, 'Production-looking EAA tokens are refused', 401);
    const known = (
      engine.config.tokens ?? [
        {
          token: engine.config.graphToken,
          scopes: ['whatsapp_business_messaging', 'whatsapp_business_management'],
        },
      ]
    ).find((t: Json) => t.token === input);
    return Response.json({
      data: {
        app_id: engine.config.appId,
        type: 'SYSTEM_USER',
        application: 'wa-fake synthetic app',
        is_valid: !!known,
        expires_at: 0,
        data_access_expires_at: 0,
        scopes: known?.scopes ?? [],
        user_id: '400000000001',
      },
    });
  }
  if (isWaba) {
    if (!edge && method === 'GET')
      return Response.json(
        fields(
          {
            id,
            name: engine.store.wabas?.[id!]?.name ?? 'Synthetic WABA',
            message_template_namespace: 'wa_fake',
            currency: 'BRL',
            timezone_id: '25',
          },
          url.searchParams.get('fields'),
        ),
      );
    if (edge === 'phone_numbers' && method === 'GET')
      return Response.json({
        data: Object.values(engine.store.phones)
          .filter((p) => p.waba_id === id)
          .map((p) =>
            fields(
              {
                id: p.id,
                display_phone_number: p.display_phone_number,
                verified_name: p.verified_name,
                quality_rating: p.quality_rating,
                code_verification_status: p.code_verification_status,
                name_status: p.name_status,
                messaging_limit_tier: p.messaging_limit_tier,
              },
              url.searchParams.get('fields'),
            ),
          ),
      });
    if (edge === 'subscribed_apps') {
      if (method === 'GET')
        return Response.json({
          data: engine.store.subscriptions[id]
            ? [
                {
                  whatsapp_business_api_data: {
                    id: engine.config.appId,
                    name: 'wa-fake synthetic app',
                  },
                },
              ]
            : [],
        });
      if (method === 'DELETE') {
        delete engine.store.subscriptions[id];
        return Response.json({ success: true });
      }
      if (method === 'POST') {
        const body = await jsonBody(request, true);
        if (Object.keys(body).some((k) => !['override_callback_uri', 'verify_token'].includes(k)))
          throw unsupported('subscribed_apps option');
        if (body.override_callback_uri) {
          const previous = engine.config.webhookUrl;
          await engine.configure({
            webhook_url: body.override_callback_uri,
            verify_token: body.verify_token ?? engine.config.verifyToken,
          });
          engine.config.webhookUrl = previous;
        }
        engine.store.subscriptions[id] = {
          app_id: engine.config.appId,
          ...(body.override_callback_uri ? { callback_url: body.override_callback_uri } : {}),
        };
        return Response.json({ success: true });
      }
    }
  }
  if (phone) {
    if (!edge && method === 'GET')
      return Response.json(
        fields(
          {
            id: phone.id,
            display_phone_number: phone.display_phone_number,
            verified_name: phone.verified_name,
            quality_rating: phone.quality_rating,
            code_verification_status: phone.code_verification_status,
            name_status: phone.name_status,
            messaging_limit_tier: phone.messaging_limit_tier,
            platform_type: 'CLOUD_API',
            status: phone.registered ? 'CONNECTED' : 'DISCONNECTED',
          },
          url.searchParams.get('fields'),
        ),
      );
    if (
      ['register', 'deregister', 'request_code', 'verify_code'].includes(edge) &&
      method === 'POST'
    ) {
      const data = await jsonBody(request, edge === 'deregister');
      if (edge === 'register') {
        if (data.messaging_product !== 'whatsapp' || !/^\d{6}$/.test(data.pin ?? ''))
          throw new GraphError(
            100,
            'Registration requires messaging_product and a synthetic 6-digit PIN',
          );
        phone.registered = true;
      }
      if (edge === 'deregister') phone.registered = false;
      if (edge === 'request_code') {
        if (!['SMS', 'VOICE'].includes(data.code_method) || typeof data.language !== 'string')
          throw new GraphError(100, 'code_method and language required');
        phone.code_verification_status = 'NOT_VERIFIED';
      }
      if (edge === 'verify_code') {
        if (data.code !== (engine.config.verificationCode ?? '123456'))
          throw new GraphError(100, 'Invalid synthetic verification code');
        phone.code_verification_status = 'VERIFIED';
      }
      engine.emit('phone', { id: phone.id, registered: phone.registered });
      return Response.json({ success: true });
    }
    if (edge === 'whatsapp_business_profile') {
      if (method === 'GET')
        return Response.json({
          data: [
            fields(
              { messaging_product: 'whatsapp', ...phone.profile },
              url.searchParams.get('fields'),
            ),
          ],
        });
      if (method === 'POST') {
        const data = await jsonBody(request);
        const allowed = [
          'messaging_product',
          'about',
          'address',
          'description',
          'email',
          'profile_picture_handle',
          'websites',
          'vertical',
        ];
        if (
          data.messaging_product !== 'whatsapp' ||
          Object.keys(data).some((k) => !allowed.includes(k))
        )
          throw new GraphError(100, 'Invalid business profile properties');
        for (const [key, value] of Object.entries(data)) {
          if (key === 'websites') {
            if (
              !Array.isArray(value) ||
              value.length > 2 ||
              value.some((v) => typeof v !== 'string')
            )
              throw new GraphError(100, 'websites must be at most two strings');
          } else if (typeof value !== 'string')
            throw new GraphError(100, 'Profile fields must be strings');
        }
        delete data.messaging_product;
        phone.profile = { ...phone.profile, ...data };
        return Response.json({ success: true });
      }
    }
  }
  throw unsupported('Graph endpoint ' + edge);
}
