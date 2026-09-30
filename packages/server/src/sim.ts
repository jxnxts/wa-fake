import { WaEngine, GraphError, unsupported, parseDuration } from '../../core/src/index.ts';
import type { RouteContext, Json } from '../../core/src/index.ts';
import { bearer, jsonBody } from '../../graph/src/index.ts';
export async function handleSim(request: Request, engine: WaEngine): Promise<Response> {
  const url = new URL(request.url),
    path = url.pathname,
    method = request.method;
  if (path.startsWith('/_wa/media/')) {
    const id = decodeURIComponent(path.slice('/_wa/media/'.length));
    const record = engine.store.media[id];
    engine.auth(bearer(request), 'graph', record?.phone_number_id);
    if (method !== 'GET') throw unsupported('media download method');
    const media = engine.downloadMedia(
      id,
      url.searchParams.get('expires'),
      url.searchParams.get('signature'),
    );
    return new Response(Buffer.from(media.data, 'base64'), {
      headers: {
        'content-type': media.mime_type,
        'content-length': String(media.file_size),
        'content-disposition': `inline; filename="${media.filename}"`,
        'cache-control': 'no-store',
      },
    });
  }
  engine.auth(
    bearer(request) ??
      (path === '/_wa/events' ? (url.searchParams.get('token') ?? undefined) : undefined),
    'sim',
  );
  if (path === '/_wa/events' && method === 'GET') {
    let unsubscribe: (() => void) | undefined;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (event: { type: string; data: unknown }) => {
          controller.enqueue(
            encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`),
          );
        };
        send({ type: 'ready', data: { now: engine.now() } });
        unsubscribe = engine.onEvent(send);
        request.signal.addEventListener(
          'abort',
          () => {
            unsubscribe?.();
            try {
              controller.close();
            } catch {}
          },
          { once: true },
        );
      },
      cancel() {
        unsubscribe?.();
      },
    });
    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      },
    });
  }
  if (path === '/_wa/state' && method === 'GET') return Response.json(engine.state());
  if (path === '/_wa/log' && method === 'GET') return Response.json({ data: engine.store.logs });
  if (path === '/_wa/users' && method === 'POST') {
    const data = await jsonBody(request);
    if (typeof data.wa_id !== 'string') throw new GraphError(100, 'wa_id is required');
    return Response.json(engine.user(data.wa_id, data));
  }
  if (path === '/_wa/config' && method === 'POST')
    return Response.json(await engine.configure(await jsonBody(request)));
  if (path === '/_wa/clock' && method === 'POST') {
    const data = await jsonBody(request);
    return Response.json(await engine.advance(data.advance ?? data.ms));
  }
  if (path === '/_wa/faults' && method === 'POST')
    return Response.json(engine.addFault(await jsonBody(request)));
  if (path === '/_wa/reset' && method === 'POST') {
    engine.reset();
    return Response.json({ success: true });
  }
  if (path === '/_wa/snapshot' && method === 'POST') return Response.json(engine.snapshot());
  if (path === '/_wa/restore' && method === 'POST') {
    const data = await jsonBody(request);
    return Response.json(await engine.restore(data.snapshot));
  }
  if (path === '/_wa/webhooks/drain' && method === 'POST') {
    const data = await jsonBody(request, true);
    if (Object.keys(data).some((key) => !['advance', 'limit'].includes(key)))
      throw unsupported('drain option');
    return Response.json(await engine.drain({ advance: data.advance ?? true, limit: data.limit }));
  }
  const redelivery = /^\/_wa\/webhooks\/([^/]+)\/redeliver$/.exec(path);
  if (redelivery && method === 'POST') return Response.json(await engine.redeliver(redelivery[1]!));
  if (path === '/_wa/outbox' && method === 'GET') {
    const to = url.searchParams.get('to'),
      type = url.searchParams.get('type'),
      since = url.searchParams.get('since');
    if (since && !/^\d+$/.test(since) && !engine.store.messages.some((m) => m.id === since))
      throw new GraphError(100, 'Unknown since message cursor');
    const start = since
      ? /^\d+$/.test(since)
        ? Number(since)
        : engine.store.messages.findIndex((m) => m.id === since) + 1
      : 0;
    const query = () =>
      engine.store.messages
        .slice(start)
        .filter(
          (m) => m.direction === 'outbound' && (!to || m.to === to) && (!type || m.type === type),
        );
    const wait = url.searchParams.get('wait');
    let messages = query();
    if (wait && !messages.length) {
      const ms = Math.min(parseDuration(/^\d+$/.test(wait) ? Number(wait) : wait), 30000);
      await new Promise<void>((resolve) => {
        let timer: ReturnType<typeof setTimeout>;
        const cleanup = () => {
          clearTimeout(timer);
          off();
          request.signal.removeEventListener('abort', cleanup);
          resolve();
        };
        const off = engine.onEvent((e) => {
          if (e.type === 'message' && query().length) cleanup();
        });
        timer = setTimeout(cleanup, ms);
        request.signal.addEventListener('abort', cleanup, { once: true });
      });
      messages = query();
    }
    return Response.json({ messages, cursor: engine.store.messages.length });
  }
  const userRoute = /^\/_wa\/users\/([^/]+)\/(send|tap|select|react)$/.exec(path);
  if (userRoute && method === 'POST') {
    const [, waId, action] = userRoute,
      data = await jsonBody(request);
    let result: Json;
    if (action === 'send') result = await engine.receiveMessage(waId!, data, data.phone_number_id);
    else if (action === 'tap') result = await engine.tap(waId!, data.message_id, data.button_id);
    else if (action === 'select') result = await engine.select(waId!, data.message_id, data.row_id);
    else {
      const target = engine.store.messages.find(
        (m) => m.id === data.message_id && (m.from === waId || m.to === waId),
      );
      if (!target) throw new GraphError(100, 'Unknown conversation message');
      result = await engine.receiveMessage(
        waId!,
        { type: 'reaction', reaction: { message_id: data.message_id, emoji: data.emoji } },
        target.phone_number_id,
      );
    }
    return Response.json(result);
  }
  const parts = path.slice('/_wa/'.length).split('/');
  const context: RouteContext = {
    method,
    id: parts[1] ?? '',
    edge: parts.slice(2).join('/'),
    version: 'sim',
    path,
    request,
    baseUrl: engine.config.baseUrl ?? url.origin,
    engine,
  };
  for (const extension of engine.extensions) {
    const response = await extension.sim(context);
    if (response) return response;
  }
  throw unsupported('Sim endpoint');
}
