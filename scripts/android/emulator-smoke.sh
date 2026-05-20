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


pkill -f "/opt/android-sdk/emulator/emulator -avd ${AVD_NAME}" >/dev/null 2>&1 || true

# Ensure stale emulator for same AVD is not running
if "$ADB_BIN" devices | awk "NR>1 {print \$1}" | grep -q "^emulator-"; then
  while read -r serial; do
    [[ -n "$serial" ]] || continue
    avd=$($ADB_BIN -s "$serial" emu avd name 2>/dev/null | tr -d "\r" || true)
    if [[ "$avd" == "$AVD_NAME" ]]; then
      $ADB_BIN -s "$serial" emu kill >/dev/null 2>&1 || true
    fi
  done < <("$ADB_BIN" devices | awk 'NR>1 {print $1}')
  sleep 2
fi

"$EMULATOR_BIN" -avd "$AVD_NAME" -no-window -no-audio -no-snapshot -no-boot-anim -gpu swiftshader_indirect -accel off -no-metrics >/tmp/lumiverse-emulator.log 2>&1 &
EMU_PID=$!
trap 'kill ${EMU_PID} >/dev/null 2>&1 || true' EXIT

"$ADB_BIN" wait-for-device
BOOT_TIMEOUT_SECS="${BOOT_TIMEOUT_SECS:-900}"
DEADLINE=$(( $(date +%s) + BOOT_TIMEOUT_SECS ))
while [[ $(date +%s) -lt $DEADLINE ]]; do
  if "$ADB_BIN" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r' | grep -q "1"; then
    echo "Emulator booted: ${AVD_NAME}"
    echo "TODO: wire APK install + launch when android-shell app module is finalized"
    exit 0
  fi
  if ! kill -0 "$EMU_PID" 2>/dev/null; then
    echo "emulator process exited early; inspect /tmp/lumiverse-emulator.log" >&2
    exit 1
  fi
  sleep 2
done

echo "emulator failed to report boot_completed within ${BOOT_TIMEOUT_SECS}s" >&2
exit 1
