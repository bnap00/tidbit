// Wi-Fi, pairing with the brain over HTTP, and the rig stream over a WebSocket.
#pragma once
#include <stddef.h>
#include <stdint.h>
#include <string>

struct Config {
  std::string ssid, password, server, token;
};

Config config_load();
void config_save(const Config& c);

/** Runs forever: join Wi-Fi, pair if needed, then keep the stream open. */
void net_run(Config cfg);

/** Send a touch ("poke", "pet", "feed", "shake") if the stream is open. */
void net_touch(const char* kind);
/**
 * A spoken question (WAV) to /api/device/ask. Returns the HTTP status (or -1), the reply's
 * words in `text`, or the brain's reason in `error`. The reply's turn reaches the screen
 * through the stream.
 */
int net_ask(const uint8_t* wav, size_t len, std::string& text, std::string& error);
/** The pal's words as speech (/api/device/speak), passed to `sink` as the WAV downloads. */
bool net_speak(const std::string& text, void (*sink)(const uint8_t*, size_t));
/** The screen is off for lack of company (the pal dozes), or back on. Sent on change. */
void net_rest(bool on);
/** Finger position over the pal, -1…1 from its centre; lifted = false. */
void net_attend(bool down, float x, float y);
