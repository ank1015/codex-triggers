#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const packageRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageJson = JSON.parse(
  await readFile(join(packageRoot, "package.json"), "utf8"),
);
const version = packageJson.version;
const repository = "ank1015/codex-triggers";
const appName = "Codex Triggers.app";

function log(message) {
  process.stdout.write(`${message}\n`);
}

function fail(message) {
  process.stderr.write(`\nCodex Triggers could not be installed: ${message}\n`);
  process.exitCode = 1;
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function download(url, destination) {
  const response = await fetch(url, {
    headers: { "user-agent": `codex-triggers-installer/${version}` },
    redirect: "follow",
  });
  if (!response.ok || !response.body) {
    throw new Error(`download failed (${response.status}) for ${url}`);
  }
  await pipeline(response.body, createWriteStream(destination));
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function terminateRunningApp() {
  await execFile("osascript", [
    "-e",
    'tell application id "com.codexmaxxing.triggers" to quit',
  ]).catch(() => undefined);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
}

async function install() {
  if (process.platform !== "darwin") {
    throw new Error("the desktop app currently supports macOS only");
  }
  if (process.arch !== "arm64" && process.arch !== "x64") {
    throw new Error(`unsupported Mac architecture: ${process.arch}`);
  }

  const artifact = `codex-triggers-v${version}-darwin-${process.arch}.zip`;
  const releaseBase = `https://github.com/${repository}/releases/download/v${version}`;
  const temporary = await mkdtemp(join(tmpdir(), "codex-triggers-install-"));
  const archive = join(temporary, artifact);
  const extracted = join(temporary, "extracted");
  const applicationsDirectory = resolve(
    process.env.CODEX_TRIGGERS_APPLICATIONS_DIR || join(homedir(), "Applications"),
  );
  const destination = join(applicationsDirectory, appName);
  const backup = join(temporary, `${appName}.previous`);

  try {
    const localArchive = process.env.CODEX_TRIGGERS_ARCHIVE;
    if (localArchive) {
      log(`Using local release ${basename(localArchive)}…`);
      await cp(resolve(localArchive), archive);
    } else {
      const archiveUrl = process.env.CODEX_TRIGGERS_DOWNLOAD_URL ||
        `${releaseBase}/${artifact}`;
      log(`Downloading Codex Triggers v${version} for ${process.arch}…`);
      await download(archiveUrl, archive);

      const checksumUrl = process.env.CODEX_TRIGGERS_CHECKSUM_URL ||
        `${archiveUrl}.sha256`;
      const checksumPath = `${archive}.sha256`;
      await download(checksumUrl, checksumPath);
      const expected = (await readFile(checksumPath, "utf8"))
        .trim()
        .split(/\s+/)[0];
      const actual = await sha256(archive);
      if (!expected || expected !== actual) {
        throw new Error("the downloaded release checksum did not match");
      }
    }

    await mkdir(extracted, { recursive: true });
    await execFile("ditto", ["-x", "-k", archive, extracted]);
    const source = join(extracted, appName);
    if (!(await exists(source))) {
      throw new Error(`release archive does not contain ${appName}`);
    }

    log(`Installing to ${destination}…`);
    await mkdir(applicationsDirectory, { recursive: true });
    await terminateRunningApp();
    if (await exists(destination)) await rename(destination, backup);

    try {
      await cp(source, destination, {
        recursive: true,
        force: true,
        verbatimSymlinks: true,
      });
      await execFile("xattr", ["-dr", "com.apple.quarantine", destination])
        .catch(() => undefined);
      await execFile("codesign", [
        "--force",
        "--deep",
        "--sign",
        "-",
        destination,
      ]);
      await execFile("codesign", ["--verify", "--deep", "--strict", destination]);
    } catch (error) {
      await rm(destination, { recursive: true, force: true });
      if (await exists(backup)) await rename(backup, destination);
      throw error;
    }

    await rm(backup, { recursive: true, force: true });
    if (process.env.CODEX_TRIGGERS_SKIP_LAUNCH !== "1") {
      await execFile("open", [destination]);
    }
    log("\nCodex Triggers is installed.");
    log("Open it and click “Let's Start” to verify Codex and install the skill.");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

try {
  await install();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
