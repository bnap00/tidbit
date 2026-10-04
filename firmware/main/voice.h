// Talking to the pal: hold BOOT and speak, let go, and it answers out loud.
#pragma once

/** Bring up the codec and the voice task. */
void voice_start();
/** True when the codec answered, so holding BOOT can talk. */
bool voice_ready();
/** BOOT went down (start listening) or up (send what was heard). */
void voice_listen(bool on);
/** Throw away what is being heard (Wi-Fi setup took over the button). */
void voice_cancel();
/** Listening, waiting for the answer, or speaking it. */
bool voice_busy();
/** Something louder than the room was heard since listening started. */
bool voice_heard();
