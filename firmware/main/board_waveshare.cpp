// Waveshare ESP32-S3-Touch-AMOLED-1.8: 368×448 AMOLED (V1 SH8601 + FT3168, V2 CO5300 +
// CST820), AXP2101 power, TCA9554 IO expander for the resets, QMI8658 IMU, BOOT and PWR
// buttons.
#include <sdkconfig.h>
#if CONFIG_PAL_BOARD_WAVESHARE_AMOLED_18

#include <driver/gpio.h>
#include <driver/i2c_master.h>
#include <esp_log.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>

#include "board.h"

static const char* TAG = "board";

static constexpr gpio_num_t I2C_SDA = GPIO_NUM_15;
static constexpr gpio_num_t I2C_SCL = GPIO_NUM_14;
static constexpr gpio_num_t BOOT_PIN = GPIO_NUM_0;
static constexpr gpio_num_t V2_TOUCH_RST = GPIO_NUM_39;
static constexpr uint8_t TCA9554_ADDR = 0x20;
static constexpr uint8_t AXP2101_ADDR = 0x34;
static constexpr uint8_t FT3168_ADDR = 0x38;
static constexpr uint8_t CST820_ADDR = 0x15;
static constexpr uint8_t QMI8658_ADDR = 0x6B;

// From XiaoZhi's board support for the two revisions.
static const InitCmd SH8601_INIT[] = {
    {0x11, {}, 0, 120},
    {0x3A, {0x55}, 1, 0},  // RGB565
    {0x36, {0x00}, 1, 0},
    {0x44, {0x01, 0xD1}, 2, 0},
    {0x35, {0x00}, 1, 0},
    {0x53, {0x20}, 1, 10},
    {0x2A, {0x00, 0x00, 0x01, 0x6F}, 4, 0},
    {0x2B, {0x00, 0x00, 0x01, 0xBF}, 4, 0},
    {0x51, {0x00}, 1, 10},
    {0x29, {}, 0, 10},
};
static const InitCmd CO5300_INIT[] = {
    {0x11, {}, 0, 600},
    {0xFE, {0x20}, 1, 0},
    {0x19, {0x10}, 1, 0},
    {0x1C, {0xA0}, 1, 0},
    {0xFE, {0x00}, 1, 0},
    {0xC4, {0x80}, 1, 0},
    {0x3A, {0x55}, 1, 0},
    {0x35, {0x00}, 1, 0},
    {0x53, {0x20}, 1, 0},
    {0x51, {0x00}, 1, 0},
    {0x63, {0xFF}, 1, 0},
    {0x2A, {0x00, 0x00, 0x01, 0xDF}, 4, 0},
    {0x2B, {0x00, 0x00, 0x01, 0xDF}, 4, 0},
    {0x36, {0x00}, 1, 0},
    {0x29, {}, 0, 100},
};

static Board B = {
    "Waveshare ESP32-S3-Touch-AMOLED-1.8",
    // The pal centred in the upper part, its words under its feet.
    {368, 448, 1.65f, 184 - 120 * 1.65f, 175 - 125 * 1.65f, 372},
    {12, 11, 4, 5, 6, 7, SH8601_INIT, sizeof SH8601_INIT / sizeof *SH8601_INIT, 0},
    "BOOT",
};

static i2c_master_bus_handle_t bus;
static i2c_master_dev_handle_t touch_dev;
static i2c_master_dev_handle_t imu_dev;

static i2c_master_dev_handle_t add(uint8_t addr) {
  i2c_device_config_t cfg = {};
  cfg.dev_addr_length = I2C_ADDR_BIT_LEN_7;
  cfg.device_address = addr;
  cfg.scl_speed_hz = 400000;
  i2c_master_dev_handle_t dev = nullptr;
  ESP_ERROR_CHECK(i2c_master_bus_add_device(bus, &cfg, &dev));
  return dev;
}

static esp_err_t write_reg(i2c_master_dev_handle_t dev, uint8_t reg, uint8_t value) {
  uint8_t buf[2] = {reg, value};
  return i2c_master_transmit(dev, buf, 2, 50);
}

static void tca9554_reset_peripherals() {
  auto dev = add(TCA9554_ADDR);
  // Pins 0-2 drive the screen and touch resets; pin 4 is an input.
  if (write_reg(dev, 0x03, 0xF8) != ESP_OK) ESP_LOGE(TAG, "TCA9554 not found");
  write_reg(dev, 0x01, 0x07);
  vTaskDelay(pdMS_TO_TICKS(100));
  write_reg(dev, 0x01, 0x00);
  vTaskDelay(pdMS_TO_TICKS(300));
  write_reg(dev, 0x01, 0x07);
  vTaskDelay(pdMS_TO_TICKS(50));
}

static void axp2101_init() {
  auto dev = add(AXP2101_ADDR);
  // The same rails as XiaoZhi's board support: DC1 3.3 V, ALDO1 3.3 V, 4.1 V charging.
  const uint8_t regs[][2] = {
      {0x22, 0b110}, {0x27, 0x10},  // PWR held 4 s powers off
      {0x80, 0x01},                 // only DC1
      {0x90, 0x00}, {0x91, 0x00},   // LDOs off
      {0x82, (3300 - 1500) / 100},  // DC1 3.3 V
      {0x92, (3300 - 500) / 100},   // ALDO1 3.3 V
      {0x90, 0x01},                 // ALDO1 on
      {0x64, 0x02}, {0x61, 0x02}, {0x62, 0x08}, {0x63, 0x01},
  };
  for (auto& r : regs)
    if (write_reg(dev, r[0], r[1]) != ESP_OK) {
      ESP_LOGE(TAG, "AXP2101 not found");
      return;
    }
}

static void qmi8658_init() {
  if (i2c_master_probe(bus, QMI8658_ADDR, 50) != ESP_OK) {
    ESP_LOGW(TAG, "QMI8658 not found");
    return;
  }
  auto dev = add(QMI8658_ADDR);
  uint8_t reg = 0x00, who = 0;
  if (i2c_master_transmit_receive(dev, &reg, 1, &who, 1, 50) != ESP_OK || who != 0x05) {
    ESP_LOGW(TAG, "QMI8658 answered 0x%02x", who);
    return;
  }
  write_reg(dev, 0x60, 0xB0);  // soft reset
  vTaskDelay(pdMS_TO_TICKS(20));
  const uint8_t regs[][2] = {
      {0x02, 0x40},  // CTRL1: address auto-increment, little endian
      {0x03, 0x16},  // CTRL2: accelerometer ±4 g, 125 Hz
      {0x04, 0x56},  // CTRL3: gyroscope ±512 dps, 125 Hz
      {0x08, 0x03},  // CTRL7: both on
  };
  for (auto& r : regs) write_reg(dev, r[0], r[1]);
  imu_dev = dev;
  ESP_LOGI(TAG, "QMI8658 ready");
}

const Board& board() { return B; }
i2c_master_bus_handle_t board_i2c() { return bus; }

const Board& board_init() {
  i2c_master_bus_config_t cfg = {};
  cfg.i2c_port = I2C_NUM_0;
  cfg.sda_io_num = I2C_SDA;
  cfg.scl_io_num = I2C_SCL;
  cfg.clk_source = I2C_CLK_SRC_DEFAULT;
  cfg.glitch_ignore_cnt = 7;
  cfg.flags.enable_internal_pullup = 1;
  ESP_ERROR_CHECK(i2c_new_master_bus(&cfg, &bus));

  gpio_config_t boot = {};
  boot.pin_bit_mask = 1ULL << BOOT_PIN;
  boot.mode = GPIO_MODE_INPUT;
  boot.pull_up_en = GPIO_PULLUP_ENABLE;
  gpio_config(&boot);

  tca9554_reset_peripherals();
  axp2101_init();
  qmi8658_init();

  // V2 boards reset touch from a GPIO; harmless on V1 where the pin is unused.
  gpio_config_t rst = {};
  rst.pin_bit_mask = 1ULL << V2_TOUCH_RST;
  rst.mode = GPIO_MODE_OUTPUT;
  gpio_config(&rst);
  gpio_set_level(V2_TOUCH_RST, 0);
  vTaskDelay(pdMS_TO_TICKS(10));
  gpio_set_level(V2_TOUCH_RST, 1);
  vTaskDelay(pdMS_TO_TICKS(60));

  bool v2;
#if CONFIG_PAL_WS_REV_V1
  v2 = false;
#elif CONFIG_PAL_WS_REV_V2
  v2 = true;
#else
  if (i2c_master_probe(bus, FT3168_ADDR, 50) == ESP_OK) v2 = false;
  else if (i2c_master_probe(bus, CST820_ADDR, 50) == ESP_OK) v2 = true;
  else {
    ESP_LOGW(TAG, "no touch controller answered; assuming V1");
    v2 = false;
  }
#endif
  if (v2) {
    B.panel.init = CO5300_INIT;
    B.panel.initLen = sizeof CO5300_INIT / sizeof *CO5300_INIT;
    B.panel.xOffset = 16;
  }
  touch_dev = add(v2 ? CST820_ADDR : FT3168_ADDR);
  // CST8xx sleeps when idle and stops answering; keep it awake.
  if (v2) write_reg(touch_dev, 0xFE, 0x01);
  ESP_LOGI(TAG, "%s %s", B.name, v2 ? "V2 (CO5300/CST820)" : "V1 (SH8601/FT3168)");
  return B;
}

TouchPoint board_touch() {
  // FT3168 and CST820 share this layout: points, XH, XL, YH, YL from register 0x02.
  uint8_t reg = 0x02;
  uint8_t d[5] = {};
  if (i2c_master_transmit_receive(touch_dev, &reg, 1, d, sizeof d, 20) != ESP_OK) return {};
  int n = d[0] & 0x0F;
  if (n == 0 || n > 5) return {};
  int x = ((d[1] & 0x0F) << 8) | d[2];
  int y = ((d[3] & 0x0F) << 8) | d[4];
  if (x >= B.screen.w || y >= B.screen.h) return {};
  return {true, x, y};
}

bool board_button() { return gpio_get_level(BOOT_PIN) == 0; }
Motion board_motion() {
  if (!imu_dev) return {};
  uint8_t reg = 0x35;  // AX_L … GZ_H
  uint8_t d[12];
  if (i2c_master_transmit_receive(imu_dev, &reg, 1, d, sizeof d, 20) != ESP_OK) return {};
  auto at = [&](int i) { return (float)(int16_t)(d[i] | d[i + 1] << 8); };
  // The chip's axes, mapped to the screen's. Check with GET /info: lying face up on a
  // table should read about z = +1, and tilting the right edge down x = -1.
  const float A = 1 / 8192.f, G = 1 / 64.f;
  return {true, at(0) * A, -at(2) * A, -at(4) * A, at(6) * G, -at(8) * G, -at(10) * G};
}

#endif
