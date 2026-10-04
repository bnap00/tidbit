#!/usr/bin/env bash
# Build and send firmware to a pal over Wi-Fi (no USB once it runs an OTA-capable build):
#   ./ota.sh waveshare-amoled-18 tidbit-xxxx.local
# Skip the build with NO_BUILD=1. The password comes from sdkconfig.local.
set -euo pipefail
cd "$(dirname "$0")"
BOARD=${1:?usage: ./ota.sh <board> <host or IP>}
HOST=${2:?usage: ./ota.sh <board> <host or IP>}
[ "${NO_BUILD:-}" = 1 ] || BOARD=$BOARD ./idf.sh build >/dev/null
PASSWORD=$(sed -n 's/^CONFIG_PAL_OTA_PASSWORD="\(.*\)"$/\1/p' sdkconfig.local)
BIN=build/$BOARD/tidbit.bin
echo "before: $(curl -fsS -m 5 "http://$HOST/info")"
echo "sending $BIN ($(stat -c %s "$BIN") bytes) to $HOST"
curl -fsS -m 300 -H "X-OTA-Password: $PASSWORD" -H "Content-Type: application/octet-stream" \
  --data-binary @"$BIN" "http://$HOST/ota"
# Wait for it to come back on the new build.
for _ in $(seq 1 30); do
  sleep 2
  if INFO=$(curl -fsS -m 3 "http://$HOST/info" 2>/dev/null); then
    echo "after:  $INFO"
    exit 0
  fi
done
echo "the pal did not come back within a minute; check it over USB (./idf.sh -p /dev/ttyACM0 monitor)" >&2
exit 1
