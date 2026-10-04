// First-time setup: the pal opens its own Wi-Fi network with a page for the owner's
// Wi-Fi and the Tidbit server address, then restarts with them.
#pragma once
#include "net.h"

[[noreturn]] void portal_run(const Config& current);
