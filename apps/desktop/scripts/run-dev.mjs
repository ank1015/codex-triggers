import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { prepareDevApp } from "./prepare-dev-app.mjs";

const appDirectory = fileURLToPath(new URL("../", import.meta.url));
const executable = await prepareDevApp();
const child = spawn(executable, [appDirectory], {
  cwd: appDirectory,
  env: process.env,
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.once("error", (error) => {
  console.error("Could not launch the Codex Triggers development app", error);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
