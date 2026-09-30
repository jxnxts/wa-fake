import { createHash, createPublicKey } from 'node:crypto';
import type { EngineHost, GraphExtension, Json, RouteContext } from '../../core/src/contracts.ts';
import { createEncryptedEndpoint, FlowEndpointError } from './endpoint.ts';
import { createSessionController } from './sessions.ts';
import { isObject, validateAsset } from './validation.ts';

const categories = [
  'SIGN_UP',
  'SIGN_IN',
  'APPOINTMENT_BOOKING',
  'LEAD_GENERATION',
  'CONTACT_US',
  'CUSTOMER_SUPPORT',
  'SURVEY',
  'OTHER',
];

async function input(ctx: RouteContext): Promise<Json> {
  const body: Json = Object.fromEntries(new URL(ctx.request.url).searchParams);
  const kind = ctx.request.headers.get('content-type') ?? '';
  if (!['GET', 'DELETE'].includes(ctx.method)) {
    if (kind.includes('application/json')) {
      const value = await ctx.request.json();
      if (!isObject(value)) throw ctx.engine.graphError(100, 'Request body must be an object');
      Object.assign(body, value);
    } else if (kind.includes('form'))
      Object.assign(body, Object.fromEntries(await ctx.request.formData()));
  }
  for (const key of ['categories', 'flow_json'])
    if (typeof body[key] === 'string') {
      try {
        body[key] = JSON.parse(body[key]);
      } catch {
        throw ctx.engine.graphError(100, `${key} must contain valid JSON`);
      }
    }
  return body;
}

export function createFlows(engine: EngineHost): GraphExtension {
  engine.store.flows ??= {};
  engine.store.sessions ??= {};
  const flows = () => engine.store.flows as Record<string, Json>;
  const error = (message: string, code = 100, status = 400): never => {
    throw engine.graphError(code, message, status);
  };
  const unsupported = (capability: string): never =>
    error(`not_implemented: ${capability}`, 100, 501);
  const get = (id: string): Json =>
    Object.hasOwn(flows(), id) ? flows()[id]! : error('Unknown Flow', 100, 404);
  const flowId = () =>
    String(
      5000000000000000n +
        (BigInt('0x' + createHash('sha256').update(engine.id('flow')).digest('hex').slice(0, 13)) %
          1000000000000000n),
    );
  const sessions = createSessionController(engine, get);
  const ownsWaba = (id: string): boolean =>
    !!(engine.store.wabas && Object.hasOwn(engine.store.wabas, id)) ||
    Object.values(engine.store.phones ?? {}).some((phone: any) => phone.waba_id === id);
  function validateMeta(body: Json): Json {
    if (typeof body.name !== 'string' || !body.name.trim() || [...body.name].length > 200)
      error('Flow name must contain 1-200 characters');
    if (
      !Array.isArray(body.categories) ||
      !body.categories.length ||
      body.categories.some((value: unknown) => !categories.includes(value as string))
    )
      error('Invalid Flow categories');
    return { name: body.name, categories: [...new Set(body.categories)] };
  }
  function unique(flow: Json, exclude?: string): void {
    if (
      Object.values(flows()).some(
        (value) =>
          value.id !== exclude && value.waba_id === flow.waba_id && value.name === flow.name,
      )
    )
      error('A Flow with this name already exists');
  }
  function draft(flow: Json): void {
    if (flow.status !== 'DRAFT') error('Only DRAFT Flows can be changed or deleted');
  }
  function usesEndpoint(flow: Json): boolean {
    return (
      JSON.stringify(flow.json).includes('"data_exchange"') ||
      flow.json?.screens?.some((screen: Json) => screen.refresh_on_back)
    );
  }
  function phoneFor(flow: Json): Json {
    return (
      (Object.values(engine.store.phones).find(
        (phone: any) => phone.waba_id === flow.waba_id && phone.public_key,
      ) as Json) ?? error('Flow endpoint requires a registered encryption public key')
    );
  }
  async function status(flow: Json, next: string): Promise<void> {
    const phone =
      Object.values(engine.store.phones).find((phone) => phone.waba_id === flow.waba_id) ??
      unsupported('Flow status webhook for WABA without a local phone');
    flow.status = next;
    flow.updated_at = engine.now();
    await engine.enqueueWebhook(
      'flows',
      { event: 'FLOW_STATUS_CHANGE', flow_id: flow.id, status: next },
      phone.id,
    );
    engine.emit('flow.status', { id: flow.id, status: next });
  }
  function preview(flow: Json, ctx: RouteContext): Json {
    return {
      preview_url: `${ctx.baseUrl}/?flow=${encodeURIComponent(flow.id)}`,
      expires_at: new Date(engine.now() + 24 * 60 * 60 * 1000).toISOString(),
    };
  }
  function project(flow: Json, ctx: RouteContext): Json {
    const defaultFields = ['id', 'name', 'status', 'categories', 'validation_errors'];
    const fields = new URL(ctx.request.url).searchParams.get('fields')?.split(',') ?? defaultFields;
    const result: Json = {};
    for (const key of fields) {
      if (key === 'preview' || key.startsWith('preview.')) result.preview = preview(flow, ctx);
      else if (key === 'json_version') result.json_version = flow.json?.version ?? null;
      else if (key === 'data_api_version')
        result.data_api_version = flow.json?.data_api_version ?? null;
      else if (key === 'health_status')
        result.health_status = flow.health_status ?? {
          can_send_message: flow.status === 'PUBLISHED',
          entities: [],
        };
      else if ([...defaultFields, 'endpoint_uri', 'created_at', 'updated_at'].includes(key))
        result[key] = flow[key] ?? null;
      else if (key === 'whatsapp_business_account') result[key] = { id: flow.waba_id };
      else unsupported(`Flow field ${key}`);
    }
    return result;
  }
  return {
    async graph(ctx) {
      if (ctx.edge === 'whatsapp_business_encryption') {
        const phone = Object.hasOwn(engine.store.phones, ctx.id)
          ? engine.store.phones[ctx.id]!
          : error('Unknown phone number', 100, 404);
        if (ctx.method === 'GET')
          return Response.json({
            data: phone.public_key
              ? [
                  {
                    business_public_key: phone.public_key,
                    business_public_key_signature_status: 'VALID',
                  },
                ]
              : [],
          });
        if (ctx.method === 'POST') {
          const body = await input(ctx);
          if (typeof body.business_public_key !== 'string')
            error('business_public_key is required');
          try {
            const key = createPublicKey(body.business_public_key);
            if (
              key.asymmetricKeyType !== 'rsa' ||
              (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
            )
              throw new Error();
            phone.public_key = key.export({ format: 'pem', type: 'spki' }).toString();
          } catch {
            error('business_public_key must be a PEM RSA public key of at least 2048 bits');
          }
          engine.emit('flow.key', { phone_number_id: ctx.id });
          return Response.json({ success: true });
        }
        return unsupported(`encryption ${ctx.method}`);
      }
      if (ctx.edge === 'migrate_flows') return unsupported('Flow migration');
      if (ctx.edge === 'flows') {
        if (!ownsWaba(ctx.id)) error('Unknown WhatsApp Business Account', 100, 404);
        const body = await input(ctx);
        if (ctx.method === 'POST') {
          const metadata = validateMeta(body);
          const source = body.clone_flow_id ? get(body.clone_flow_id) : undefined;
          if (source && source.waba_id !== ctx.id) error('Cannot clone a Flow from another WABA');
          const endpoint = body.endpoint_uri ?? source?.endpoint_uri ?? null;
          if (endpoint !== null) await engine.assertLocalUrl(endpoint);
          const flow: Json = {
            ...metadata,
            id: flowId(),
            waba_id: ctx.id,
            status: 'DRAFT',
            endpoint_uri: endpoint,
            json: source?.json ? structuredClone(source.json) : null,
            validation_errors: source?.validation_errors
              ? structuredClone(source.validation_errors)
              : [],
            unsupported: source?.unsupported ?? false,
            created_at: engine.now(),
            updated_at: engine.now(),
          };
          unique(flow);
          flows()[flow.id] = flow;
          engine.emit('flow.created', { id: flow.id });
          return Response.json({ id: flow.id });
        }
        if (ctx.method === 'GET') {
          const all = Object.values(flows()).filter(
            (flow) =>
              flow.waba_id === ctx.id &&
              (!body.status || flow.status === body.status) &&
              (!body.name || flow.name === body.name),
          );
          const limit = body.limit == null ? 25 : Number(body.limit);
          if (!Number.isInteger(limit) || limit < 1 || limit > 100) error('limit must be 1-100');
          let start = 0;
          if (body.after) {
            const at = all.findIndex((flow) => flow.id === body.after);
            if (at < 0) error('Invalid Flow cursor');
            start = at + 1;
          }
          if (body.before) {
            const at = all.findIndex((flow) => flow.id === body.before);
            if (at < 0) error('Invalid Flow cursor');
            start = Math.max(0, at - limit);
          }
          const page = all.slice(start, start + limit),
            paging: Json = { cursors: { before: page[0]?.id ?? '', after: page.at(-1)?.id ?? '' } };
          if (start + limit < all.length) {
            const url = new URL(ctx.request.url);
            url.searchParams.delete('before');
            url.searchParams.set('after', page.at(-1)!.id);
            paging.next = url.toString();
          }
          if (start > 0) {
            const url = new URL(ctx.request.url);
            url.searchParams.delete('after');
            url.searchParams.set('before', page[0]!.id);
            paging.previous = url.toString();
          }
          return Response.json({ data: page.map((flow) => project(flow, ctx)), paging });
        }
        return unsupported(`flows ${ctx.method}`);
      }
      if (!Object.hasOwn(flows(), ctx.id)) return null;
      const flow = get(ctx.id);
      if (ctx.edge === 'assets') {
        if (ctx.method === 'GET') {
          if (new URL(ctx.request.url).searchParams.get('download') === '1')
            return flow.json
              ? Response.json(flow.json)
              : error('Flow JSON asset not found', 100, 404);
          return Response.json({
            data: flow.json
              ? [
                  {
                    name: 'flow.json',
                    asset_type: 'FLOW_JSON',
                    download_url: `${ctx.baseUrl}/${ctx.version}/${flow.id}/assets?download=1`,
                  },
                ]
              : [],
            paging: { cursors: { before: '', after: '' } },
          });
        }
        if (ctx.method === 'POST') {
          draft(flow);
          const body = await input(ctx);
          if ((body.asset_type ?? 'FLOW_JSON') !== 'FLOW_JSON')
            return unsupported(`Flow asset ${body.asset_type}`);
          let json = body.flow_json;
          if (body.file instanceof Blob) {
            if (body.file.size > 2_000_000) error('Flow JSON asset is too large');
            try {
              json = JSON.parse(await body.file.text());
            } catch {
              error('Flow asset must contain valid JSON');
            }
          }
          if (json === undefined) error('Multipart file or synthetic flow_json is required');
          const result = validateAsset(json);
          if (isObject(json) && json.data_channel_uri)
            await engine.assertLocalUrl(json.data_channel_uri);
          flow.json = structuredClone(json);
          flow.validation_errors = result.errors;
          flow.unsupported = result.unsupported;
          flow.updated_at = engine.now();
          // data_channel_uri is supported for older Flow JSON assets, with the same loopback rule.
          if (isObject(json) && json.data_channel_uri && !flow.endpoint_uri)
            flow.endpoint_uri = json.data_channel_uri;
          engine.emit('flow.asset', { id: flow.id, valid: !result.errors.length });
          return Response.json(
            { success: !result.errors.length, validation_errors: result.errors },
            { status: result.unsupported ? 501 : 200 },
          );
        }
        return unsupported(`Flow assets ${ctx.method}`);
      }
      if (ctx.edge === 'publish') {
        if (ctx.method !== 'POST') return unsupported('Flow publish method');
        draft(flow);
        if (flow.unsupported)
          return unsupported('Flow contains unsupported schema/runtime components');
        if (!flow.json || flow.validation_errors.length)
          error('Flow cannot be published without valid Flow JSON', 139002);
        if (usesEndpoint(flow) && !flow.endpoint_uri)
          error('Flow requires an endpoint_uri', 139002);
        if (flow.endpoint_uri) {
          const phone = phoneFor(flow);
          try {
            const reply = await createEncryptedEndpoint(engine, flow, phone.id).exchange({
              version: flow.json.data_api_version ?? '3.0',
              action: 'ping',
              flow_token: 'wa-fake-health',
              data: {},
            });
            if (
              reply.data?.status !== 'active' ||
              (reply.version !== undefined &&
                reply.version !== (flow.json.data_api_version ?? '3.0'))
            )
              throw new FlowEndpointError('invalid_response');
            flow.health_status = {
              can_send_message: true,
              entities: [{ entity_type: 'DATA_ENDPOINT', id: flow.id, can_send_message: true }],
            };
          } catch {
            flow.health_status = {
              can_send_message: false,
              entities: [{ entity_type: 'DATA_ENDPOINT', id: flow.id, can_send_message: false }],
            };
            await engine.enqueueWebhook(
              'flows',
              { event: 'ENDPOINT_ERROR', flow_id: flow.id, error: 'endpoint_unhealthy' },
              phone.id,
            );
            error('Flow endpoint health check failed', 139002);
          }
        }
        await status(flow, 'PUBLISHED');
        return Response.json({ success: true });
      }
      if (ctx.edge === 'deprecate') {
        if (ctx.method !== 'POST') return unsupported('Flow deprecate method');
        if (flow.status !== 'PUBLISHED') error('Only PUBLISHED Flows can be deprecated');
        await status(flow, 'DEPRECATED');
        return Response.json({ success: true });
      }
      if (ctx.edge) return unsupported(`Flow edge ${ctx.edge}`);
      if (ctx.method === 'GET') return Response.json(project(flow, ctx));
      if (ctx.method === 'POST') {
        draft(flow);
        const body = await input(ctx);
        const metadata = validateMeta({ ...flow, ...body });
        const next: Json = { ...flow, ...metadata };
        if (body.endpoint_uri !== undefined) {
          if (body.endpoint_uri !== null) await engine.assertLocalUrl(body.endpoint_uri);
          next.endpoint_uri = body.endpoint_uri;
        }
        unique(next, flow.id);
        Object.assign(flow, next, { updated_at: engine.now() });
        engine.emit('flow.updated', { id: flow.id });
        return Response.json({ success: true });
      }
      if (ctx.method === 'DELETE') {
        draft(flow);
        delete flows()[flow.id];
        engine.emit('flow.deleted', { id: flow.id });
        return Response.json({ success: true });
      }
      return unsupported(`Flow ${ctx.method}`);
    },
    async sim(ctx) {
      const preview = ctx.path.match(/^\/_wa\/flows\/([^/]+)\/preview$/);
      if (preview) {
        if (ctx.method !== 'GET') return unsupported('Flow preview method');
        const flow = get(decodeURIComponent(preview[1]!));
        if (!flow.json) error('Flow JSON is missing', 100, 404);
        return Response.json(flow.json);
      }
      const open = ctx.path.match(/^\/_wa\/users\/([^/]+)\/flows\/open$/);
      const act = ctx.path.match(/^\/_wa\/users\/([^/]+)\/flows\/([^/]+)\/(fill|submit|back)$/);
      if (!open && !act) return null;
      if (ctx.method !== 'POST') return unsupported('Flow session method');
      const body = await input(ctx);
      return Response.json(
        open
          ? await sessions.open(decodeURIComponent(open[1]!), body)
          : await sessions.act(
              decodeURIComponent(act![1]!),
              decodeURIComponent(act![2]!),
              act![3]!,
              body,
            ),
      );
    },
    async validateMessage(payload, phone) {
      if (payload.type !== 'interactive' || payload.interactive?.type !== 'flow') return undefined;
      const params = payload.interactive.action?.parameters;
      if (!isObject(params) || payload.interactive.action?.name !== 'flow')
        error('Flow action and parameters are required');
      if (params!.flow_message_version !== '3') return unsupported('Flow message version');
      if (!!params!.flow_id === !!params!.flow_name)
        error('Supply exactly one flow_id or flow_name');
      const flow = params!.flow_id
        ? get(params!.flow_id)
        : Object.values(flows()).find(
            (flow) => flow.name === params!.flow_name && flow.waba_id === phone.waba_id,
          );
      if (!flow || flow.waba_id !== phone.waba_id) error('Flow does not belong to sender WABA');
      const mode = params!.mode ?? 'published';
      if (!['draft', 'published'].includes(mode)) error('Flow mode must be draft or published');
      if (mode === 'draft' ? flow!.status !== 'DRAFT' : flow!.status !== 'PUBLISHED')
        error('Flow is not available in this mode', 131008);
      if (!flow!.json || flow!.validation_errors.length) error('Flow has no valid JSON', 131008);
      if (flow!.unsupported) return unsupported('Flow schema/runtime');
      if (
        typeof params!.flow_cta !== 'string' ||
        ![...params!.flow_cta].length ||
        [...params!.flow_cta].length > 30
      )
        error('flow_cta must contain 1-30 characters');
      const action = params!.flow_action ?? 'navigate';
      if (!['navigate', 'data_exchange'].includes(action)) error('Invalid flow_action');
      if (
        params!.flow_token !== undefined &&
        (typeof params!.flow_token !== 'string' || !params!.flow_token.length)
      )
        error('Invalid flow_token');
      if (action === 'data_exchange' && !flow!.endpoint_uri)
        error('data_exchange Flow requires endpoint_uri');
      if (action === 'navigate') {
        const screen = params!.flow_action_payload?.screen ?? flow!.json.screens[0]?.id;
        if (!flow!.json.screens.some((value: Json) => value.id === screen))
          error('Unknown initial Flow screen');
      }
      return { type: 'flow', flow_id: flow!.id, title: flow!.name, cta: params!.flow_cta };
    },
  };
}
