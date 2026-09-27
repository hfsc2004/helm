// PSF Sensor Board v1.3 bench bring-up firmware.
// Camera endpoints are on port 81; sensors and LED diagnostics are on port 82.
// No motor endpoint is provided. IR emitters and UART telemetry are not
// reported until their drivers are tested.

#include <WiFi.h>
#include <WebServer.h>
#include <Wire.h>
#include <ESPmDNS.h>
#include <esp_camera.h>
#include <esp32-hal-rmt.h>
#include <esp32-hal-ledc.h>
#include <ESP_I2S.h>
#include <driver/gpio.h>
#include <driver/i2s_pdm.h>
#include <driver/pulse_cnt.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <freertos/task.h>
#include <VL53L1X.h>
#include <Adafruit_VL53L5CX.h>
#include "startup_chime.h"

static const char *WIFI_SSID = "{{wifi.ssid}}";
static const char *WIFI_PASSWORD = "{{wifi.password}}";
static const char *MDNS_NAME = "{{mdns.name}}";
static const bool USE_STATIC_IP = {{wifi.useStatic}};
static const IPAddress STATIC_IP({{wifi.staticIp.octets}});
static const int STATIC_CIDR = {{wifi.staticCidr}};
static const char *FRAME_SIZE = "{{camera.frameSize}}";
static const int JPEG_QUALITY = {{camera.jpegQuality}};

static constexpr uint8_t I2C_SDA = 2;
static constexpr uint8_t I2C_SCL = 1;
static constexpr uint8_t TCA9534_ADDRESS = 0x20;
static constexpr uint8_t SPEAKER_ENABLE_MASK = 0x10; // TCA9534 P4 -> MAX98357A SD_MODE#
static constexpr uint8_t FRONT_TOF_ADDRESS = 0x30;
static constexpr uint8_t REAR_TOF_ADDRESS = 0x31;
static constexpr uint32_t TOF_AUTO_RETRY_MS = 2000;
static constexpr uint8_t IMU_ADDRESS = 0x68;
static constexpr uint8_t IMU_WHO_AM_I = 0x61;
static constexpr uint8_t MIC_PDM_CLK = 21;
static constexpr uint8_t MIC_PDM_DATA = 14;
static constexpr uint32_t MIC_SAMPLE_RATE = 16000;
static constexpr uint32_t MIC_PDM_CLOCK_HZ = MIC_SAMPLE_RATE * 128;
static constexpr uint8_t SPEAKER_DIN = 47;
static constexpr uint8_t SPEAKER_BCLK = 41;
static constexpr uint8_t SPEAKER_LRCLK = 42;
static constexpr uint32_t SPEAKER_SAMPLE_RATE = 16000;
static constexpr uint16_t SPEAKER_TONE_HZ = 660;
static constexpr uint16_t SPEAKER_TONE_MS = 350;
static constexpr int16_t SPEAKER_TONE_AMPLITUDE = 6000;
static constexpr size_t SPEAKER_CHUNK_BYTES = 1024;
static constexpr uint8_t SPEAKER_BUFFER_CHUNKS = 32;
static constexpr uint8_t STARTUP_CHIME_GAIN_PERCENT = 30;
static constexpr uint16_t STARTUP_CHIME_FADE_FRAMES = SPEAKER_SAMPLE_RATE / 50;

constexpr int16_t scaleStartupChimeSample(int16_t sample, int32_t fade) {
  return static_cast<int16_t>(static_cast<int64_t>(sample) *
    STARTUP_CHIME_GAIN_PERCENT * fade / (100 * STARTUP_CHIME_FADE_FRAMES));
}
static_assert(scaleStartupChimeSample(-10000, STARTUP_CHIME_FADE_FRAMES) == -3000,
  "startup chime gain must preserve negative samples");
static constexpr uint8_t LED_PIN = 48;
static constexpr uint8_t LED_COUNT = 3;
static constexpr uint8_t CAMERA_PORT = 81;
static constexpr uint8_t DIAGNOSTIC_PORT = 82;

// GOOUUU ESP32-S3-CAM pin map; matches Espressif's BOARD_ESP32S3_GOOUUU.
// GPIO4 is camera SCCB data. The board's IR strobe switch must stay in its
// expander-controlled position while the camera is in use.
static constexpr int CAM_XCLK = 15, CAM_SDA = 4, CAM_SCL = 5;
static constexpr int CAM_D0 = 11, CAM_D1 = 9, CAM_D2 = 8, CAM_D3 = 10;
static constexpr int CAM_D4 = 12, CAM_D5 = 18, CAM_D6 = 17, CAM_D7 = 16;
static constexpr int CAM_VSYNC = 6, CAM_HREF = 7, CAM_PCLK = 13;

WebServer cameraServer(CAMERA_PORT);
WebServer diagnosticServer(DIAGNOSTIC_PORT);
bool cameraReady = false;
bool expanderReady = false;
bool ledsReady = false;
bool frontTofReady = false;
bool rearTofReady = false;
bool wideTofReady = false;
bool imuReady = false;
bool microphonesReady = false;
bool micClockHeld = false;
int micClockHeldLevel = -1;
bool speakerReady = false;
bool speakerAmpEnabled = false;
bool startupChimePlayed = false;
const char *startupChimeStage = "not-started";
size_t startupChimeBytesWritten = 0;
int startupChimeI2sError = 0;
int imuWhoAmI = -1;
uint32_t bootMs = 0;
uint8_t ledValues[LED_COUNT][4] = {};
VL53L1X frontTof;
VL53L1X rearTof;
VL53L1X::DistanceMode frontTofMode = VL53L1X::Short;
VL53L1X::DistanceMode rearTofMode = VL53L1X::Short;
bool frontTofAuto = true;
bool rearTofAuto = true;
uint32_t frontTofInvalidSince = 0;
uint32_t rearTofInvalidSince = 0;
Adafruit_VL53L5CX wideTof;
I2SClass microphoneI2s;
I2SClass speakerI2s;
struct SpeakerPcmChunk {
  uint16_t size;
  uint8_t data[SPEAKER_CHUNK_BYTES];
};
QueueHandle_t speakerQueue = nullptr;
volatile uint32_t speakerPcmQueuedBytes = 0;
volatile uint32_t speakerPcmPlayedBytes = 0;
volatile bool speakerPcmStreaming = false;
volatile bool speakerPcmUploadComplete = false;
volatile bool speakerPcmUploadFailed = false;
uint8_t speakerPcmPending[4] = {};
bool playStartupChime();
bool showLeds();
uint8_t speakerPcmPendingSize = 0;
VL53L5CX_ResultsData wideResults = {};
bool wideHasFrame = false;
uint32_t wideCapturedAt = 0;
uint32_t wideLastPollAt = 0;

bool i2cPresent(uint8_t address) {
  Wire.beginTransmission(address);
  return Wire.endTransmission() == 0;
}

bool writeExpander(uint8_t reg, uint8_t value) {
  Wire.beginTransmission(TCA9534_ADDRESS);
  Wire.write(reg);
  Wire.write(value);
  return Wire.endTransmission() == 0;
}

bool readRegister8(uint8_t address, uint8_t reg, uint8_t *value) {
  Wire.beginTransmission(address);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom(address, static_cast<uint8_t>(1)) != 1) return false;
  *value = Wire.read();
  return true;
}

void muteSpeakerAmpEarly() {
  // Best effort immediately after I2C starts; initExpander retries later if
  // the sensor-board rail has not risen yet. Preserve the other P0-P7 states.
  uint8_t output = 0, direction = 0;
  if (!readRegister8(TCA9534_ADDRESS, 0x01, &output) ||
      !readRegister8(TCA9534_ADDRESS, 0x03, &direction)) return;
  writeExpander(0x01, output & ~SPEAKER_ENABLE_MASK);
  writeExpander(0x03, direction & ~SPEAKER_ENABLE_MASK);
}

bool writeRegister8(uint8_t address, uint8_t reg, uint8_t value) {
  Wire.beginTransmission(address);
  Wire.write(reg);
  Wire.write(value);
  return Wire.endTransmission() == 0;
}

bool readRegisters(uint8_t address, uint8_t reg, uint8_t *values, size_t count) {
  Wire.beginTransmission(address);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom(address, count) != count) return false;
  for (size_t i = 0; i < count; ++i) values[i] = Wire.read();
  return true;
}

void initImu() {
  uint8_t identity = 0;
  if (!readRegister8(IMU_ADDRESS, 0x75, &identity)) return;
  imuWhoAmI = identity;
  if (identity != IMU_WHO_AM_I) return;
  // ICM-42607-C: 100 Hz, +/-250 dps and +/-2 g, then enable both in LN mode.
  // Configure scale/ODR before waking the sensors (PWR_MGMT0 = 0x0F).
  if (!writeRegister8(IMU_ADDRESS, 0x20, 0x69) ||
      !writeRegister8(IMU_ADDRESS, 0x21, 0x69) ||
      !writeRegister8(IMU_ADDRESS, 0x1F, 0x0F)) return;
  delay(50); // exceeds gyro startup time; do not write immediately after wake
  uint8_t gyroConfig = 0, accelConfig = 0, power = 0;
  imuReady = readRegister8(IMU_ADDRESS, 0x20, &gyroConfig) && gyroConfig == 0x69 &&
    readRegister8(IMU_ADDRESS, 0x21, &accelConfig) && accelConfig == 0x69 &&
    readRegister8(IMU_ADDRESS, 0x1F, &power) && power == 0x0F;
  Serial.printf("IMU WHO_AM_I=0x%02X ready=%d\n", identity, imuReady);
}

void initMicrophones() {
  // The two MSM261DHP006 parts share clock/data and have opposite L/R straps.
  // GPIO21/GPIO14 follow the v1.3 schematic, not the older Rev A notes.
  microphoneI2s.setPinsPdmRx(MIC_PDM_CLK, MIC_PDM_DATA);
  microphoneI2s.setTimeout(1000);
  microphonesReady = microphoneI2s.begin(I2S_MODE_PDM_RX, MIC_SAMPLE_RATE,
    I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_STEREO);
  if (!microphonesReady) {
    Serial.println("PDM microphone I2S initialization failed");
    return;
  }
  i2s_chan_info_t info = {};
  const esp_err_t infoError = i2s_channel_get_info(microphoneI2s.rxChan(), &info);
  if (infoError == ESP_OK) {
    Serial.printf("PDM RX allocated I2S port: %d\n", static_cast<int>(info.id));
  } else {
    Serial.printf("Failed to query PDM RX I2S port: %s\n", esp_err_to_name(infoError));
  }
  // Arduino's default 8S decimation drives 16 kHz * 64 = 1.024 MHz,
  // between this microphone's specified low-power and normal clock ranges.
  // 16S makes the clock 2.048 MHz while preserving 16 kHz PCM output.
  i2s_chan_handle_t rx = microphoneI2s.rxChan();
  i2s_pdm_rx_clk_config_t clockConfig = I2S_PDM_RX_CLK_DEFAULT_CONFIG(MIC_SAMPLE_RATE);
  clockConfig.dn_sample_mode = I2S_PDM_DSR_16S;
  const esp_err_t stopped = i2s_channel_disable(rx);
  if (stopped != ESP_OK) {
    microphonesReady = false;
    Serial.printf("PDM clock reconfiguration stop failed: %s\n", esp_err_to_name(stopped));
    return;
  }
  const esp_err_t configured = i2s_channel_reconfig_pdm_rx_clock(rx, &clockConfig);
  const esp_err_t started = i2s_channel_enable(rx);
  microphonesReady = configured == ESP_OK && started == ESP_OK;
  Serial.printf("PDM microphones ready=%d clock=%lu Hz config=%s start=%s\n",
    microphonesReady, static_cast<unsigned long>(MIC_PDM_CLOCK_HZ),
    esp_err_to_name(configured), esp_err_to_name(started));
}

void speakerPlaybackTask(void *) {
  SpeakerPcmChunk chunk;
  bool started = false;
  for (;;) {
    if (!speakerPcmStreaming) {
      started = false;
      vTaskDelay(pdMS_TO_TICKS(1));
      continue;
    }
    // Prime half the 32 KiB queue before starting. This gives short Wi-Fi
    // pauses room to recover; a shorter file starts once its upload ends.
    if (!started) {
      if (uxQueueMessagesWaiting(speakerQueue) < SPEAKER_BUFFER_CHUNKS / 2 &&
          !speakerPcmUploadComplete) {
        vTaskDelay(pdMS_TO_TICKS(1));
        continue;
      }
      started = true;
    }
    if (xQueueReceive(speakerQueue, &chunk, pdMS_TO_TICKS(20)) == pdTRUE) {
      if (speakerI2s.write(chunk.data, chunk.size) != chunk.size) {
        speakerPcmUploadFailed = true;
      }
      speakerPcmPlayedBytes += chunk.size;
    }
    if (speakerPcmUploadComplete && speakerPcmPlayedBytes == speakerPcmQueuedBytes) {
      speakerPcmStreaming = false;
    }
  }
}

void setStartupLeds(uint8_t blue, uint8_t white, int8_t activeIndex = -1) {
  for (uint8_t i = 0; i < LED_COUNT; ++i) {
    const bool active = activeIndex < 0 || activeIndex == i;
    ledValues[i][0] = 0;
    ledValues[i][1] = 0;
    ledValues[i][2] = active ? blue : 0;
    ledValues[i][3] = active ? white : 0;
  }
  showLeds();
}

void playStartupLedFade() {
  if (!ledsReady) return;
  static constexpr uint8_t FRAMES = 25;
  static constexpr uint32_t DURATION_MS = 1000;
  static constexpr uint8_t ORDER[LED_COUNT] = {2, 1, 0}; // lower right, upper left, upper right
  const uint32_t started = millis();
  for (uint8_t frame = 0; frame <= FRAMES; ++frame) {
    const float t = static_cast<float>(frame) / FRAMES;
    const float eased = t * t * (3.0f - 2.0f * t);
    const float brightness = 6.0f + (13.0f - 6.0f) * eased;
    const uint8_t blue = static_cast<uint8_t>(roundf(brightness * (1.0f - 0.5f * eased)));
    const uint8_t white = static_cast<uint8_t>(roundf(brightness)) - blue;
    const int8_t activeIndex = frame == FRAMES ? -1 :
      ORDER[min(static_cast<uint8_t>(LED_COUNT - 1),
                static_cast<uint8_t>(frame * LED_COUNT / FRAMES))];
    setStartupLeds(blue, white, activeIndex);
    if (frame < FRAMES) {
      const uint32_t due = started + DURATION_MS * (frame + 1) / FRAMES;
      while (millis() < due) delay(1);
    }
  }
}

void updateChimeLeds(size_t frame, size_t totalFrames) {
  if (!ledsReady || !totalFrames) return;
  const float t = static_cast<float>(frame) / totalFrames;
  uint8_t blue = 6, white = 0;
  if (t < 0.23f) {
    // The opening strike moves from the chase's blue-white mix to white.
    const float p = t / 0.23f;
    const float eased = p * p * (3.0f - 2.0f * p);
    blue = static_cast<uint8_t>(roundf(7.0f * (1.0f - eased)));
    white = 13 - blue;
  } else if (t < 0.78f) {
    // Follow the audible decay back to dim blue, then hold through the tail.
    const float p = (t - 0.23f) / (0.78f - 0.23f);
    const float eased = p * p * (3.0f - 2.0f * p);
    const float brightness = 13.0f - 7.0f * eased;
    white = static_cast<uint8_t>(roundf(brightness * (1.0f - eased)));
    blue = static_cast<uint8_t>(roundf(brightness)) - white;
  }
  setStartupLeds(blue, white);
}

bool runStartupSequence() {
  playStartupLedFade();
  const bool played = playStartupChime();
  if (ledsReady) setStartupLeds(0, 0);
  return played;
}

void initSpeaker() {
  // MAX98357A on Rev 1.3: GPIO47 DIN, GPIO41 BCLK, GPIO42 LRCLK.
  // Mono amplifier slot selection is a board strap; send the same PCM to
  // both I2S slots so the test does not depend on that strap.
  speakerI2s.setPins(SPEAKER_BCLK, SPEAKER_LRCLK, SPEAKER_DIN);
  speakerI2s.setTimeout(1000);
  speakerReady = speakerI2s.begin(I2S_MODE_STD, SPEAKER_SAMPLE_RATE,
    I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_STEREO, I2S_STD_SLOT_BOTH);
  // Play the boot chime before reserving the 32 KiB streaming queue. I2S TX
  // needs its largest free heap during initialization and first playback.
  if (speakerReady && expanderReady) {
    startupChimePlayed = runStartupSequence();
    Serial.printf("PSF startup chime played=%d\n", startupChimePlayed);
  }
  if (speakerReady) {
    speakerQueue = xQueueCreate(SPEAKER_BUFFER_CHUNKS, sizeof(SpeakerPcmChunk));
    speakerReady = speakerQueue != nullptr &&
      xTaskCreate(speakerPlaybackTask, "speaker-tx", 4096, nullptr, 2, nullptr) == pdPASS;
    if (!speakerReady && speakerQueue) {
      vQueueDelete(speakerQueue);
      speakerQueue = nullptr;
    }
  }
  Serial.printf("MAX98357A I2S ready=%d\n", speakerReady);
}

void initExpander() {
  expanderReady = false;
  speakerAmpEnabled = false;
  if (!i2cPresent(TCA9534_ADDRESS)) return;
  // Hold all ToFs in reset while assigning distinct addresses to the two
  // VL53L1CB devices. P3 high also held the wide VL53L5CX off on the bench.
  // P4 drives MAX98357A SD_MODE#. Hold it LOW (amp shutdown) until I2S is
  // initialized and primed with silence; enabling it here caused a pop.
  // P5-P7 remain inputs until their board-control nets are verified.
  for (uint8_t attempt = 0; attempt < 5 && !expanderReady; ++attempt) {
    const bool outputSet = writeExpander(0x01, 0x08);
    const bool directionSet = writeExpander(0x03, 0xE0);
    uint8_t output = 0, direction = 0, input = 0;
    const bool outputVerified = readRegister8(TCA9534_ADDRESS, 0x01, &output) &&
      output == 0x08;
    const bool directionVerified = readRegister8(TCA9534_ADDRESS, 0x03, &direction) &&
      direction == 0xE0;
    const bool pinVerified = readRegister8(TCA9534_ADDRESS, 0x00, &input) &&
      (input & SPEAKER_ENABLE_MASK) == 0;
    expanderReady = outputSet && directionSet && outputVerified &&
      directionVerified && pinVerified;
    if (!expanderReady) delay(50);
  }
}

bool ensureSpeakerAmpEnabled() {
  // A late I2C response should not require restarting the ToF sensors.
  // Preserve every other expander bit while driving P4 high.
  speakerAmpEnabled = false;
  uint8_t output = 0, direction = 0, input = 0;
  if (!readRegister8(TCA9534_ADDRESS, 0x01, &output) ||
      !readRegister8(TCA9534_ADDRESS, 0x03, &direction)) return false;
  if (!writeExpander(0x01, output | SPEAKER_ENABLE_MASK) ||
      !writeExpander(0x03, direction & ~SPEAKER_ENABLE_MASK)) return false;
  speakerAmpEnabled = readRegister8(TCA9534_ADDRESS, 0x00, &input) &&
    (input & SPEAKER_ENABLE_MASK) != 0;
  return speakerAmpEnabled;
}

bool muteSpeakerAmp() {
  // Keep P4 low while the I2S TX path is reconfigured between uploads.
  uint8_t output = 0, direction = 0, input = 0;
  if (!readRegister8(TCA9534_ADDRESS, 0x01, &output) ||
      !readRegister8(TCA9534_ADDRESS, 0x03, &direction)) return false;
  if (!writeExpander(0x01, output & ~SPEAKER_ENABLE_MASK) ||
      !writeExpander(0x03, direction & ~SPEAKER_ENABLE_MASK)) return false;
  if (!readRegister8(TCA9534_ADDRESS, 0x00, &input) ||
      (input & SPEAKER_ENABLE_MASK) != 0) return false;
  speakerAmpEnabled = false;
  return true;
}

bool prepareSpeakerPcmStream() {
  if (!speakerReady || !muteSpeakerAmp() || !speakerI2s.configureTX(
      SPEAKER_SAMPLE_RATE, I2S_DATA_BIT_WIDTH_16BIT,
      I2S_SLOT_MODE_STEREO, I2S_STD_SLOT_BOTH)) return false;
  // Match boot playback: establish quiet I2S clocks before unmuting P4.
  static const int16_t silence[256 * 2] = {};
  if (speakerI2s.write(reinterpret_cast<const uint8_t *>(silence), sizeof(silence))
      != sizeof(silence)) return false;
  delay(20);
  if (!ensureSpeakerAmpEnabled()) return false;
  return speakerI2s.write(reinterpret_cast<const uint8_t *>(silence), sizeof(silence))
    == sizeof(silence);
}

bool playStartupChime() {
  startupChimeStage = "precheck";
  startupChimeBytesWritten = 0;
  startupChimeI2sError = 0;
  if (!speakerReady || !expanderReady || kStartupChimeBytes % 2 != 0) return false;
  startupChimeStage = "mute";
  if (!muteSpeakerAmp()) return false;
  startupChimeStage = "configure";
  if (!speakerI2s.configureTX(SPEAKER_SAMPLE_RATE, I2S_DATA_BIT_WIDTH_16BIT,
                              I2S_SLOT_MODE_STEREO, I2S_STD_SLOT_BOTH)) return false;
  // Establish stable BCLK/LRCLK/DIN while the amplifier is still shut down.
  static const int16_t silence[256 * 2] = {};
  startupChimeStage = "prime";
  if (speakerI2s.write(reinterpret_cast<const uint8_t *>(silence), sizeof(silence))
      != sizeof(silence)) {
    startupChimeI2sError = speakerI2s.lastError();
    return false;
  }
  delay(20);
  startupChimeStage = "enable-amp";
  if (!ensureSpeakerAmpEnabled()) return false;
  startupChimeStage = "post-enable-silence";
  if (speakerI2s.write(reinterpret_cast<const uint8_t *>(silence), sizeof(silence))
      != sizeof(silence)) {
    startupChimeI2sError = speakerI2s.lastError();
    return false;
  }

  static constexpr size_t BLOCK_FRAMES = 256;
  const size_t totalFrames = kStartupChimeBytes / sizeof(int16_t);
  int16_t stereo[BLOCK_FRAMES * 2];
  startupChimeStage = "pcm";
  for (size_t start = 0; start < totalFrames; start += BLOCK_FRAMES) {
    if (start % (BLOCK_FRAMES * 3) == 0) updateChimeLeds(start, totalFrames);
    const size_t frames = min(BLOCK_FRAMES, totalFrames - start);
    for (size_t i = 0; i < frames; ++i) {
      const size_t frame = start + i;
      const size_t offset = frame * 2;
      const uint16_t bits = static_cast<uint16_t>(kStartupChimePcm[offset]) |
        (static_cast<uint16_t>(kStartupChimePcm[offset + 1]) << 8);
      const int16_t mono = static_cast<int16_t>(bits);
      uint32_t fade = STARTUP_CHIME_FADE_FRAMES;
      if (frame < fade) fade = frame;
      if (totalFrames - 1 - frame < fade) fade = totalFrames - 1 - frame;
      // Keep the entire gain/fade calculation signed. Multiplying a negative
      // sample by the unsigned fade used to wrap it into harsh distortion.
      const int16_t sample = scaleStartupChimeSample(mono, static_cast<int32_t>(fade));
      stereo[2 * i] = sample;
      stereo[2 * i + 1] = sample;
    }
    const size_t bytes = frames * 2 * sizeof(int16_t);
    if (speakerI2s.write(reinterpret_cast<const uint8_t *>(stereo), bytes) != bytes) {
      startupChimeI2sError = speakerI2s.lastError();
      return false;
    }
    startupChimeBytesWritten += bytes;
  }
  if (ledsReady) setStartupLeds(6, 0);
  startupChimeStage = "tail";
  if (speakerI2s.write(reinterpret_cast<const uint8_t *>(silence), sizeof(silence))
      != sizeof(silence)) {
    startupChimeI2sError = speakerI2s.lastError();
    return false;
  }
  startupChimeStage = "complete";
  return true;
}

bool initNarrowTof(VL53L1X &sensor, uint8_t pinMask,
                   uint8_t address, uint8_t *activePins) {
  const uint8_t enabled = 0x08 | *activePins | pinMask;
  if (!writeExpander(0x01, enabled)) return false;
  delay(20);
  sensor.setBus(&Wire);
  sensor.setTimeout(500);
  if (!sensor.init()) {
    writeExpander(0x01, 0x08 | *activePins);
    return false;
  }
  sensor.setAddress(address);
  delay(2);
  if (!i2cPresent(address) ||
      !sensor.setDistanceMode(VL53L1X::Short) ||
      !sensor.setMeasurementTimingBudget(50000)) {
    writeExpander(0x01, 0x08 | *activePins);
    return false;
  }
  *activePins |= pinMask;
  return true;
}

void initTofSensors() {
  if (!expanderReady) return;
  uint8_t activePins = 0;
  frontTofReady = initNarrowTof(frontTof, 0x01, FRONT_TOF_ADDRESS, &activePins);
  rearTofReady = initNarrowTof(rearTof, 0x02, REAR_TOF_ADDRESS, &activePins);

  // The wide sensor retains the default address while the two narrow parts
  // stay powered at 0x30/0x31. P2 high + P3 low was confirmed on the bench.
  if (!writeExpander(0x01, activePins | 0x04)) return;
  delay(100);
  if (!i2cPresent(0x29)) return;
  wideTofReady = wideTof.begin(0x29, &Wire, 400000) &&
    wideTof.setResolution(64) &&
    wideTof.setRangingFrequency(5) &&
    wideTof.startRanging();
  Serial.printf("ToF front=%d rear=%d wide=%d\n",
                frontTofReady, rearTofReady, wideTofReady);
}

framesize_t selectedFrameSize() {
  if (strcmp(FRAME_SIZE, "QVGA") == 0) return FRAMESIZE_QVGA;
  if (strcmp(FRAME_SIZE, "SVGA") == 0) return FRAMESIZE_SVGA;
  if (strcmp(FRAME_SIZE, "XGA") == 0) return FRAMESIZE_XGA;
  if (strcmp(FRAME_SIZE, "HD") == 0) return FRAMESIZE_HD;
  return FRAMESIZE_VGA;
}

bool initCamera() {
  camera_config_t c = {};
  c.ledc_channel = LEDC_CHANNEL_0;
  c.ledc_timer = LEDC_TIMER_0;
  c.pin_d0 = CAM_D0; c.pin_d1 = CAM_D1;
  c.pin_d2 = CAM_D2; c.pin_d3 = CAM_D3;
  c.pin_d4 = CAM_D4; c.pin_d5 = CAM_D5;
  c.pin_d6 = CAM_D6; c.pin_d7 = CAM_D7;
  c.pin_xclk = CAM_XCLK;
  c.pin_pclk = CAM_PCLK;
  c.pin_vsync = CAM_VSYNC;
  c.pin_href = CAM_HREF;
  c.pin_sccb_sda = CAM_SDA;
  c.pin_sccb_scl = CAM_SCL;
  c.pin_pwdn = -1;
  c.pin_reset = -1;
  c.xclk_freq_hz = 20000000;
  c.pixel_format = PIXFORMAT_JPEG;
  c.frame_size = selectedFrameSize();
  c.jpeg_quality = constrain(JPEG_QUALITY, 0, 63);
  c.fb_count = psramFound() ? 2 : 1;
  c.fb_location = psramFound() ? CAMERA_FB_IN_PSRAM : CAMERA_FB_IN_DRAM;
  c.grab_mode = CAMERA_GRAB_LATEST;
  const esp_err_t err = esp_camera_init(&c);
  if (err != ESP_OK) Serial.printf("Camera init failed: 0x%x\n", err);
  return err == ESP_OK;
}

IPAddress subnetMask(int cidr) {
  const int n = constrain(cidr, 0, 32);
  const uint32_t bits = n == 0 ? 0 : (0xFFFFFFFFUL << (32 - n));
  return IPAddress((bits >> 24) & 255, (bits >> 16) & 255,
                   (bits >> 8) & 255, bits & 255);
}

void connectWifi() {
  WiFi.mode(WIFI_STA);
  if (USE_STATIC_IP) {
    const IPAddress gateway(STATIC_IP[0], STATIC_IP[1], STATIC_IP[2], 1);
    if (!WiFi.config(STATIC_IP, gateway, subnetMask(STATIC_CIDR))) {
      Serial.println("Static IP config failed; trying DHCP");
    }
  }
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  const uint32_t start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 30000) delay(250);
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("WiFi connect timed out; rebooting");
    delay(1000);
    ESP.restart();
  }
  Serial.printf("WiFi connected: %s\n", WiFi.localIP().toString().c_str());
  if (MDNS.begin(MDNS_NAME)) {
    MDNS.addService("http", "tcp", CAMERA_PORT);
    Serial.printf("mDNS: %s.local\n", MDNS_NAME);
  } else {
    Serial.println("mDNS startup failed; use the board IP");
  }
}

void sendHealth() {
  String body = "{\"ok\":true,\"board\":\"psf-sensor-board\",\"revision\":\"1.3\"";
  body += ",\"firmware\":\"bring-up-10\",\"uptimeMs\":" + String(millis() - bootMs);
  body += ",\"cameraReady\":" + String(cameraReady ? "true" : "false");
  body += ",\"expanderReady\":" + String(expanderReady ? "true" : "false");
  body += ",\"frontTofReady\":" + String(frontTofReady ? "true" : "false");
  body += ",\"rearTofReady\":" + String(rearTofReady ? "true" : "false");
  body += ",\"wideTofReady\":" + String(wideTofReady ? "true" : "false");
  body += ",\"imuReady\":" + String(imuReady ? "true" : "false");
  body += ",\"microphonesReady\":" + String(microphonesReady ? "true" : "false");
  body += ",\"speakerReady\":" + String(speakerReady ? "true" : "false");
  body += ",\"speakerAmpEnabled\":" + String(speakerAmpEnabled ? "true" : "false");
  body += ",\"startupChimePlayed\":" + String(startupChimePlayed ? "true" : "false");
  body += ",\"startupChimeStage\":\"" + String(startupChimeStage) + "\"";
  body += ",\"startupChimeBytesWritten\":" + String(startupChimeBytesWritten);
  body += ",\"startupChimeI2sError\":" + String(startupChimeI2sError);
  body += ",\"ledsReady\":" + String(ledsReady ? "true" : "false");
  body += ",\"rssi\":" + String(WiFi.RSSI()) + "}";
  cameraServer.send(200, "application/json", body);
}

void sendCapture() {
  if (!cameraReady) {
    cameraServer.send(503, "text/plain", "camera unavailable");
    return;
  }
  camera_fb_t *fb = esp_camera_fb_get();
  if (!fb) {
    cameraServer.send(500, "text/plain", "capture failed");
    return;
  }
  WiFiClient client = cameraServer.client();
  client.printf("HTTP/1.1 200 OK\r\nContent-Type: image/jpeg\r\nContent-Length: %u\r\n\r\n", fb->len);
  client.write(fb->buf, fb->len);
  esp_camera_fb_return(fb);
}

void sendStream() {
  if (!cameraReady) {
    cameraServer.send(503, "text/plain", "camera unavailable");
    return;
  }
  WiFiClient client = cameraServer.client();
  client.print("HTTP/1.1 200 OK\r\nContent-Type: multipart/x-mixed-replace; boundary=psfhelm\r\n\r\n");
  while (client.connected()) {
    camera_fb_t *fb = esp_camera_fb_get();
    if (!fb) break;
    client.printf("--psfhelm\r\nContent-Type: image/jpeg\r\nContent-Length: %u\r\n\r\n", fb->len);
    client.write(fb->buf, fb->len);
    client.print("\r\n");
    esp_camera_fb_return(fb);
    delay(30);
  }
}

void cameraTask(void *) {
  for (;;) {
    cameraServer.handleClient();
    vTaskDelay(pdMS_TO_TICKS(2));
  }
}

// SK6812 RGBW, GRBW wire order. RMT tick = 100 ns; each bit spans 1.2 us.
bool showLeds() {
  if (!ledsReady) return false;
  rmt_data_t symbols[LED_COUNT * 32];
  size_t count = 0;
  for (uint8_t i = 0; i < LED_COUNT; ++i) {
    const uint8_t order[4] = { ledValues[i][1], ledValues[i][0],
                               ledValues[i][2], ledValues[i][3] };
    for (uint8_t channel = 0; channel < 4; ++channel) {
      for (int bit = 7; bit >= 0; --bit) {
        const bool one = (order[channel] >> bit) & 1;
        symbols[count].level0 = 1;
        symbols[count].duration0 = one ? 6 : 3;
        symbols[count].level1 = 0;
        symbols[count].duration1 = one ? 6 : 9;
        ++count;
      }
    }
  }
  const bool sent = rmtWrite(LED_PIN, symbols, count, 100);
  delayMicroseconds(100); // SK6812 reset latch
  return sent;
}

void sendDiagnostics() {
  String body = "{\"board\":\"psf-sensor-board\",\"revision\":\"1.3\"";
  body += ",\"i2cAddresses\":[";
  bool first = true;
  for (uint8_t addr = 0x08; addr < 0x78; ++addr) {
    if (!i2cPresent(addr)) continue;
    if (!first) body += ',';
    body += String(addr);
    first = false;
  }
  body += "]";
  uint8_t expanderInput = 0, expanderOutput = 0, expanderConfig = 0;
  const bool inputReadable = readRegister8(TCA9534_ADDRESS, 0x00, &expanderInput);
  const bool outputReadable = readRegister8(TCA9534_ADDRESS, 0x01, &expanderOutput);
  const bool configReadable = readRegister8(TCA9534_ADDRESS, 0x03, &expanderConfig);
  body += ",\"expanderPresent\":" + String(i2cPresent(TCA9534_ADDRESS) ? "true" : "false");
  body += ",\"expanderInput\":" + String(inputReadable ? String(expanderInput) : "null");
  body += ",\"expanderOutput\":" + String(outputReadable ? String(expanderOutput) : "null");
  body += ",\"expanderConfig\":" + String(configReadable ? String(expanderConfig) : "null");
  body += ",\"expanderReady\":" + String(expanderReady ? "true" : "false");
  body += ",\"frontTofReady\":" + String(frontTofReady ? "true" : "false");
  body += ",\"rearTofReady\":" + String(rearTofReady ? "true" : "false");
  body += ",\"wideTofReady\":" + String(wideTofReady ? "true" : "false");
  body += ",\"imuReady\":" + String(imuReady ? "true" : "false");
  body += ",\"microphonesReady\":" + String(microphonesReady ? "true" : "false");
  body += ",\"speakerReady\":" + String(speakerReady ? "true" : "false");
  body += ",\"speakerAmpEnabled\":" + String(speakerAmpEnabled ? "true" : "false");
  body += ",\"startupChimePlayed\":" + String(startupChimePlayed ? "true" : "false");
  body += ",\"startupChimeStage\":\"" + String(startupChimeStage) + "\"";
  body += ",\"startupChimeBytesWritten\":" + String(startupChimeBytesWritten);
  body += ",\"startupChimeI2sError\":" + String(startupChimeI2sError);
  body += ",\"imuWhoAmI\":" + String(imuWhoAmI);
  uint8_t imuGyroConfig = 0, imuAccelConfig = 0, imuPower = 0;
  const bool imuGyroReadable = readRegister8(IMU_ADDRESS, 0x20, &imuGyroConfig);
  const bool imuAccelReadable = readRegister8(IMU_ADDRESS, 0x21, &imuAccelConfig);
  const bool imuPowerReadable = readRegister8(IMU_ADDRESS, 0x1F, &imuPower);
  body += ",\"imuGyroConfig\":" + String(imuGyroReadable ? String(imuGyroConfig) : "null");
  body += ",\"imuAccelConfig\":" + String(imuAccelReadable ? String(imuAccelConfig) : "null");
  body += ",\"imuPower\":" + String(imuPowerReadable ? String(imuPower) : "null");
  body += ",\"frontAddressResponds\":" + String(i2cPresent(FRONT_TOF_ADDRESS) ? "true" : "false");
  body += ",\"rearAddressResponds\":" + String(i2cPresent(REAR_TOF_ADDRESS) ? "true" : "false");
  body += ",\"tofDefaultAddressResponds\":" + String(i2cPresent(0x29) ? "true" : "false");
  body += ",\"imuAddressResponds\":" + String((i2cPresent(0x68) || i2cPresent(0x69)) ? "true" : "false");
  body += ",\"distanceMm\":null,\"imuSample\":null}";
  diagnosticServer.send(200, "application/json", body);
}

const char *tofModeName(VL53L1X::DistanceMode mode) {
  switch (mode) {
    case VL53L1X::Short: return "short";
    case VL53L1X::Medium: return "medium";
    case VL53L1X::Long: return "long";
    default: return "unknown";
  }
}

VL53L1X::DistanceMode nextTofMode(VL53L1X::DistanceMode mode) {
  return mode == VL53L1X::Short ? VL53L1X::Medium :
    mode == VL53L1X::Medium ? VL53L1X::Long : VL53L1X::Short;
}

String tofModesJson() {
  String body = "{\"ok\":true,\"retryMs\":" + String(TOF_AUTO_RETRY_MS);
  body += ",\"front\":{\"ready\":" + String(frontTofReady ? "true" : "false");
  body += ",\"mode\":\"" + String(tofModeName(frontTofMode)) + "\",\"auto\":" + String(frontTofAuto ? "true" : "false") + '}';
  body += ",\"rear\":{\"ready\":" + String(rearTofReady ? "true" : "false");
  body += ",\"mode\":\"" + String(tofModeName(rearTofMode)) + "\",\"auto\":" + String(rearTofAuto ? "true" : "false") + "}}";
  return body;
}

void sendTofMode() {
  diagnosticServer.send(200, "application/json", tofModesJson());
}

void setTofMode() {
  const String sensor = diagnosticServer.arg("sensor");
  const String mode = diagnosticServer.arg("mode");
  if ((sensor != "front" && sensor != "rear" && sensor != "both") ||
      (mode != "auto" && mode != "short" && mode != "medium" && mode != "long")) {
    diagnosticServer.send(400, "application/json", "{\"ok\":false,\"error\":\"use sensor=front|rear|both and mode=auto|short|medium|long\"}");
    return;
  }
  const bool useFront = sensor != "rear", useRear = sensor != "front";
  if ((!frontTofReady && useFront) || (!rearTofReady && useRear)) {
    diagnosticServer.send(503, "application/json", "{\"ok\":false,\"error\":\"requested ToF unavailable\"}");
    return;
  }
  if (mode == "auto") {
    if (useFront) { frontTofAuto = true; frontTofInvalidSince = 0; }
    if (useRear) { rearTofAuto = true; rearTofInvalidSince = 0; }
  } else {
    const VL53L1X::DistanceMode selected = mode == "short" ? VL53L1X::Short :
      mode == "medium" ? VL53L1X::Medium : VL53L1X::Long;
    if ((useFront && !frontTof.setDistanceMode(selected)) ||
        (useRear && !rearTof.setDistanceMode(selected))) {
      diagnosticServer.send(503, "application/json", "{\"ok\":false,\"error\":\"ToF mode switch failed\"}");
      return;
    }
    if (useFront) { frontTofMode = selected; frontTofAuto = false; frontTofInvalidSince = 0; }
    if (useRear) { rearTofMode = selected; rearTofAuto = false; rearTofInvalidSince = 0; }
  }
  diagnosticServer.send(200, "application/json", tofModesJson());
}

void appendNarrowRange(String &body, const char *name,
                       VL53L1X &sensor, bool ready,
                       VL53L1X::DistanceMode &mode, bool automatic,
                       uint32_t &invalidSince) {
  bool timedOut = false, valid = false;
  uint16_t mm = 0;
  int status = -1;
  if (ready) {
    mm = sensor.readSingle();
    timedOut = sensor.timeoutOccurred();
    if (!timedOut) {
      status = static_cast<int>(sensor.ranging_data.range_status);
      valid = sensor.ranging_data.range_status == VL53L1X::RangeValid;
    }
  }
  const VL53L1X::DistanceMode sampledMode = mode;
  bool modeChanged = false;
  if (automatic && ready) {
    if (valid) {
      invalidSince = 0;
    } else if (invalidSince == 0) {
      invalidSince = millis();
    } else if (millis() - invalidSince >= TOF_AUTO_RETRY_MS) {
      const VL53L1X::DistanceMode candidate = nextTofMode(mode);
      if (sensor.setDistanceMode(candidate)) {
        mode = candidate;
        modeChanged = true;
      }
      invalidSince = millis();
    }
  }
  body += "{\"name\":\"" + String(name) + "\",\"ready\":";
  body += ready ? "true" : "false";
  body += ",\"timeout\":";
  body += timedOut ? "true" : "false";
  body += ",\"rangeStatus\":" + String(status);
  body += ",\"mode\":\"" + String(tofModeName(sampledMode)) + "\"";
  body += ",\"activeMode\":\"" + String(tofModeName(mode)) + "\"";
  body += ",\"auto\":" + String(automatic ? "true" : "false");
  body += ",\"modeChanged\":" + String(modeChanged ? "true" : "false");
  body += ",\"distanceMm\":";
  body += valid ? String(mm) : "null";
  body += '}';
}

void sendRanges() {
  String body = "{\"ok\":true,\"singleZone\":[";
  appendNarrowRange(body, "front", frontTof, frontTofReady,
    frontTofMode, frontTofAuto, frontTofInvalidSince);
  body += ',';
  appendNarrowRange(body, "rear", rearTof, rearTofReady,
    rearTofMode, rearTofAuto, rearTofInvalidSince);
  body += "],\"wideReady\":" + String(wideTofReady ? "true" : "false");
  body += ",\"rssi\":" + String(WiFi.RSSI()) + '}';
  diagnosticServer.send(200, "application/json", body);
}

void sendWideRange() {
  if (!wideTofReady) {
    diagnosticServer.send(503, "application/json", "{\"ok\":false,\"error\":\"wide ToF unavailable\"}");
    return;
  }
  if (!wideHasFrame) {
    diagnosticServer.send(202, "application/json", "{\"ok\":true,\"ready\":false}");
    return;
  }
  String body;
  body.reserve(1600);
  body = "{\"ok\":true,\"ready\":true,\"ageMs\":" + String(millis() - wideCapturedAt);
  body += ",\"rawDistanceMm\":[";
  for (uint8_t zone = 0; zone < 64; ++zone) {
    if (zone) body += ',';
    body += String(wideResults.distance_mm[zone]);
  }
  body += "],\"targetStatus\":[";
  for (uint8_t zone = 0; zone < 64; ++zone) {
    if (zone) body += ',';
    body += String(wideResults.target_status[zone]);
  }
  body += "]}";
  diagnosticServer.send(200, "application/json", body);
}

int16_t signedImuWord(const uint8_t *bytes) {
  return static_cast<int16_t>((static_cast<uint16_t>(bytes[0]) << 8) | bytes[1]);
}

void sendImu() {
  // A busy shared I2C bus can make the boot-time configuration check fail.
  // Allow a fresh initialization when an IMU sample is explicitly requested.
  if (!imuReady) initImu();
  if (!imuReady) {
    diagnosticServer.send(503, "application/json", "{\"ok\":false,\"error\":\"IMU unavailable\"}");
    return;
  }
  // One burst reads temperature, acceleration and angular rate together.
  uint8_t data[14];
  if (!readRegisters(IMU_ADDRESS, 0x09, data, sizeof(data))) {
    diagnosticServer.send(502, "application/json", "{\"ok\":false,\"error\":\"IMU read failed\"}");
    return;
  }
  const int16_t temperature = signedImuWord(data);
  int16_t accel[3], gyro[3];
  for (uint8_t axis = 0; axis < 3; ++axis) {
    accel[axis] = signedImuWord(data + 2 + axis * 2);
    gyro[axis] = signedImuWord(data + 8 + axis * 2);
  }
  String body = "{\"ok\":true,\"sampledAtMs\":" + String(millis());
  body += ",\"frame\":\"chip\",\"rawAccel\":[";
  for (uint8_t axis = 0; axis < 3; ++axis) {
    if (axis) body += ',';
    body += String(accel[axis]);
  }
  body += "],\"accelG\":[";
  for (uint8_t axis = 0; axis < 3; ++axis) {
    if (axis) body += ',';
    body += String(accel[axis] / 16384.0f, 4);
  }
  body += "],\"rawGyro\":[";
  for (uint8_t axis = 0; axis < 3; ++axis) {
    if (axis) body += ',';
    body += String(gyro[axis]);
  }
  body += "],\"gyroDps\":[";
  for (uint8_t axis = 0; axis < 3; ++axis) {
    if (axis) body += ',';
    body += String(gyro[axis] / 131.0f, 4);
  }
  body += "],\"rawTemperature\":" + String(temperature);
  body += ",\"temperatureC\":" + String(25.0f + temperature / 128.0f, 2) + '}';
  diagnosticServer.send(200, "application/json", body);
}

void sendMicrophoneLevels() {
  if (!microphonesReady) {
    diagnosticServer.send(503, "application/json", "{\"ok\":false,\"error\":\"microphones unavailable\"}");
    return;
  }
  // 2048 stereo frames: enough for a short level check without a live stream.
  int16_t samples[512 * 2];
  int64_t sum[2] = {}, sumSquares[2] = {};
  uint32_t peak[2] = {};
  uint32_t frames = 0;
  for (uint8_t block = 0; block < 4; ++block) {
    const size_t bytes = microphoneI2s.readBytes(reinterpret_cast<char *>(samples), sizeof(samples));
    if (bytes != sizeof(samples)) {
      diagnosticServer.send(502, "application/json", "{\"ok\":false,\"error\":\"PDM capture failed\"}");
      return;
    }
    for (size_t frame = 0; frame < 512; ++frame) {
      for (uint8_t channel = 0; channel < 2; ++channel) {
        const int32_t value = samples[frame * 2 + channel];
        sum[channel] += value;
        sumSquares[channel] += static_cast<int64_t>(value) * value;
        peak[channel] = max(peak[channel], static_cast<uint32_t>(abs(value)));
      }
    }
    frames += 512;
  }
  String body = "{\"ok\":true,\"sampleRate\":" + String(MIC_SAMPLE_RATE);
  body += ",\"configuredPdmClockHz\":" + String(MIC_PDM_CLOCK_HZ);
  body += ",\"frames\":" + String(frames) + ",\"channels\":[";
  for (uint8_t channel = 0; channel < 2; ++channel) {
    if (channel) body += ',';
    const double mean = static_cast<double>(sum[channel]) / frames;
    const double variance = max(0.0, static_cast<double>(sumSquares[channel]) / frames - mean * mean);
    body += "{\"channel\":" + String(channel);
    body += ",\"mean\":" + String(mean, 2);
    body += ",\"rms\":" + String(sqrt(variance), 2);
    body += ",\"peak\":" + String(peak[channel]) + '}';
  }
  body += "]}";
  diagnosticServer.send(200, "application/json", body);
}

void sendMicrophonePinTest() {
  // Bench-only electrical clue: sample the GPIO pad while I2S owns it.
  // Vary the interval so a periodic PDM clock is less likely to alias.
  gpio_input_enable(static_cast<gpio_num_t>(MIC_PDM_CLK));
  gpio_input_enable(static_cast<gpio_num_t>(MIC_PDM_DATA));
  uint32_t clockHigh = 0, dataHigh = 0;
  for (uint32_t sample = 0; sample < 10000; ++sample) {
    clockHigh += gpio_get_level(static_cast<gpio_num_t>(MIC_PDM_CLK));
    dataHigh += gpio_get_level(static_cast<gpio_num_t>(MIC_PDM_DATA));
    delayMicroseconds(sample % 7 + 1);
  }
  String body = "{\"ok\":true,\"samples\":10000,\"clockPin\":" + String(MIC_PDM_CLK);
  body += ",\"clockHigh\":" + String(clockHigh) + ",\"dataPin\":" + String(MIC_PDM_DATA);
  body += ",\"dataHigh\":" + String(dataHigh) + '}';
  diagnosticServer.send(200, "application/json", body);
}

void sendMicrophoneLivePullTest() {
  if (!microphonesReady) {
    diagnosticServer.send(503, "application/json", "{\"ok\":false,\"error\":\"microphone I2S unavailable\"}");
    return;
  }
  // Leave the PDM receiver and clock running. A weak internal pull-up can
  // reveal a floating DATA net without driving against a microphone output.
  const gpio_num_t dataPin = static_cast<gpio_num_t>(MIC_PDM_DATA);
  gpio_input_enable(dataPin);
  uint32_t beforeHigh = 0, pulledHigh = 0, restoredHigh = 0;
  for (uint16_t sample = 0; sample < 1000; ++sample) {
    beforeHigh += gpio_get_level(dataPin);
    delayMicroseconds(sample % 7 + 1);
  }
  const esp_err_t enabled = gpio_pullup_en(dataPin);
  if (enabled != ESP_OK) {
    diagnosticServer.send(500, "application/json", "{\"ok\":false,\"error\":\"could not enable DATA pull-up\"}");
    return;
  }
  delay(5);
  for (uint32_t sample = 0; sample < 10000; ++sample) {
    pulledHigh += gpio_get_level(dataPin);
    delayMicroseconds(sample % 7 + 1);
  }
  const esp_err_t disabled = gpio_pullup_dis(dataPin);
  delay(5);
  for (uint16_t sample = 0; sample < 1000; ++sample) {
    restoredHigh += gpio_get_level(dataPin);
    delayMicroseconds(sample % 7 + 1);
  }
  String body = "{\"ok\":" + String(disabled == ESP_OK ? "true" : "false");
  body += ",\"dataPin\":" + String(MIC_PDM_DATA);
  body += ",\"beforeHighOf1000\":" + String(beforeHigh);
  body += ",\"pulledHighOf10000\":" + String(pulledHigh);
  body += ",\"restoredHighOf1000\":" + String(restoredHigh);
  body += ",\"pullupRemoved\":" + String(disabled == ESP_OK ? "true" : "false") + '}';
  diagnosticServer.send(disabled == ESP_OK ? 200 : 500, "application/json", body);
}

void sendMicrophoneLineTest() {
  if (!microphonesReady) {
    diagnosticServer.send(503, "application/json", "{\"ok\":false,\"error\":\"microphone I2S unavailable\"}");
    return;
  }
  // Release GPIO14 from I2S before testing its pad with only weak internal
  // pulls. Neither microphone is clocked during these measurements.
  if (!microphoneI2s.end()) {
    microphonesReady = false;
    diagnosticServer.send(500, "application/json", "{\"ok\":false,\"error\":\"could not stop microphone I2S\"}");
    return;
  }
  microphonesReady = false;
  pinMode(MIC_PDM_DATA, INPUT_PULLUP);
  delay(25);
  uint32_t pullupHigh = 0;
  for (uint16_t sample = 0; sample < 1000; ++sample) {
    pullupHigh += digitalRead(MIC_PDM_DATA);
    delayMicroseconds(10);
  }
  pinMode(MIC_PDM_DATA, INPUT_PULLDOWN);
  delay(25);
  uint32_t pulldownHigh = 0;
  for (uint16_t sample = 0; sample < 1000; ++sample) {
    pulldownHigh += digitalRead(MIC_PDM_DATA);
    delayMicroseconds(10);
  }
  pinMode(MIC_PDM_DATA, INPUT);
  initMicrophones();
  if (microphonesReady) delay(25); // allow the microphones to wake after clock resumes
  String body = "{\"ok\":" + String(microphonesReady ? "true" : "false");
  body += ",\"samples\":1000,\"dataPin\":" + String(MIC_PDM_DATA);
  body += ",\"pullupHigh\":" + String(pullupHigh);
  body += ",\"pulldownHigh\":" + String(pulldownHigh);
  body += ",\"captureRestored\":" + String(microphonesReady ? "true" : "false") + '}';
  diagnosticServer.send(microphonesReady ? 200 : 500, "application/json", body);
}

void sendMicrophoneRawClockTest() {
  if (!microphonesReady) {
    diagnosticServer.send(503, "application/json", "{\"ok\":false,\"error\":\"microphone I2S unavailable\"}");
    return;
  }
  // Isolate microphone output from the I2S PDM receiver. Release both pins,
  // drive CLK with an independent LEDC timer, then read DATA as a plain GPIO.
  if (!microphoneI2s.end()) {
    microphonesReady = false;
    diagnosticServer.send(500, "application/json", "{\"ok\":false,\"error\":\"could not stop microphone I2S\"}");
    return;
  }
  microphonesReady = false;
  const gpio_num_t clockPin = static_cast<gpio_num_t>(MIC_PDM_CLK);
  const gpio_num_t dataPin = static_cast<gpio_num_t>(MIC_PDM_DATA);
  pinMode(MIC_PDM_DATA, INPUT);
  gpio_pullup_dis(dataPin);
  gpio_pulldown_dis(dataPin);
  const bool attached = ledcAttachChannel(MIC_PDM_CLK, MIC_PDM_CLOCK_HZ, 1, 7);
  const bool running = attached && ledcWrite(MIC_PDM_CLK, 1); // 1/2 = 50% duty
  const uint32_t actualClockHz = running ? ledcReadFreq(MIC_PDM_CLK) : 0;
  uint32_t clockHigh = 0, dataHigh = 0, dataTransitions = 0, pulledHigh = 0;
  if (running) {
    delay(30); // microphone wake-up maximum is 20 ms
    gpio_input_enable(clockPin);
    uint8_t previous = gpio_get_level(dataPin);
    for (uint32_t sample = 0; sample < 10000; ++sample) {
      clockHigh += gpio_get_level(clockPin);
      const uint8_t value = gpio_get_level(dataPin);
      dataHigh += value;
      dataTransitions += value != previous;
      previous = value;
      delayMicroseconds(sample % 7 + 1);
    }
    gpio_pullup_en(dataPin); // weak pull distinguishes a floating DATA net
    delay(5);
    for (uint32_t sample = 0; sample < 10000; ++sample) {
      pulledHigh += gpio_get_level(dataPin);
      delayMicroseconds(sample % 7 + 1);
    }
    gpio_pullup_dis(dataPin);
  }
  if (attached) ledcDetach(MIC_PDM_CLK);
  pinMode(MIC_PDM_CLK, INPUT);
  pinMode(MIC_PDM_DATA, INPUT);
  initMicrophones();
  String body = "{\"ok\":" + String(running && microphonesReady ? "true" : "false");
  body += ",\"independentClockHz\":" + String(actualClockHz);
  body += ",\"samples\":10000,\"clockHigh\":" + String(clockHigh);
  body += ",\"dataHighNoPull\":" + String(dataHigh);
  body += ",\"dataTransitionsNoPull\":" + String(dataTransitions);
  body += ",\"dataHighWeakPullup\":" + String(pulledHigh);
  body += ",\"pdmCaptureRestored\":" + String(microphonesReady ? "true" : "false") + '}';
  diagnosticServer.send(running && microphonesReady ? 200 : 500, "application/json", body);
}

esp_err_t countRisingEdges(uint8_t pin, int *count) {
  // Five milliseconds keeps a 2.048 MHz clock below PCNT's 16-bit limit.
  pcnt_unit_config_t unitConfig = {};
  unitConfig.low_limit = -32768;
  unitConfig.high_limit = 32767;
  pcnt_unit_handle_t unit = nullptr;
  pcnt_channel_handle_t channel = nullptr;
  bool enabled = false;
  bool started = false;
  esp_err_t result = pcnt_new_unit(&unitConfig, &unit);
  if (result != ESP_OK) return result;
  pcnt_chan_config_t channelConfig = {};
  channelConfig.edge_gpio_num = pin;
  channelConfig.level_gpio_num = -1;
  result = pcnt_new_channel(unit, &channelConfig, &channel);
  if (result == ESP_OK) {
    result = pcnt_channel_set_edge_action(channel,
      PCNT_CHANNEL_EDGE_ACTION_INCREASE, PCNT_CHANNEL_EDGE_ACTION_HOLD);
  }
  if (result == ESP_OK) {
    // PCNT may enable a pull-up while attaching its input. Measure the net
    // with no internal bias, as the microphones normally drive it.
    gpio_pullup_dis(static_cast<gpio_num_t>(pin));
    gpio_pulldown_dis(static_cast<gpio_num_t>(pin));
    result = pcnt_unit_enable(unit);
    enabled = result == ESP_OK;
  }
  if (result == ESP_OK) result = pcnt_unit_clear_count(unit);
  if (result == ESP_OK) {
    result = pcnt_unit_start(unit);
    started = result == ESP_OK;
  }
  if (result == ESP_OK) {
    delayMicroseconds(5000);
    result = pcnt_unit_stop(unit);
    started = false;
  }
  if (result == ESP_OK) result = pcnt_unit_get_count(unit, count);
  if (started) pcnt_unit_stop(unit);
  if (enabled) pcnt_unit_disable(unit);
  if (channel) pcnt_del_channel(channel);
  pcnt_del_unit(unit);
  return result;
}

void sendMicrophonePcntTest() {
  if (!microphonesReady) {
    diagnosticServer.send(503, "application/json", "{\"ok\":false,\"error\":\"microphone I2S unavailable\"}");
    return;
  }
  if (!microphoneI2s.end()) {
    microphonesReady = false;
    diagnosticServer.send(500, "application/json", "{\"ok\":false,\"error\":\"could not stop microphone I2S\"}");
    return;
  }
  microphonesReady = false;
  const gpio_num_t dataPin = static_cast<gpio_num_t>(MIC_PDM_DATA);
  pinMode(MIC_PDM_DATA, INPUT);
  gpio_pullup_dis(dataPin);
  gpio_pulldown_dis(dataPin);
  const bool attached = ledcAttachChannel(MIC_PDM_CLK, MIC_PDM_CLOCK_HZ, 1, 7);
  const bool running = attached && ledcWrite(MIC_PDM_CLK, 1);
  const uint32_t actualClockHz = running ? ledcReadFreq(MIC_PDM_CLK) : 0;
  int dataEdges = -1, clockEdges = -1;
  esp_err_t dataError = ESP_ERR_INVALID_STATE;
  esp_err_t clockError = ESP_ERR_INVALID_STATE;
  if (running) {
    delay(30); // microphone wake-up maximum is 20 ms
    dataError = countRisingEdges(MIC_PDM_DATA, &dataEdges);
    gpio_input_enable(static_cast<gpio_num_t>(MIC_PDM_CLK));
    clockError = countRisingEdges(MIC_PDM_CLK, &clockEdges);
  }
  if (attached) ledcDetach(MIC_PDM_CLK);
  pinMode(MIC_PDM_CLK, INPUT);
  pinMode(MIC_PDM_DATA, INPUT);
  initMicrophones();
  const bool ok = running && dataError == ESP_OK && clockError == ESP_OK && microphonesReady;
  String body = "{\"ok\":" + String(ok ? "true" : "false");
  body += ",\"independentClockHz\":" + String(actualClockHz);
  body += ",\"windowUs\":5000,\"dataRisingEdges\":" + String(dataEdges);
  body += ",\"clockRisingEdges\":" + String(clockEdges);
  body += ",\"dataPcntError\":\"" + String(esp_err_to_name(dataError)) + '"';
  body += ",\"clockPcntError\":\"" + String(esp_err_to_name(clockError)) + '"';
  body += ",\"pdmCaptureRestored\":" + String(microphonesReady ? "true" : "false") + '}';
  diagnosticServer.send(ok ? 200 : 500, "application/json", body);
}

void holdMicrophoneClock(uint8_t level) {
  if (!micClockHeld) {
    if (!microphonesReady || !microphoneI2s.end()) {
      diagnosticServer.send(503, "application/json", "{\"ok\":false,\"error\":\"could not stop microphone I2S\"}");
      return;
    }
    microphonesReady = false;
  }
  // Claim the pad with the ESP-IDF GPIO driver after I2S releases it. This
  // also enables input readback while the output is held for a DMM check.
  const gpio_num_t pin = static_cast<gpio_num_t>(MIC_PDM_CLK);
  gpio_config_t config = {};
  config.pin_bit_mask = 1ULL << MIC_PDM_CLK;
  config.mode = GPIO_MODE_INPUT_OUTPUT;
  config.pull_up_en = GPIO_PULLUP_DISABLE;
  config.pull_down_en = GPIO_PULLDOWN_DISABLE;
  config.intr_type = GPIO_INTR_DISABLE;
  const esp_err_t reset = gpio_reset_pin(pin);
  const esp_err_t configured = reset == ESP_OK ? gpio_config(&config) : reset;
  const esp_err_t driven = configured == ESP_OK ? gpio_set_level(pin, level) : configured;
  if (driven != ESP_OK) {
    micClockHeld = false;
    micClockHeldLevel = -1;
    gpio_reset_pin(pin);
    initMicrophones();
    diagnosticServer.send(500, "application/json",
      "{\"ok\":false,\"error\":\"GPIO clock hold failed: " + String(esp_err_to_name(driven)) + "\"}");
    return;
  }
  micClockHeld = true;
  micClockHeldLevel = level;
  delay(1);
  const int padLevel = gpio_get_level(pin);
  String body = "{\"ok\":true,\"clockPin\":" + String(MIC_PDM_CLK);
  body += ",\"heldLevel\":" + String(level);
  body += ",\"padLevel\":" + String(padLevel) + '}';
  diagnosticServer.send(200, "application/json", body);
}

void holdMicrophoneClockLow() { holdMicrophoneClock(0); }
void holdMicrophoneClockHigh() { holdMicrophoneClock(1); }

void sendMicrophoneHeldClockEdges() {
  if (!micClockHeld) {
    diagnosticServer.send(503, "application/json", "{\"ok\":false,\"error\":\"microphone clock is not held\"}");
    return;
  }
  int edges = -1;
  const esp_err_t error = countRisingEdges(MIC_PDM_CLK, &edges);
  String body = "{\"ok\":" + String(error == ESP_OK ? "true" : "false");
  body += ",\"clockPin\":" + String(MIC_PDM_CLK);
  body += ",\"heldLevel\":" + String(micClockHeldLevel);
  body += ",\"padLevel\":" + String(gpio_get_level(static_cast<gpio_num_t>(MIC_PDM_CLK)));
  body += ",\"windowUs\":5000,\"risingEdges\":" + String(edges);
  body += ",\"pcntError\":\"" + String(esp_err_to_name(error)) + "\"}";
  diagnosticServer.send(error == ESP_OK ? 200 : 500, "application/json", body);
}

void restoreMicrophoneClock() {
  if (!micClockHeld) {
    diagnosticServer.send(200, "application/json", "{\"ok\":true,\"held\":false,\"pdmCaptureRestored\":" + String(microphonesReady ? "true" : "false") + '}');
    return;
  }
  gpio_reset_pin(static_cast<gpio_num_t>(MIC_PDM_CLK));
  micClockHeld = false;
  micClockHeldLevel = -1;
  initMicrophones();
  const bool ok = microphonesReady;
  diagnosticServer.send(ok ? 200 : 500, "application/json",
    "{\"ok\":" + String(ok ? "true" : "false") +
    ",\"held\":false,\"pdmCaptureRestored\":" + String(ok ? "true" : "false") + '}');
}

void sendMicrophoneWav() {
  if (!microphonesReady) {
    diagnosticServer.send(503, "application/json", "{\"ok\":false,\"error\":\"microphones unavailable\"}");
    return;
  }
  // Explicit one-second capture; no always-on network audio stream.
  size_t bytes = 0;
  uint8_t *wav = microphoneI2s.recordWAV(1, &bytes);
  if (!wav || !bytes) {
    diagnosticServer.send(503, "application/json", "{\"ok\":false,\"error\":\"WAV capture failed\"}");
    return;
  }
  WiFiClient client = diagnosticServer.client();
  client.printf("HTTP/1.1 200 OK\r\nContent-Type: audio/wav\r\nContent-Length: %u\r\nCache-Control: no-store\r\n\r\n",
                static_cast<unsigned>(bytes));
  size_t written = 0;
  while (written < bytes && client.connected()) {
    const size_t chunk = min(static_cast<size_t>(1024), bytes - written);
    const size_t sent = client.write(wav + written, chunk);
    if (!sent) break;
    written += sent;
  }
  free(wav);
}

void sendSpeakerTest() {
  if (!speakerReady || speakerPcmStreaming) {
    diagnosticServer.send(503, "application/json", "{\"ok\":false,\"error\":\"speaker I2S unavailable\"}");
    return;
  }
  if (!ensureSpeakerAmpEnabled()) {
    diagnosticServer.send(503, "application/json", "{\"ok\":false,\"error\":\"speaker amplifier P4 enable failed\"}");
    return;
  }
  if (!speakerI2s.configureTX(SPEAKER_SAMPLE_RATE, I2S_DATA_BIT_WIDTH_16BIT,
                              I2S_SLOT_MODE_STEREO, I2S_STD_SLOT_BOTH)) {
    diagnosticServer.send(503, "application/json", "{\"ok\":false,\"error\":\"speaker sample rate unavailable\"}");
    return;
  }
  static constexpr uint16_t BLOCK_FRAMES = 256;
  static constexpr uint32_t TOTAL_FRAMES = SPEAKER_SAMPLE_RATE * SPEAKER_TONE_MS / 1000;
  static constexpr uint16_t FADE_FRAMES = SPEAKER_SAMPLE_RATE / 100;
  int16_t samples[BLOCK_FRAMES * 2];
  float phase = 0.0f;
  const float phaseStep = 2.0f * PI * SPEAKER_TONE_HZ / SPEAKER_SAMPLE_RATE;
  for (uint32_t start = 0; start < TOTAL_FRAMES; start += BLOCK_FRAMES) {
    const uint16_t frames = min(static_cast<uint32_t>(BLOCK_FRAMES), TOTAL_FRAMES - start);
    for (uint16_t i = 0; i < frames; ++i) {
      const uint32_t frame = start + i;
      float envelope = 1.0f;
      if (frame < FADE_FRAMES) envelope = static_cast<float>(frame) / FADE_FRAMES;
      else if (TOTAL_FRAMES - frame < FADE_FRAMES)
        envelope = static_cast<float>(TOTAL_FRAMES - frame) / FADE_FRAMES;
      const int16_t value = static_cast<int16_t>(SPEAKER_TONE_AMPLITUDE * envelope * sinf(phase));
      samples[2 * i] = value;
      samples[2 * i + 1] = value;
      phase += phaseStep;
      if (phase >= 2.0f * PI) phase -= 2.0f * PI;
    }
    const size_t bytes = frames * 2 * sizeof(int16_t);
    if (speakerI2s.write(reinterpret_cast<const uint8_t *>(samples), bytes) != bytes) {
      diagnosticServer.send(502, "application/json", "{\"ok\":false,\"error\":\"speaker I2S write failed\"}");
      return;
    }
  }
  diagnosticServer.send(200, "application/json",
    "{\"ok\":true,\"frequencyHz\":" + String(SPEAKER_TONE_HZ) +
    ",\"durationMs\":" + String(SPEAKER_TONE_MS) + "}");
}

void sendSpeakerChime() {
  if (speakerPcmStreaming) {
    diagnosticServer.send(503, "application/json", "{\"ok\":false,\"error\":\"speaker stream in progress\"}");
    return;
  }
  const bool played = playStartupChime();
  if (ledsReady) setStartupLeds(0, 0);
  String body = "{\"ok\":" + String(played ? "true" : "false");
  body += ",\"stage\":\"" + String(startupChimeStage) + "\"";
  body += ",\"bytesWritten\":" + String(startupChimeBytesWritten);
  body += ",\"i2sError\":" + String(startupChimeI2sError) + "}";
  diagnosticServer.send(played ? 200 : 503, "application/json", body);
}

void sendStartupSequence() {
  if (speakerPcmStreaming) {
    diagnosticServer.send(503, "application/json", "{\"ok\":false,\"error\":\"speaker stream in progress\"}");
    return;
  }
  const bool played = runStartupSequence();
  String body = "{\"ok\":" + String(played ? "true" : "false");
  body += ",\"stage\":\"" + String(startupChimeStage) + "\"";
  body += ",\"bytesWritten\":" + String(startupChimeBytesWritten);
  body += ",\"i2sError\":" + String(startupChimeI2sError) + "}";
  diagnosticServer.send(played ? 200 : 503, "application/json", body);
}

bool queueSpeakerPcm(const uint8_t *data, size_t bytes) {
  while (bytes) {
    SpeakerPcmChunk chunk;
    chunk.size = min(bytes, SPEAKER_CHUNK_BYTES);
    memcpy(chunk.data, data, chunk.size);
    if (xQueueSend(speakerQueue, &chunk, pdMS_TO_TICKS(2000)) != pdTRUE) return false;
    speakerPcmQueuedBytes += chunk.size;
    data += chunk.size;
    bytes -= chunk.size;
  }
  return true;
}

void receiveSpeakerPcm() {
  HTTPUpload &upload = diagnosticServer.upload();
  if (upload.status == UPLOAD_FILE_START) {
    if (speakerPcmStreaming) {
      speakerPcmUploadFailed = true;
      return;
    }
    speakerPcmQueuedBytes = 0;
    speakerPcmPlayedBytes = 0;
    speakerPcmPendingSize = 0;
    speakerPcmUploadComplete = false;
    speakerPcmUploadFailed = !prepareSpeakerPcmStream();
    if (!speakerPcmUploadFailed) speakerPcmStreaming = true;
  } else if (upload.status == UPLOAD_FILE_WRITE) {
    if (speakerPcmUploadFailed) return;
    const uint8_t *data = upload.buf;
    size_t remaining = upload.currentSize;
    if (speakerPcmPendingSize) {
      while (speakerPcmPendingSize < 4 && remaining) {
        speakerPcmPending[speakerPcmPendingSize++] = *data++;
        --remaining;
      }
      if (speakerPcmPendingSize == 4) {
        if (!queueSpeakerPcm(speakerPcmPending, 4)) speakerPcmUploadFailed = true;
        speakerPcmPendingSize = 0;
      }
    }
    const size_t aligned = remaining & ~static_cast<size_t>(3);
    if (!speakerPcmUploadFailed && aligned) {
      if (!queueSpeakerPcm(data, aligned)) speakerPcmUploadFailed = true;
    }
    data += aligned;
    remaining -= aligned;
    while (remaining) {
      speakerPcmPending[speakerPcmPendingSize++] = *data++;
      --remaining;
    }
  } else if (upload.status == UPLOAD_FILE_END) {
    speakerPcmUploadComplete = true;
  } else if (upload.status == UPLOAD_FILE_ABORTED) {
    speakerPcmUploadFailed = true;
    speakerPcmUploadComplete = true;
  }
}

void sendSpeakerPcm() {
  if (!speakerReady) {
    diagnosticServer.send(503, "application/json", "{\"ok\":false,\"error\":\"speaker I2S unavailable\"}");
    return;
  }
  if (!speakerAmpEnabled) {
    diagnosticServer.send(503, "application/json", "{\"ok\":false,\"error\":\"speaker amplifier P4 enable failed\"}");
    return;
  }
  speakerPcmUploadComplete = true;
  const uint32_t deadline = millis() + 5000;
  while (speakerPcmStreaming && millis() < deadline) delay(1);
  if (speakerPcmStreaming || speakerPcmUploadFailed || speakerPcmPendingSize || !speakerPcmQueuedBytes) {
    diagnosticServer.send(400, "application/json", "{\"ok\":false,\"error\":\"PCM missing, unaligned, or I2S write failed\"}");
    return;
  }
  diagnosticServer.send(200, "application/json",
    "{\"ok\":true,\"bytes\":" + String(speakerPcmPlayedBytes) +
    ",\"boardBufferBytes\":" + String(SPEAKER_BUFFER_CHUNKS * SPEAKER_CHUNK_BYTES) + "}");
}

bool parseByteArg(const char *name, uint8_t *out) {
  if (!diagnosticServer.hasArg(name)) return false;
  const String value = diagnosticServer.arg(name);
  if (value.isEmpty()) return false;
  for (size_t i = 0; i < value.length(); ++i) {
    if (!isDigit(value[i])) return false;
  }
  const long n = value.toInt();
  if (n < 0 || n > 255) return false;
  *out = static_cast<uint8_t>(n);
  return true;
}

void setLed() {
  uint8_t index, red, green, blue, white;
  if (!parseByteArg("index", &index) || index >= LED_COUNT ||
      !parseByteArg("r", &red) || !parseByteArg("g", &green) ||
      !parseByteArg("b", &blue) || !parseByteArg("w", &white)) {
    diagnosticServer.send(400, "application/json", "{\"ok\":false,\"error\":\"expected index=0..2 and r,g,b,w=0..255\"}");
    return;
  }
  ledValues[index][0] = red;
  ledValues[index][1] = green;
  ledValues[index][2] = blue;
  ledValues[index][3] = white;
  if (!showLeds()) {
    diagnosticServer.send(503, "application/json", "{\"ok\":false,\"error\":\"LED RMT unavailable\"}");
    return;
  }
  diagnosticServer.send(200, "application/json", "{\"ok\":true}");
}

void setup() {
  Serial.begin(115200);
  bootMs = millis();
  Serial.println("PSF Sensor Board v1.3 bring-up firmware");
  Wire.begin(I2C_SDA, I2C_SCL);
  Wire.setClock(400000);
  muteSpeakerAmpEarly();
  ledsReady = rmtInit(LED_PIN, RMT_TX_MODE, RMT_MEM_NUM_BLOCKS_1, 10000000);
  if (ledsReady) showLeds(); // all off at boot
  cameraReady = initCamera();
  connectWifi();
  // The sensor rail can come up after the ESP32's I2C peripheral. Configure
  // the expander only after Wi-Fi setup has given the board time to settle.
  initExpander();

  cameraServer.on("/health", HTTP_GET, sendHealth);
  cameraServer.on("/capture", HTTP_GET, sendCapture);
  cameraServer.on("/stream", HTTP_GET, sendStream);
  cameraServer.begin();
  xTaskCreatePinnedToCore(cameraTask, "camera-http", 8192, nullptr, 1, nullptr, 1);

  // Keep the camera reachable while the wide sensor loads its firmware over
  // I2C; this can take several seconds on the first initialization.
  initTofSensors();
  initImu();
  initMicrophones();
  initSpeaker();

  diagnosticServer.on("/diagnostics", HTTP_GET, sendDiagnostics);
  diagnosticServer.on("/ranges", HTTP_GET, sendRanges);
  diagnosticServer.on("/tof-mode", HTTP_GET, sendTofMode);
  diagnosticServer.on("/tof-mode", HTTP_POST, setTofMode);
  diagnosticServer.on("/wide-range", HTTP_GET, sendWideRange);
  diagnosticServer.on("/imu", HTTP_GET, sendImu);
  diagnosticServer.on("/mic-levels", HTTP_GET, sendMicrophoneLevels);
  diagnosticServer.on("/mic-pin-test", HTTP_GET, sendMicrophonePinTest);
  diagnosticServer.on("/mic-live-pull-test", HTTP_GET, sendMicrophoneLivePullTest);
  diagnosticServer.on("/mic-line-test", HTTP_GET, sendMicrophoneLineTest);
  diagnosticServer.on("/mic-raw-clock-test", HTTP_GET, sendMicrophoneRawClockTest);
  diagnosticServer.on("/mic-pcnt-test", HTTP_GET, sendMicrophonePcntTest);
  diagnosticServer.on("/mic-clock-low", HTTP_POST, holdMicrophoneClockLow);
  diagnosticServer.on("/mic-clock-high", HTTP_POST, holdMicrophoneClockHigh);
  diagnosticServer.on("/mic-clock-edges", HTTP_GET, sendMicrophoneHeldClockEdges);
  diagnosticServer.on("/mic-clock-restore", HTTP_POST, restoreMicrophoneClock);
  diagnosticServer.on("/mic-capture.wav", HTTP_GET, sendMicrophoneWav);
  diagnosticServer.on("/speaker-test", HTTP_POST, sendSpeakerTest);
  diagnosticServer.on("/speaker-chime", HTTP_POST, sendSpeakerChime);
  diagnosticServer.on("/startup-sequence", HTTP_POST, sendStartupSequence);
  diagnosticServer.on("/speaker-pcm", HTTP_POST, sendSpeakerPcm, receiveSpeakerPcm);
  diagnosticServer.on("/led", HTTP_GET, setLed);
  diagnosticServer.begin();
  Serial.printf("Camera port %u, diagnostics port %u\n", CAMERA_PORT, DIAGNOSTIC_PORT);
}

void loop() {
  diagnosticServer.handleClient();
  if (wideTofReady && millis() - wideLastPollAt >= 40) {
    wideLastPollAt = millis();
    if (wideTof.isDataReady() && wideTof.getRangingData(&wideResults)) {
      wideHasFrame = true;
      wideCapturedAt = millis();
    }
  }
  delay(2);
}
