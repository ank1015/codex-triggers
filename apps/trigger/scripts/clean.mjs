import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(appRoot, "dist");

if (dirname(dist) !== appRoot) {
  throw new Error("Refusing to clean outside the Trigger application directory");
}

await rm(dist, { recursive: true, force: true });
