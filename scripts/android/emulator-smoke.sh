#!/usr/bin/env bash
set -euo pipefail

HOST_ARCH="$(uname -m)"
if [[ "$HOST_ARCH" == "x86_64" ]]; then
  DEFAULT_ABI="x86_64"
else
  DEFAULT_ABI="arm64-v8a"
fi

AVD_NAME="${AVD_NAME:-lumiverse-api34-${DEFAULT_ABI}}"
API_LEVEL="${API_LEVEL:-34}"
ABI="${ABI:-$DEFAULT_ABI}"
DEVICE="${DEVICE:-pixel_7}"
PKG_SYSIMG="system-images;android-${API_LEVEL};google_apis;${ABI}"

if [[ -z "${ANDROID_SDK_ROOT:-}" ]]; then
  echo "ANDROID_SDK_ROOT is required" >&2
  exit 1
fi

SDKMANAGER="${ANDROID_SDK_ROOT}/cmdline-tools/latest/bin/sdkmanager"
AVDMANAGER="${ANDROID_SDK_ROOT}/cmdline-tools/latest/bin/avdmanager"
EMULATOR_BIN="${ANDROID_SDK_ROOT}/emulator/emulator"
ADB_BIN="${ANDROID_SDK_ROOT}/platform-tools/adb"

for bin in "$SDKMANAGER" "$AVDMANAGER"; do
  [[ -x "$bin" ]] || { echo "missing required sdk tool: $bin" >&2; exit 1; }
done

yes | "$SDKMANAGER" --licenses >/dev/null || true
"$SDKMANAGER" "platform-tools" "emulator" "$PKG_SYSIMG"

for bin in "$EMULATOR_BIN" "$ADB_BIN"; do
  [[ -x "$bin" ]] || { echo "missing required sdk tool after install: $bin" >&2; exit 1; }
done

if ! "$AVDMANAGER" list avd | grep -q "Name: ${AVD_NAME}"; then
  echo "no" | "$AVDMANAGER" create avd -n "$AVD_NAME" -k "$PKG_SYSIMG" -d "$DEVICE"
fi

"$EMULATOR_BIN" -avd "$AVD_NAME" -no-window -no-audio -no-snapshot -gpu swiftshader_indirect -accel off >/tmp/lumiverse-emulator.log 2>&1 &
EMU_PID=$!
trap 'kill ${EMU_PID} >/dev/null 2>&1 || true' EXIT

"$ADB_BIN" wait-for-device
for _ in $(seq 1 180); do
  if "$ADB_BIN" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r' | grep -q "1"; then
    echo "Emulator booted: ${AVD_NAME}"
    echo "TODO: wire APK install + launch when android-shell app module is finalized"
    exit 0
  fi
  sleep 2
done

echo "emulator failed to report boot_completed within timeout" >&2
exit 1
