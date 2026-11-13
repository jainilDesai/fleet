// Bundles the agent-team server (hq/server) into one ESM file that Fleet's server imports.
// Everything is bundled, including the MCP SDK and zod, so Fleet keeps zero runtime dependencies.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

await build({
  entryPoints: [here("./server/index.ts")],
  outfile: here("../dist/hq.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  // Some bundled CommonJS code calls require(); give the ESM bundle one.
  banner: { js: 'import { createRequire as __fleetRequire } from "node:module"; const require = __fleetRequire(import.meta.url);' },
  sourcemap: false,
  logLevel: "warning",
});
console.log("built dist/hq.mjs");
