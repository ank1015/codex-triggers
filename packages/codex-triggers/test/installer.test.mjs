import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("installer package exposes the npx command", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.equal(packageJson.name, "codex-triggers");
  assert.equal(packageJson.bin["codex-triggers"], "./bin/codex-triggers.mjs");
  assert.match(packageJson.version, /^\d+\.\d+\.\d+$/);
});
