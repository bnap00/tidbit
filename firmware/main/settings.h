// The owner's settings panel: swipe down from the top edge of the pal screen to open it,
// drag a bar to change brightness or volume, swipe up (or press BOOT) to close.
#pragma once
#include <stdint.h>

#include "board.h"

/** Bars on the panel, in screen pixels (the input task and the drawing share them). */
struct SettingsBar {
  int y;  // top of the bar
  static constexpr int X = 34, W = 300, H = 40;
};
constexpr SettingsBar BRIGHTNESS_BAR{150}, VOLUME_BAR{280};
/** A touch this close to a bar (above or below) drags it. */
constexpr int BAR_REACH = 34;

constexpr int BRIGHTNESS_MIN = 15, BRIGHTNESS_MAX = 255;

/** Read the stored values into `shared` (defaults on first boot). */
void settings_load();
/** Store `shared`'s values if they changed. */
void settings_save();
/** 0–100 along a bar for screen column x. */
int settings_bar_value(int x);
