import { afterEach, expect, it } from 'vitest';
import { WhatsAppClient } from '@kapso/whatsapp-cloud-api';
import { createWaFake } from '../packages/sdk-js/src/index.ts';

let close: (() => Promise<unknown>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});
it('unmodified Kapso Cloud API SDK sends messages, marks read and uploads/downloads/deletes media', async () => {
  const wa = await createWaFake();
  close = wa.close;
  const ana = wa.user('5511900000001');
  const inbound = await ana.sendText('Hello');
  const client = new WhatsAppClient({
    baseUrl: wa.url,
    accessToken: 'wa-fake-token',
    graphVersion: 'v23.0',
  });
  const text = await client.messages.sendText({
    phoneNumberId: wa.phoneId,
    to: ana.waId,
    body: 'Message from the external SDK',
  });
  expect(text.messages?.[0]?.id).toMatch(/^wamid\./);
  const record = await ana.expectMessage({ type: 'text' });
  expect(record.payload.text.body).toBe('Message from the external SDK');
  await client.messages.sendInteractiveButtons({
    phoneNumberId: wa.phoneId,
    to: ana.waId,
    bodyText: 'Choose',
    buttons: [{ id: 'ok', title: 'Confirm' }],
  });
  const menu = await ana.expectMessage({ interactive: 'button' });
  await ana.tapButton(menu, 'ok');
  const id = inbound.id ?? inbound.message?.id;
  expect(
    await client.messages.markRead({
      phoneNumberId: wa.phoneId,
      messageId: id,
      typingIndicator: { type: 'text' },
    }),
  ).toMatchObject({ success: true });
  const bytes = Buffer.from('%PDF-1.4\nsynthetic fixture\n%%EOF');
  const media = await client.media.upload({
    phoneNumberId: wa.phoneId,
    type: 'application/pdf',
    file: bytes,
    fileName: 'synthetic.pdf',
  });
  const metadata = await client.media.get({ mediaId: media.id });
  expect(Number(metadata.fileSize)).toBe(bytes.length);
  expect(metadata.sha256).toMatch(/^[a-f0-9]{64}$/);
  const download = await client.media.download({ mediaId: media.id, auth: 'always' });
  expect(Buffer.from(download as ArrayBuffer)).toEqual(bytes);
  await client.messages.sendDocument({
    phoneNumberId: wa.phoneId,
    to: ana.waId,
    document: { id: media.id, filename: 'synthetic.pdf' },
  });
  expect((await ana.expectMessage({ type: 'document' })).payload.document.id).toBe(media.id);
  expect(await client.media.delete({ mediaId: media.id })).toMatchObject({ success: true });
});
