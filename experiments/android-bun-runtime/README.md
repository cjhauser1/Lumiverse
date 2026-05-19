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
