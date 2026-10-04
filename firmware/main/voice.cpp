#include "voice.h"

#include <esp_heap_caps.h>
#include <esp_log.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <stdlib.h>
#include <string.h>

#include <algorithm>
#include <atomic>
#include <string>

#include "app.h"
#include "audio.h"
#include "net.h"

static const char* TAG = "voice";

static constexpr int MAX_S = 30;
static constexpr int MIN_SAMPLES = AUDIO_RATE * 4 / 10;  // shorter is a slip of the thumb
static constexpr int SPEECH_PEAK = 6000;                 // of 32767, close to the mic

static TaskHandle_t task;
static std::atomic<bool> listening{false}, cancelled{false}, busy{false}, heard{false};

/** The line over the pal's words; only while the pal is on screen. */
static void say_status(const std::string& s) {
  Lock l;
  if (shared.mode == Mode::Pet && shared.online) shared.status = s;
}

static void wav_header(uint8_t* h, int samples) {
  auto u32 = [&](int o, uint32_t v) { memcpy(h + o, &v, 4); };
  auto u16 = [&](int o, uint16_t v) { memcpy(h + o, &v, 2); };
  memcpy(h, "RIFF", 4);
  u32(4, 36 + samples * 2);
  memcpy(h + 8, "WAVEfmt ", 8);
  u32(16, 16);
  u16(20, 1);  // PCM
  u16(22, 1);  // mono
  u32(24, AUDIO_RATE);
  u32(28, AUDIO_RATE * 2);
  u16(32, 2);
  u16(34, 16);
  memcpy(h + 36, "data", 4);
  u32(40, samples * 2);
}

static void play(const uint8_t* data, size_t len) { audio_play_feed(data, len); }

[[noreturn]] static void voice_task(void*) {
  const int cap = AUDIO_RATE * MAX_S;
  auto* wav = (uint8_t*)heap_caps_malloc(44 + cap * 2, MALLOC_CAP_SPIRAM);
  assert(wav);
  auto* pcm = (int16_t*)(wav + 44);
  for (;;) {
    ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
    if (!listening) continue;
    busy = true;
    heard = false;
    cancelled = false;
    say_status("Listening…");
    int n = 0, peak = 0;
    const int chunk = AUDIO_RATE / 50;  // 20 ms
    while (listening && n + chunk <= cap) {
      if (!audio_read(pcm + n, chunk)) break;
      for (int i = 0; i < chunk; i++) peak = std::max(peak, abs((int)pcm[n + i]));
      if (peak > SPEECH_PEAK) heard = true;
      n += chunk;
    }
    listening = false;
    ESP_LOGI(TAG, "heard %.1f s, peak %d", n / (float)AUDIO_RATE, peak);
    if (cancelled || n < MIN_SAMPLES || !heard) {
      say_status(cancelled || n < MIN_SAMPLES ? "" : "I didn't hear anything.");
      if (!cancelled && n >= MIN_SAMPLES) vTaskDelay(pdMS_TO_TICKS(2000)), say_status("");
      busy = false;
      continue;
    }
    say_status("Thinking…");
    wav_header(wav, n);
    std::string text, error;
    int status = net_ask(wav, 44 + n * 2, text, error);
    if (status != 200) {
      ESP_LOGW(TAG, "ask failed (%d): %s", status, error.c_str());
      say_status(!error.empty() ? error : status < 0 ? "Can't reach the Tidbit server." : "Something went wrong.");
      vTaskDelay(pdMS_TO_TICKS(4000));
      say_status("");
      busy = false;
      continue;
    }
    // The answer's turn arrives through the stream (face, gestures, words on screen).
    say_status("");
    if (!text.empty()) {
      audio_play_begin();
      net_speak(text, play);
      audio_play_end();
    }
    busy = false;
  }
}

void voice_start() {
  if (!audio_init()) {
    ESP_LOGW(TAG, "no codec; voice is off");
    return;
  }
  xTaskCreatePinnedToCore(voice_task, "voice", 6144, nullptr, 4, &task, 0);
}

bool voice_ready() { return task != nullptr; }

void voice_listen(bool on) {
  if (!task) return;
  if (on && busy) return;  // still answering the last one
  listening = on;
  if (on) xTaskNotifyGive(task);
}

void voice_cancel() {
  cancelled = true;
  listening = false;
}

bool voice_busy() { return busy || listening; }
bool voice_heard() { return heard; }
