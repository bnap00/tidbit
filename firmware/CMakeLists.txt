# Tidbit firmware (docs/DEVICE.md). Build through ./idf.sh, which picks the board.
cmake_minimum_required(VERSION 3.16)
# The build time is the version, so /info shows which build a pal is running.
string(TIMESTAMP PROJECT_VER "%Y%m%d-%H%M%S" UTC)
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(tidbit)
