#include "settings.h"

#include <nvs.h>

#include "app.h"

static uint8_t savedBrightness, savedVolume;

void settings_load() {
  uint8_t b = 220, v = 75;
  nvs_handle_t h;
  if (nvs_open("pal", NVS_READONLY, &h) == ESP_OK) {
    nvs_get_u8(h, "bright", &b);
    nvs_get_u8(h, "volume", &v);
    nvs_close(h);
  }
  savedBrightness = b < BRIGHTNESS_MIN ? BRIGHTNESS_MIN : b;
  savedVolume = v > 100 ? 100 : v;
  Lock l;
  shared.brightness = savedBrightness;
  shared.volume = savedVolume;
}

void settings_save() {
  uint8_t b, v;
  {
    Lock l;
    b = shared.brightness;
    v = shared.volume;
  }
  if (b == savedBrightness && v == savedVolume) return;
  nvs_handle_t h;
  if (nvs_open("pal", NVS_READWRITE, &h) != ESP_OK) return;
  nvs_set_u8(h, "bright", b);
  nvs_set_u8(h, "volume", v);
  nvs_commit(h);
  nvs_close(h);
  savedBrightness = b, savedVolume = v;
}

int settings_bar_value(int x) {
  int v = (x - SettingsBar::X) * 100 / SettingsBar::W;
  return v < 0 ? 0 : v > 100 ? 100 : v;
}
