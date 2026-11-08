import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Vite configuration for OpenDriveTeX.
 * Defines `global: 'globalThis'` to ensure compatibility with WebRTC
 * peer dependencies (such as simple-peer inside y-webrtc) in browser environments.
 */
export default defineConfig({
  plugins: [react()],
  define: {
    global: 'globalThis',
  },
  server: { allowedHosts: true },
  preview: { allowedHosts: true },
});

