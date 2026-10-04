// The ES8311 codec: the onboard microphone and speaker, mono 16-bit at 24 kHz (Kokoro's
// own rate, so the pal's voice plays without resampling).
#pragma once
#include <stddef.h>
#include <stdint.h>

constexpr int AUDIO_RATE = 24000;

/** False if the codec did not answer; then there is no voice. */
bool audio_init();
bool audio_ok();
/** Fill `pcm` with `samples` from the microphone (blocks for their duration). */
bool audio_read(int16_t* pcm, int samples);

/** Speaker volume, 0–100. */
void audio_set_volume(int volume);
/** A short beep at the current volume (blocks for its length). */
void audio_tone(int hz, int ms);

/** Play a WAV fed in pieces as it downloads: the header first, then PCM. */
void audio_play_begin();
void audio_play_feed(const uint8_t* data, size_t len);
void audio_play_end();
