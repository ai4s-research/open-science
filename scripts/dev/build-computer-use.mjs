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
// Wired as Tauri's `beforeBundleCommand` rather than as a CI step of its own:
// the signing identity is in the keychain by then, and running it any earlier
// would sign the helper ad-hoc and fail notarization. Node, not bash, for the
// same reason `build-acp-server.mjs` is — it is the one interpreter every
// platform's build already has.
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
  const identity = resolveSigningIdentity();
  const args = ["--force", "--sign", identity];
  // Hardened runtime and a timestamp are what notarization requires; an ad-hoc
  // dev signature cannot carry them.
  if (identity !== "-") {
    args.push("--options", "runtime", "--timestamp");
  }
  run("codesign", [...args, appPath]);
  console.log(`Built and signed ${appPath} with identity: ${identity}`);
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
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
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
