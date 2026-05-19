import { existsSync, mkdirSync, rmSync, cpSync, readdirSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), "../..");
const outputDir = join(repoRoot, "apps", "android-shell", "android-assets", "backend");
const stageDir = join(repoRoot, ".tmp", "android-backend-bundle");
const bunLockFile = join(repoRoot, "bun.lock");
const npmLockFile = join(repoRoot, "package-lock.json");

function logStep(step: string, message: string) {
  console.log(`[android:build-backend-bundle] ${step}: ${message}`);
}

function hardFail(message: string, details?: string): never {
  console.error(`\n[android:build-backend-bundle] ERROR: ${message}`);
  if (details) console.error(details);
  process.exit(1);
}

function run(cmd: string, args: string[], cwd = repoRoot) {
  const res = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  if (res.status !== 0) {
    hardFail(`Command failed: ${cmd} ${args.join(" ")}`, [res.stdout, res.stderr].filter(Boolean).join("\n"));
  }
  return res.stdout.trim();
}

function findNodeBinaries(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) findNodeBinaries(full, acc);
    else if (entry.endsWith('.node')) acc.push(full);
  }
  return acc;
}

function ensureDependencies() {
  if (!existsSync(join(repoRoot, "node_modules"))) {
    logStep("deps", "node_modules missing; running bun install");
    run("bun", existsSync(bunLockFile) ? ["install", "--frozen-lockfile"] : ["install"]);
    return;
  }
  const lockPath = existsSync(bunLockFile) ? bunLockFile : existsSync(npmLockFile) ? npmLockFile : null;
  if (!lockPath) {
    hardFail("A lockfile is required (bun.lock or package-lock.json) for reproducible android backend bundling.");
  }
  const lockStats = statSync(lockPath);
  const modulesStats = statSync(join(repoRoot, "node_modules"));
  if (lockStats.mtimeMs > modulesStats.mtimeMs) {
    logStep("deps", "bun.lock newer than node_modules; refreshing install");
    run("bun", existsSync(bunLockFile) ? ["install", "--frozen-lockfile"] : ["install"]);
  }
}

function preflight() {
  logStep("preflight", `bun=${run("bun", ["--version"])}`);
  logStep("preflight", `rustc=${run("rustc", ["--version"])}`);
  logStep("preflight", `java=${run("java", ["-version"]).split("\n")[0] || "unknown"}`);
  logStep("preflight", `ANDROID_HOME=${process.env.ANDROID_HOME || "<unset>"}`);
  logStep("preflight", `ANDROID_SDK_ROOT=${process.env.ANDROID_SDK_ROOT || "<unset>"}`);
  logStep("preflight", "targets=arm64-v8a");
}

function main() {
  preflight();
  ensureDependencies();

  rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(stageDir, { recursive: true });
  mkdirSync(outputDir, { recursive: true });

  const entry = join(repoRoot, "src", "index.ts");
  if (!existsSync(entry)) hardFail(`Backend entry not found: ${entry}`);

  logStep("bundle", "building backend with bun --outdir");
  run("bun", [
    "build",
    entry,
    "--target", "bun",
    "--format", "esm",
    "--outdir", stageDir,
    "--sourcemap"
  ]);

  const nativeAssets = findNodeBinaries(join(repoRoot, "node_modules"));
  const nativeOutDir = join(stageDir, "native");
  mkdirSync(nativeOutDir, { recursive: true });
  for (const binary of nativeAssets) {
    const rel = binary.replace(join(repoRoot, "node_modules") + "/", "").replaceAll("/", "_");
    cpSync(binary, join(nativeOutDir, rel));
  }
  const manifest = {
    generatedAt: new Date().toISOString(),
    bundle: readdirSync(stageDir),
    nativeAssetCount: nativeAssets.length,
  };
  Bun.write(join(stageDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  rmSync(outputDir, { recursive: true, force: true });
  cpSync(stageDir, outputDir, { recursive: true });
  logStep("complete", `backend assets staged at ${outputDir}`);
}

main();
