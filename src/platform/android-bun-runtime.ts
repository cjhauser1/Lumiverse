import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export type AndroidBunRuntimeConfig = {
  assetBunPath: string;
  runtimeBunPath: string;
  workingDir: string;
  backendEntry: string;
  port: number;
  smokeTimeoutMs?: number;
  startupTimeoutMs?: number;
  healthcheckPath?: string;
  logFilePath?: string;
};

export type AndroidRuntimeDiagnosticCode =
  | "OK"
  | "TIMEOUT"
  | "EXTRACTION_FAILED"
  | "CHMOD_FAILED"
  | "ELF_ABI_MISMATCH"
  | "EXEC_PERMISSION"
  | "SELINUX_DENIED"
  | "LINKER_OR_SHARED_LIB"
  | "SPAWN_ERROR"
  | "PROCESS_CRASH"
  | "PORT_BIND_FAILURE"
  | "NON_ZERO_EXIT";

export type AndroidRuntimeDiagnostic = {
  ok: boolean;
  code: AndroidRuntimeDiagnosticCode;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  detail: string;
};

type RuntimeLogEvent = {
  ts: string;
  phase: string;
  event: string;
  detail?: string;
  code?: AndroidRuntimeDiagnosticCode;
};

function writeRuntimeLog(config: AndroidBunRuntimeConfig, entry: RuntimeLogEvent) {
  if (!config.logFilePath) return;
  mkdirSync(dirname(config.logFilePath), { recursive: true });
  appendFileSync(config.logFilePath, `${JSON.stringify(entry)}\n`);
}

export function isAndroidAppRuntime(): boolean {
  return process.env.LUMIVERSE_ANDROID_APP === "1";
}

export function prepareAndroidBunBinary(config: AndroidBunRuntimeConfig): void {
  if (!existsSync(config.assetBunPath)) {
    writeRuntimeLog(config, { ts: new Date().toISOString(), phase: "prepare", event: "missing_asset", code: "EXTRACTION_FAILED" });
    throw new Error(`Bundled Bun binary missing at ${config.assetBunPath}`);
  }

  const targetDir = dirname(config.runtimeBunPath);
  if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });

  if (!existsSync(config.runtimeBunPath)) {
    try {
      copyFileSync(config.assetBunPath, config.runtimeBunPath);
    } catch (error) {
      writeRuntimeLog(config, { ts: new Date().toISOString(), phase: "prepare", event: "copy_failed", code: "EXTRACTION_FAILED", detail: String(error) });
      throw error;
    }
    try {
      chmodSync(config.runtimeBunPath, 0o700);
    } catch (error) {
      writeRuntimeLog(config, { ts: new Date().toISOString(), phase: "prepare", event: "chmod_failed", code: "CHMOD_FAILED", detail: String(error) });
      throw error;
    }
  }
}

function classifyFailure(stderr: string): AndroidRuntimeDiagnosticCode {
  const lower = stderr.toLowerCase();
  if (lower.includes("bad elf") || lower.includes("wrong architecture") || lower.includes("exec format error")) return "ELF_ABI_MISMATCH";
  if (lower.includes("selinux") || lower.includes("avc: denied")) return "SELINUX_DENIED";
  if (lower.includes("permission denied") || lower.includes("operation not permitted")) return "EXEC_PERMISSION";
  if (lower.includes("linker") || lower.includes("shared library") || lower.includes("not found")) return "LINKER_OR_SHARED_LIB";
  if (lower.includes("eaddrinuse") || lower.includes("address already in use")) return "PORT_BIND_FAILURE";
  return "NON_ZERO_EXIT";
}

export async function smokeTestAndroidBun(config: AndroidBunRuntimeConfig): Promise<AndroidRuntimeDiagnostic> {
  return await new Promise((resolve) => {
    const child = spawn(config.runtimeBunPath, ["--version"], { cwd: config.workingDir, stdio: ["ignore", "pipe", "pipe"] });
    let done = false;
    let stdout = "";
    let stderr = "";
    const timeoutMs = config.smokeTimeoutMs ?? 10_000;
    const finish = (diag: AndroidRuntimeDiagnostic) => {
      if (done) return;
      done = true;
      writeRuntimeLog(config, { ts: new Date().toISOString(), phase: "smoke", event: "result", code: diag.code, detail: diag.detail });
      resolve(diag);
    };
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ ok: false, code: "TIMEOUT", exitCode: null, stdout: stdout.trim(), stderr: stderr.trim(), detail: `Smoke test timed out after ${timeoutMs}ms` });
    }, timeoutMs);

    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("error", (err: Error) => {
      clearTimeout(timeout);
      finish({ ok: false, code: "SPAWN_ERROR", exitCode: null, stdout: stdout.trim(), stderr: stderr.trim(), detail: err.message });
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) return finish({ ok: true, code: "OK", exitCode: code, stdout: stdout.trim(), stderr: stderr.trim(), detail: "bun --version completed" });
      finish({ ok: false, code: classifyFailure(stderr), exitCode: code, stdout: stdout.trim(), stderr: stderr.trim(), detail: "bun --version failed" });
    });
  });
}

export type AndroidBackendLaunch = {
  child: ChildProcessWithoutNullStreams;
  startup: Promise<AndroidRuntimeDiagnostic>;
};

export function launchAndroidBackend(config: AndroidBunRuntimeConfig): AndroidBackendLaunch {
  const child = spawn(config.runtimeBunPath, ["run", config.backendEntry, "--port", String(config.port)], {
    cwd: config.workingDir,
    stdio: "pipe",
    env: { ...process.env, LUMIVERSE_LOCAL_ONLY: "1", LUMIVERSE_ANDROID_APP: "1", PORT: String(config.port) },
  });

  const startup = waitForHealthyBackend(config, child);
  return { child, startup };
}

async function waitForHealthyBackend(config: AndroidBunRuntimeConfig, child: ChildProcessWithoutNullStreams): Promise<AndroidRuntimeDiagnostic> {
  const timeoutMs = config.startupTimeoutMs ?? 20_000;
  const healthcheckPath = config.healthcheckPath ?? "/healthz";
  const start = Date.now();
  let stdout = "";
  let stderr = "";
  let exitCode: number | null = null;

  child.stdout.on("data", (d) => (stdout += String(d)));
  child.stderr.on("data", (d) => (stderr += String(d)));
  child.on("exit", (code) => {
    exitCode = code;
    writeRuntimeLog(config, { ts: new Date().toISOString(), phase: "backend", event: "exit", detail: `exit=${String(code)}`, code: code === 0 ? "OK" : "PROCESS_CRASH" });
  });

  while (Date.now() - start < timeoutMs) {
    if (exitCode !== null) {
      return { ok: false, code: classifyFailure(stderr) === "NON_ZERO_EXIT" ? "PROCESS_CRASH" : classifyFailure(stderr), exitCode, stdout: stdout.trim(), stderr: stderr.trim(), detail: "backend exited before healthcheck passed" };
    }
    try {
      const response = await fetch(`http://127.0.0.1:${config.port}${healthcheckPath}`);
      if (response.ok) {
        writeRuntimeLog(config, { ts: new Date().toISOString(), phase: "backend", event: "healthcheck_ok", code: "OK" });
        return { ok: true, code: "OK", exitCode: null, stdout: stdout.trim(), stderr: stderr.trim(), detail: "backend healthcheck passed" };
      }
    } catch {
      // keep polling
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  child.kill("SIGKILL");
  writeRuntimeLog(config, { ts: new Date().toISOString(), phase: "backend", event: "startup_timeout", code: "TIMEOUT" });
  return { ok: false, code: "TIMEOUT", exitCode, stdout: stdout.trim(), stderr: stderr.trim(), detail: `backend startup timed out after ${timeoutMs}ms` };
}

export function defaultAndroidRuntimePaths(baseDir: string) {
  return {
    assetBunPath: join(baseDir, "assets", "bun", "bun-arm64"),
    runtimeBunPath: join(baseDir, "runtime", "bun", "bun"),
    logFilePath: join(baseDir, "runtime", "logs", "bun-runtime.jsonl"),
  };
}
