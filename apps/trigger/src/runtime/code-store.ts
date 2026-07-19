import { access, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

import type { TriggerKind } from "../domain/types.js";
import { ValidationError } from "../domain/validation.js";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const unsupportedPatterns: { pattern: RegExp; message: string }[] = [
  {
    pattern: /(?:node:)?child_process/,
    message: "Starting child processes from Trigger code is unsupported",
  },
  {
    pattern: /(?:node:)?cluster/,
    message: "Creating clusters from Trigger code is unsupported",
  },
  {
    pattern: /(?:node:)?worker_threads/,
    message: "Creating Worker Threads from Trigger code is unsupported",
  },
  {
    pattern: /\bprocess\s*\.\s*(?:exit|abort|kill)\s*\(/,
    message: "Terminating processes from Trigger code is unsupported",
  },
];

export class TriggerCodeStore {
  readonly revisionDir: string;
  private readonly builds = new Map<string, Promise<string>>();

  constructor(dataDir: string) {
    this.revisionDir = resolve(dataDir, "runtime", "revisions");
  }

  modulePath(revisionId: string): string {
    return resolve(this.revisionDir, `${revisionId}.mjs`);
  }

  async compile(
    revisionId: string,
    code: string,
    kind: TriggerKind,
  ): Promise<string> {
    for (const unsupported of unsupportedPatterns) {
      if (unsupported.pattern.test(code)) {
        throw new ValidationError(unsupported.message);
      }
    }

    const outfile = this.modulePath(revisionId);
    await mkdir(dirname(outfile), { recursive: true });
    try {
      await build({
        stdin: {
          contents: code,
          loader: "ts",
          resolveDir: appRoot,
          sourcefile: `${kind}-trigger-${revisionId}.ts`,
        },
        outfile,
        bundle: true,
        platform: "node",
        target: "node22",
        format: "esm",
        sourcemap: "inline",
        logLevel: "silent",
      });
      return outfile;
    } catch (error) {
      await rm(outfile, { force: true });
      const message = error instanceof Error ? error.message : String(error);
      throw new ValidationError("Trigger code could not be compiled", [message]);
    }
  }

  async ensure(
    revisionId: string,
    code: string,
    kind: TriggerKind,
  ): Promise<string> {
    const path = this.modulePath(revisionId);
    try {
      await access(path);
      return path;
    } catch {
      const active = this.builds.get(revisionId);
      if (active) return await active;
      const build = this.compile(revisionId, code, kind).finally(() => {
        this.builds.delete(revisionId);
      });
      this.builds.set(revisionId, build);
      return await build;
    }
  }

  async remove(revisionId: string): Promise<void> {
    await rm(this.modulePath(revisionId), { force: true });
  }
}
