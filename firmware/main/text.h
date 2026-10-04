// Anti-aliased text into an RGB565 canvas (big-endian pixels, as the panel wants).
#pragma once
#include <stdint.h>
#include <string>
#include <vector>

#include "board.h"
#include "font.h"

extern const Font& FONT_TEXT;   // captions and messages
extern const Font& FONT_NOTE;   // small print
extern const Font& FONT_DIGITS; // the pairing code

struct Canvas {
  uint16_t* px;
  int w, h;
  void fill(uint16_t c);
  void fill_rect(int x, int y, int w, int h, uint16_t c);
};

struct Rgb {
  uint8_t r, g, b;
};

int text_width(const Font& f, const std::string& s, size_t bytes = std::string::npos);
/** Draw one line with its top at y. */
void text_draw(Canvas& c, const Font& f, int x, int y, const std::string& s, Rgb fg, Rgb bg);
/** Split into lines no wider than `width`, breaking at spaces where possible. */
std::vector<std::string> text_wrap(const Font& f, const std::string& s, int width);
/** Lines centred horizontally, block centred on `cy`. */
void text_block(Canvas& c, const Font& f, int cy, const std::string& s, Rgb fg, Rgb bg,
                int width = 320);
/**
 * The pal's words as a 4-bit coverage mask (one byte per pixel, screen width, rows from
 * `screen.captionY`): up to two centred lines, the newest when longer. Returns the rows
 * used.
 */
int caption_mask(uint8_t* mask, int rows, const Layout& screen, const Font& f,
                 const std::string& words);
/** Usable text width inside a margin. */
int text_room(const Layout& screen, int margin);
/** The words' colour (native RGB565): light on a dark backdrop, dark on a pale one. */
uint16_t caption_ink(const uint8_t palette[8][3], bool dark);
/** Mix a big-endian RGB565 pixel towards a native RGB565 colour by a/15. */
static inline uint16_t mix565(uint16_t px, uint16_t fg, int a) {
  uint16_t p = (uint16_t)(px >> 8 | px << 8);
  int r = p >> 11, g = (p >> 5) & 63, b = p & 31;
  r += ((fg >> 11) - r) * a / 15;
  g += (((fg >> 5) & 63) - g) * a / 15;
  b += ((fg & 31) - b) * a / 15;
  uint16_t v = (uint16_t)(r << 11 | g << 5 | b);
  return (uint16_t)(v >> 8 | v << 8);
}
/** The first n characters (code points) of a UTF-8 string. */
std::string utf8_prefix(const std::string& s, int n);
int utf8_length(const std::string& s);
