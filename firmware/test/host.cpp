// Host build of the firmware's rasteriser and text, for checks without the device:
//   host <ws|ref>[-dark] <frame.bin> <palette: 24 numbers> <caption> <out.ppm> [out.idx]
// Writes the whole screen as PPM and the palette slot of every
// pixel (one byte each).
#include <math.h>
#include <stdio.h>
#include <string.h>
#include <algorithm>
#include <vector>

#include "../main/display.h"
#include "../main/raster.h"
#include "../main/text.h"

int main(int argc, char** argv) {
  if (argc < 6) return 2;
  bool dark = strstr(argv[1], "dark") != nullptr;
  // ws follows board_waveshare.cpp; ref is the rig's own 240-unit canvas at 368 px, for
  // comparison with IndexedBufferTarget.
  Layout L = !strncmp(argv[1], "ref", 3) ? Layout{368, 368, 368 / 240.f, 0, 0, 368}
                                         : Layout{368, 448, 1.65f, 184 - 120 * 1.65f, 175 - 125 * 1.65f, 372};
  FILE* f = fopen(argv[2], "rb");
  std::vector<uint8_t> frame(65536);
  int len = fread(frame.data(), 1, frame.size(), f);
  fclose(f);
  uint8_t pal[8][3];
  FILE* p = fopen(argv[3], "r");
  for (int i = 0; i < 24; i++) {
    int v;
    if (fscanf(p, "%d", &v) != 1) return 3;
    pal[i / 3][i % 3] = (uint8_t)v;
  }
  fclose(p);
  std::vector<uint8_t> idx(L.w * L.h);
  Raster r(idx.data(), L.w, L.h, L.k, L.ox, L.oy);
  r.dark = dark;
  if (!r.frame(frame.data(), len)) return 4;
  uint16_t lut[256];
  build_lut(pal, lut, dark);
  std::vector<uint16_t> screen(L.w * L.h), bg(L.w * L.h);
  r.paint_backdrop565(pal, bg.data());
  for (size_t i = 0; i < idx.size(); i++) screen[i] = idx[i] & 7 ? lut[idx[i]] : bg[i];
  // The words, over the backdrop, as the screen task composes them.
  const int CAP = std::min(L.h - L.captionY, 2 * FONT_TEXT.lineHeight + 8);
  std::vector<uint8_t> mask(L.w * CAP);
  caption_mask(mask.data(), CAP, L, FONT_TEXT, argv[4]);
  uint16_t ink = caption_ink(pal, dark);
  for (int y = 0; y < CAP; y++)
    for (int x = 0; x < L.w; x++) {
      uint16_t& o = screen[(L.captionY + y) * L.w + x];
      if (mask[y * L.w + x]) o = mix565(o, ink, mask[y * L.w + x]);
    }
  FILE* o = fopen(argv[5], "wb");
  fprintf(o, "P6\n%d %d\n255\n", L.w, L.h);
  for (int y = 0; y < L.h; y++)
    for (int x = 0; x < L.w; x++) {
      uint16_t v = screen[y * L.w + x];
      v = (uint16_t)(v >> 8 | v << 8);
      uint8_t rgb[3] = {(uint8_t)((v >> 11) << 3), (uint8_t)(((v >> 5) & 63) << 2), (uint8_t)((v & 31) << 3)};
      fwrite(rgb, 1, 3, o);
    }
  fclose(o);
  if (argc > 6) {
    FILE* io = fopen(argv[6], "wb");
    for (uint8_t v : idx) fputc(v & 7, io);
    fclose(io);
  }
  return 0;
}
