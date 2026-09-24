// Stage the native computer-use providers into the directory Tauri bundles.
//
//   node scripts/dev/build-computer-use.mjs
//
// Three providers, one per platform, all landing in one directory so the agent
// runtime needs exactly one path to find any of them:
//
//   apps/desktop/src-tauri/computer-use/
//     runtime.py                        Linux, AT-SPI
//     runtime.ps1                       Windows, UI Automation
//     Open Science Computer Use.app     macOS, accessibility API (built here)
//
// The two scripts are copied on every platform — they cost nothing and keep the
// staged layout identical everywhere. The macOS helper is compiled and signed
// only on macOS, because only a signed app bundle can hold a TCC grant, and the
// grant follows the signature.
//
// Wired as Tauri's `beforeBundleCommand` so the helper lands in the bundle
// directory right before Tauri signs and notarizes the whole app. In CI the
// signing identity is NOT in any keychain yet at that point — Tauri imports
// `APPLE_CERTIFICATE` into its own keychain later, while bundling, and deletes
// it afterwards — so when that certificate is in the environment this script
// imports it into a throwaway keychain of its own (see `withReleaseKeychain`).
// Node, not bash, for the same reason `build-acp-server.mjs` is — it is the one
// interpreter every platform's build already has.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const stage = path.join(root, "apps", "desktop", "src-tauri", "computer-use");
const BUNDLE_ID = "com.ai4s.workbench.computer-use";
const DISPLAY_NAME = "Open Science Computer Use";

mkdirSync(stage, { recursive: true });
copyFileSync(path.join(root, "native/computer-use-linux/runtime.py"), path.join(stage, "runtime.py"));
copyFileSync(path.join(root, "native/computer-use-windows/runtime.ps1"), path.join(stage, "runtime.ps1"));
console.log(`Staged runtime.py and runtime.ps1 in ${stage}`);

if (process.platform !== "darwin") {
  process.exit(0);
}

const packagePath = path.join(root, "native", "computer-use-macos");
const appPath = path.join(stage, `${DISPLAY_NAME}.app`);
const executablePath = path.join(appPath, "Contents", "MacOS", "osd-computer-use-macos");

buildUniversalHelper();
writeBundle();
sign();

/** Universal, because the helper is exec'd by whichever architecture the agent
 *  runtime happens to be, and a mismatch reads to the user as "computer use does
 *  not work on this Mac". */
function buildUniversalHelper() {
  const triples = ["arm64-apple-macosx", "x86_64-apple-macosx"];
  const built = triples.map((triple) => {
    run("swift", ["build", "-c", "release", "--package-path", packagePath, "--triple", triple]);
    return path.join(packagePath, ".build", triple, "release", "osd-computer-use-macos");
  });
  rmSync(appPath, { recursive: true, force: true });
  mkdirSync(path.dirname(executablePath), { recursive: true });
  run("lipo", ["-create", ...built, "-output", executablePath]);
  chmodSync(executablePath, 0o755);
}

function writeBundle() {
  const resources = path.join(appPath, "Contents", "Resources");
  mkdirSync(resources, { recursive: true });
  copyFileSync(
    path.join(root, "apps/desktop/src-tauri/icons/icon.icns"),
    path.join(resources, "AppIcon.icns"),
  );
  writeFileSync(path.join(appPath, "Contents", "Info.plist"), infoPlist(), "utf8");
}

function sign() {
  withReleaseKeychain((keychain) => {
    const identity = resolveSigningIdentity();
    const args = ["--force", "--sign", identity];
    // Hardened runtime and a timestamp are what notarization requires; an ad-hoc
    // dev signature cannot carry them.
    if (identity !== "-") {
      args.push("--options", "runtime", "--timestamp");
    }
    if (keychain) {
      args.push("--keychain", keychain);
    }
    run("codesign", [...args, appPath]);
    console.log(`Built and signed ${appPath} with identity: ${identity}`);
  });
}

/** CI hands the release certificate over as base64 (`APPLE_CERTIFICATE`), the
 *  same variables Tauri reads. Import it into a keychain that exists only for
 *  this one codesign call and delete it afterwards: leaving it on the search
 *  list would put a second copy of the identity next to the one Tauri imports,
 *  and codesign refuses an identity name that matches twice. */
function withReleaseKeychain(signWith) {
  const certificate = process.env.APPLE_CERTIFICATE;
  if (!certificate) {
    signWith(null);
    return;
  }
  const dir = mkdtempSync(path.join(tmpdir(), "osd-computer-use-sign-"));
  const keychain = path.join(dir, "sign.keychain-db");
  const p12 = path.join(dir, "cert.p12");
  const password = randomBytes(24).toString("hex");
  const searchList = keychainSearchList();
  // Restoring an empty list below would wipe the user's keychain search list.
  if (searchList.length === 0) {
    throw new Error("could not read the keychain search list; refusing to change it");
  }
  try {
    writeFileSync(p12, Buffer.from(certificate, "base64"), { mode: 0o600 });
    run("security", ["create-keychain", "-p", password, keychain]);
    run("security", ["set-keychain-settings", "-lut", "3600", keychain]);
    run("security", ["unlock-keychain", "-p", password, keychain]);
    run("security", [
      "import", p12, "-k", keychain, "-f", "pkcs12",
      "-P", process.env.APPLE_CERTIFICATE_PASSWORD ?? "", "-T", "/usr/bin/codesign",
    ]);
    // Without this, codesign stops at a GUI "allow access" prompt nobody can click.
    run("security", ["set-key-partition-list", "-S", "apple-tool:,apple:,codesign:", "-s", "-k", password, keychain]);
    // On the search list too, so codesign can build the certificate chain.
    run("security", ["list-keychains", "-d", "user", "-s", keychain, ...searchList]);
    signWith(keychain);
  } finally {
    spawnSync("security", ["list-keychains", "-d", "user", "-s", ...searchList], { stdio: "inherit" });
    spawnSync("security", ["delete-keychain", keychain], { stdio: "inherit" });
    rmSync(dir, { recursive: true, force: true });
  }
}

function keychainSearchList() {
  const listed = spawnSync("security", ["list-keychains", "-d", "user"], { encoding: "utf8" });
  return (listed.stdout ?? "")
    .split("\n")
    .map((line) => line.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
}

/** The release identity when the build has one, otherwise whatever this machine
 *  has, otherwise ad-hoc so a dev build still runs — it just cannot keep a TCC
 *  grant across rebuilds. */
function resolveSigningIdentity() {
  const explicit = process.env.OSD_COMPUTER_USE_SIGN_IDENTITY ?? process.env.APPLE_SIGNING_IDENTITY;
  if (explicit) {
    return explicit;
  }
  const found = spawnSync("security", ["find-identity", "-v", "-p", "codesigning"], {
    encoding: "utf8",
  });
  if (found.status !== 0 || !found.stdout) {
    return "-";
  }
  const pick = (label) => found.stdout.match(new RegExp(`"([^"]*${label}:[^"]+)"`))?.[1];
  return pick("Developer ID Application") ?? pick("Apple Development") ?? "-";
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.signal) {
    process.kill(process.pid, result.signal);
  }
  // Throw rather than exit, so `withReleaseKeychain` still gets to clean up.
  if (result.status !== 0) {
    throw new Error(`${command} ${args[0]} exited with ${result.status ?? "an error"}`);
  }
}

function infoPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleExecutable</key>
  <string>osd-computer-use-macos</string>
  <key>CFBundleIdentifier</key>
  <string>${BUNDLE_ID}</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>CFBundleName</key>
  <string>${DISPLAY_NAME}</string>
  <key>CFBundleDisplayName</key>
  <string>${DISPLAY_NAME}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>14.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSAccessibilityUsageDescription</key>
  <string>${DISPLAY_NAME} needs Accessibility permission to read and interact with app interfaces when you ask the workbench to use an app.</string>
  <key>NSScreenCaptureUsageDescription</key>
  <string>${DISPLAY_NAME} needs Screen Recording permission to capture app windows when you ask the workbench to look at one.</string>
</dict>
</plist>
`;
}
