import { Hono } from 'hono';
import { serve, getRequestListener } from '@hono/node-server';
import { createServer as createHttpsServer } from 'node:https';
import { readFile } from 'node:fs/promises';
import { dirname, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { WaEngine, GraphError, errorResponse, isLoopback } from '../../core/src/index.ts';
import type { EngineOptions, GraphExtension } from '../../core/src/index.ts';
import { handleGraph } from '../../graph/src/index.ts';
import { handleSim } from './sim.ts';
import { createTemplates } from '../../templates/src/index.ts';
import { createFlows } from '../../flows/src/index.ts';
export interface ServerOptions extends EngineOptions {
  port?: number;
  host?: string;
  cert?: string;
  key?: string;
  inspectorDir?: string;
  engine?: WaEngine;
  extensions?: GraphExtension[];
}
const moduleDir = dirname(fileURLToPath(import.meta.url));
const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
};
export function createApp(engine: WaEngine, options: { inspectorDir?: string } = {}) {
  const app = new Hono();
  app.onError((error) => errorResponse(error));
  app.use('*', async (c, next) => {
    // Reject hostile Host/Origin values as well as binding the listener to loopback.
    const host = new URL(c.req.url).hostname.replace(/^\[|\]$/g, '');
    if (host !== 'localhost' && !isLoopback(host))
      return errorResponse(new GraphError(100, 'Server is loopback-only', 403));
    const origin = c.req.header('origin');
    if (origin) {
      try {
        const originUrl = new URL(origin);
        if (originUrl.origin !== new URL(engine.config.baseUrl ?? c.req.url).origin)
          return errorResponse(
            new GraphError(100, 'Cross-origin browser requests are refused', 403),
          );
      } catch {
        return errorResponse(new GraphError(100, 'Invalid Origin', 403));
      }
    }
    await next();
    if (c.req.path.startsWith('/v') || c.req.path.startsWith('/_wa/'))
      engine.log('http', {
        method: c.req.method,
        path: c.req.path.replace(/[^/a-zA-Z0-9_.-]/g, '_').slice(0, 180),
        status: c.res.status,
      });
    c.header('x-content-type-options', 'nosniff');
    c.header('cache-control', 'no-store');
  });
  app.get('/health', (c) => c.json({ status: 'ok', mode: 'synthetic-only' }));
  app.all('/_wa/*', (c) => handleSim(c.req.raw, engine));
  app.all('/v*', (c) => handleGraph(c.req.raw, engine));
  app.get('*', async (c) => {
    if (
      c.req.path !== '/' &&
      !c.req.path.startsWith('/assets/') &&
      !['/favicon.ico', '/favicon.svg'].includes(c.req.path)
    )
      return c.json({ error: { code: 100, message: 'not_implemented: unknown endpoint' } }, 501);
    const relative = c.req.path === '/' ? 'index.html' : decodeURIComponent(c.req.path.slice(1));
    const directories = options.inspectorDir
      ? [resolve(options.inspectorDir)]
      : [
          resolve(moduleDir, 'inspector'),
          resolve(moduleDir, '../inspector'),
          resolve(moduleDir, '../../inspector/dist'),
          resolve(process.cwd(), 'packages/inspector/dist'),
          resolve(process.cwd(), 'dist/inspector'),
        ];
    for (const dir of directories) {
      const file = resolve(dir, relative);
      if (!file.startsWith(dir + '/')) continue;
      try {
        return new Response(await readFile(file), {
          headers: { 'content-type': types[extname(file)] ?? 'application/octet-stream' },
        });
      } catch {}
    }
    if (c.req.path === '/')
      return c.html(
        '<!doctype html><title>wa-fake</title><h1>wa-fake · simulated environment</h1><p>Inspector assets are not built. Run pnpm build. Authenticated state: /_wa/state.</p>',
      );
    return c.notFound();
  });
  app.notFound((c) =>
    c.json({ error: { code: 100, message: 'not_implemented: unknown endpoint' } }, 501),
  );
  return app;
}
export async function createWaFake(options: ServerOptions = {}) {
  const host = options.host ?? '127.0.0.1';
  if (host !== 'localhost' && !isLoopback(host))
    throw new GraphError(100, 'Server must bind to loopback');
  if (!!options.cert !== !!options.key)
    throw new GraphError(100, 'HTTPS requires both cert and key');
  const engine = options.engine ?? new WaEngine(options);
  engine.extensions = options.extensions ?? [createTemplates(engine), createFlows(engine)];
  const app = createApp(engine, options);
  let server: Server;
  const port = options.port ?? (options.cert ? 58990 : 58991);
  if (options.cert && options.key) {
    const [cert, key] = await Promise.all([readFile(options.cert), readFile(options.key)]);
    server = createHttpsServer({ cert, key }, getRequestListener(app.fetch));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => resolve());
    });
  } else {
    server = serve({ fetch: app.fetch, port, hostname: host }) as Server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      if (server.listening) resolve();
      else server.once('listening', resolve);
    });
  }
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Cannot resolve bound address');
  const baseUrl = `${options.cert ? 'https' : 'http'}://${host.includes(':') ? '[' + host + ']' : host}:${address.port}`;
  engine.config.baseUrl = baseUrl;
  try {
    if (options.webhookUrl) await engine.configure({ webhook_url: options.webhookUrl });
  } catch (error) {
    server.close();
    throw error;
  }
  return {
    engine,
    app,
    baseUrl,
    url: baseUrl,
    graphToken: engine.config.graphToken as string,
    simToken: engine.config.simToken as string,
    user: (waId: string, persona: Record<string, unknown> = {}) => engine.user(waId, persona),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections?.();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
