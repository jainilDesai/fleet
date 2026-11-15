import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

const here = (f: string) => fileURLToPath(new URL(f, import.meta.url));

const fleetPort = Number(process.env.FLEET_PORT ?? 7789);
const fleet = `http://127.0.0.1:${fleetPort}`;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  optimizeDeps: { entries: ["index.html", "home.html"] },
  // The page is served by Fleet's server from public/, next to its old assets-free layout.
  // Two pages: the project office (index.html) and the home page (home.html, served by `fleet home`).
  build: { outDir: "../public", emptyOutDir: true, rollupOptions: { input: { index: here("index.html"), home: here("home.html") } } },
  server: {
    // Fleet's server reloads itself; don't reload the page for its files.
    watch: { ignored: ["**/server/**"] },
    // `npm run dev` runs on mock data. With Fleet running, these reach its server.
    proxy: { "/api": fleet, "/hook": fleet, "/mcp": fleet },
  },
});
