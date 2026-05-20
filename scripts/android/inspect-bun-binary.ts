import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), "../..");
const bunPath = process.argv[2] ?? join(repoRoot, "apps", "android-shell", "android-assets", "bun", "bun-arm64");
const outDir = join(repoRoot, "apps", "android-shell", "android-assets", "diagnostics");

function run(cmd: string, args: string[]) {
  const res = spawnSync(cmd, args, { encoding: "utf8" });
  return { code: res.status ?? 1, stdout: String(res.stdout ?? "").trim(), stderr: String(res.stderr ?? "").trim() };
}

if (!existsSync(bunPath)) {
  console.error(`[android:inspect-bun-binary] missing bun binary: ${bunPath}`);
  process.exit(1);
}

const fileInfo = run("file", [bunPath]);
const readElf = run("readelf", ["-h", "-l", "-d", bunPath]);
const lddInfo = run("ldd", [bunPath]);

const report = {
  generatedAt: new Date().toISOString(),
  bunPath,
  checks: {
    file: fileInfo,
    readelf: readElf,
    ldd: lddInfo,
  },
  inferred: {
    isAarch64: /aarch64|arm64/i.test(fileInfo.stdout),
    likelyDynamic: /interpreter|shared library|dynamically linked/i.test(`${fileInfo.stdout}\n${readElf.stdout}`),
    likelyGlibc: /glibc|gnu\/linux|ld-linux/i.test(`${fileInfo.stdout}\n${readElf.stdout}\n${lddInfo.stdout}\n${lddInfo.stderr}`),
    likelyMusl: /musl/i.test(`${fileInfo.stdout}\n${readElf.stdout}\n${lddInfo.stdout}\n${lddInfo.stderr}`),
    androidCompatibleHint: /android|\/system\/bin\/linker64/i.test(`${readElf.stdout}\n${lddInfo.stdout}\n${lddInfo.stderr}`),
  },
};

mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, "bun-compatibility-report.json");
writeFileSync(outFile, JSON.stringify(report, null, 2));
console.log(`[android:inspect-bun-binary] wrote ${outFile}`);
console.log(JSON.stringify(report.inferred, null, 2));
