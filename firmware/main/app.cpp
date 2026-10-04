// Tidbit on a small AMOLED (docs/DEVICE.md): Wi-Fi, touch, motion, voice and the pal.
// The brain renders the rig and streams draw commands (apps/brain/src/rig-stream.ts);
// this firmware rasterises them, shows the pal's words, and sends touches back.
#include <esp_event.h>
#include <esp_heap_caps.h>
#include <esp_log.h>
#include <esp_memory_utils.h>
#include <esp_netif.h>
#include <esp_system.h>
#include <esp_timer.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <math.h>
#include <nvs.h>
#include <nvs_flash.h>
#include <sdkconfig.h>
#include <string.h>

#include <algorithm>

#include "app.h"
#include "board.h"
#include "display.h"
#include "net.h"
#include "ota.h"
#include "portal.h"
#include "raster.h"
#include "settings.h"
#include "text.h"
#include "voice.h"
#include "audio.h"

static const char* TAG = "app";

Shared shared;
volatile int screen_stage = 0;
volatile uint32_t screen_loops = 0;
TaskHandle_t screen_task_handle = nullptr;

void set_mode(Mode m, const std::string& status) {
  Lock l;
  shared.mode = m;
  shared.status = status;
}

static constexpr Rgb INK = {236, 236, 240};
static constexpr Rgb MUTED = {150, 150, 165};
static constexpr Rgb ACCENT_UI = {150, 136, 255};
static constexpr Rgb BLACK = {0, 0, 0};

// ---- Message screens --------------------------------------------------------------

/** A text block centred at a fraction of the screen height. */
static void block(Canvas& fb, const Font& f, float at, const std::string& s, Rgb fg) {
  const Layout& L = board().screen;
  int cy = (int)(at * L.h);
  int room = std::min(320, text_room(L, 28));
  text_block(fb, f, cy, s, fg, BLACK, room);
}

static void draw_screen(Canvas& fb, Mode mode, const std::string& status, const std::string& ssid,
                        const std::string& code) {
  fb.fill(0);
  block(fb, FONT_TEXT, 0.17f, "Tidbit", ACCENT_UI);
  std::string hold = std::string("Hold ") + board().button + " for 10 s to change Wi-Fi";
  switch (mode) {
    case Mode::Setup:
      if (!status.empty()) {
        block(fb, FONT_TEXT, 0.5f, status, INK);
        break;
      }
      block(fb, FONT_TEXT, 0.34f, "Let's get your pal online.\nOn your phone, join", INK);
      block(fb, FONT_TEXT, 0.51f, ssid, ACCENT_UI);
      block(fb, FONT_TEXT, 0.68f, "then open\n192.168.4.1", INK);
      break;
    case Mode::Pairing:
      block(fb, FONT_TEXT, 0.34f, status, INK);
      if (!code.empty()) block(fb, FONT_DIGITS, 0.6f, code, ACCENT_UI);
      block(fb, FONT_NOTE, 0.84f, hold, MUTED);
      break;
    default:
      block(fb, FONT_TEXT, 0.5f, status.empty() ? "Waking up…" : status, INK);
      break;
  }
}

static void draw_bar(Canvas& fb, const SettingsBar& bar, const char* label, int value) {
  const int x = SettingsBar::X, w = SettingsBar::W;
  std::string pct = std::to_string(value) + "%";
  text_draw(fb, FONT_TEXT, x, bar.y - FONT_TEXT.lineHeight - 6, label, INK, BLACK);
  text_draw(fb, FONT_TEXT, x + w - text_width(FONT_TEXT, pct), bar.y - FONT_TEXT.lineHeight - 6, pct,
            MUTED, BLACK);
  fb.fill_rect(x, bar.y, w, SettingsBar::H, rgb565(40, 40, 52));
  fb.fill_rect(x, bar.y, w * value / 100, SettingsBar::H, rgb565(ACCENT_UI.r, ACCENT_UI.g, ACCENT_UI.b));
}

/** The settings panel: brightness and volume bars. */
static void draw_settings(Canvas& fb, int brightness, int volume) {
  fb.fill(0);
  block(fb, FONT_TEXT, 0.12f, "Settings", ACCENT_UI);
  int pct = (brightness - BRIGHTNESS_MIN) * 100 / (BRIGHTNESS_MAX - BRIGHTNESS_MIN);
  draw_bar(fb, BRIGHTNESS_BAR, "Brightness", pct);
  draw_bar(fb, VOLUME_BAR, voice_ready() ? "Volume" : "Volume (no speaker)", volume);
  block(fb, FONT_NOTE, 0.9f, "Swipe up to close", MUTED);
}

static void push_canvas(const Canvas& c, int y0) {
  display_rows(y0, c.h, [&](int y, int n, uint16_t* out) {
    memcpy(out, c.px + (y - y0) * c.w, c.w * n * 2);
  });
}

// ---- The pal ------------------------------------------------------------------------

/** Half brightness, for big-endian RGB565. */
static inline uint16_t dim565(uint16_t c) {
  uint16_t v = (uint16_t)(c >> 8 | c << 8);
  v = (uint16_t)((v >> 1) & 0x7BEF);
  return (uint16_t)(v >> 8 | v << 8);
}

[[noreturn]] static void screen_task(void*) {
  const Layout& L = board().screen;
  const int W = L.w, H = L.h;
  auto* fb_px = (uint16_t*)heap_caps_malloc(W * H * 2, MALLOC_CAP_SPIRAM);
  // Internal RAM is faster, but Wi-Fi needs about 100 KB of it; otherwise use PSRAM.
  uint8_t* idx = nullptr;
  if (heap_caps_get_free_size(MALLOC_CAP_INTERNAL) > (size_t)(W * H) + 120 * 1024)
    idx = (uint8_t*)heap_caps_malloc(W * H, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
  if (!idx) idx = (uint8_t*)heap_caps_malloc(W * H, MALLOC_CAP_SPIRAM);
  auto* frame = (uint8_t*)heap_caps_malloc(8192, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
  const Font& captionFont = FONT_TEXT;
  const int CAP = std::min(H - L.captionY, 2 * FONT_TEXT.lineHeight + 8);
  auto* mask = (uint8_t*)heap_caps_malloc(W * CAP, MALLOC_CAP_SPIRAM);
  // The backdrop in full precision (see Raster::paint_backdrop565).
  auto* bg = (uint16_t*)heap_caps_malloc(W * H * 2, MALLOC_CAP_SPIRAM);
  assert(fb_px && idx && frame && mask && bg);
  ESP_LOGI(TAG, "pal buffer in %s, %u KB internal free",
           esp_ptr_internal(idx) ? "internal RAM" : "PSRAM",
           (unsigned)(heap_caps_get_free_size(MALLOC_CAP_INTERNAL) / 1024));
  memset(mask, 0, W * CAP);
  Canvas fb{fb_px, W, H};
  Raster raster(idx, W, H, L.k, L.ox, L.oy);
#ifdef CONFIG_PAL_DARK
  raster.dark = true;
#endif
  uint16_t lut[256], dim[256];
  uint16_t ink = 0;  // the words' colour, native RGB565
  uint8_t palette[8][3] = {};

  Mode shownMode = Mode::Boot;
  std::string shownScreen = "\x01";  // force the first draw
  std::string shownWords = "\x01";
  uint32_t frameSeen = 0, paletteSeen = 0;
  bool wasOnline = false;
  // Screen off: the pal dozes for a few seconds, the screen fades out, the panel goes off.
  // Waking, the pal's next frame goes up first, then the screen fades in.
  int BRIGHT = 220;  // the owner's setting, read each loop
  constexpr int64_t DOZE_US = 3'000'000, FADE_OUT_US = 800'000, FADE_IN_US = 350'000;
  int lit = BRIGHT, litAtWake = BRIGHT;
  bool off = false, turnOn = false;
  int64_t restAt = 0, wakeAt = 0;
  int64_t fpsStart = esp_timer_get_time(), rasterUs = 0, pushUs = 0;
  int frames = 0;

  for (;;) {
    screen_loops++;
    screen_stage = 1;  // reading shared state
    Mode mode;
    std::string status, ssid, code, caption;
    int charMs;
    int64_t captionStart;
    bool online, asleep, settingsOpen, fresh = false;
    int brightness, volume;
    uint32_t paletteVersion;
    int frameLen = 0;
    {
      Lock l;
      mode = shared.mode;
      status = shared.status;
      ssid = shared.setupSsid;
      code = shared.pairCode;
      caption = shared.caption;
      charMs = shared.captionCharMs;
      captionStart = shared.captionStartUs;
      online = shared.online;
      asleep = shared.asleep;
      settingsOpen = shared.settingsOpen;
      brightness = shared.brightness;
      volume = shared.volume;
      paletteVersion = shared.paletteVersion;
      if (shared.frameVersion != frameSeen && shared.frame) {
        frameSeen = shared.frameVersion;
        frameLen = shared.frameLen;
        memcpy(frame, shared.frame, frameLen);
        fresh = true;
      }
      if (paletteVersion != paletteSeen) memcpy(palette, shared.palette, sizeof palette);
    }

    screen_stage = 2;  // brightness
    BRIGHT = brightness;
    int64_t now = esp_timer_get_time();
    bool wake = false;
    int want = lit;
    if (asleep) {
      if (!restAt) restAt = now;
      float f = (now - restAt - DOZE_US) / (float)FADE_OUT_US;
      want = f <= 0 ? BRIGHT : f >= 1 ? 0 : (int)(BRIGHT * (1 - f));
      if (off) {
        vTaskDelay(pdMS_TO_TICKS(50));
        continue;
      }
    } else {
      if (restAt || off) {
        restAt = 0;
        wakeAt = now;
        litAtWake = off ? 0 : lit;
        wake = off;
        turnOn = off;
        off = false;
      }
      float f = (now - wakeAt) / (float)FADE_IN_US;
      want = f >= 1 ? BRIGHT : litAtWake + (int)((BRIGHT - litAtWake) * f);
    }
    if (want != lit) {
      lit = want;
      display_brightness((uint8_t)lit);
    }
    if (asleep && lit == 0) {
      display_power(false);
      off = true;
      continue;
    }

    if (mode != Mode::Pet) {
      std::string key = std::to_string((int)mode) + status + ssid + code;
      if (key != shownScreen || mode != shownMode) {
        draw_screen(fb, mode, status, ssid, code);
        push_canvas(fb, 0);
        shownScreen = key;
      }
      if (turnOn) display_power(true), turnOn = false;
      shownMode = mode;
      vTaskDelay(pdMS_TO_TICKS(50));
      continue;
    }
    // Settings: drawn over the pal; the pal is drawn again when it closes.
    if (settingsOpen) {
      std::string key = "settings" + std::to_string(brightness) + "/" + std::to_string(volume);
      if (key != shownScreen) {
        draw_settings(fb, brightness, volume);
        push_canvas(fb, 0);
        shownScreen = key;
      }
      if (turnOn) display_power(true), turnOn = false;
      vTaskDelay(pdMS_TO_TICKS(20));
      continue;
    }
    bool redraw = shownMode != Mode::Pet || wake || shownScreen != "\x01";
    shownMode = mode;
    shownScreen = "\x01";

    if (paletteVersion != paletteSeen) {
      paletteSeen = paletteVersion;
      build_lut(palette, lut, raster.dark);
      // Offline, the last frame stays up, dimmed.
      for (int i = 0; i < 256; i++) dim[i] = dim565(lut[i]);
      ink = caption_ink(palette, raster.dark);
      raster.paint_backdrop565(palette, bg);
      redraw = true;
    }

    // Words: the beat's text typed out as the browser does, or a status line.
    std::string words;
    if (!status.empty()) words = status;
    else if (!caption.empty() && charMs > 0) {
      int typed = (int)((esp_timer_get_time() - captionStart) / 1000 / charMs) + 1;
      words = utf8_prefix(caption, typed);
    }
    if (words != shownWords) {
      shownWords = words;
      caption_mask(mask, CAP, L, status.empty() ? captionFont : FONT_NOTE, words);
      redraw = true;
    }

    if (online != wasOnline) redraw = true;
    wasOnline = online;
    screen_stage = 3;  // raster
    int64_t t0 = esp_timer_get_time();
    if (fresh && raster.frame(frame, frameLen)) redraw = true;
    int64_t t1 = esp_timer_get_time();
    rasterUs += t1 - t0;
    if (redraw && paletteSeen) {
      screen_stage = 4;  // pushing pixels
      const uint16_t* t = online ? lut : dim;
      const bool text = !words.empty();
      display_rows(0, H, [&](int y, int n, uint16_t* out) {
        const uint8_t* src = idx + y * W;
        const uint16_t* back = bg + y * W;
        if (online)
          for (int i = 0; i < W * n; i++) out[i] = src[i] & 7 ? t[src[i]] : back[i];
        else
          for (int i = 0; i < W * n; i++) out[i] = src[i] & 7 ? t[src[i]] : dim565(back[i]);
        if (!text) return;
        for (int r = 0; r < n; r++) {
          int my = y + r - L.captionY;
          if (my < 0 || my >= CAP) continue;
          const uint8_t* m = mask + my * W;
          uint16_t* o = out + r * W;
          for (int x = 0; x < W; x++)
            if (m[x]) o[x] = mix565(o[x], ink, m[x]);
        }
      });
      screen_stage = 5;  // after the push
      frames++;
      {
        Lock l;
        shared.framesDrawn++;
      }
      pushUs += esp_timer_get_time() - t1;
      if (turnOn) display_power(true), turnOn = false;
    }

    if (esp_timer_get_time() - fpsStart > 10'000'000) {
      ESP_LOGI(TAG, "%.1f fps (raster %d ms, push %d ms a frame), %u KB internal free",
               frames / 10.f, frames ? (int)(rasterUs / frames / 1000) : 0,
               frames ? (int)(pushUs / frames / 1000) : 0,
               (unsigned)(heap_caps_get_free_size(MALLOC_CAP_INTERNAL) / 1024));
      fpsStart = esp_timer_get_time();
      frames = 0;
      rasterUs = pushUs = 0;
    }
    screen_stage = 6;  // idle
    if (!fresh) vTaskDelay(pdMS_TO_TICKS(4));
  }
}

// ---- Input --------------------------------------------------------------------------

static void request_setup() {
  nvs_handle_t h;
  if (nvs_open("pal", NVS_READWRITE, &h) == ESP_OK) {
    nvs_set_u8(h, "setup", 1);
    nvs_commit(h);
    nvs_close(h);
  }
  esp_restart();
}

/** Screen-off after this long without company (0 = never). */
static constexpr int64_t IDLE_US = (int64_t)CONFIG_PAL_SCREEN_OFF_S * 1'000'000;

[[noreturn]] static void input_task(void*) {
  const Layout& L = board().screen;
  // The pal's canvas centre and half-size on screen, for where it should look.
  const float cx = 120 * L.k + L.ox, cy = 120 * L.k + L.oy, half = 120 * L.k;
  bool down = false, petted = false;
  int lastX = 0, lastY = 0;
  float travel = 0;
  int64_t downAt = 0, attendAt = 0, buttonAt = 0;
  bool talking = false;
  // Settings: a swipe down from the top edge opens them; up, BOOT or 15 s alone closes.
  bool settings = false, edge = false;
  int downY = 0, dragging = 0;  // 1 brightness, 2 volume
  int64_t settingsAt = 0;
  auto closeSettings = [&] {
    settings = false;
    {
      Lock l;
      shared.settingsOpen = false;
    }
    settings_save();
  };
  // IMU: gravity followed slowly, so a tilt reads as a change from how the pal rests.
  float bx = 0, by = 0;
  bool primed = false, tilting = false;
  int jolts = 0;
  int64_t joltAt = 0, joltsFrom = 0, shookAt = 0, tiltAt = 0;
  // Screen off when nobody is around. The touch or press that wakes it does nothing else.
  bool asleep = false, swallowTouch = false, swallowButton = false;
  int64_t activeAt = esp_timer_get_time();
  std::string heard;
  // Last resort: a screen task that stops for 5 s restarts the pal instead of freezing it.
  uint32_t loopsSeen = 0;
  int64_t loopsAt = activeAt;

  for (;;) {
    vTaskDelay(pdMS_TO_TICKS(20));
    int64_t now = esp_timer_get_time();
    Mode mode;
    std::string caption;
    {
      Lock l;
      mode = shared.mode;
      caption = shared.caption;
    }
    if (screen_loops != loopsSeen || mode == Mode::Updating) {
      loopsSeen = screen_loops;
      loopsAt = now;
    } else if (now - loopsAt > 5'000'000) {
      ESP_LOGE(TAG, "screen stalled (stage %d, display %d); restarting", screen_stage, display_stage);
      esp_restart();
    }

    TouchPoint p = board_touch();
    Motion m = board_motion();
    bool button = board_button();

    // Company: a finger, the button, being picked up or carried, or the pal speaking.
    bool moved = m.ok && hypotf(hypotf(m.gx, m.gy), m.gz) > 25;
    bool spoke = caption != heard && !caption.empty();
    heard = caption;
    if (p.down || button || moved || spoke || voice_busy() || mode != Mode::Pet) {
      activeAt = now;
      if (asleep) {
        asleep = false;
        swallowTouch = p.down;
        swallowButton = button;
        Lock l;
        shared.asleep = false;
      }
    } else if (!asleep && IDLE_US && now - activeAt > IDLE_US) {
      asleep = true;
      if (tilting) net_attend(false, 0, 0), tilting = false;
      Lock l;
      shared.asleep = true;
    }
    net_rest(asleep);  // sent only when it changes

    // The button: a tap feeds the pal; holding it talks to it until let go. Held 10 s
    // without a word (or on any other screen), it opens Wi-Fi setup.
    if (button) {
      if (!buttonAt) buttonAt = now;
      int64_t held = now - buttonAt;
      if (!talking && !swallowButton && !settings && mode == Mode::Pet && held > 400'000 &&
          voice_ready() && !voice_busy()) {
        talking = true;
        voice_listen(true);
      }
      if (mode != Mode::Setup && held > 10'000'000 && !(talking && voice_heard())) {
        if (talking) voice_cancel();
        set_mode(Mode::Setup, "Opening Wi-Fi setup…");
        vTaskDelay(pdMS_TO_TICKS(600));
        request_setup();
      }
    } else if (buttonAt) {
      if (talking) voice_listen(false);
      else if (settings && !swallowButton) closeSettings();
      else if (now - buttonAt < 400'000 && mode == Mode::Pet && !swallowButton) net_touch("feed");
      talking = false;
      buttonAt = 0;
      swallowButton = false;
    }

    if (settings && (mode != Mode::Pet || asleep)) closeSettings();
    if (mode != Mode::Pet || asleep) continue;  // also ignores input while updating

    if (settings) {
      if (swallowTouch) {
        if (!p.down) swallowTouch = false;
        continue;
      }
      if (p.down) {
        settingsAt = now;
        if (!down) {
          down = true;
          downY = p.y;
          auto on = [&](const SettingsBar& b) {
            return p.y >= b.y - BAR_REACH && p.y < b.y + SettingsBar::H + BAR_REACH;
          };
          dragging = on(BRIGHTNESS_BAR) ? 1 : on(VOLUME_BAR) ? 2 : 0;
        }
        lastY = p.y;
        int v = settings_bar_value(p.x);
        if (dragging == 1) {
          Lock l;
          shared.brightness = (uint8_t)(BRIGHTNESS_MIN + v * (BRIGHTNESS_MAX - BRIGHTNESS_MIN) / 100);
        } else if (dragging == 2) {
          bool changed;
          {
            Lock l;
            changed = shared.volume != v;
            shared.volume = (uint8_t)v;
          }
          if (changed) audio_set_volume(v);
        }
      } else if (down) {
        down = false;
        if (dragging == 2 && voice_ready() && !voice_busy()) audio_tone(880, 120);
        if (!dragging && downY - lastY > 90) closeSettings();
        dragging = 0;
      }
      if (settings && now - settingsAt > 15'000'000) closeSettings();
      continue;
    }

    // Motion: shaking shakes the pal; tilting makes it glance downhill.
    if (m.ok) {
      if (!primed) bx = m.ax, by = m.ay, primed = true;
      bx += (m.ax - bx) * 0.01f, by += (m.ay - by) * 0.01f;  // ~2 s
      float jolt = fabsf(sqrtf(m.ax * m.ax + m.ay * m.ay + m.az * m.az) - 1);
      // Four jolts of over 1 g within a second; taps on the screen don't come close.
      if (jolt > 1.0f && now - joltAt > 60'000) {
        if (now - joltsFrom > 1'000'000) jolts = 0, joltsFrom = now;
        joltAt = now;
        if (++jolts >= 4 && now - shookAt > 2'500'000) {
          shookAt = now;
          jolts = 0;
          net_touch("shake");
        }
      }
      // The accelerometer reads against gravity, so downhill is the opposite of the change.
      float tx = -(m.ax - bx) * 2.5f, ty = -(m.ay - by) * 2.5f;
      bool settled = now - joltAt > 500'000;
      if (!down && settled && hypotf(tx, ty) > 0.3f) {
        if (now - tiltAt > 100'000) {
          tiltAt = now;
          tilting = true;
          net_attend(true, fmaxf(-1, fminf(1, tx)), fmaxf(-1, fminf(1, ty)));
        }
      } else if (tilting && !down) {
        tilting = false;
        net_attend(false, 0, 0);
      }
    }

    if (swallowTouch) {
      if (!p.down) swallowTouch = false;
      continue;
    }
    if (p.down && !down) {
      // A touch starting at the top edge is a swipe for the settings, not the pal.
      edge = p.y < 60;
      downY = p.y;
      tilting = false;
      down = true;
      petted = false;
      travel = 0;
      downAt = now;
      lastX = p.x, lastY = p.y;
    }
    if (p.down && edge) {
      lastX = p.x, lastY = p.y;
    } else if (p.down && down && !edge) {
      travel += hypotf(p.x - lastX, p.y - lastY);
      lastX = p.x, lastY = p.y;
      // A stroke across the pal is petting (60 virtual px, as in the browser).
      if (!petted && travel > 60 * L.k) {
        petted = true;
        net_touch("pet");
      }
      if (now - attendAt > 100'000) {
        attendAt = now;
        net_attend(true, (p.x - cx) / half, (p.y - cy) / half);
      }
    } else if (down && edge) {
      down = false;
      edge = false;
      if (lastY - downY > 90) {
        settings = true;
        settingsAt = now;
        net_attend(false, 0, 0);
        Lock l;
        shared.settingsOpen = true;
      }
    } else if (down) {
      down = false;
      if (!petted && now - downAt < 700'000) net_touch("poke");
      net_attend(false, 0, 0);
    }
  }
}

// ---- Start --------------------------------------------------------------------------

extern "C" void app_main() {
  esp_err_t err = nvs_flash_init();
  if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
    nvs_flash_erase();
    nvs_flash_init();
  }
  ESP_ERROR_CHECK(esp_netif_init());
  ESP_ERROR_CHECK(esp_event_loop_create_default());
  shared.lock = xSemaphoreCreateMutex();

  ota_confirm_later();
  settings_load();
  const Board& b = board_init();
  display_init(b);
  voice_start();
  xTaskCreatePinnedToCore(screen_task, "screen", 8192, nullptr, 5, &screen_task_handle, 1);
  xTaskCreatePinnedToCore(input_task, "input", 4096, nullptr, 4, nullptr, 0);

  Config cfg = config_load();
  bool setup = false;
  nvs_handle_t h;
  if (nvs_open("pal", NVS_READWRITE, &h) == ESP_OK) {
    uint8_t flag = 0;
    if (nvs_get_u8(h, "setup", &flag) == ESP_OK && flag) {
      setup = true;
      nvs_erase_key(h, "setup");
      nvs_commit(h);
    }
    nvs_close(h);
  }
  if (setup || cfg.ssid.empty() || cfg.server.empty()) portal_run(cfg);
  ESP_LOGI(TAG, "wifi %s, server %s, %s", cfg.ssid.c_str(), cfg.server.c_str(),
           cfg.token.empty() ? "not paired" : "paired");
  net_run(cfg);
}
