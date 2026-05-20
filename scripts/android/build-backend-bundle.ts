import { existsSync, mkdirSync, rmSync, cpSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), "../..");
const outputDir = join(repoRoot, "apps", "android-shell", "android-assets", "backend");
const stageDir = join(repoRoot, ".tmp", "android-backend-bundle");
const bunLockFile = join(repoRoot, "bun.lock");
const npmLockFile = join(repoRoot, "package-lock.json");

function logStep(step: string, message: string) { console.log(`[android:build-backend-bundle] ${step}: ${message}`); }
function hardFail(message: string, details?: string): never { console.error(`\n[android:build-backend-bundle] ERROR: ${message}`); if (details) console.error(details); process.exit(1); }
function run(cmd: string, args: string[], cwd = repoRoot) {
  const res = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  if (res.status !== 0) hardFail(`Command failed: ${cmd} ${args.join(" ")}`, [res.stdout, res.stderr].filter(Boolean).join("\n"));
  return { stdout: res.stdout.trim(), stderr: res.stderr.trim() };
}
function findNodeBinaries(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) findNodeBinaries(full, acc);
    else if (entry.endsWith(".node")) acc.push(full);
  }
  return acc;
}
function isAndroidNodeBinary(path: string): boolean {
  const lower = path.toLowerCase();
  if (lower.includes("android") || lower.includes("arm64") || lower.includes("aarch64")) return true;
  if (lower.includes("linux-x64") || lower.includes("darwin") || lower.includes("win32") || lower.includes("musl-x64") || lower.includes("gnu")) return false;
  return false;
}
function ensureDependencies() {
  if (!existsSync(join(repoRoot, "node_modules"))) {
    logStep("deps", "node_modules missing; running bun install");
    run("bun", existsSync(bunLockFile) ? ["install", "--frozen-lockfile"] : ["install"]); return;
  }
  const lockPath = existsSync(bunLockFile) ? bunLockFile : existsSync(npmLockFile) ? npmLockFile : null;
  if (!lockPath) hardFail("A lockfile is required (bun.lock or package-lock.json) for reproducible android backend bundling.");
  if (statSync(lockPath).mtimeMs > statSync(join(repoRoot, "node_modules")).mtimeMs) {
    logStep("deps", "lockfile newer than node_modules; refreshing install");
    run("bun", existsSync(bunLockFile) ? ["install", "--frozen-lockfile"] : ["install"]);
  }
}
function preflight() {
  logStep("preflight", `bun=${run("bun", ["--version"]).stdout}`);
  logStep("preflight", `rustc=${run("rustc", ["--version"]).stdout}`);
  const java = run("java", ["-version"]); logStep("preflight", `java=${(java.stderr || java.stdout).split("\n")[0] ?? "unknown"}`);
}
function main() {
  preflight(); ensureDependencies();
  rmSync(stageDir, { recursive: true, force: true }); mkdirSync(stageDir, { recursive: true }); mkdirSync(outputDir, { recursive: true });
  const entry = join(repoRoot, "src", "index.ts"); if (!existsSync(entry)) hardFail(`Backend entry not found: ${entry}`);
  run("bun", ["build", entry, "--target", "bun", "--format", "esm", "--outdir", stageDir, "--sourcemap"]);

  const nativeAssets = findNodeBinaries(join(repoRoot, "node_modules"));
  const androidNative = nativeAssets.filter(isAndroidNodeBinary);
  const excludedNative = nativeAssets.filter((x) => !isAndroidNodeBinary(x));
  const nativeOutDir = join(stageDir, "native"); mkdirSync(nativeOutDir, { recursive: true });
  for (const binary of androidNative) {
    const rel = binary.replace(join(repoRoot, "node_modules") + "/", "").replaceAll("/", "_");
    cpSync(binary, join(nativeOutDir, rel));
  }

  const fileSizes = readdirSync(stageDir).map((entryName) => {
    const full = join(stageDir, entryName);
    const st = statSync(full);
    return { name: entryName, bytes: st.isFile() ? st.size : 0 };
  });
  const report = {
    generatedAt: new Date().toISOString(),
    totalNativeDiscovered: nativeAssets.length,
    nativeStaged: androidNative.length,
    nativeExcluded: excludedNative.length,
    excludedExamples: excludedNative.slice(0, 20).map((x) => x.replace(repoRoot + "/", "")),
    stageFiles: fileSizes,
  };
  writeFileSync(join(stageDir, "size-report.json"), JSON.stringify(report, null, 2));
  writeFileSync(join(stageDir, "manifest.json"), JSON.stringify(report, null, 2));

  rmSync(outputDir, { recursive: true, force: true }); cpSync(stageDir, outputDir, { recursive: true });
  logStep("complete", `backend assets staged at ${outputDir}; nativeStaged=${androidNative.length}, nativeExcluded=${excludedNative.length}`);
}
main();
