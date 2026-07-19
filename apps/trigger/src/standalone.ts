import { loadConfig } from "./config/index.js";
import { TriggerServer } from "./server.js";

const server = new TriggerServer(loadConfig());
const addresses = await server.start();

console.log(`Trigger control API listening on ${addresses.control.origin}`);
console.log(`Trigger webhook gateway listening on ${addresses.public.origin}`);

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}; shutting down Trigger`);
  await server.stop();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
