import { spawnSync } from "node:child_process";

const action = process.argv[2] ?? "start";
const port = process.env.TRIGGER_PUBLIC_PORT ?? "47832";
const argumentsByAction = {
  start: ["funnel", "--bg", "--yes", port],
  status: ["funnel", "status"],
  reset: ["funnel", "reset"],
};
const args = argumentsByAction[action];

if (!args) {
  console.error("Usage: funnel.mjs <start|status|reset>");
  process.exitCode = 2;
} else {
  const result = spawnSync("tailscale", args, { stdio: "inherit" });
  if (result.error) {
    console.error(`Unable to run tailscale: ${result.error.message}`);
    process.exitCode = 1;
  } else {
    process.exitCode = result.status ?? 1;
  }
}
