#include "raster.h"

#include <math.h>
#include <stdlib.h>
#include <string.h>
#include <algorithm>

#include "display.h"

static constexpr float TAU = 6.28318530718f;

static inline bool shaded(uint8_t c) {
  return c == BODY || c == SHADE || c == ACCENT || c == EYE_WHITE || c == FX;
}

// 4×4 ordered dither, so light levels blend instead of banding.
static const float BAYER[16] = {0,     0.5f,   0.125f, 0.625f, 0.75f,  0.25f,  0.875f, 0.375f,
                                0.1875f, 0.6875f, 0.0625f, 0.5625f, 0.9375f, 0.4375f, 0.8125f, 0.3125f};
static inline float dither(int x, int y) { return BAYER[(y & 3) * 4 + (x & 3)]; }

/** Light at a point of a rounded shape, nx/ny in -1…1 from its centre: lit top-left. */
static inline uint8_t light(float nx, float ny, float dith) {
  float d = 0.15f - 0.45f * nx - 0.8f * ny - 0.35f * (nx * nx + ny * ny);
  int l = (int)(FLAT + d * 14.f + dith);
  return (uint8_t)(l < 0 ? 0 : l > LEVELS - 1 ? LEVELS - 1 : l);
}

static inline uint8_t flat(uint8_t c) { return (uint8_t)(c | (FLAT << 3)); }

Raster::Raster(uint8_t* pixels, int w, int h, float k, float ox, float oy)
    : px(pixels), w(w), h(h), k(k), ox(ox), oy(oy) {}

int Raster::x0(float v) const { return std::max(0, (int)ceilf(v * k + ox - 0.5f)); }
int Raster::x1(float v) const { return std::min(w - 1, (int)floorf(v * k + ox - 0.5f)); }
int Raster::y0(float v) const { return std::max(0, (int)ceilf(v * k + oy - 0.5f)); }
int Raster::y1(float v) const { return std::min(h - 1, (int)floorf(v * k + oy - 0.5f)); }

float Raster::backdrop_level(int x, int y) const {
  if (dark) {
    // A glow centred a little below the pal's middle, black by the corners. Smooth all
    // the way out: a kink in the falloff shows as a ring.
    float dx = (x + 0.5f - (120 * k + ox)) / (150 * k), dy = (y + 0.5f - (130 * k + oy)) / (150 * k);
    return 22 * expf(-2.f * (dx * dx + dy * dy));
  }
  // The backdrop darkens a little towards the floor.
  return 20.f - y * 10.f / h;
}

void Raster::paint_backdrop(uint8_t* px, uint8_t c) const {
  for (int y = 0; y < h; y++) {
    uint8_t* row = px + y * w;
    for (int x = 0; x < w; x++) {
      int l = (int)(backdrop_level(x, y) + dither(x, y));
      row[x] = (uint8_t)(c | (l < 0 ? 0 : l > LEVELS - 1 ? LEVELS - 1 : l) << 3);
    }
  }
}

void Raster::clear(uint8_t c) {
  int key = c | (dark ? 0x100 : 0);
  if (!backdrop) backdrop = (uint8_t*)malloc(w * h);  // PSRAM on the device
  if (!backdrop) return paint_backdrop(px, c);
  if (key != backdropKey) {
    paint_backdrop(backdrop, c);
    backdropKey = key;
  }
  memcpy(px, backdrop, w * h);
}

template <typename F>
void Raster::box(float x0, float y0, float x1, float y1, F fn) {
  int ax = this->x0(x0), bx = this->x1(x1);
  int ay = this->y0(y0), by = this->y1(y1);
  for (int py = ay; py <= by; py++) {
    float v = vy(py);
    uint8_t* row = px + py * w;
    for (int pxi = ax; pxi <= bx; pxi++) fn(row + pxi, vx(pxi), v);
  }
}

void Raster::ellipse(float cx, float cy, float rx, float ry, uint8_t c) {
  if (!(rx > 0 && ry > 0)) return;
  bool sh = shaded(c);
  int ay = y0(cy - ry), by = y1(cy + ry);
  for (int py = ay; py <= by; py++) {
    float t = (vy(py) - cy) / ry;
    float hw = rx * sqrtf(std::max(0.f, 1 - t * t));
    int a = x0(cx - hw), b = x1(cx + hw);
    uint8_t* row = px + py * w;
    if (!sh) {
      if (b >= a) memset(row + a, flat(c), b - a + 1);
      continue;
    }
    for (int x = a; x <= b; x++)
      row[x] = (uint8_t)(c | light((vx(x) - cx) / rx, t, dither(x, py)) << 3);
  }
}

void Raster::roundRect(float x, float y, float rw, float rh, float r, uint8_t c) {
  if (!(rw > 0 && rh > 0)) return;
  r = std::max(0.f, std::min(r, std::min(rw / 2, rh / 2)));
  bool sh = shaded(c);
  float cx = x + rw / 2, cy = y + rh / 2;
  int ay = y0(y), by = y1(y + rh);
  for (int py = ay; py <= by; py++) {
    float v = vy(py);
    float dy = v < y + r ? y + r - v : v > y + rh - r ? v - (y + rh - r) : 0;
    float inset = dy > 0 ? r - sqrtf(std::max(0.f, r * r - dy * dy)) : 0;
    int a = x0(x + inset), b = x1(x + rw - inset);
    uint8_t* row = px + py * w;
    if (!sh) {
      if (b >= a) memset(row + a, flat(c), b - a + 1);
      continue;
    }
    float ny = (v - cy) / (rh / 2);
    for (int i = a; i <= b; i++)
      row[i] = (uint8_t)(c | light((vx(i) - cx) / (rw / 2), ny, dither(i, py)) << 3);
  }
}

void Raster::tri(float x1, float y1, float x2, float y2, float x3, float y3, uint8_t c) {
  float area = (x2 - x1) * (y3 - y1) - (y2 - y1) * (x3 - x1);
  if (area == 0) return;
  float s = area > 0 ? 1 : -1;
  uint8_t v = flat(c);
  box(std::min({x1, x2, x3}), std::min({y1, y2, y3}), std::max({x1, x2, x3}),
      std::max({y1, y2, y3}), [&](uint8_t* p, float x, float y) {
        float e1 = ((x2 - x1) * (y - y1) - (y2 - y1) * (x - x1)) * s;
        float e2 = ((x3 - x2) * (y - y2) - (y3 - y2) * (x - x2)) * s;
        float e3 = ((x1 - x3) * (y - y3) - (y1 - y3) * (x - x3)) * s;
        if (e1 >= 0 && e2 >= 0 && e3 >= 0) *p = v;
      });
}

void Raster::line(float x1, float y1, float x2, float y2, float width, uint8_t c) {
  float hw = width / 2;
  if (!(hw > 0)) return;
  float dx = x2 - x1, dy = y2 - y1;
  float len2 = dx * dx + dy * dy;
  float hw2 = hw * hw;
  uint8_t v = flat(c);
  box(std::min(x1, x2) - hw, std::min(y1, y2) - hw, std::max(x1, x2) + hw, std::max(y1, y2) + hw,
      [&](uint8_t* p, float x, float y) {
        float t = len2 > 0 ? ((x - x1) * dx + (y - y1) * dy) / len2 : 0;
        t = std::max(0.f, std::min(1.f, t));
        float ex = x1 + t * dx - x, ey = y1 + t * dy - y;
        if (ex * ex + ey * ey <= hw2) *p = v;
      });
}

void Raster::arc(float cx, float cy, float r, float a0, float a1, float width, uint8_t c) {
  float hw = width / 2;
  if (!(hw > 0) || !(r > 0)) return;
  float sweep = std::max(0.f, std::min(TAU, a1 - a0));
  float ex0 = cx + r * cosf(a0), ey0 = cy + r * sinf(a0);
  float ex1 = cx + r * cosf(a0 + sweep), ey1 = cy + r * sinf(a0 + sweep);
  float hw2 = hw * hw, R = r + hw;
  float inner = std::max(0.f, r - hw), inner2 = inner * inner, outer2 = R * R;
  uint8_t v = flat(c);
  box(cx - R, cy - R, cx + R, cy + R, [&](uint8_t* p, float x, float y) {
    float dx = x - cx, dy = y - cy;
    float d2 = dx * dx + dy * dy;
    if (d2 >= inner2 && d2 <= outer2) {
      float a = atan2f(dy, dx) - a0;
      a = fmodf(fmodf(a, TAU) + TAU, TAU);
      if (a <= sweep) {
        *p = v;
        return;
      }
    }
    // Round caps.
    float c0 = (x - ex0) * (x - ex0) + (y - ey0) * (y - ey0);
    float c1 = (x - ex1) * (x - ex1) + (y - ey1) * (y - ey1);
    if (c0 <= hw2 || c1 <= hw2) *p = v;
  });
}

static inline float rd(const uint8_t* p) { return (int16_t)(p[0] | p[1] << 8) / 16.f; }
static inline float ra(const uint8_t* p) { return (int16_t)(p[0] | p[1] << 8) / 1000.f; }

bool Raster::frame(const uint8_t* d, int len) {
  static const uint8_t PARAMS[6] = {0, 4, 5, 6, 5, 6};
  if (len < 8 || d[0] != 0x46 || d[1] != 1) return false;
  int count = d[2] | d[3] << 8;
  int o = 8;
  for (int i = 0; i < count; i++) {
    if (o >= len) return false;
    uint8_t op = d[o] & 0x0F, c = (d[o] >> 4) & 0x07;
    o++;
    if (op > 5 || o + PARAMS[op] * 2 > len) return false;
    const uint8_t* p = d + o;
    switch (op) {
      case 0: clear(c); break;
      case 1: ellipse(rd(p), rd(p + 2), rd(p + 4), rd(p + 6), c); break;
      case 2: roundRect(rd(p), rd(p + 2), rd(p + 4), rd(p + 6), rd(p + 8), c); break;
      case 3: tri(rd(p), rd(p + 2), rd(p + 4), rd(p + 6), rd(p + 8), rd(p + 10), c); break;
      case 4: line(rd(p), rd(p + 2), rd(p + 4), rd(p + 6), rd(p + 8), c); break;
      case 5: arc(rd(p), rd(p + 2), rd(p + 4), ra(p + 6), ra(p + 8), rd(p + 10), c); break;
    }
    o += PARAMS[op] * 2;
  }
  return true;
}

/** The pal's backdrop hue at low lightness, for the dark backdrop. */
static void darken_backdrop(const uint8_t in[3], uint8_t out[3]) {
  float r = in[0] / 255.f, g = in[1] / 255.f, b = in[2] / 255.f;
  float mx = std::max({r, g, b}), mn = std::min({r, g, b});
  float l = (mx + mn) / 2, d = mx - mn;
  float s = d == 0 ? 0 : d / (1 - fabsf(2 * l - 1));
  // Same hue, a muted saturation, about 10 % lightness.
  s = std::min(s, 0.55f);
  float L = 0.1f, C = (1 - fabsf(2 * L - 1)) * s;
  float hue = 0;
  if (d > 0) {
    if (mx == r) hue = fmodf((g - b) / d + 6, 6);
    else if (mx == g) hue = (b - r) / d + 2;
    else hue = (r - g) / d + 4;
  }
  float X = C * (1 - fabsf(fmodf(hue, 2) - 1)), m = L - C / 2;
  float rgb[3] = {0, 0, 0};
  int sector = (int)hue % 6;
  // Which channel gets C and which gets X in each 60° sector.
  const int idx[6][2] = {{0, 1}, {1, 0}, {1, 2}, {2, 1}, {2, 0}, {0, 2}};
  rgb[idx[sector][0]] = C;
  rgb[idx[sector][1]] = X;
  for (int i = 0; i < 3; i++) out[i] = (uint8_t)std::min(255.f, (rgb[i] + m) * 255 + 0.5f);
}

static void shade_f(const uint8_t base[3], float hi, float sh, float level, float out[3]) {
  for (int ch = 0; ch < 3; ch++) {
    float v = base[ch];
    if (level >= FLAT) v += (255 - v) * hi * (level - FLAT) / (LEVELS - 1 - FLAT);
    else v *= 1 - sh * (FLAT - level) / FLAT;
    out[ch] = v;
  }
}

// [highlight, shadow] for the backdrop; the dark one glows brighter and falls to black.
static void shade(const uint8_t base[3], float hi, float sh, int level, float out[3]) {
  shade_f(base, hi, sh, (float)level, out);
}

static const float BG_LIGHT[2] = {0.14f, 0.3f};
static const float BG_DARK[2] = {0.22f, 1.0f};

void backdrop_rgb(const uint8_t palette[8][3], int level, bool dark, uint8_t out[3]) {
  uint8_t base[3];
  if (dark) darken_backdrop(palette[BG], base);
  else for (int i = 0; i < 3; i++) base[i] = palette[BG][i];
  const float* k = dark ? BG_DARK : BG_LIGHT;
  float v[3];
  shade(base, k[0], k[1], level, v);
  for (int i = 0; i < 3; i++) out[i] = (uint8_t)v[i];
}

/** Interleaved gradient noise in 0…1: a fine, patternless dither threshold. */
static inline float ign(int x, int y) {
  float v = 0.06711056f * x + 0.00583715f * y;
  v = 52.9829189f * (v - floorf(v));
  return v - floorf(v);
}

void Raster::paint_backdrop565(const uint8_t palette[8][3], uint16_t* out) const {
  // The indexed backdrop has 32 levels, and RGB565 rounds those further, so a slow glow
  // bands into rings. Here the colour is worked out per pixel and dithered once, to the
  // panel's own steps.
  uint8_t base[3];
  if (dark) darken_backdrop(palette[BG], base);
  else for (int i = 0; i < 3; i++) base[i] = palette[BG][i];
  float glow[3];
  // Dark: black scaled up to the brightest level, so the falloff has no kink at FLAT.
  shade(base, BG_DARK[0], BG_DARK[1], 22, glow);
  for (int y = 0; y < h; y++)
    for (int x = 0; x < w; x++) {
      float l = backdrop_level(x, y), v[3];
      if (dark) for (int i = 0; i < 3; i++) v[i] = glow[i] * l / 22;
      else shade_f(base, BG_LIGHT[0], BG_LIGHT[1], l, v);
      float d = ign(x, y);
      int r = (int)(v[0] * 31 / 255 + d), g = (int)(v[1] * 63 / 255 + d), b = (int)(v[2] * 31 / 255 + d);
      uint16_t c = (uint16_t)(std::min(r, 31) << 11 | std::min(g, 63) << 5 | std::min(b, 31));
      out[y * w + x] = (uint16_t)(c >> 8 | c << 8);
    }
}

void build_lut(const uint8_t palette[8][3], uint16_t lut[256], bool dark) {
  // [highlight, shadow] per slot, after the browser's PetTarget shading.
  static const float SHADING[8][2] = {
      {0.14f, 0.3f},  // BG: the backdrop gradient
      {0, 0},         {0.36f, 0.3f}, {0.14f, 0.22f}, {0.32f, 0.28f},
      {0.1f, 0.16f},  {0, 0},        {0.28f, 0.18f},
  };
  for (int i = 0; i < 256; i++) {
    int slot = i & 7, level = i >> 3;
    if (slot == BG) {
      uint8_t c[3];
      backdrop_rgb(palette, level, dark, c);
      lut[i] = rgb565(c[0], c[1], c[2]);
      continue;
    }
    float rgb[3];
    shade(palette[slot], SHADING[slot][0], SHADING[slot][1], level, rgb);
    lut[i] = rgb565((uint8_t)rgb[0], (uint8_t)rgb[1], (uint8_t)rgb[2]);
  }
}
