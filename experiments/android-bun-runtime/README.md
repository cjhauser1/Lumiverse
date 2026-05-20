# Android Bun Runtime Experiments

This directory captures a practical path for running Lumiverse as a self-contained Android APK **without Termux**.

## Current status

- ✅ Architecture drafted for embedding Bun as an app sidecar binary.
- ✅ Runtime launcher module added (`src/platform/android-bun-runtime.ts`).
- ✅ Android packaging helper script added (`scripts/android/prepare-bun-sidecar.ts`).
- ⏳ Pending device validation with Tauri Android shell.

## Proposed architecture (strong fallback)

1. Build Lumiverse backend bundle (`bun build`) ahead of time.
2. Package Android arm64 Bun binary as an app asset (`bun-arm64`) inside Tauri/Android.
3. On first launch:
   - copy Bun binary to app-private files dir
   - `chmod 700` the copied binary
   - run smoke test (`bun --version`)
4. Launch backend process from Rust/Tauri host using extracted binary.
5. Frontend WebView points to `http://127.0.0.1:<port>`.

If direct execution fails on specific OEM kernels/SELinux profiles, fallback is to run a Rust native HTTP micro-host and move only Bun-specific logic into precompiled worker artifacts.

## Device validation matrix (to run)

- Pixel 7/8 (Android 14/15)
- Samsung OneUI (Android 14)
- ABI: `arm64-v8a`
- Checks:
  - binary extraction
  - execute permission persistence across restarts
  - process restart after app background/foreground
  - clean shutdown on app kill

## Why this is viable

Android app-private dirs (`Context.getFilesDir`) generally allow executing copied ELF binaries when:
- ABI matches
- loader/libs are available or statically linked
- SELinux policy permits app domain execution from private storage

This approach avoids Termux and keeps Lumiverse's Bun-first runtime model.

## Pipeline hardening updates (staging)

- `android:build-backend-bundle` now writes to `apps/android-shell/android-assets/backend` via `bun build --outdir`, avoiding multi-output single-file errors.
- The bundler performs preflight logging for Bun/Rust/Java and Android SDK env vars before build steps.
- Dependency bootstrap now checks `node_modules` + lockfile freshness and runs `bun install` only when needed.
- Native `.node` artifacts are staged into a `native/` folder with a generated `manifest.json` for diagnostics.
- CI workflow `android-prototype.yml` caches Bun/Cargo/Gradle and uploads only backend bundle diagnostics artifacts.

## Known blockers & assumptions

- This repository does not currently include the full Android Tauri project structure; CI currently validates backend bundle staging only.
- Java preflight can report `unknown` when stderr-only `java -version` output is not captured by host shell behavior.
- Device/runtime linker compatibility for Bun sidecar still requires on-device validation.

## Fallback architecture if Bun execution is blocked on-device

If Android OEM policy or linker/runtime compatibility prevents executing the Bun binary:

1. Run a Rust-native HTTP microhost in the Android shell process.
2. Build backend worker artifacts ahead-of-time during CI (Bun as build-time only tool).
3. Host serves static frontend + dispatches runtime-safe worker units.
4. Keep Bun out of on-device runtime path to avoid exec/SELinux/linker failures.

Tradeoffs:

- Pros: More predictable Android runtime behavior, fewer linker constraints.
- Cons: Additional Rust host complexity and reduced parity with desktop Bun runtime behavior.

## Phase 6/7/8 iteration notes

### Runtime hardening updates

- `android-bun-runtime.ts` now supports startup timeout enforcement, backend healthcheck polling, async process-exit capture, and JSONL runtime log persistence in app-private storage.
- Failure classification now differentiates extraction/chmod issues, ELF/ABI mismatch signals, SELinux denial signatures, linker/shared-lib failures, process crashes, and potential port bind failures.

### Bun compatibility tooling

- New script: `bun run android:inspect-bun-binary [path-to-bun]`
- Produces `apps/android-shell/android-assets/diagnostics/bun-compatibility-report.json` containing:
  - `file` metadata output
  - `readelf` ELF header / interpreter / dynamic section output
  - `ldd` dependency output
  - inferred compatibility hints (arch, dynamic/static tendency, glibc/musl hints, Android linker hints)

### APK footprint reduction (current pass)

- Backend bundling now filters staged native `.node` binaries to Android/arm64-labeled entries only.
- Linux desktop / Darwin / Windows / x64-oriented native binaries are excluded from staged Android assets.
- Bundling emits `size-report.json` with included/excluded native counts and examples.

### Current blockers / assumptions

- Robust Android-ABI validation of `.node` payloads currently relies on filename heuristics and should be upgraded to ELF-level ABI checks in a follow-up.
- Actual on-device runtime validation still requires emulator/device runs from `apps/android-shell` host app wiring.

## Emulator smoke test automation (host-side)

A host-side script was added to automate Android emulator provisioning and boot checks:

- `bun run android:emulator-smoke`
- Script: `scripts/android/emulator-smoke.sh`

What it does:

1. Validates Android SDK toolchain paths (`sdkmanager`, `avdmanager`, `emulator`, `adb`).
2. Installs emulator + platform tools + API 34 arm64 system image.
3. Creates AVD `lumiverse-api34-arm64` (configurable via env vars).
4. Boots emulator in headless mode (`-no-window`, `-accel off`).
5. Waits for `sys.boot_completed=1` as readiness gate.

Current limitation in this repo snapshot:

- APK install/launch wiring is left as TODO in script output because this checkout still lacks finalized Android app module task wiring for deterministic CLI install/launch in CI-like hosts.

## 2026-05-20 container validation update

Executed in Ubuntu 24.04 container with internet access:

1. Installed Android cmdline tools under `/opt/android-sdk`.
2. Installed emulator host runtime libs (`libx11-xcb1`, `libxcb*`, `libgbm1`, `mesa-libgallium`, etc.) to resolve previous `libX11-xcb.so.1` startup failure.
3. Re-ran `android:emulator-smoke` with `ANDROID_SDK_ROOT=/opt/android-sdk`.

Result:

- Emulator process now launches past the previous shared-library error.
- In this container it remains unstable / non-deterministic for full boot (device frequently `offline` without hardware acceleration), preventing reliable APK install/launch verification in this environment.

Actionable next environment requirement:

- run emulator smoke on a runner/host with KVM acceleration enabled for deterministic `sys.boot_completed` and adb-online transition.
