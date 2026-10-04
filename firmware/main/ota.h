// Updates over Wi-Fi: ota.sh POSTs a build to http://tidbit-xxxx.local/ota with the
// password from sdkconfig.local. The new build boots from the other app slot and is
// rolled back unless it stays up for 30 s.
#pragma once

/** Advertise tidbit-xxxx.local and accept updates. Call once Wi-Fi is up. */
void ota_start();
/** Keep this build once it has run for a while (cancels the rollback). */
void ota_confirm_later();
