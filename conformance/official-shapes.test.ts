import { afterEach, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createWaFake } from '../packages/sdk-js/src/index.ts';

let close: (() => Promise<unknown>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});
function keysShape(value: any): any {
  if (Array.isArray(value)) return value.length ? [keysShape(value[0])] : [];
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, keysShape(value[key])]),
    );
  return typeof value;
}
it('text and interactive send responses match curated official response field shapes', async () => {
  const wa = await createWaFake();
  close = wa.close;
  const ana = wa.user('5511900000001');
  await ana.sendText('Oi');
  const fixtures = JSON.parse(
    readFileSync(new URL('./official/responses.json', import.meta.url), 'utf8'),
  );
  const expected = fixtures.find((fixture: any) => fixture.request === 'Send Text Message').body;
  const result = await wa.send(ana.waId, { type: 'text', text: { body: 'Hello' } });
  expect(keysShape(result)).toEqual(keysShape(expected));
  const button = await wa.send(ana.waId, {
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: 'Choose' },
      action: { buttons: [{ type: 'reply', reply: { id: 'ok', title: 'OK' } }] },
    },
  });
  expect(keysShape(button)).toEqual(keysShape(expected));
});
