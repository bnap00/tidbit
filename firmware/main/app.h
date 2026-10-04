// State shared between the network tasks and the screen.
#pragma once
#include <stdint.h>
#include <string>

#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#include <freertos/task.h>

enum class Mode {
  Boot,        // splash
  Setup,       // our own Wi-Fi network is up for configuration
  Joining,     // connecting to the owner's Wi-Fi
  Pairing,     // showing a code to enter in the browser
  Linking,     // opening the stream
  Pet,         // drawing frames
  Updating,    // receiving a new build over Wi-Fi
};

struct Shared {
  SemaphoreHandle_t lock;
  Mode mode = Mode::Boot;
  std::string status;       // one line under the screen's title, or over the pal
  std::string setupSsid;    // the setup network's name
  std::string pairCode;
  // Stream state.
  bool online = false;      // the stream is open
  bool thinking = false;
  /** Nobody around: the screen dozes off and goes dark (input task decides). */
  bool asleep = false;
  /** The settings panel is over the pal (input task opens and closes it). */
  bool settingsOpen = false;
  uint8_t brightness = 220;  // panel level, BRIGHTNESS_MIN…255
  uint8_t volume = 75;       // speaker, 0–100
  uint8_t palette[8][3] = {};
  uint32_t paletteVersion = 0;
  std::string caption;
  int captionCharMs = 0;
  int64_t captionStartUs = 0;
  /** Latest whole frame from the brain; frameVersion bumps on each. */
  uint8_t* frame = nullptr;
  int frameLen = 0;
  uint32_t frameVersion = 0;
  /** Frames the screen task has pushed, for GET /info. */
  uint32_t framesDrawn = 0;
};

extern Shared shared;

/** Where the screen task is (GET /info), to find a stall without a serial port. */
extern volatile int screen_stage;
extern volatile uint32_t screen_loops;
extern TaskHandle_t screen_task_handle;

struct Lock {
  Lock() { xSemaphoreTake(shared.lock, portMAX_DELAY); }
  ~Lock() { xSemaphoreGive(shared.lock); }
};

void set_mode(Mode m, const std::string& status = "");
