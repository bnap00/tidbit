#include "audio.h"

#include <driver/i2c_master.h>
#include <driver/i2s_std.h>
#include <esp_codec_dev.h>
#include <esp_codec_dev_defaults.h>
#include <esp_log.h>
#include <math.h>
#include <string.h>

#include <algorithm>
#include <vector>

#include "app.h"
#include "board.h"

static const char* TAG = "audio";

// Pins from XiaoZhi's board support (waveshare/esp32-s3-touch-amoled-1.8[-v2]).
static constexpr gpio_num_t MCLK = GPIO_NUM_16, BCLK = GPIO_NUM_9, WS = GPIO_NUM_45;
static constexpr gpio_num_t DOUT = GPIO_NUM_8, DIN = GPIO_NUM_10, PA = GPIO_NUM_46;
static constexpr int MIC_GAIN_DB = 30;

static esp_codec_dev_handle_t dev;

bool audio_init() {
  i2s_chan_handle_t tx = nullptr, rx = nullptr;
  i2s_chan_config_t chan = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_MASTER);
  chan.auto_clear_after_cb = true;
  if (i2s_new_channel(&chan, &tx, &rx) != ESP_OK) return false;
  i2s_std_config_t std = {
      .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(AUDIO_RATE),
      .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_STEREO),
      .gpio_cfg = {.mclk = MCLK, .bclk = BCLK, .ws = WS, .dout = DOUT, .din = DIN, .invert_flags = {}},
  };
  std.clk_cfg.mclk_multiple = I2S_MCLK_MULTIPLE_256;
  ESP_ERROR_CHECK(i2s_channel_init_std_mode(tx, &std));
  ESP_ERROR_CHECK(i2s_channel_init_std_mode(rx, &std));
  ESP_ERROR_CHECK(i2s_channel_enable(tx));
  ESP_ERROR_CHECK(i2s_channel_enable(rx));

  audio_codec_i2s_cfg_t i2s_cfg = {.port = I2S_NUM_0, .rx_handle = rx, .tx_handle = tx};
  const audio_codec_data_if_t* data_if = audio_codec_new_i2s_data(&i2s_cfg);
  audio_codec_i2c_cfg_t i2c_cfg = {.port = I2C_NUM_0, .addr = ES8311_CODEC_DEFAULT_ADDR, .bus_handle = board_i2c()};
  const audio_codec_ctrl_if_t* ctrl_if = audio_codec_new_i2c_ctrl(&i2c_cfg);
  const audio_codec_gpio_if_t* gpio_if = audio_codec_new_gpio();
  if (!data_if || !ctrl_if || !gpio_if) return false;

  es8311_codec_cfg_t cfg = {};
  cfg.ctrl_if = ctrl_if;
  cfg.gpio_if = gpio_if;
  cfg.codec_mode = ESP_CODEC_DEV_WORK_MODE_BOTH;
  cfg.pa_pin = PA;
  cfg.use_mclk = true;
  cfg.hw_gain.pa_voltage = 5.0;
  cfg.hw_gain.codec_dac_voltage = 3.3;
  const audio_codec_if_t* codec = es8311_codec_new(&cfg);
  if (!codec) {
    ESP_LOGE(TAG, "ES8311 not found");
    return false;
  }
  esp_codec_dev_cfg_t dev_cfg = {.dev_type = ESP_CODEC_DEV_TYPE_IN_OUT, .codec_if = codec, .data_if = data_if};
  dev = esp_codec_dev_new(&dev_cfg);
  esp_codec_dev_sample_info_t fs = {};
  fs.bits_per_sample = 16;
  fs.channel = 1;
  fs.sample_rate = AUDIO_RATE;
  if (!dev || esp_codec_dev_open(dev, &fs) != ESP_CODEC_DEV_OK) {
    dev = nullptr;
    return false;
  }
  esp_codec_dev_set_in_gain(dev, MIC_GAIN_DB);
  int volume;
  {
    Lock l;
    volume = shared.volume;
  }
  esp_codec_dev_set_out_vol(dev, volume);
  ESP_LOGI(TAG, "ES8311 ready");
  return true;
}

bool audio_ok() { return dev != nullptr; }

void audio_set_volume(int volume) {
  if (dev) esp_codec_dev_set_out_vol(dev, volume);
}

void audio_tone(int hz, int ms) {
  if (!dev) return;
  std::vector<int16_t> pcm(AUDIO_RATE * ms / 1000);
  for (size_t i = 0; i < pcm.size(); i++) {
    // Soft edges, so it doesn't click.
    float env = std::min({1.f, i / 240.f, (pcm.size() - i) / 240.f});
    pcm[i] = (int16_t)(9000 * env * sinf(6.2831853f * hz * i / AUDIO_RATE));
  }
  esp_codec_dev_write(dev, pcm.data(), pcm.size() * 2);
}

bool audio_read(int16_t* pcm, int samples) {
  return dev && esp_codec_dev_read(dev, pcm, samples * 2) == ESP_CODEC_DEV_OK;
}

// ---- WAV playback ---------------------------------------------------------------

static std::vector<uint8_t> head;  // bytes until the data chunk is found
static bool playing;
static int rate, channels, bits;
static float step, pos;          // resampling to AUDIO_RATE, nearest sample
static std::vector<int16_t> out;
static uint8_t carry[4];
static int carried;

void audio_play_begin() {
  head.clear();
  playing = false;
  carried = 0;
}

static uint32_t le32(const uint8_t* p) { return p[0] | p[1] << 8 | p[2] << 16 | (uint32_t)p[3] << 24; }

/** Find fmt and data in the header; returns the offset of the PCM, or 0 if not yet. */
static size_t parse_header() {
  if (head.size() < 12 || memcmp(head.data(), "RIFF", 4) || memcmp(head.data() + 8, "WAVE", 4)) return 0;
  size_t o = 12;
  while (o + 8 <= head.size()) {
    uint32_t len = le32(&head[o + 4]);
    if (!memcmp(&head[o], "fmt ", 4) && o + 24 <= head.size()) {
      channels = head[o + 10] | head[o + 11] << 8;
      rate = (int)le32(&head[o + 12]);
      bits = head[o + 22] | head[o + 23] << 8;
    }
    if (!memcmp(&head[o], "data", 4)) return o + 8;
    o += 8 + len + (len & 1);
  }
  return 0;
}

static void play_pcm(const uint8_t* data, size_t len) {
  const int frame = channels * 2;
  out.clear();
  // Whole frames only; a split one waits for the next piece.
  while (len > 0) {
    if (carried || len < (size_t)frame) {
      size_t n = std::min(len, (size_t)(frame - carried));
      memcpy(carry + carried, data, n);
      carried += n, data += n, len -= n;
      if (carried < frame) break;
      carried = 0;
      int16_t s;
      memcpy(&s, carry, 2);
      for (pos += 1; pos >= step; pos -= step) out.push_back(s);
      continue;
    }
    int16_t s;
    memcpy(&s, data, 2);  // the left channel when stereo
    for (pos += 1; pos >= step; pos -= step) out.push_back(s);
    data += frame, len -= frame;
  }
  if (!out.empty()) esp_codec_dev_write(dev, out.data(), out.size() * 2);
}

void audio_play_feed(const uint8_t* data, size_t len) {
  if (!dev) return;
  if (!playing) {
    head.insert(head.end(), data, data + len);
    size_t at = parse_header();
    if (!at) {
      if (head.size() > 4096) head.clear();  // not a WAV we understand
      return;
    }
    if (bits != 16 || channels < 1 || channels > 2 || rate <= 0) {
      ESP_LOGW(TAG, "unsupported WAV: %d Hz, %d ch, %d bit", rate, channels, bits);
      head.clear();
      return;
    }
    playing = true;
    step = (float)rate / AUDIO_RATE;
    pos = 0;
    std::vector<uint8_t> rest(head.begin() + std::min(at, head.size()), head.end());
    head.clear();
    if (!rest.empty()) play_pcm(rest.data(), rest.size());
    return;
  }
  play_pcm(data, len);
}

void audio_play_end() {
  if (!dev || !playing) return;
  // Let the last DMA buffers drain as silence instead of a click.
  std::vector<int16_t> silence(AUDIO_RATE / 20, 0);
  esp_codec_dev_write(dev, silence.data(), silence.size() * 2);
  playing = false;
}
