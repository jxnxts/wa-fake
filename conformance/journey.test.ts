import { afterEach, describe, expect, it } from 'vitest';
import { createWaFake } from '../packages/sdk-js/src/index.ts';
import { configureDemo } from '../examples/demo-endpoint.ts';

describe('real HTTP application journey', () => {
  const cleanup: (() => Promise<unknown>)[] = [];
  afterEach(async () => {
    for (const close of cleanup.reverse()) await close();
    cleanup.length = 0;
  });
  it('text -> buttons -> list -> encrypted INIT/exchange -> nfm_reply -> acknowledgement', async () => {
    const wa = await createWaFake();
    cleanup.push(wa.close);
    const { endpoint } = await configureDemo(wa, { port: 0 });
    cleanup.push(endpoint.close);
    const ana = wa.user('5511900000001', { name: 'Ana' });
    await ana.sendText('Hello');
    await wa.drain();
    const menu = await ana.expectMessage({ interactive: 'button' });
    await ana.tapButton(menu, 'menu');
    await wa.drain();
    const list = await ana.expectMessage({ interactive: 'list' });
    await ana.selectRow(list, 'flow');
    await wa.drain();
    const message = await ana.expectMessage({ interactive: 'flow' });
    const flow = await ana.openFlow(message);
    expect(flow.session.screen).toBe('FORM');
    await flow.fill({ name: 'Synthetic Ana', note: 'end-to-end test' });
    await flow.submit();
    expect(flow.session.screen).toBe('REVIEW');
    await flow.submit();
    await wa.drain();
    const ack = await ana.expectMessage({ type: 'text' });
    expect(ack.payload.text.body).toContain('nfm_reply');
    expect(
      endpoint.received.some((event) => event.kind === 'flow' && event.action === 'INIT'),
    ).toBe(true);
    const inbound = endpoint.received
      .filter((event) => event.kind === 'webhook')
      .flatMap((event) =>
        event.body.entry.flatMap((entry: any) =>
          entry.changes.flatMap((change: any) => change.value.messages ?? []),
        ),
      );
    const reply = inbound.find((message: any) => message.interactive?.type === 'nfm_reply');
    expect(JSON.parse(reply.interactive.nfm_reply.response_json)).toMatchObject({
      status: 'completed',
    });
  });
});
