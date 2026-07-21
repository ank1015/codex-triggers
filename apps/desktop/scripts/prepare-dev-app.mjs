import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createRequire } from "node:module";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const electronExecutable = require("electron");
const electronApp = resolve(dirname(electronExecutable), "../..");
const developmentDirectory = join(packageRoot, ".dev");
const developmentApp = join(developmentDirectory, "Codex Triggers.app");
const markerPath = join(developmentDirectory, "Codex Triggers.source");
const plistPath = join(developmentApp, "Contents", "Info.plist");
const iconSource = join(packageRoot, "assets", "app-icon.icns");
const plistBuddy = "/usr/libexec/PlistBuddy";

async function signingIdentity() {
  const { stdout } = await execFileAsync("security", [
    "find-identity",
    "-v",
    "-p",
    "codesigning",
  ]);
  const preferred = stdout
    .split("\n")
    .find((line) => line.includes('"Apple Development:'));
  const fallback = stdout
    .split("\n")
    .find((line) => /\b[0-9A-F]{40}\b/.test(line));
  const match = (preferred ?? fallback)?.match(/\b[0-9A-F]{40}\b/);
  if (!match) {
    throw new Error(
      "A macOS code-signing identity is required for native notifications. Add an Apple Development certificate in Xcode and try again.",
    );
  }
  return match[0];
}

async function setPlistValue(key, value) {
  try {
    await execFileAsync(plistBuddy, ["-c", `Set :${key} ${value}`, plistPath]);
  } catch {
    await execFileAsync(plistBuddy, ["-c", `Add :${key} string ${value}`, plistPath]);
  }
}

export async function prepareDevApp() {
  const electronPackage = require("electron/package.json");
  const iconHash = createHash("sha256")
    .update(await readFile(iconSource))
    .digest("hex");
  const sourceMarker = JSON.stringify({
    electronVersion: electronPackage.version,
    electronApp,
    iconHash,
    bundleVersion: 3,
  });
  const currentMarker = await readFile(markerPath, "utf8").catch(() => null);

  if (currentMarker !== sourceMarker) {
    await rm(developmentApp, { recursive: true, force: true });
    await mkdir(developmentDirectory, { recursive: true });
    await cp(electronApp, developmentApp, {
      recursive: true,
      force: true,
      verbatimSymlinks: true,
    });
    await setPlistValue("CFBundleIdentifier", "com.codexmaxxing.triggers.dev");
    await setPlistValue("CFBundleName", "Codex Triggers");
    await setPlistValue("CFBundleDisplayName", "Codex Triggers");
    await setPlistValue("CFBundleShortVersionString", "0.0.0");
    await setPlistValue("CFBundleVersion", "2");
    await setPlistValue("CFBundleIconFile", "app-icon.icns");
    await setPlistValue("NSUserNotificationAlertStyle", "alert");
    await cp(
      iconSource,
      join(developmentApp, "Contents", "Resources", "app-icon.icns"),
      { force: true },
    );

    const identity = await signingIdentity();
    await execFileAsync("codesign", [
      "--force",
      "--deep",
      "--sign",
      identity,
      developmentApp,
    ]);
    await execFileAsync("codesign", [
      "--verify",
      "--deep",
      "--strict",
      developmentApp,
    ]);
    await writeFile(markerPath, sourceMarker, "utf8");
  }

  await execFileAsync("open", ["-Ra", developmentApp]);
  return join(developmentApp, "Contents", "MacOS", "Electron");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${await prepareDevApp()}\n`);
}
