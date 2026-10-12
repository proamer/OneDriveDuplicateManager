import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
// @ts-ignore Local Node-only module; never imported by browser application code.
import { googleSessionHandler } from './server/googleSession.mjs';

export default defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const credential = env.GOOGLE_OAUTH_CLIENT_FILE ? JSON.parse(readFileSync(env.GOOGLE_OAUTH_CLIENT_FILE, 'utf8')).web : undefined;
  if (credential && credential.client_id !== env.VITE_GOOGLE_CLIENT_ID) throw new Error('Google OAuth client file must match VITE_GOOGLE_CLIENT_ID');
  const clientSecret = env.GOOGLE_CLIENT_SECRET || credential?.client_secret;
  const port = Number(process.env.PORT) || 5173;
  const autoRefresh = command === 'serve' && Boolean(clientSecret && env.VITE_GOOGLE_CLIENT_ID);
  return {
  define: { 'import.meta.env.VITE_GOOGLE_AUTO_REFRESH': JSON.stringify(autoRefresh) },
  plugins: [react(), { name: 'local-google-session', configureServer(server) {
    server.middlewares.use(googleSessionHandler({ clientId: env.VITE_GOOGLE_CLIENT_ID, clientSecret, origin: `http://localhost:${port}` }));
  } }],
  server: {
    // Keep in sync with the Azure App Registration redirect URI (http://localhost:5173).
    // PORT override exists only for tooling; MSAL login requires the registered port.
    port,
    strictPort: true,
    fs: { deny: ['.env', '.env.*', '**/.env*', '*.{crt,pem}', '**/.git/**', '**/client_secret*.json'] },
  },
}; });
