import { copyFile, cp, mkdir } from "node:fs/promises";

const source = new URL("../src/", import.meta.url);
const destination = new URL("../dist/", import.meta.url);

await mkdir(destination, { recursive: true });
await Promise.all(
  ["index.html", "styles.css"].map((file) =>
    copyFile(new URL(file, source), new URL(file, destination)),
  ),
);
await copyFile(
  new URL("../../../logo-2.png", import.meta.url),
  new URL("logo-2.png", destination),
);
await cp(
  new URL("../../../skills/manage-codex-triggers/", import.meta.url),
  new URL("skills/manage-codex-triggers/", destination),
  { recursive: true, force: true },
);
