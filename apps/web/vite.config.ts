import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { varlockVitePlugin } from "@varlock/vite-integration";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 3001,
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("src", import.meta.url)),
    },
  },
  plugins: [
    varlockVitePlugin({
      ssrInjectMode: "init-only",
      ssrEntryCode: [
        `import ${JSON.stringify(fileURLToPath(new URL("src/validate-master-key.server.ts", import.meta.url)))};`,
      ],
    }),
    tailwindcss(),
    tanstackStart(),
    nitro({ preset: "node-server" }),
    viteReact(),
  ],
});
