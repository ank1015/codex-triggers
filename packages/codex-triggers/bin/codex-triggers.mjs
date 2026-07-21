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
import { Transform } from "node:stream";
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

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
}

function progress(message, done = false) {
  if (process.stdout.isTTY) {
    process.stdout.write(`\r\u001b[2K${message}${done ? "\n" : ""}`);
  } else if (done) {
    log(message);
  }
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

async function download(url, destination, { showProgress = false } = {}) {
  const response = await fetch(url, {
    headers: { "user-agent": `codex-triggers-installer/${version}` },
    redirect: "follow",
  });
  if (!response.ok || !response.body) {
    throw new Error(`download failed (${response.status}) for ${url}`);
  }
  const total = Number(response.headers.get("content-length")) || null;
  let received = 0;
  let lastUpdate = 0;
  const tracker = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      const now = Date.now();
      if (showProgress && now - lastUpdate >= 200) {
        const percent = total ? ` (${Math.round((received / total) * 100)}%)` : "";
        progress(`   ${formatBytes(received)}${total ? ` / ${formatBytes(total)}` : ""}${percent}`);
        lastUpdate = now;
      }
      callback(null, chunk);
    },
  });
  await pipeline(response.body, tracker, createWriteStream(destination));
  if (showProgress) {
    progress(
      `   ${formatBytes(received)}${total ? ` / ${formatBytes(total)}` : ""} (100%)`,
      true,
    );
  }
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
    log(`[1/6] Preparing Codex Triggers v${version} for ${process.arch}…`);
    const localArchive = process.env.CODEX_TRIGGERS_ARCHIVE;
    if (localArchive) {
      log(`[2/6] Using local release ${basename(localArchive)}…`);
      await cp(resolve(localArchive), archive);
    } else {
      const archiveUrl = process.env.CODEX_TRIGGERS_DOWNLOAD_URL ||
        `${releaseBase}/${artifact}`;
      log(`[2/6] Downloading application…`);
      await download(archiveUrl, archive, { showProgress: true });

      const checksumUrl = process.env.CODEX_TRIGGERS_CHECKSUM_URL ||
        `${archiveUrl}.sha256`;
      const checksumPath = `${archive}.sha256`;
      await download(checksumUrl, checksumPath);
      log(`[3/6] Verifying download integrity…`);
      const expected = (await readFile(checksumPath, "utf8"))
        .trim()
        .split(/\s+/)[0];
      const actual = await sha256(archive);
      if (!expected || expected !== actual) {
        throw new Error("the downloaded release checksum did not match");
      }
    }

    if (localArchive) log(`[3/6] Local release selected; checksum skipped.`);
    log(`[4/6] Extracting application…`);
    await mkdir(extracted, { recursive: true });
    await execFile("ditto", ["-x", "-k", archive, extracted]);
    const source = join(extracted, appName);
    if (!(await exists(source))) {
      throw new Error(`release archive does not contain ${appName}`);
    }

    log(`[5/6] Installing and signing ${destination}…`);
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
      log(`[6/6] Launching Codex Triggers…`);
      await execFile("open", [destination]);
    } else {
      log(`[6/6] Launch skipped.`);
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
