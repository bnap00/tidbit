// What the rest of the firmware needs from a board: the screen and its panel, touch,
// the button and the IMU. One board_*.cpp is built,
// chosen in menuconfig → Tidbit (see boards/*.defaults and idf.sh).
#pragma once
#include <stdint.h>

// As in driver/i2c_master.h, so host builds of the rasteriser need no ESP-IDF headers.
typedef struct i2c_master_bus_t* i2c_master_bus_handle_t;

struct InitCmd {
  uint8_t reg;
  uint8_t data[4];
  uint8_t len;
  uint16_t delay_ms;
};

/** A QSPI AMOLED driven with the SH8601/CO5300 command set. */
struct Panel {
  int cs, sclk, d0, d1, d2, d3;
  const InitCmd* init;
  int initLen;
  int xOffset;
};

/**
 * Screen layout. The pal and its backdrop fill the screen; the rig's 240-unit canvas
 * maps to pixels as p = v·k + (ox, oy). Its words are drawn over the backdrop in two
 * lines starting at row `captionY`.
 */
struct Layout {
  int w, h;
  float k, ox, oy;
  int captionY;
};

struct Board {
  const char* name;
  Layout screen;
  Panel panel;
  /** How the owner should hold the button, for on-screen hints. */
  const char* button;
};

const Board& board_init();
/** The I²C bus shared by touch, power, the IMU and the audio codec. */
i2c_master_bus_handle_t board_i2c();
const Board& board();

struct TouchPoint {
  bool down;
  int x, y;
};
TouchPoint board_touch();

/** True while the main button (BOOT) is held. */
bool board_button();

struct Motion {
  bool ok;         // false without an IMU
  float ax, ay, az;  // g, in screen axes: x right, y down, z out of the screen
  float gx, gy, gz;  // degrees per second, about the same axes
};
/** The IMU's latest reading. */
Motion board_motion();
