#include "display.h"

#include <driver/gpio.h>
#include <driver/spi_master.h>
#include <esp_heap_caps.h>
#include <esp_lcd_panel_io.h>
#include <esp_log.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#include <freertos/task.h>

static const char* TAG = "display";

// QSPI opcodes: the command byte rides in bits 15:8 of a 32-bit command word.
static constexpr uint32_t OP_WRITE_CMD = 0x02;
static constexpr uint32_t OP_WRITE_COLOR = 0x32;

static esp_lcd_panel_io_handle_t io;
static SemaphoreHandle_t free_strips;
static uint16_t* strips[2];
static int next_strip;
static int width, x_offset;
static bool first_strip;
volatile int display_stage;
volatile uint32_t display_done;

static bool on_done(esp_lcd_panel_io_handle_t, esp_lcd_panel_io_event_data_t*, void*) {
  BaseType_t woken = pdFALSE;
  display_done++;
  xSemaphoreGiveFromISR(free_strips, &woken);
  return woken == pdTRUE;
}

static void cmd(uint8_t reg, const uint8_t* data = nullptr, size_t len = 0) {
  display_stage = 10 + reg;  // a command (waits for queued pixels)
  ESP_ERROR_CHECK(esp_lcd_panel_io_tx_param(io, (OP_WRITE_CMD << 24) | (reg << 8), data, len));
}

int display_width() { return width; }

void display_init(const Board& b) {
  const Panel& p = b.panel;
  width = b.screen.w;
  x_offset = p.xOffset;

  spi_bus_config_t bus = {};
  bus.sclk_io_num = p.sclk;
  bus.data0_io_num = p.d0;
  bus.data1_io_num = p.d1;
  bus.data2_io_num = p.d2;
  bus.data3_io_num = p.d3;
  bus.max_transfer_sz = width * STRIP_ROWS * 2 + 64;
  bus.flags = SPICOMMON_BUSFLAG_QUAD;
  // The screen task (core 1) queues the pixels, so their interrupt lives there too. On
  // core 0 a flash write (Wi-Fi saving its settings on a reconnect) could leave it
  // disabled while the driver thought it on: the transfer done, the screen frozen.
  bus.isr_cpu_id = ESP_INTR_CPU_AFFINITY_1;
  ESP_ERROR_CHECK(spi_bus_initialize(SPI2_HOST, &bus, SPI_DMA_CH_AUTO));

  esp_lcd_panel_io_spi_config_t cfg = {};
  cfg.cs_gpio_num = p.cs;
  cfg.dc_gpio_num = GPIO_NUM_NC;
  cfg.spi_mode = 0;
  cfg.pclk_hz = 40 * 1000 * 1000;
  cfg.trans_queue_depth = 4;
  cfg.lcd_cmd_bits = 32;
  cfg.lcd_param_bits = 8;
  cfg.flags.quad_mode = true;
  cfg.on_color_trans_done = on_done;
  ESP_ERROR_CHECK(esp_lcd_new_panel_io_spi(SPI2_HOST, &cfg, &io));

  free_strips = xSemaphoreCreateCounting(2, 2);
  for (auto& s : strips) {
    s = (uint16_t*)heap_caps_malloc(width * STRIP_ROWS * 2, MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL);
    assert(s);
  }

  for (int i = 0; i < p.initLen; i++) {
    cmd(p.init[i].reg, p.init[i].len ? p.init[i].data : nullptr, p.init[i].len);
    if (p.init[i].delay_ms) vTaskDelay(pdMS_TO_TICKS(p.init[i].delay_ms));
  }
  // Start black, then light up, so the panel never flashes its old contents.
  display_rows(0, b.screen.h, [](int, int n, uint16_t* out) {
    for (int i = 0; i < width * n; i++) out[i] = 0;
  });
  display_brightness(220);
  ESP_LOGI(TAG, "ready");
}

void display_brightness(uint8_t level) { cmd(0x51, &level, 1); }

void display_power(bool on) { cmd(on ? 0x29 : 0x28, nullptr, 0); }

void display_begin(int y0, int rows) {
  // tx_param waits for queued pixels, so the window is set once per region and the
  // strips follow as RAMWR then RAMWR_CONTINUE.
  int x1 = x_offset + width - 1;
  int y1 = y0 + rows - 1;
  uint8_t ca[4] = {(uint8_t)(x_offset >> 8), (uint8_t)x_offset, (uint8_t)(x1 >> 8), (uint8_t)x1};
  uint8_t ra[4] = {(uint8_t)(y0 >> 8), (uint8_t)y0, (uint8_t)(y1 >> 8), (uint8_t)y1};
  cmd(0x2A, ca, 4);
  cmd(0x2B, ra, 4);
  first_strip = true;
}

uint16_t* display_strip() {
  display_stage = 1;  // waiting for a free strip
  xSemaphoreTake(free_strips, portMAX_DELAY);
  display_stage = 2;  // filling it
  uint16_t* s = strips[next_strip];
  next_strip ^= 1;
  return s;
}

void display_send(uint16_t* strip, int rows) {
  uint32_t ram = first_strip ? 0x2C : 0x3C;
  first_strip = false;
  display_stage = 3;  // queueing it
  ESP_ERROR_CHECK(esp_lcd_panel_io_tx_color(io, (OP_WRITE_COLOR << 24) | (ram << 8), strip,
                                            width * rows * 2));
  display_stage = 4;
}
