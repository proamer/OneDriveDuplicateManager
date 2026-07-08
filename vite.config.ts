import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // Keep in sync with the Azure App Registration redirect URI (http://localhost:5173).
    // PORT override exists only for tooling; MSAL login requires the registered port.
    port: Number(process.env.PORT) || 5173,
  },
});
