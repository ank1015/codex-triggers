import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const desktopRoot = fileURLToPath(new URL("../", import.meta.url));
const workspaceRoot = resolve(desktopRoot, "../..");
const releaseRoot = join(desktopRoot, "release");
const stagingRoot = join(releaseRoot, "staging");
const deployedApp = join(stagingRoot, "runtime");
const packagedApp = join(stagingRoot, "Codex Triggers.app");
const plistPath = join(packagedApp, "Contents", "Info.plist");
const resourcesPath = join(packagedApp, "Contents", "Resources");
const plistBuddy = "/usr/libexec/PlistBuddy";

const installerPackage = JSON.parse(
  await readFile(
    join(workspaceRoot, "packages", "codex-triggers", "package.json"),
    "utf8",
  ),
);
const version = installerPackage.version;
const architecture = process.arch;
if (
  process.env.GITHUB_REF_TYPE === "tag" &&
  process.env.GITHUB_REF_NAME !== `v${version}`
) {
  throw new Error(
    `Release tag ${process.env.GITHUB_REF_NAME} does not match installer version v${version}`,
  );
}
if (process.platform !== "darwin") {
  throw new Error("Codex Triggers releases can only be packaged on macOS");
}
if (architecture !== "arm64" && architecture !== "x64") {
  throw new Error(`Unsupported release architecture: ${architecture}`);
}

async function setPlistValue(key, value) {
  try {
    await execFileAsync(plistBuddy, ["-c", `Set :${key} ${value}`, plistPath]);
  } catch {
    await execFileAsync(plistBuddy, [
      "-c",
      `Add :${key} string ${value}`,
      plistPath,
    ]);
  }
}

async function buildRelease() {
  await rm(stagingRoot, { recursive: true, force: true });
  await mkdir(stagingRoot, { recursive: true });

  await execFileAsync(
    "pnpm",
    [
      "--config.node-linker=hoisted",
      "--filter",
      "@codexmaxxing/desktop",
      "deploy",
      "--prod",
      deployedApp,
    ],
    { cwd: workspaceRoot },
  );
  // Runtime code uses package APIs directly; executable shims are unnecessary
  // and are the only symlinks produced by the hoisted deployment.
  await rm(join(deployedApp, "node_modules", ".bin"), {
    recursive: true,
    force: true,
  });

  const electronExecutable = require("electron");
  const electronApp = resolve(dirname(electronExecutable), "../..");
  await cp(electronApp, packagedApp, {
    recursive: true,
    force: true,
    verbatimSymlinks: true,
  });

  await setPlistValue("CFBundleIdentifier", "com.codexmaxxing.triggers");
  await setPlistValue("CFBundleName", "Codex Triggers");
  await setPlistValue("CFBundleDisplayName", "Codex Triggers");
  await setPlistValue("CFBundleShortVersionString", version);
  await setPlistValue(
    "CFBundleVersion",
    process.env.GITHUB_RUN_NUMBER || version.replace(/\D/g, "") || "1",
  );
  await setPlistValue("CFBundleIconFile", "app-icon.icns");
  await setPlistValue("NSUserNotificationAlertStyle", "alert");

  await rm(join(resourcesPath, "default_app.asar"), { force: true });
  await rm(join(resourcesPath, "app"), { recursive: true, force: true });
  await cp(deployedApp, join(resourcesPath, "app"), {
    recursive: true,
    force: true,
  });
  await cp(
    join(desktopRoot, "assets", "app-icon.icns"),
    join(resourcesPath, "app-icon.icns"),
    { force: true },
  );

  await execFileAsync("codesign", [
    "--force",
    "--deep",
    "--sign",
    "-",
    packagedApp,
  ]);
  await execFileAsync("codesign", [
    "--verify",
    "--deep",
    "--strict",
    packagedApp,
  ]);

  const artifactName =
    `codex-triggers-v${version}-darwin-${architecture}.zip`;
  const artifactPath = join(releaseRoot, artifactName);
  await rm(artifactPath, { force: true });
  await execFileAsync("ditto", [
    "-c",
    "-k",
    "--sequesterRsrc",
    "--keepParent",
    packagedApp,
    artifactPath,
  ]);
  const checksum = createHash("sha256")
    .update(await readFile(artifactPath))
    .digest("hex");
  await writeFile(
    `${artifactPath}.sha256`,
    `${checksum}  ${artifactName}\n`,
    "utf8",
  );
  process.stdout.write(`${artifactPath}\n`);
}

await buildRelease();
