#include "text.h"

#include <algorithm>
#include <cmath>
#include <cstring>

#include "display.h"
#include "raster.h"
#include "font_big.h"
#include "font_caption.h"
#include "font_small.h"

const Font& FONT_TEXT = FONT_CAPTION;
const Font& FONT_NOTE = FONT_SMALL;
const Font& FONT_DIGITS = FONT_BIG;

void Canvas::fill(uint16_t c) {
  for (int i = 0; i < w * h; i++) px[i] = c;
}

void Canvas::fill_rect(int x, int y, int rw, int rh, uint16_t c) {
  for (int j = y < 0 ? 0 : y; j < y + rh && j < h; j++)
    for (int i = x < 0 ? 0 : x; i < x + rw && i < w; i++) px[j * w + i] = c;
}

/** Next code point; advances i. Invalid bytes become U+FFFD. */
static uint32_t next_cp(const std::string& s, size_t& i) {
  uint8_t c = s[i++];
  if (c < 0x80) return c;
  int extra = (c & 0xE0) == 0xC0 ? 1 : (c & 0xF0) == 0xE0 ? 2 : (c & 0xF8) == 0xF0 ? 3 : -1;
  if (extra < 0) return 0xFFFD;
  uint32_t cp = c & (0x3F >> extra);
  while (extra-- > 0) {
    if (i >= s.size() || (s[i] & 0xC0) != 0x80) return 0xFFFD;
    cp = cp << 6 | (s[i++] & 0x3F);
  }
  return cp;
}

static const Glyph* glyph(const Font& f, uint32_t cp) {
  if (cp == '\n' || cp == '\t') cp = ' ';
  int lo = 0, hi = f.count - 1;
  while (lo <= hi) {
    int mid = (lo + hi) / 2;
    if (f.glyphs[mid].cp == cp) return &f.glyphs[mid];
    if (f.glyphs[mid].cp < cp) lo = mid + 1;
    else hi = mid - 1;
  }
  return cp == '?' ? nullptr : glyph(f, '?');
}

int text_width(const Font& f, const std::string& s, size_t bytes) {
  int w = 0;
  size_t end = bytes < s.size() ? bytes : s.size();
  for (size_t i = 0; i < end;)
    if (const Glyph* g = glyph(f, next_cp(s, i))) w += g->adv;
  return w;
}

static inline uint16_t blend(Rgb fg, Rgb bg, int a) {
  return rgb565((uint8_t)(bg.r + (fg.r - bg.r) * a / 15), (uint8_t)(bg.g + (fg.g - bg.g) * a / 15),
                (uint8_t)(bg.b + (fg.b - bg.b) * a / 15));
}

void text_draw(Canvas& c, const Font& f, int x, int y, const std::string& s, Rgb fg, Rgb bg) {
  uint16_t shades[16];
  for (int a = 0; a < 16; a++) shades[a] = blend(fg, bg, a);
  for (size_t i = 0; i < s.size();) {
    const Glyph* g = glyph(f, next_cp(s, i));
    if (!g) continue;
    int stride = (g->w + 1) / 2;
    for (int gy = 0; gy < g->h; gy++) {
      int py = y + g->y + gy;
      if (py < 0 || py >= c.h) continue;
      const uint8_t* row = f.bitmap + g->offset + gy * stride;
      for (int gx = 0; gx < g->w; gx++) {
        int a = gx & 1 ? row[gx / 2] & 0x0F : row[gx / 2] >> 4;
        int pxx = x + g->x + gx;
        if (a && pxx >= 0 && pxx < c.w) c.px[py * c.w + pxx] = shades[a];
      }
    }
    x += g->adv;
  }
}

std::vector<std::string> text_wrap(const Font& f, const std::string& s, int width) {
  std::vector<std::string> lines;
  size_t start = 0;
  while (start < s.size()) {
    while (start < s.size() && s[start] == ' ') start++;
    if (start >= s.size()) break;
    size_t i = start, lastSpace = std::string::npos, nl = s.find('\n', start);
    int w = 0;
    size_t end = s.size();
    while (i < s.size()) {
      if (i == nl) {
        end = i;
        break;
      }
      size_t before = i;
      const Glyph* g = glyph(f, next_cp(s, i));
      int adv = g ? g->adv : 0;
      if (w + adv > width && before > start) {
        end = lastSpace != std::string::npos ? lastSpace : before;
        break;
      }
      if (s[before] == ' ') lastSpace = before;
      w += adv;
    }
    lines.push_back(s.substr(start, end - start));
    start = end < s.size() && s[end] == '\n' ? end + 1 : end;
  }
  return lines;
}

void text_block(Canvas& c, const Font& f, int cy, const std::string& s, Rgb fg, Rgb bg,
                int width) {
  auto lines = text_wrap(f, s, width);
  int y = cy - (int)lines.size() * f.lineHeight / 2;
  for (auto& line : lines) {
    text_draw(c, f, (c.w - text_width(f, line)) / 2, y, line, fg, bg);
    y += f.lineHeight;
  }
}

std::string utf8_prefix(const std::string& s, int n) {
  size_t i = 0;
  while (n-- > 0 && i < s.size()) next_cp(s, i);
  return s.substr(0, i);
}

int utf8_length(const std::string& s) {
  int n = 0;
  for (size_t i = 0; i < s.size(); n++) next_cp(s, i);
  return n;
}

int text_room(const Layout& screen, int margin) { return screen.w - 2 * margin; }

static void mask_draw(uint8_t* mask, int w, int h, const Font& f, int x, int y,
                      const std::string& s) {
  for (size_t i = 0; i < s.size();) {
    const Glyph* g = glyph(f, next_cp(s, i));
    if (!g) continue;
    int stride = (g->w + 1) / 2;
    for (int gy = 0; gy < g->h; gy++) {
      int py = y + g->y + gy;
      if (py < 0 || py >= h) continue;
      const uint8_t* row = f.bitmap + g->offset + gy * stride;
      for (int gx = 0; gx < g->w; gx++) {
        int a = gx & 1 ? row[gx / 2] & 0x0F : row[gx / 2] >> 4;
        int px = x + g->x + gx;
        if (a && px >= 0 && px < w && a > mask[py * w + px]) mask[py * w + px] = (uint8_t)a;
      }
    }
    x += g->adv;
  }
}

int caption_mask(uint8_t* mask, int rows, const Layout& screen, const Font& f,
                 const std::string& words) {
  memset(mask, 0, screen.w * rows);
  int room = text_room(screen, 20);
  auto lines = text_wrap(f, words, room);
  size_t first = lines.size() > 2 ? lines.size() - 2 : 0;
  int y = 0;
  for (size_t i = first; i < lines.size(); i++, y += f.lineHeight)
    mask_draw(mask, screen.w, rows, f, (screen.w - text_width(f, lines[i])) / 2, y, lines[i]);
  return y;
}

uint16_t caption_ink(const uint8_t palette[8][3], bool dark) {
  uint8_t bg[3];
  backdrop_rgb(palette, 12, dark, bg);
  bool pale = !dark && 0.2126f * bg[0] + 0.7152f * bg[1] + 0.0722f * bg[2] > 140;
  return pale ? (uint16_t)((24 >> 3) << 11 | (24 >> 2) << 5 | (32 >> 3))
              : (uint16_t)((236 >> 3) << 11 | (236 >> 2) << 5 | (240 >> 3));
}
