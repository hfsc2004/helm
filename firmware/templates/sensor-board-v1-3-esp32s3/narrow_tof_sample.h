#pragma once

#include <stdint.h>

struct NarrowTofTarget {
  uint16_t distanceMm = 0;
  int16_t rangeStatus = -1;
  uint32_t signalRate = 0;
};

struct NarrowTofZone {
  uint16_t distanceMm = 0;
  int16_t rangeStatus = -1;
  uint32_t signalRate = 0; // 16.16 MCPS from the ST driver
  uint8_t targetCount = 0;
  NarrowTofTarget targets[4];
  uint32_t sampledAt = 0;
  uint16_t stableDistanceMm = 0;
  uint32_t stableAt = 0;
  uint16_t pendingDistanceMm = 0;
  uint8_t pendingCount = 0;
  bool hasFrame = false;
  bool hasStable = false;
};

struct NarrowTofSample {
  NarrowTofZone zones[5]; // full field, then four programmable quadrants
  int16_t driverError = 0;
  uint32_t lastPollAt = 0;
  uint32_t phaseStartedAt = 0;
  uint32_t lastDataAt = 0;
  uint16_t recoveryCount = 0;
  uint8_t phaseFrames = 0;
  bool scanningQuadrants = false;
  bool modeChanged = false;
};
