import { defineConfig } from "vite";

// PAL_WEB_HOST: interface to listen on (e.g. your Tailscale IP). Default: localhost only.
// PAL_PORT: where the brain listens; its WebSocket is proxied at /ws so the browser
// never needs to reach the brain directly.
const brainPort = process.env.PAL_PORT ?? "18790";

// Cross-origin isolation lets the Kokoro voice run ONNX Runtime multi-threaded (~2x
// faster). Browsers only honour it on https or localhost; elsewhere it is ignored.
// "credentialless" still allows cross-origin loads such as the Hugging Face model files.
const isolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "credentialless",
};

export default defineConfig({
  server: {
    host: process.env.PAL_WEB_HOST || "127.0.0.1",
    port: Number(process.env.PAL_WEB_PORT ?? 5174),
    strictPort: true,
    headers: isolation,
    // Allow Tailscale MagicDNS names (e.g. my-pc.tailnet-name.ts.net).
    allowedHosts: [".ts.net"],
    proxy: {
      "/ws": { target: `ws://127.0.0.1:${brainPort}`, ws: true },
      "/api": { target: `http://127.0.0.1:${brainPort}` },
    },
  },
  preview: { headers: isolation },
  // The Kokoro voice worker imports modules, so workers are bundled as ES modules.
  worker: { format: "es" },
  appType: "spa",
});
