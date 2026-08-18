import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // The OSM snapshot is a few megabytes of JSON. Inlined as an object literal
  // the browser has to parse it as JavaScript, which is markedly slower than
  // handing the same bytes to JSON.parse as a string.
  json: { stringify: true },
  server: { host: "127.0.0.1", port: 4173 },
});
