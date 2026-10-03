#pragma once
#include <driver/pulse_cnt.h>

struct MicActivityCounter {
  pcnt_unit_handle_t unit = nullptr;
  pcnt_channel_handle_t channel = nullptr;
  bool enabled = false, started = false;
  int signalIndex = -1;
  uint32_t originalRouting = 0, previousRaw = 0;
  uint64_t total = 0;
};

struct MicActivityBin {
  int64_t endUs = 0;
  uint32_t durationUs = 0, dataEdges = 0, clockEdges = 0;
  bool rxEnabled = false, counterCleared = false;
  uint8_t dataLevel = 0;
};
