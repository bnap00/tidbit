#!/usr/bin/env bash
# Run idf.py from the ESP-IDF Docker image for one board:
#   ./idf.sh build                                   # Waveshare ESP32-S3-Touch-AMOLED-1.8
#   ./idf.sh -p /dev/ttyACM0 flash monitor
# Each board builds in build/<board> with its own sdkconfig. sdkconfig.local (gitignored)
# adds Wi-Fi and server defaults to every board.
set -euo pipefail
cd "$(dirname "$0")"
BOARD=${BOARD:-waveshare-amoled-18}
[ -f "boards/$BOARD.defaults" ] || { echo "unknown BOARD=$BOARD (see boards/)" >&2; exit 1; }
# Updates over Wi-Fi need a password; make one the first time (sdkconfig.local is gitignored).
if ! grep -q '^CONFIG_PAL_OTA_PASSWORD=' sdkconfig.local 2>/dev/null; then
  echo "CONFIG_PAL_OTA_PASSWORD=\"$(head -c 18 /dev/urandom | base64 | tr '+/' '-_')\"" >> sdkconfig.local
fi
DEFAULTS="sdkconfig.defaults;boards/$BOARD.defaults"
[ -f sdkconfig.local ] && DEFAULTS="$DEFAULTS;sdkconfig.local"
IMAGE=espressif/idf:v5.3.2
DEVICES=()
for d in /dev/ttyACM* /dev/ttyUSB*; do [ -e "$d" ] && DEVICES+=(--device "$d"); done
TTY=()
[ -t 0 ] && TTY=(-it)
docker run --rm "${TTY[@]}" "${DEVICES[@]}" -v "$PWD":/project -w /project "$IMAGE" \
  bash -c "git config --global --add safe.directory '*'; idf.py -B build/$BOARD -D SDKCONFIG=build/$BOARD/sdkconfig -D SDKCONFIG_DEFAULTS='$DEFAULTS' $*"
