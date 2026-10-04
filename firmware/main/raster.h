// The rig's primitives, rasterised into an indexed buffer (a port of the rig's
// IndexedBufferTarget). Each pixel is a palette slot (bits 0-2) and a light level
// (bits 3-7, 16 = flat), so bodies get the soft top-left light of the browser pal.
#pragma once
#include <stdint.h>

enum Slot : uint8_t { BG, OUTLINE, BODY, SHADE, ACCENT, EYE_WHITE, DARK, FX };
constexpr int LEVELS = 32;
constexpr int FLAT = 16;

class Raster {
 public:
  /** A w×h pixel area; the rig's 240-unit canvas maps to p = v·k + (ox, oy). */
  Raster(uint8_t* pixels, int w, int h, float k, float ox, float oy);

  void clear(uint8_t c);
  void ellipse(float cx, float cy, float rx, float ry, uint8_t c);
  void roundRect(float x, float y, float w, float h, float r, uint8_t c);
  void tri(float x1, float y1, float x2, float y2, float x3, float y3, uint8_t c);
  void line(float x1, float y1, float x2, float y2, float width, uint8_t c);
  void arc(float cx, float cy, float r, float a0, float a1, float width, uint8_t c);

  /**
   * Dark backdrop: the pal's backdrop colour as a soft glow behind it, falling to black
   * at the edges (AMOLED pixels off), instead of a full-colour gradient.
   */
  bool dark = false;

  /**
   * The backdrop in full colour precision, dithered to big-endian RGB565, for the BG
   * pixels of the indexed frame (they would band through the LUT).
   */
  void paint_backdrop565(const uint8_t palette[8][3], uint16_t* out) const;

  /** Decode and draw one streamed frame (see apps/brain/src/rig-stream.ts). */
  bool frame(const uint8_t* data, int len);

  uint8_t* const px;
  const int w, h;

 private:
  const float k, ox, oy;
  /** The backdrop never moves, so it is drawn once and copied (see clear). */
  uint8_t* backdrop = nullptr;
  int backdropKey = -1;
  void paint_backdrop(uint8_t* out, uint8_t c) const;
  /** The backdrop's light level (0…LEVELS-1, fractional) at a pixel. */
  float backdrop_level(int x, int y) const;
  /** Pixel range [a, b] whose centres fall in the virtual interval [v0, v1]. */
  int x0(float v) const;
  int x1(float v) const;
  int y0(float v) const;
  int y1(float v) const;
  float vx(int p) const { return (p + 0.5f - ox) / k; }
  float vy(int p) const { return (p + 0.5f - oy) / k; }
  template <typename F>
  void box(float x0, float y0, float x1, float y1, F fn);
};

/** Big-endian RGB565 for every (slot, level) byte, from the pal's 8 colours. */
void build_lut(const uint8_t palette[8][3], uint16_t lut[256], bool dark);
/** The backdrop's colour at a light level, as build_lut makes it. */
void backdrop_rgb(const uint8_t palette[8][3], int level, bool dark, uint8_t out[3]);
