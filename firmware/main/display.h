// The board's QSPI AMOLED (SH8601 or CO5300 command set). Pixels go out in strips
// from two DMA buffers, so filling one strip overlaps sending the other.
#pragma once
#include <stdint.h>

#include "board.h"

constexpr int STRIP_ROWS = 16;

void display_init(const Board& b);
/** Diagnostics for GET /info: where the driver is, and finished pixel transfers. */
extern volatile int display_stage;
extern volatile uint32_t display_done;
/** 0–255. */
void display_brightness(uint8_t level);
/** Panel on or off (off keeps its memory, so on shows the last frame). */
void display_power(bool on);

// Implementation detail of display_rows.
void display_begin(int y0, int rows);
uint16_t* display_strip();
void display_send(uint16_t* strip, int rows);
int display_width();

/**
 * Send rows [y0, y0 + rows) of the full screen width. `fill(y, n, out)` writes n rows
 * starting at screen row y into `out` as big-endian RGB565 (what the panel expects).
 */
template <typename Fill>
void display_rows(int y0, int rows, Fill fill) {
  display_begin(y0, rows);
  for (int y = y0; y < y0 + rows; y += STRIP_ROWS) {
    int n = y0 + rows - y < STRIP_ROWS ? y0 + rows - y : STRIP_ROWS;
    uint16_t* out = display_strip();
    fill(y, n, out);
    display_send(out, n);
  }
}

/** Swap to the panel's byte order. */
static inline uint16_t rgb565(uint8_t r, uint8_t g, uint8_t b) {
  uint16_t v = ((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3);
  return (uint16_t)((v >> 8) | (v << 8));
}
