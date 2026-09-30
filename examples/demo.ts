import { WaFakeClient } from '../packages/sdk-js/src/index.ts';
import { configureDemo } from './demo-endpoint.ts';

const client = new WaFakeClient({ url: process.env.WA_FAKE_URL });
const { endpoint, flowId } = await configureDemo(client);
await client.user('5511900000001', { name: 'Ana · demo' }).ensure();
await client.user('5511900000002', { name: 'Bruno · demo' }).ensure();
console.log(
  `Local demo ready. Endpoint: ${endpoint.url}; Flow: ${flowId}. Open ${client.url}, select Ana and type hello.`,
);
process.once('SIGINT', async () => {
  await endpoint.close();
  process.exit(0);
});
process.once('SIGTERM', async () => {
  await endpoint.close();
  process.exit(0);
});
