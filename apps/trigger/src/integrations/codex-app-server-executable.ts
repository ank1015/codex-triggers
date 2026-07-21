import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function executableCandidates(): string[] {
  return [
    process.env.TRIGGER_CODEX_EXECUTABLE?.trim(),
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    "/Applications/Codex.app/Contents/Resources/codex",
    "codex",
  ].filter((candidate): candidate is string => Boolean(candidate));
}

export async function findCodexAppServerExecutable(): Promise<string | null> {
  for (const candidate of [...new Set(executableCandidates())]) {
    if (candidate.includes("/")) {
      try {
        await access(candidate);
      } catch {
        continue;
      }
    }
    try {
      await execFileAsync(candidate, ["app-server", "--help"], {
        timeout: 5_000,
        maxBuffer: 1_000_000,
      });
      return candidate;
    } catch {
      // Try the next installed Codex executable.
    }
  }
  return null;
}

export async function requireCodexAppServerExecutable(): Promise<string> {
  const executable = await findCodexAppServerExecutable();
  if (!executable) {
    throw new Error(
      "Codex app-server is not available. Install or update the Codex app, then try again.",
    );
  }
  return executable;
}
