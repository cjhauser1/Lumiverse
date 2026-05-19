import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";

export type AndroidBunRuntimeConfig = {
  assetBunPath: string;
  runtimeBunPath: string;
  workingDir: string;
  backendEntry: string;
  port: number;
};

export function isAndroidAppRuntime(): boolean {
  return process.env.LUMIVERSE_ANDROID_APP === "1";
}

export function prepareAndroidBunBinary(config: AndroidBunRuntimeConfig): void {
  if (!existsSync(config.assetBunPath)) {
    throw new Error(`Bundled Bun binary missing at ${config.assetBunPath}`);
  }

  const targetDir = dirname(config.runtimeBunPath);
  if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });

  if (!existsSync(config.runtimeBunPath)) {
    copyFileSync(config.assetBunPath, config.runtimeBunPath);
    chmodSync(config.runtimeBunPath, 0o700);
  }
}

export async function smokeTestAndroidBun(config: AndroidBunRuntimeConfig): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(config.runtimeBunPath, ["--version"], {
      cwd: config.workingDir,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += String(d)));
    child.stderr.on("data", (d) => (err += String(d)));

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) return resolve(out.trim());
      reject(new Error(`Bun smoke test failed (code=${code}): ${err || out}`));
    });
  });
}

export function launchAndroidBackend(config: AndroidBunRuntimeConfig) {
  return spawn(config.runtimeBunPath, ["run", config.backendEntry, "--port", String(config.port)], {
    cwd: config.workingDir,
    stdio: "pipe",
    env: {
      ...process.env,
      LUMIVERSE_LOCAL_ONLY: "1",
      LUMIVERSE_ANDROID_APP: "1",
      PORT: String(config.port),
    },
  });
}

export function defaultAndroidRuntimePaths(baseDir: string) {
  return {
    assetBunPath: join(baseDir, "assets", "bun", "bun-arm64"),
    runtimeBunPath: join(baseDir, "runtime", "bun", "bun"),
  };
}
