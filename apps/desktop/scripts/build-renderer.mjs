import { build } from "esbuild";

await build({
  entryPoints: [new URL("../src/renderer.tsx", import.meta.url).pathname],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "chrome150",
  outfile: new URL("../dist/renderer.js", import.meta.url).pathname,
  sourcemap: true,
  jsx: "automatic",
});
