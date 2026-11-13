import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const fleetPort = Number(process.env.FLEET_PORT ?? 7788);
const fleet = `http://127.0.0.1:${fleetPort}`;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  optimizeDeps: { entries: ["index.html"] },
  // The page is served by Fleet's server from public/, next to its old assets-free layout.
  build: { outDir: "../public", emptyOutDir: true },
  server: {
    // Fleet's server reloads itself; don't reload the page for its files.
    watch: { ignored: ["**/server/**"] },
    // `npm run dev` runs on mock data. With Fleet running, these reach its server.
    proxy: { "/api": fleet, "/hook": fleet, "/mcp": fleet },
  },
});
