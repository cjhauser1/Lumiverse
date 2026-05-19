import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";

export type AndroidBunRuntimeConfig = {
  assetBunPath: string;
  runtimeBunPath: string;
  workingDir: string;
  backendEntry: string;
  port: number;
  smokeTimeoutMs?: number;
};

export type AndroidRuntimeDiagnosticCode =
  | "OK"
  | "TIMEOUT"
  | "EXEC_PERMISSION"
  | "LINKER_OR_SHARED_LIB"
  | "SPAWN_ERROR"
  | "NON_ZERO_EXIT";

export type AndroidRuntimeDiagnostic = {
  ok: boolean;
  code: AndroidRuntimeDiagnosticCode;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  detail: string;
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

function classifyFailure(stderr: string): AndroidRuntimeDiagnosticCode {
  const lower = stderr.toLowerCase();
  if (lower.includes("permission denied") || lower.includes("operation not permitted")) return "EXEC_PERMISSION";
  if (lower.includes("linker") || lower.includes("shared library") || lower.includes("not found")) return "LINKER_OR_SHARED_LIB";
  return "NON_ZERO_EXIT";
}

export async function smokeTestAndroidBun(config: AndroidBunRuntimeConfig): Promise<AndroidRuntimeDiagnostic> {
  return await new Promise((resolve) => {
    const child = spawn(config.runtimeBunPath, ["--version"], {
      cwd: config.workingDir,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const timeoutMs = config.smokeTimeoutMs ?? 10_000;
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ ok: false, code: "TIMEOUT", exitCode: null, stdout: stdout.trim(), stderr: stderr.trim(), detail: `Smoke test timed out after ${timeoutMs}ms` });
    }, timeoutMs);

    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));

    child.on("error", (err: Error) => {
      clearTimeout(timeout);
      resolve({ ok: false, code: "SPAWN_ERROR", exitCode: null, stdout: stdout.trim(), stderr: stderr.trim(), detail: err.message });
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve({ ok: true, code: "OK", exitCode: code, stdout: stdout.trim(), stderr: stderr.trim(), detail: "bun --version completed" });
        return;
      }
      resolve({ ok: false, code: classifyFailure(stderr), exitCode: code, stdout: stdout.trim(), stderr: stderr.trim(), detail: "bun --version failed" });
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
