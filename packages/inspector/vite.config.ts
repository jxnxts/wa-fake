import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
const localProxy = {
  target: 'http://127.0.0.1:58991',
  changeOrigin: true,
  configure: (proxy: any) =>
    proxy.on('proxyReq', (request: any, incoming: any) => {
      // The API correctly refuses cross-origin mutations. Translate only our loopback
      // Vite origin while preserving that check for every other caller.
      if (incoming.headers.origin === 'http://127.0.0.1:5173')
        request.setHeader('origin', 'http://127.0.0.1:58991');
    }),
};
export default defineConfig({
  plugins: [vue()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: { '/_wa': localProxy, '/v23.0': localProxy },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
