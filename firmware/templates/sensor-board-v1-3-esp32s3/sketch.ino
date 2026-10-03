// PSF Sensor Board v1.3 bench bring-up firmware.
// Camera endpoints are on port 81; sensors and LED diagnostics are on port 82.
// Bounded Uno commands use the UART bridge; there is no IR collision guard.
// Uno replies and working microphone DATA remain unresolved.

#include <WiFi.h>
#include <WebServer.h>
#include <HardwareSerial.h>
#include <Wire.h>
#include <ESPmDNS.h>
#include <esp_camera.h>
#include <esp32-hal-rmt.h>
#include <esp32-hal-ledc.h>
#include <ESP_I2S.h>
#include <driver/gpio.h>
#include <soc/gpio_struct.h>
#include <soc/pcnt_periph.h>
#include <esp_timer.h>
#include <esp_heap_caps.h>
#include "src/mic_activity_types.h"
#include <soc/gpio_periph.h>
#include <soc/io_mux_reg.h>
#include <soc/i2s_struct.h>
#include "src/mic_trace_i2s/MicTraceI2S.h"
#include <esp_rom_gpio.h>
#include <soc/gpio_sig_map.h>
#include <driver/i2s_pdm.h>
#include <driver/pulse_cnt.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <freertos/task.h>
#include "src/vl53l1_class.h"
#include "narrow_tof_sample.h"
#include <Adafruit_VL53L5CX.h>
#include <math.h>
#include "startup_chime.h"

// Keep Wi-Fi and camera serving on core 0; sensor/control polling stays on core 1.
#if !defined(CONFIG_ESP_WIFI_TASK_PINNED_TO_CORE_0) || !CONFIG_ESP_WIFI_TASK_PINNED_TO_CORE_0
#error "Sensor Board v1.3 requires the Wi-Fi driver task pinned to core 0"
#endif
#if !defined(CONFIG_LWIP_TCPIP_TASK_AFFINITY_CPU0) || !CONFIG_LWIP_TCPIP_TASK_AFFINITY_CPU0
#error "Sensor Board v1.3 requires the TCP/IP task pinned to core 0"
#endif
#if !defined(CONFIG_CAMERA_CORE0) || !CONFIG_CAMERA_CORE0
#error "Sensor Board v1.3 requires the camera driver task pinned to core 0"
#endif
#if ARDUINO_RUNNING_CORE != 1
#error "Sensor Board v1.3 requires LoopCore=1 for sensor polling and packaging"
#endif
#if ARDUINO_EVENT_RUNNING_CORE != 0
#error "Sensor Board v1.3 requires EventsCore=0 for network events"
#endif

static const char *WIFI_SSID = "{{wifi.ssid}}";
static const char *WIFI_PASSWORD = "{{wifi.password}}";
static const char *MDNS_NAME = "{{mdns.name}}";
static const bool USE_STATIC_IP = {{wifi.useStatic}};
static const IPAddress STATIC_IP({{wifi.staticIp.octets}});
static const int STATIC_CIDR = {{wifi.staticCidr}};
static const char *FRAME_SIZE = "{{camera.frameSize}}";
static const int JPEG_QUALITY = {{camera.jpegQuality}};
static const bool CAMERA_MIRROR_DEFAULT = {{camera.hmirror}};

static constexpr uint8_t I2C_SDA = 2;
static constexpr uint8_t I2C_SCL = 1;
static constexpr uint8_t TCA9534_ADDRESS = 0x20;
static constexpr uint8_t SPEAKER_ENABLE_MASK = 0x10; // TCA9534 P4 -> MAX98357A SD_MODE#
static constexpr uint8_t FRONT_TOF_ADDRESS = 0x30;
static constexpr uint8_t REAR_TOF_ADDRESS = 0x31;
static constexpr uint32_t TOF_AUTO_RETRY_MS = 2000;
static constexpr uint8_t IMU_ADDRESS = 0x68;
static constexpr uint8_t IMU_WHO_AM_I = 0x61;
static constexpr uint32_t IMU_SAMPLE_INTERVAL_MS = 20;
static constexpr uint16_t IMU_CALIBRATION_SAMPLES = 80;
static constexpr float IMU_TILT_CORRECTION = 1.5f;
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
// 22.5% amplitude: 25% quieter than the previous 30% boot setting.
static constexpr uint16_t STARTUP_CHIME_GAIN_PERMILLE = 225;
static constexpr uint16_t STARTUP_CHIME_FADE_FRAMES = SPEAKER_SAMPLE_RATE / 50;

constexpr int16_t scaleStartupChimeSample(int16_t sample, int32_t fade) {
  return static_cast<int16_t>(static_cast<int64_t>(sample) *
    STARTUP_CHIME_GAIN_PERMILLE * fade / (1000 * STARTUP_CHIME_FADE_FRAMES));
}
static_assert(scaleStartupChimeSample(-10000, STARTUP_CHIME_FADE_FRAMES) == -2250,
  "startup chime gain must preserve negative samples");
static constexpr uint8_t LED_PIN = 48;
static constexpr uint8_t LED_COUNT = 3;
static constexpr uint8_t CAMERA_PORT = 81;
static constexpr uint8_t DIAGNOSTIC_PORT = 82;
static constexpr uint8_t SPEAKER_PORT = 83;
// Uno TX reaches GPIO44 through the 5 V-to-3.3 V divider; GPIO43 drives Uno RX.
static constexpr uint8_t UNO_UART_DEFAULT_RX = 44;
static constexpr uint8_t UNO_UART_DEFAULT_TX = 43;
static constexpr uint32_t UNO_UART_DEFAULT_BAUD = 9600;
static constexpr const char *UNO_RGB_OFF_FIELDS =
  ",\"D1\":0,\"D2\":0,\"D3\":0,\"D4\":0";

// GOOUUU ESP32-S3-CAM pin map; matches Espressif's BOARD_ESP32S3_GOOUUU.
// GPIO4 is camera SCCB data. The board's IR strobe switch must stay in its
// expander-controlled position while the camera is in use.
static constexpr int CAM_XCLK = 15, CAM_SDA = 4, CAM_SCL = 5;
static constexpr int CAM_D0 = 11, CAM_D1 = 9, CAM_D2 = 8, CAM_D3 = 10;
static constexpr int CAM_D4 = 12, CAM_D5 = 18, CAM_D6 = 17, CAM_D7 = 16;
static constexpr int CAM_VSYNC = 6, CAM_HREF = 7, CAM_PCLK = 13;

WebServer cameraServer(CAMERA_PORT);
WebServer diagnosticServer(DIAGNOSTIC_PORT);
WebServer speakerServer(SPEAKER_PORT);
SemaphoreHandle_t boardIoMutex = nullptr;
SemaphoreHandle_t speakerControlMutex = nullptr;
bool speakerHttpReady = false;
bool dedicatedSpeakerUploadAccepted = false;
bool legacySpeakerUploadAccepted = false;
bool cameraReady = false;
bool cameraMirrored = false;
bool expanderReady = false;
bool ledsReady = false;
bool frontTofReady = false;
bool rearTofReady = false;
bool wideTofReady = false;
bool imuReady = false;
bool microphonesReady = false;
String micGpio14PostEnable = "null";
uint32_t micGpio14PostEnableMs = 0;
bool micClockHeld = false;
int micClockHeldLevel = -1;
int micDataHeldLevel = -1; // weak pull only; clock stopped during DATA tests
bool micDataFloating = false;
bool micIndependentClockRunning = false;
i2s_chan_handle_t micComparisonRx = nullptr;
bool micComparisonRxEnabled = false;
uint8_t micComparisonPhase = 0; // 0 inactive, 1 clock-only, 2 RX enabled
uint32_t micComparisonPhaseAt = 0;
String micComparisonResult = "idle";
String micComparisonBefore = "null", micComparisonAfter = "null", micComparisonEnd = "null";
uint32_t micComparisonFirstDuration = 0, micComparisonSecondDuration = 0;
String micComparisonError;
bool micTraceRequested = false;
volatile bool micTraceRunning = false, micTraceAbort = false;
TaskHandle_t micTraceTask = nullptr;
SemaphoreHandle_t micTraceMutex = nullptr;
SemaphoreHandle_t micTraceProceed = nullptr;
bool micTraceWaiting = false;
uint32_t micTraceCheckpointAt = 0;
uint8_t micTraceCount = 0;
static constexpr uint8_t MIC_TRACE_CAPACITY = 40;
String micTraceLogs[MIC_TRACE_CAPACITY];
String micTraceState = "idle";
bool micActivityRequested = false;
volatile bool micActivityActive = false, micActivityStopRequested = false;
SemaphoreHandle_t micActivityMutex = nullptr, micActivityStopped = nullptr;
MicActivityCounter micActivityData, micActivityClock;
static constexpr uint16_t MIC_ACTIVITY_FIRST_CAPACITY = 512;
static constexpr uint16_t MIC_ACTIVITY_RECENT_CAPACITY = 128;
MicActivityBin micActivityFirst[MIC_ACTIVITY_FIRST_CAPACITY], micActivityRecent[MIC_ACTIVITY_RECENT_CAPACITY];
uint16_t micActivityFirstCount = 0, micActivityRecentCount = 0, micActivityRecentHead = 0;
uint32_t micActivityCounterClears = 0;
int64_t micActivityStartedUs = 0, micActivityLastNonzeroUs = 0;
int64_t micActivityDisableBeginUs = 0, micActivityDisableEndUs = 0;
uint64_t micActivityEdgesAtDisableBegin = 0, micActivityEdgesAtDisableEnd = 0;
String micActivityError, micActivityGpioBefore = "null", micActivityGpioAfter = "null";



bool speakerReady = false;
bool speakerAmpEnabled = false;
bool startupChimePlayed = false;
const char *startupChimeStage = "not-started";
size_t startupChimeBytesWritten = 0;
int startupChimeI2sError = 0;
int imuWhoAmI = -1;
uint32_t bootMs = 0;
uint8_t ledValues[LED_COUNT][4] = {};
VL53L1 frontTof(&Wire, -1);
VL53L1 rearTof(&Wire, -1);
VL53L1_DistanceModes frontTofMode = VL53L1_DISTANCEMODE_MEDIUM;
VL53L1_DistanceModes rearTofMode = VL53L1_DISTANCEMODE_MEDIUM;
bool frontTofAuto = true;
bool rearTofAuto = true;
uint32_t frontTofInvalidSince = 0;
uint32_t rearTofInvalidSince = 0;
NarrowTofSample frontTofSample, rearTofSample;
Adafruit_VL53L5CX wideTof;
MicTraceI2SClass microphoneI2s;
I2SClass speakerI2s;
HardwareSerial unoUart(1);
bool unoUartReady = false;
uint32_t unoUartBaud = UNO_UART_DEFAULT_BAUD;
uint8_t unoUartRxPin = UNO_UART_DEFAULT_RX;
uint8_t unoUartTxPin = UNO_UART_DEFAULT_TX;
uint32_t unoLastRxAt = 0;
uint16_t unoRequestId = 0;
String unoRecentRx;
String unoFrameBuffer;
String unoLastFrame;
bool unoDriveActive = false;
uint32_t unoDriveDeadline = 0;
uint8_t unoStartupLedClearsRemaining = 0;
uint32_t unoStartupLedNextAt = 0;
struct SpeakerPcmChunk {
  uint16_t size;
  uint8_t data[SPEAKER_CHUNK_BYTES];
};
QueueHandle_t speakerQueue = nullptr;
volatile uint32_t speakerPcmQueuedBytes = 0;
volatile uint32_t speakerPcmPlayedBytes = 0;
volatile bool speakerPcmStreaming = false;
volatile bool speakerPcmPreparing = false;
volatile bool speakerPcmUploadComplete = false;
volatile bool speakerPcmUploadFailed = false;
uint8_t speakerPcmPending[4] = {};
bool playStartupChime();
bool showLeds();
uint8_t speakerPcmPendingSize = 0;
VL53L5CX_ResultsData wideResults = {};
// Boot in Low Power; Helm can select a higher-rate profile when needed.
uint8_t wideResolution = 16;
uint8_t wideFrequencyHz = 2;
const char *wideProfile = "idle";
bool wideAutonomous = true;
uint32_t wideFrameSequence = 0;
uint32_t wideFramePeriodMs = 0;
bool wideHasFrame = false;
uint32_t wideCapturedAt = 0;
uint32_t wideLastPollAt = 0;

struct ImuSample {
  int16_t temperature = 0;
  int16_t accel[3] = {};
  int16_t gyro[3] = {};
  uint32_t sampledAt = 0;
  bool valid = false;
};
ImuSample imuSample;
uint32_t imuLastPollAt = 0;
uint16_t imuCalibrationCount = 0;
float imuGyroSum[3] = {};
float imuAccelSum[3] = {};
float imuGyroBias[3] = {};
float imuGravityReference[3] = {0.0f, 0.0f, 1.0f};
float imuOrientation[4] = {1.0f, 0.0f, 0.0f, 0.0f}; // body-to-boot-frame quaternion
bool imuOrientationReady = false;
uint32_t imuIntegrationAt = 0;

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

// Read hardware configuration without changing direction, pulls, or routing.
String readMicrophoneGpio(uint8_t pin) {
  gpio_io_config_t config = {};
  const esp_err_t error = gpio_get_io_config(static_cast<gpio_num_t>(pin), &config);
  if (error != ESP_OK) return "{\"ok\":false,\"error\":\"" + String(esp_err_to_name(error)) + "\"}";
  String body = "{\"ok\":true,\"pin\":" + String(pin);
  const char *direction = config.ie ? (config.oe ? "input-output" : "input") : (config.oe ? "output" : "disabled");
  body += ",\"direction\":\"" + String(direction) + "\"";
  body += ",\"inputEnable\":" + String(config.ie ? "true" : "false");
  body += ",\"outputEnable\":" + String(config.oe ? "true" : "false");
  body += ",\"pullUp\":" + String(config.pu ? "true" : "false");
  body += ",\"pullDown\":" + String(config.pd ? "true" : "false");
  body += ",\"iomuxRaw\":" + String(REG_READ(GPIO_PIN_MUX_REG[pin]));
  body += ",\"gpioPinRaw\":" + String(GPIO.pin[pin].val);
  body += ",\"outputMatrixRaw\":" + String(GPIO.func_out_sel_cfg[pin].val);
  body += ",\"iomuxFunction\":" + String(config.fun_sel);
  body += ",\"outputSignalIndex\":" + String(config.sig_out);
  body += ",\"outputEnableControlledByPeripheral\":" + String(config.oe_ctrl_by_periph ? "true" : "false");
  body += ",\"outputEnableInverted\":" + String(config.oe_inv ? "true" : "false");
  body += ",\"gpioOutputEnableBit\":" + String((GPIO.enable >> pin) & 1U);
  if (pin == MIC_PDM_DATA) body += ",\"expectedI2s0DataSignalIndex\":" + String(I2S0I_SD_IN_IDX);
  body += ",\"inputMatrixSignals\":[";
  bool first = true;
  for (uint16_t index = 0; index < 256; ++index) {
    const uint32_t raw = GPIO.func_in_sel_cfg[index].val;
    if (!(raw & (1U << 7)) || (raw & 0x3fU) != pin) continue;
    if (!first) body += ',';
    first = false;
    body += "{\"signalIndex\":" + String(index);
    body += ",\"inverted\":" + String((raw & (1U << 6)) ? "true" : "false");
    body += ",\"rawRegister\":" + String(raw) + '}';
  }
  body += "]}";
  return body;
}

String readMicrophoneDataGpio() { return readMicrophoneGpio(MIC_PDM_DATA); }

void sendMicrophoneGpio() {
  String body = "{\"ok\":true,\"postEnableCapturedMs\":" + String(micGpio14PostEnableMs);
  body += ",\"postEnable\":" + micGpio14PostEnable;
  body += ",\"current\":" + readMicrophoneDataGpio() + '}';
  diagnosticServer.send(200, "application/json", body);
}


String readMicrophoneRestoreHardware() {
  String body = "{\"gpio14\":" + readMicrophoneDataGpio();
  body += ",\"gpio21\":" + readMicrophoneGpio(MIC_PDM_CLK);
  body += ",\"i2s0\":{\"rxConfRaw\":" + String(I2S0.rx_conf.val);
  body += ",\"rxConf1Raw\":" + String(I2S0.rx_conf1.val);
  body += ",\"clockConfRaw\":" + String(I2S0.rx_clkm_conf.val);
  body += ",\"clockDivRaw\":" + String(I2S0.rx_clkm_div_conf.val);
  body += ",\"slotMaskRaw\":" + String(I2S0.rx_tdm_ctrl.val);
  body += ",\"timingRaw\":" + String(I2S0.rx_timing.val);
  body += ",\"rxStart\":" + String(I2S0.rx_conf.rx_start);
  body += ",\"slave\":" + String(I2S0.rx_conf.rx_slave_mod);
  body += ",\"pdmEnabled\":" + String(I2S0.rx_conf.rx_pdm_en);
  body += ",\"pdmToPcmEnabled\":" + String(I2S0.rx_conf.rx_pdm2pcm_en);
  body += ",\"decimation16S\":" + String(I2S0.rx_conf.rx_pdm_sinc_dsr_16_en);
  body += ",\"mono\":" + String(I2S0.rx_conf.rx_mono);
  body += ",\"dataBits\":" + String(I2S0.rx_conf1.rx_bits_mod + 1);
  body += ",\"slotBits\":" + String(I2S0.rx_conf1.rx_tdm_chan_bits + 1);
  body += ",\"clockActive\":" + String(I2S0.rx_clkm_conf.rx_clk_active);
  body += ",\"clockSourceSelector\":" + String(I2S0.rx_clkm_conf.rx_clk_sel);
  body += ",\"clockDividerInteger\":" + String(I2S0.rx_clkm_conf.rx_clkm_div_num);
  body += ",\"clockDividerX\":" + String(I2S0.rx_clkm_div_conf.rx_clkm_div_x);
  body += ",\"clockDividerY\":" + String(I2S0.rx_clkm_div_conf.rx_clkm_div_y);
  body += ",\"clockDividerZ\":" + String(I2S0.rx_clkm_div_conf.rx_clkm_div_z);
  body += ",\"clockDividerYn1\":" + String(I2S0.rx_clkm_div_conf.rx_clkm_div_yn1);
  body += ",\"bckDivider\":" + String(I2S0.rx_conf1.rx_bck_div_num + 1) + '}';
  i2s_chan_handle_t handle = micComparisonRx ? micComparisonRx : microphoneI2s.rxChan();
  body += ",\"driver\":";
  if (!handle) body += "null";
  else {
    i2s_chan_info_t info = {};
    const esp_err_t error = i2s_channel_get_info(handle, &info);
    body += "{\"queryError\":\"" + String(esp_err_to_name(error)) + "\"";
    if (error == ESP_OK) {
      body += ",\"port\":" + String(static_cast<int>(info.id));
      body += ",\"role\":" + String(static_cast<int>(info.role));
      body += ",\"mode\":" + String(static_cast<int>(info.mode));
      body += ",\"direction\":" + String(static_cast<int>(info.dir));
      body += ",\"enabled\":" + String(info.is_enabled ? "true" : "false");
      body += ",\"initialized\":" + String(info.mode_cfg ? "true" : "false");
      body += ",\"dmaBytes\":" + String(info.total_dma_buf_size);
      body += ",\"clockSource\":" + String(static_cast<int>(info.clk_src));
      body += ",\"sourceHz\":" + String(info.sclk_hz);
      body += ",\"mclkHz\":" + String(info.mclk_hz);
      body += ",\"bclkHz\":" + String(info.bclk_hz);
      if (info.mode_cfg && info.mode == I2S_COMM_MODE_PDM && info.dir == I2S_DIR_RX) {
        const auto *config = static_cast<const i2s_pdm_rx_config_t *>(info.mode_cfg);
        body += ",\"sampleRate\":" + String(config->clk_cfg.sample_rate_hz);
        body += ",\"decimation\":" + String(static_cast<int>(config->clk_cfg.dn_sample_mode));
        body += ",\"slotMode\":" + String(static_cast<int>(config->slot_cfg.slot_mode));
        body += ",\"slotMask\":" + String(static_cast<int>(config->slot_cfg.slot_mask));
        body += ",\"dataBits\":" + String(static_cast<int>(config->slot_cfg.data_bit_width));
        body += ",\"clockPin\":" + String(static_cast<int>(config->gpio_cfg.clk));
        body += ",\"dataPin\":" + String(static_cast<int>(config->gpio_cfg.din));
        body += ",\"clockInverted\":" + String(config->gpio_cfg.invert_flags.clk_inv ? "true" : "false");
      }
    }
    body += '}';
  }
  body += ",\"wrapper\":{\"rxSampleRate\":" + String(microphoneI2s.rxSampleRate());
  body += ",\"rxDataWidth\":" + String(static_cast<int>(microphoneI2s.rxDataWidth()));
  body += ",\"rxSlotMode\":" + String(static_cast<int>(microphoneI2s.rxSlotMode())) + '}';
  body += ",\"independentClockHz\":" + String(micIndependentClockRunning ? ledcReadFreq(MIC_PDM_CLK) : 0) + '}';
  return body;
}

// Called only AFTER an operation has returned, including calls inside begin().
// Normal boot/restore does not pause: only the opt-in trace task activates it.
void psfMicRestoreCheckpoint(void *owner, const char *operation, int result) {
  if (!micTraceRunning || xTaskGetCurrentTaskHandle() != micTraceTask || micTraceAbort) return;
  if (owner && owner != &microphoneI2s) return;
  const bool activityBaseline = micActivityRequested && String(operation) == "baseline: end of Phase 2 before restore";
  if (activityBaseline) {
    micActivityRequested = false;
    if (!startMicrophoneActivityMonitor()) {
      micTraceAbort = true;
      return;
    }
    delay(100); // collect a pre-disable baseline with counters already running
  }
  const String hardware = readMicrophoneRestoreHardware();
  xSemaphoreTake(micTraceMutex, portMAX_DELAY);
  if (micTraceCount >= MIC_TRACE_CAPACITY) {
    micTraceAbort = true;
    micTraceState = "log-capacity-exceeded";
    xSemaphoreGive(micTraceMutex);
    return;
  }
  const uint8_t index = micTraceCount++;
  micTraceLogs[index] = "{\"step\":" + String(index) + ",\"operation\":\"" + String(operation);
  micTraceLogs[index] += "\",\"returnValue\":" + String(result);
  micTraceLogs[index] += ",\"capturedMs\":" + String(millis()) + ",\"hardware\":" + hardware + '}';
  micTraceCheckpointAt = millis();
  micTraceWaiting = !activityBaseline;
  micTraceState = activityBaseline ? "advancing-to-rx-off" : "paused";
  xSemaphoreGive(micTraceMutex);
  if (activityBaseline) return; // only checkpoint 0; checkpoint 1 still waits indefinitely
  // No timeout: operator has as long as needed to read the meter.
  xSemaphoreTake(micTraceProceed, portMAX_DELAY);
}

void initMicrophones() {
  // The two MSM261DHP006 parts share clock/data and have opposite L/R straps.
  // GPIO21/GPIO14 follow the v1.3 schematic, not the older Rev A notes.
  microphoneI2s.setPinsPdmRx(MIC_PDM_CLK, MIC_PDM_DATA);
  psfMicRestoreCheckpoint(nullptr, "setPinsPdmRx(GPIO21,GPIO14)", 0);
  microphoneI2s.setTimeout(1000);
  psfMicRestoreCheckpoint(nullptr, "setTimeout(1000)", 0);
  microphonesReady = microphoneI2s.begin(I2S_MODE_PDM_RX, MIC_SAMPLE_RATE,
    I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_STEREO);
  psfMicRestoreCheckpoint(nullptr, "begin(PDM_RX,16000,16bit,stereo) returned", microphonesReady);
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
  psfMicRestoreCheckpoint(nullptr, "disable normal master RX", stopped);
  if (stopped != ESP_OK) {
    microphonesReady = false;
    Serial.printf("PDM clock reconfiguration stop failed: %s\n", esp_err_to_name(stopped));
    return;
  }
  const esp_err_t configured = i2s_channel_reconfig_pdm_rx_clock(rx, &clockConfig);
  psfMicRestoreCheckpoint(nullptr, "reconfigure normal clock to 16S / 2.048MHz", configured);
  const esp_err_t started = i2s_channel_enable(rx);
  psfMicRestoreCheckpoint(nullptr, "enable normal master RX at 2.048MHz", started);
  if (started == ESP_OK) {
    micGpio14PostEnable = readMicrophoneDataGpio();
    micGpio14PostEnableMs = millis();
    Serial.printf("GPIO14 immediately after PDM RX enable: %s\n", micGpio14PostEnable.c_str());
  }
  microphonesReady = configured == ESP_OK && started == ESP_OK;
  Serial.printf("PDM microphones ready=%d clock=%lu Hz config=%s start=%s\n",
    microphonesReady, static_cast<unsigned long>(MIC_PDM_CLOCK_HZ),
    esp_err_to_name(configured), esp_err_to_name(started));
}

void speakerPlaybackTask(void *) {
  SpeakerPcmChunk chunk;
  bool started = false;
  for (;;) {
    if (!speakerPcmStreaming || speakerPcmPreparing) {
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

VL53L1_Error configureNarrowPhase(VL53L1 &sensor, NarrowTofSample &sample,
                                  VL53L1_DistanceModes fullMode,
                                  bool quadrants, bool stopFirst) {
  VL53L1_Error error = VL53L1_ERROR_NONE;
  if (stopFirst) {
    error = sensor.VL53L1_StopMeasurement();
    if (error != VL53L1_ERROR_NONE) return error;
  }
  error = sensor.VL53L1_SetPresetMode(quadrants ?
    VL53L1_PRESETMODE_MULTIZONES_SCANNING : VL53L1_PRESETMODE_RANGING);
  if (error != VL53L1_ERROR_NONE) return error;
  error = sensor.VL53L1_SetDistanceMode(quadrants ?
    VL53L1_DISTANCEMODE_SHORT : fullMode);
  if (error != VL53L1_ERROR_NONE) return error;
  VL53L1_RoiConfig_t roi = {};
  if (quadrants) {
    roi.NumberOfRoi = 4;
    roi.UserRois[0] = {0, 15, 7, 8};  // upper-left SPAD quadrant
    roi.UserRois[1] = {8, 15, 15, 8}; // upper-right
    roi.UserRois[2] = {0, 7, 7, 0};   // lower-left
    roi.UserRois[3] = {8, 7, 15, 0};  // lower-right
  } else {
    roi.NumberOfRoi = 1;
    roi.UserRois[0] = {0, 15, 15, 0}; // full 16x16 SPAD field
  }
  error = sensor.VL53L1_SetROI(&roi);
  if (error != VL53L1_ERROR_NONE) return error;
  error = sensor.VL53L1_SetOutputMode(VL53L1_OUTPUTMODE_NEAREST);
  if (error != VL53L1_ERROR_NONE) return error;
  error = sensor.VL53L1_SetMeasurementTimingBudgetMicroSeconds(
    quadrants ? 50000 : 100000);
  if (error != VL53L1_ERROR_NONE) return error;
  error = sensor.VL53L1_StartMeasurement();
  if (error == VL53L1_ERROR_NONE) {
    sample.scanningQuadrants = quadrants;
    sample.phaseFrames = 0;
    sample.phaseStartedAt = millis();
    sample.lastDataAt = sample.phaseStartedAt;
  }
  return error;
}

bool initNarrowTof(VL53L1 &sensor, NarrowTofSample &sample, uint8_t pinMask,
                   uint8_t address, uint8_t *activePins) {
  const uint8_t enabled = 0x08 | *activePins | pinMask;
  if (!writeExpander(0x01, enabled)) return false;
  delay(20);
  sensor.begin();
  // The ST CB API takes an 8-bit I2C address; Helm stores 7-bit addresses.
  const VL53L1_Error initError = sensor.InitSensor(address << 1);
  if (initError != VL53L1_ERROR_NONE) {
    Serial.printf("VL53L1CB 0x%02x init error %d\n", address, initError);
    writeExpander(0x01, 0x08 | *activePins);
    return false;
  }
  if (!i2cPresent(address) ||
      configureNarrowPhase(sensor, sample, VL53L1_DISTANCEMODE_MEDIUM,
        false, false) != VL53L1_ERROR_NONE) {
    Serial.printf("VL53L1CB 0x%02x ranging setup failed\n", address);
    writeExpander(0x01, 0x08 | *activePins);
    return false;
  }
  *activePins |= pinMask;
  return true;
}

void initTofSensors() {
  if (!expanderReady) return;
  uint8_t activePins = 0;
  frontTofReady = initNarrowTof(frontTof, frontTofSample, 0x01, FRONT_TOF_ADDRESS, &activePins);
  rearTofReady = initNarrowTof(rearTof, rearTofSample, 0x02, REAR_TOF_ADDRESS, &activePins);

  // The wide sensor retains the default address while the two narrow parts
  // stay powered at 0x30/0x31. P2 high + P3 low was confirmed on the bench.
  if (!writeExpander(0x01, activePins | 0x04)) return;
  delay(100);
  if (!i2cPresent(0x29)) return;
  wideTofReady = wideTof.begin(0x29, &Wire, 400000) &&
    wideTof.setResolution(wideResolution) &&
    wideTof.setRangingFrequency(wideFrequencyHz) &&
    wideTof.setTargetOrder(VL53L5CX_TARGET_ORDER_STRONGEST) &&
    wideTof.setRangingMode(wideAutonomous ? VL53L5CX_RANGING_MODE_AUTONOMOUS : VL53L5CX_RANGING_MODE_CONTINUOUS) &&
    (!wideAutonomous || wideTof.setIntegrationTime(5)) &&
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
  if (err != ESP_OK) {
    Serial.printf("Camera init failed: 0x%x\n", err);
    return false;
  }
  sensor_t *sensor = esp_camera_sensor_get();
  if (sensor && sensor->set_hmirror &&
      sensor->set_hmirror(sensor, CAMERA_MIRROR_DEFAULT ? 1 : 0) == 0) {
    cameraMirrored = CAMERA_MIRROR_DEFAULT;
  } else {
    Serial.println("Camera horizontal mirror setting failed");
  }
  return true;
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
  body += ",\"firmware\":\"bring-up-11\",\"uptimeMs\":" + String(millis() - bootMs);
  body += ",\"cameraReady\":" + String(cameraReady ? "true" : "false");
  body += ",\"cameraMirrored\":" + String(cameraMirrored ? "true" : "false");
  body += ",\"expanderReady\":" + String(expanderReady ? "true" : "false");
  body += ",\"frontTofReady\":" + String(frontTofReady ? "true" : "false");
  body += ",\"rearTofReady\":" + String(rearTofReady ? "true" : "false");
  body += ",\"wideTofReady\":" + String(wideTofReady ? "true" : "false");
  body += ",\"imuReady\":" + String(imuReady ? "true" : "false");
  body += ",\"micLineTestActive\":" + String(micClockHeld ? "true" : "false");
  body += ",\"micDataPullLevel\":" + String(micDataHeldLevel);
  body += ",\"micClockHeldLevel\":" + String(micClockHeldLevel);
  body += ",\"microphonesReady\":" + String(microphonesReady ? "true" : "false");
  body += ",\"speakerReady\":" + String(speakerReady ? "true" : "false");
  body += ",\"speakerPort\":" + String(speakerHttpReady ? SPEAKER_PORT : DIAGNOSTIC_PORT);
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
  body += ",\"micLineTestActive\":" + String(micClockHeld ? "true" : "false");
  body += ",\"micDataPullLevel\":" + String(micDataHeldLevel);
  body += ",\"micClockHeldLevel\":" + String(micClockHeldLevel);
  body += ",\"microphonesReady\":" + String(microphonesReady ? "true" : "false");
  body += ",\"speakerReady\":" + String(speakerReady ? "true" : "false");
  body += ",\"speakerPort\":" + String(speakerHttpReady ? SPEAKER_PORT : DIAGNOSTIC_PORT);
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

void setCameraMirror() {
  const String enabled = diagnosticServer.arg("enabled");
  if (enabled != "0" && enabled != "1") {
    diagnosticServer.send(400, "application/json",
      "{\"ok\":false,\"error\":\"enabled must be 0 or 1\"}");
    return;
  }
  sensor_t *sensor = cameraReady ? esp_camera_sensor_get() : nullptr;
  if (!sensor || !sensor->set_hmirror ||
      sensor->set_hmirror(sensor, enabled == "1" ? 1 : 0) != 0) {
    diagnosticServer.send(503, "application/json",
      "{\"ok\":false,\"error\":\"camera mirror control unavailable\"}");
    return;
  }
  cameraMirrored = enabled == "1";
  diagnosticServer.send(200, "application/json",
    "{\"ok\":true,\"cameraMirrored\":" +
    String(cameraMirrored ? "true" : "false") + "}");
}

const char *tofModeName(VL53L1_DistanceModes mode) {
  switch (mode) {
    case VL53L1_DISTANCEMODE_SHORT: return "short";
    case VL53L1_DISTANCEMODE_MEDIUM: return "medium";
    case VL53L1_DISTANCEMODE_LONG: return "long";
    default: return "unknown";
  }
}

VL53L1_DistanceModes nextTofMode(VL53L1_DistanceModes mode) {
  return mode == VL53L1_DISTANCEMODE_SHORT ? VL53L1_DISTANCEMODE_MEDIUM :
    mode == VL53L1_DISTANCEMODE_MEDIUM ? VL53L1_DISTANCEMODE_LONG :
    VL53L1_DISTANCEMODE_SHORT;
}

VL53L1_Error switchNarrowTofMode(VL53L1 &sensor, NarrowTofSample &sample,
                                 VL53L1_DistanceModes mode) {
  // A quadrant scan always uses Short; a requested full-field mode takes
  // effect at the next full-field phase without aborting the current scan.
  if (sample.scanningQuadrants) return VL53L1_ERROR_NONE;
  const VL53L1_Error error = configureNarrowPhase(sensor, sample, mode, false, true);
  if (error == VL53L1_ERROR_NONE) sample.zones[0].hasFrame = false;
  return error;
}

bool sameNarrowDistance(uint16_t first, uint16_t second) {
  const uint32_t difference = first > second ? first - second : second - first;
  const uint32_t tenth = first / 10;
  const uint32_t tolerance = tenth > 50 ? tenth : 50;
  return difference <= tolerance;
}

void updateNarrowZone(NarrowTofZone &zone, const VL53L1_MultiRangingData_t &results,
                      bool preferStrongest) {
  const uint32_t now = millis();
  zone.targetCount = results.NumberOfObjectsFound < 4 ? results.NumberOfObjectsFound : 4;
  zone.rangeStatus = -1;
  zone.distanceMm = 0;
  zone.signalRate = 0;
  for (uint8_t i = 0; i < zone.targetCount; ++i) {
    const auto &target = results.RangeData[i];
    zone.targets[i] = {target.RangeMilliMeter, target.RangeStatus,
      target.SignalRateRtnMegaCps};
    if (zone.rangeStatus == -1) zone.rangeStatus = target.RangeStatus;
    if (target.RangeStatus != VL53L1_RANGESTATUS_RANGE_VALID ||
        target.RangeMilliMeter == 0) continue;
    if (zone.distanceMm == 0 ||
        (preferStrongest ? target.SignalRateRtnMegaCps > zone.signalRate :
          target.RangeMilliMeter < zone.distanceMm)) {
      zone.distanceMm = target.RangeMilliMeter;
      zone.signalRate = target.SignalRateRtnMegaCps;
      zone.rangeStatus = target.RangeStatus;
    }
  }
  zone.sampledAt = now;
  zone.hasFrame = true;
  if (zone.rangeStatus != VL53L1_RANGESTATUS_RANGE_VALID || zone.distanceMm == 0) {
    zone.pendingCount = 0;
    return;
  }
  if (zone.hasStable && sameNarrowDistance(zone.stableDistanceMm, zone.distanceMm)) {
    zone.stableDistanceMm = zone.distanceMm;
    zone.stableAt = now;
    zone.pendingCount = 0;
  } else if (zone.pendingCount > 0 &&
             sameNarrowDistance(zone.pendingDistanceMm, zone.distanceMm)) {
    zone.stableDistanceMm = (zone.pendingDistanceMm + zone.distanceMm) / 2;
    zone.stableAt = now;
    zone.hasStable = true;
    zone.pendingCount = 0;
  } else {
    zone.pendingDistanceMm = zone.distanceMm;
    zone.pendingCount = 1;
  }
}

void pollNarrowTof(VL53L1 &sensor, bool ready, NarrowTofSample &sample,
                   VL53L1_DistanceModes &mode, bool automatic,
                   uint32_t &invalidSince) {
  if (!ready || millis() - sample.lastPollAt < 40) return;
  sample.lastPollAt = millis();
  // An interrupted or misaligned ROI cycle can stop producing fresh frames
  // while the driver still reports no error. Restart in the full-field phase.
  if (sample.phaseStartedAt &&
      (millis() - sample.lastDataAt > 1500 ||
       millis() - sample.phaseStartedAt > 2500)) {
    const VL53L1_Error recovery = configureNarrowPhase(sensor, sample, mode, false, true);
    sample.driverError = recovery;
    if (sample.recoveryCount < UINT16_MAX) ++sample.recoveryCount;
    return;
  }
  uint8_t dataReady = 0;
  VL53L1_Error error = sensor.VL53L1_GetMeasurementDataReady(&dataReady);
  if (error == VL53L1_ERROR_NONE && dataReady) {
    VL53L1_MultiRangingData_t results = {};
    error = sensor.VL53L1_GetMultiRangingData(&results);
    if (error == VL53L1_ERROR_NONE) {
      sample.lastDataAt = millis();
      if (sample.phaseFrames < 255) ++sample.phaseFrames;
      const uint8_t roi = sample.scanningQuadrants ? results.RoiNumber + 1 : 0;
      const bool warmed = sample.scanningQuadrants ? sample.phaseFrames > 4 :
        sample.phaseFrames > 1;
      if (warmed && roi < 5) updateNarrowZone(sample.zones[roi], results, roi == 0);
    }
    const bool phaseDone = error == VL53L1_ERROR_NONE &&
      (sample.scanningQuadrants ?
        (sample.phaseFrames >= 8 && results.RoiNumber == 3) : sample.phaseFrames >= 2);
    const VL53L1_Error restart = phaseDone ?
      configureNarrowPhase(sensor, sample, mode, !sample.scanningQuadrants, true) :
      sensor.VL53L1_ClearInterruptAndStartMeasurement();
    if (error == VL53L1_ERROR_NONE) error = restart;
  }
  sample.driverError = error;
  const NarrowTofZone &full = sample.zones[0];
  const bool valid = full.hasFrame && full.rangeStatus == VL53L1_RANGESTATUS_RANGE_VALID &&
    full.distanceMm > 0 && millis() - full.sampledAt < 1500 && error == VL53L1_ERROR_NONE;
  if (!automatic) return;
  if (valid) {
    invalidSince = 0;
  } else if (invalidSince == 0) {
    invalidSince = millis();
  } else if (millis() - invalidSince >= TOF_AUTO_RETRY_MS) {
    const VL53L1_DistanceModes candidate = nextTofMode(mode);
    if (switchNarrowTofMode(sensor, sample, candidate) == VL53L1_ERROR_NONE) {
      mode = candidate;
      sample.modeChanged = true;
    }
    invalidSince = millis();
  }
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
    const VL53L1_DistanceModes selected = mode == "short" ? VL53L1_DISTANCEMODE_SHORT :
      mode == "medium" ? VL53L1_DISTANCEMODE_MEDIUM : VL53L1_DISTANCEMODE_LONG;
    if ((useFront && switchNarrowTofMode(frontTof, frontTofSample, selected) != VL53L1_ERROR_NONE) ||
        (useRear && switchNarrowTofMode(rearTof, rearTofSample, selected) != VL53L1_ERROR_NONE)) {
      diagnosticServer.send(503, "application/json", "{\"ok\":false,\"error\":\"ToF mode switch failed\"}");
      return;
    }
    if (useFront) { frontTofMode = selected; frontTofAuto = false; frontTofInvalidSince = 0; }
    if (useRear) { rearTofMode = selected; rearTofAuto = false; rearTofInvalidSince = 0; }
  }
  diagnosticServer.send(200, "application/json", tofModesJson());
}

void appendNarrowRange(String &body, const char *name, bool ready,
                       VL53L1_DistanceModes mode, bool automatic,
                       NarrowTofSample &sample) {
  const NarrowTofZone &full = sample.zones[0];
  const uint32_t age = full.hasFrame ? millis() - full.sampledAt : 0;
  const bool timedOut = !full.hasFrame || age >= 2000 || sample.driverError != VL53L1_ERROR_NONE;
  const bool valid = ready && !timedOut &&
    full.rangeStatus == VL53L1_RANGESTATUS_RANGE_VALID && full.distanceMm > 0;
  body += "{\"name\":\"" + String(name) + "\",\"ready\":";
  body += ready ? "true" : "false";
  body += ",\"timeout\":";
  body += timedOut ? "true" : "false";
  body += ",\"rangeStatus\":" + String(full.rangeStatus);
  body += ",\"mode\":\"" + String(tofModeName(mode)) + "\"";
  body += ",\"activeMode\":\"" + String(tofModeName(mode)) + "\"";
  body += ",\"auto\":" + String(automatic ? "true" : "false");
  body += ",\"modeChanged\":" + String(sample.modeChanged ? "true" : "false");
  body += ",\"ageMs\":" + (full.hasFrame ? String(age) : "null");
  body += ",\"driverError\":" + String(sample.driverError);
  body += ",\"recoveryCount\":" + String(sample.recoveryCount);
  body += ",\"distanceMm\":";
  body += valid ? String(full.distanceMm) : "null";
  body += ",\"scan\":{\"phase\":\"";
  body += sample.scanningQuadrants ? "quadrants\"" : "full\"";
  body += ",\"quadrantMode\":\"short\",\"orientationVerified\":false,\"zones\":[";
  const char *zoneIds[5] = {"full", "upper-left", "upper-right", "lower-left", "lower-right"};
  for (uint8_t index = 0; index < 5; ++index) {
    if (index) body += ',';
    const NarrowTofZone &zone = sample.zones[index];
    const uint32_t zoneAge = zone.hasFrame ? millis() - zone.sampledAt : 0;
    body += "{\"id\":\"" + String(zoneIds[index]) + "\",\"ageMs\":";
    body += zone.hasFrame ? String(zoneAge) : "null";
    body += ",\"rangeStatus\":" + String(zone.rangeStatus);
    body += ",\"distanceMm\":";
    body += zone.hasFrame && zone.rangeStatus == VL53L1_RANGESTATUS_RANGE_VALID ?
      String(zone.distanceMm) : "null";
    body += ",\"stableDistanceMm\":";
    body += zone.hasStable ? String(zone.stableDistanceMm) : "null";
    body += ",\"stableAgeMs\":";
    body += zone.hasStable ? String(millis() - zone.stableAt) : "null";
    body += ",\"targets\":[";
    for (uint8_t targetIndex = 0; targetIndex < zone.targetCount; ++targetIndex) {
      if (targetIndex) body += ',';
      const NarrowTofTarget &target = zone.targets[targetIndex];
      body += "{\"distanceMm\":" + String(target.distanceMm);
      body += ",\"rangeStatus\":" + String(target.rangeStatus);
      body += ",\"signalMcps\":" + String(target.signalRate / 65536.0f, 2) + '}';
    }
    body += "]}";
  }
  body += "]}";
  body += '}';
  sample.modeChanged = false;
}

void sendRanges() {
  String body;
  body.reserve(4500);
  body = "{\"ok\":true,\"singleZone\":[";
  appendNarrowRange(body, "front", frontTofReady,
    frontTofMode, frontTofAuto, frontTofSample);
  body += ',';
  appendNarrowRange(body, "rear", rearTofReady,
    rearTofMode, rearTofAuto, rearTofSample);
  body += "],\"wideReady\":" + String(wideTofReady ? "true" : "false");
  body += ",\"rssi\":" + String(WiFi.RSSI()) + '}';
  diagnosticServer.send(200, "application/json", body);
}

String wideResolutionJson(bool ok) {
  return "{\"ok\":" + String(ok ? "true" : "false") +
    ",\"ready\":" + String(wideTofReady && wideHasFrame ? "true" : "false") +
    ",\"resolution\":" + String(wideResolution) +
    ",\"resolutionControlVersion\":1,\"profileControlVersion\":1,\"profile\":\"" + String(wideProfile) +
    "\",\"frequencyHz\":" + String(wideFrequencyHz) +
    ",\"rangingMode\":\"" + String(wideAutonomous ? "autonomous" : "continuous") +
    "\",\"targetOrder\":\"strongest\",\"integrationMs\":" + String(wideAutonomous ? "5" : "null") + "}";
}

void sendWideResolution() {
  diagnosticServer.send(200, "application/json", wideResolutionJson(wideTofReady));
}

void setWideResolution() {
  String profile = diagnosticServer.arg("profile");
  if (profile.isEmpty()) {
    const String requested = diagnosticServer.arg("resolution");
    if (requested == "16") profile = "fast";
    else if (requested == "64") profile = "detail";
  }
  const char *nextProfile = nullptr;
  uint8_t next = 64, hz = 10, minHz = 10, maxHz = 10;
  if (profile == "detail") nextProfile = "detail";
  else if (profile == "navigation") { nextProfile = "navigation"; hz = 15; maxHz = 15; }
  else if (profile == "fast") { nextProfile = "fast"; next = 16; hz = minHz = 30; maxHz = 60; }
  else if (profile == "idle") { nextProfile = "idle"; next = 16; hz = maxHz = 2; minHz = 1; }
  else if (profile == "inspect") { nextProfile = "inspect"; hz = minHz = 5; maxHz = 10; }
  if (!nextProfile) {
    diagnosticServer.send(400, "application/json", "{\"ok\":false,\"error\":\"use detail, navigation, fast, idle, or inspect\"}");
    return;
  }
  if (diagnosticServer.hasArg("hz")) {
    const String value = diagnosticServer.arg("hz");
    bool digits = !value.isEmpty() && value.length() <= 2;
    for (uint8_t i = 0; i < value.length(); ++i) digits = digits && isDigit(value[i]);
    const int requestedHz = value.toInt();
    if (!digits || requestedHz < minHz || requestedHz > maxHz) {
      diagnosticServer.send(400, "application/json", "{\"ok\":false,\"error\":\"frequency is outside the profile range\"}");
      return;
    }
    hz = requestedHz;
  }
  if (!wideTofReady) {
    diagnosticServer.send(503, "application/json", "{\"ok\":false,\"error\":\"wide ToF unavailable\"}");
    return;
  }
  if (profile == wideProfile && hz == wideFrequencyHz) { sendWideResolution(); return; }
  if (!wideTof.stopRanging()) {
    diagnosticServer.send(503, "application/json", "{\"ok\":false,\"error\":\"could not stop wide ToF\"}");
    return;
  }
  // Never publish the old frame with new dimensions, including on rollback.
  wideHasFrame = false;
  wideResults = {};
  wideFramePeriodMs = 0;
  const bool autonomous = profile == "idle";
  const bool configured = wideTof.setResolution(next) &&
    wideTof.setRangingFrequency(hz) &&
    wideTof.setTargetOrder(VL53L5CX_TARGET_ORDER_STRONGEST) &&
    wideTof.setRangingMode(autonomous ? VL53L5CX_RANGING_MODE_AUTONOMOUS : VL53L5CX_RANGING_MODE_CONTINUOUS) &&
    (!autonomous || wideTof.setIntegrationTime(5)) && wideTof.startRanging();
  if (!configured) {
    wideTof.stopRanging();
    wideTofReady = wideTof.setResolution(wideResolution) &&
      wideTof.setRangingFrequency(wideFrequencyHz) &&
      wideTof.setTargetOrder(VL53L5CX_TARGET_ORDER_STRONGEST) &&
      wideTof.setRangingMode(wideAutonomous ? VL53L5CX_RANGING_MODE_AUTONOMOUS : VL53L5CX_RANGING_MODE_CONTINUOUS) &&
      (!wideAutonomous || wideTof.setIntegrationTime(5)) && wideTof.startRanging();
    diagnosticServer.send(503, "application/json", "{\"ok\":false,\"error\":\"profile change failed\"}");
    return;
  }
  wideResolution = next;
  wideFrequencyHz = hz;
  wideProfile = nextProfile;
  wideAutonomous = autonomous;
  wideLastPollAt = millis();
  sendWideResolution();
}

void sendWideRange() {
  if (!wideTofReady) {
    diagnosticServer.send(503, "application/json", "{\"ok\":false,\"error\":\"wide ToF unavailable\"}");
    return;
  }
  if (!wideHasFrame) {
    diagnosticServer.send(202, "application/json", wideResolutionJson(true));
    return;
  }
  String body;
  body.reserve(strcmp(wideProfile, "inspect") == 0 ? 3500 : 1600);
  body = wideResolutionJson(true);
  body.remove(body.length() - 1);
  body += ",\"frameSequence\":" + String(wideFrameSequence);
  body += ",\"framePeriodMs\":" + String(wideFramePeriodMs);
  body += ",\"ageMs\":" + String(millis() - wideCapturedAt);
  body += ",\"rawDistanceMm\":[";
  for (uint8_t zone = 0; zone < wideResolution; ++zone) {
    if (zone) body += ',';
    body += String(wideResults.distance_mm[zone]);
  }
  body += "],\"targetStatus\":[";
  for (uint8_t zone = 0; zone < wideResolution; ++zone) {
    if (zone) body += ',';
    body += String(wideResults.target_status[zone]);
  }
  body += ']';
  if (strcmp(wideProfile, "inspect") == 0) {
    body += ",\"signalKcpsPerSpad\":[";
    for (uint8_t zone = 0; zone < wideResolution; ++zone) {
      if (zone) body += ',';
      body += String(wideResults.signal_per_spad[zone]);
    }
    body += "],\"ambientKcpsPerSpad\":[";
    for (uint8_t zone = 0; zone < wideResolution; ++zone) {
      if (zone) body += ',';
      body += String(wideResults.ambient_per_spad[zone]);
    }
    body += "],\"targetCount\":[";
    for (uint8_t zone = 0; zone < wideResolution; ++zone) {
      if (zone) body += ',';
      body += String(wideResults.nb_target_detected[zone]);
    }
    body += ']';
  }
  body += '}';
  diagnosticServer.send(200, "application/json", body);
}

int16_t signedImuWord(const uint8_t *bytes) {
  return static_cast<int16_t>((static_cast<uint16_t>(bytes[0]) << 8) | bytes[1]);
}

void pollImu() {
  if (!imuReady) return;
  const uint32_t now = millis();
  if (now - imuLastPollAt < IMU_SAMPLE_INTERVAL_MS) return;
  imuLastPollAt = now;

  // One burst reads temperature, acceleration and angular rate together.
  // Keep it in the main loop so diagnostic requests cannot race the I2C bus.
  uint8_t data[14];
  if (!readRegisters(IMU_ADDRESS, 0x09, data, sizeof(data))) return;
  ImuSample next;
  next.temperature = signedImuWord(data);
  float accelG[3], gyroDps[3];
  for (uint8_t axis = 0; axis < 3; ++axis) {
    next.accel[axis] = signedImuWord(data + 2 + axis * 2);
    next.gyro[axis] = signedImuWord(data + 8 + axis * 2);
    accelG[axis] = next.accel[axis] / 16384.0f;
    gyroDps[axis] = next.gyro[axis] / 131.0f;
  }
  // On this shared I2C bus an occasional burst repeats one byte across
  // several words (for example 0x1111 or 0xFFFF). Ignore it rather than
  // treating it as movement and restarting boot calibration.
  uint8_t repeatedByteWords = 0;
  for (size_t offset = 0; offset < sizeof(data); offset += 2) {
    if (data[offset] == data[offset + 1]) ++repeatedByteWords;
  }
  if (repeatedByteWords >= 3) return;
  const float accelNorm = sqrtf(accelG[0] * accelG[0] +
    accelG[1] * accelG[1] + accelG[2] * accelG[2]);
  // Occasional I2C bursts have returned -1 on several axes. Such a sample
  // implies almost zero gravity and must not shift the orientation estimate.
  if (!isfinite(accelNorm) || accelNorm < 0.25f || accelNorm > 4.0f) return;
  next.sampledAt = now;
  next.valid = true;
  imuSample = next;

  if (!imuOrientationReady) {
    const float gyroNorm = sqrtf(gyroDps[0] * gyroDps[0] +
      gyroDps[1] * gyroDps[1] + gyroDps[2] * gyroDps[2]);
    if (accelNorm < 0.85f || accelNorm > 1.15f || gyroNorm > 5.0f) {
      imuCalibrationCount = 0;
      for (uint8_t axis = 0; axis < 3; ++axis) {
        imuGyroSum[axis] = 0.0f;
        imuAccelSum[axis] = 0.0f;
      }
      return;
    }
    for (uint8_t axis = 0; axis < 3; ++axis) {
      imuGyroSum[axis] += gyroDps[axis];
      imuAccelSum[axis] += accelG[axis];
    }
    if (++imuCalibrationCount < IMU_CALIBRATION_SAMPLES) return;
    float gravityNorm = 0.0f;
    for (uint8_t axis = 0; axis < 3; ++axis) {
      imuGyroBias[axis] = imuGyroSum[axis] / imuCalibrationCount;
      imuGravityReference[axis] = imuAccelSum[axis] / imuCalibrationCount;
      gravityNorm += imuGravityReference[axis] * imuGravityReference[axis];
    }
    gravityNorm = sqrtf(gravityNorm);
    for (uint8_t axis = 0; axis < 3; ++axis) imuGravityReference[axis] /= gravityNorm;
    imuOrientationReady = true;
    imuIntegrationAt = now;
    Serial.printf("IMU orientation calibrated from %u stationary samples\n", imuCalibrationCount);
    return;
  }

  const float dt = (now - imuIntegrationAt) / 1000.0f;
  imuIntegrationAt = now;
  if (dt <= 0.0f || dt > 0.2f) return; // never integrate across a blind gap

  float omega[3];
  for (uint8_t axis = 0; axis < 3; ++axis) {
    omega[axis] = (gyroDps[axis] - imuGyroBias[axis]) * (PI / 180.0f);
  }
  if (accelNorm > 0.7f && accelNorm < 1.3f) {
    // Predict gravity in the current chip frame by rotating the boot gravity
    // through the inverse of our body-to-boot orientation quaternion.
    const float w = imuOrientation[0], x = -imuOrientation[1];
    const float y = -imuOrientation[2], z = -imuOrientation[3];
    const float gx = imuGravityReference[0], gy = imuGravityReference[1];
    const float gz = imuGravityReference[2];
    const float tx = 2.0f * (y * gz - z * gy);
    const float ty = 2.0f * (z * gx - x * gz);
    const float tz = 2.0f * (x * gy - y * gx);
    const float predicted[3] = {
      gx + w * tx + y * tz - z * ty,
      gy + w * ty + z * tx - x * tz,
      gz + w * tz + x * ty - y * tx,
    };
    const float measured[3] = {
      accelG[0] / accelNorm, accelG[1] / accelNorm, accelG[2] / accelNorm,
    };
    omega[0] += IMU_TILT_CORRECTION * (measured[1] * predicted[2] - measured[2] * predicted[1]);
    omega[1] += IMU_TILT_CORRECTION * (measured[2] * predicted[0] - measured[0] * predicted[2]);
    omega[2] += IMU_TILT_CORRECTION * (measured[0] * predicted[1] - measured[1] * predicted[0]);
  }
  const float w = imuOrientation[0], x = imuOrientation[1];
  const float y = imuOrientation[2], z = imuOrientation[3];
  const float halfDt = 0.5f * dt;
  imuOrientation[0] += halfDt * (-x * omega[0] - y * omega[1] - z * omega[2]);
  imuOrientation[1] += halfDt * (w * omega[0] + y * omega[2] - z * omega[1]);
  imuOrientation[2] += halfDt * (w * omega[1] + z * omega[0] - x * omega[2]);
  imuOrientation[3] += halfDt * (w * omega[2] + x * omega[1] - y * omega[0]);
  const float qNorm = sqrtf(imuOrientation[0] * imuOrientation[0] +
    imuOrientation[1] * imuOrientation[1] + imuOrientation[2] * imuOrientation[2] +
    imuOrientation[3] * imuOrientation[3]);
  for (uint8_t component = 0; component < 4; ++component) imuOrientation[component] /= qNorm;
}

void sendImu() {
  if (!imuReady) initImu();
  if (!imuReady || !imuSample.valid || millis() - imuSample.sampledAt > 500) {
    diagnosticServer.send(503, "application/json", "{\"ok\":false,\"error\":\"IMU sample unavailable or stale\"}");
    return;
  }
  String body = "{\"ok\":true,\"sampledAtMs\":" + String(imuSample.sampledAt);
  body += ",\"frame\":\"chip\",\"rawAccel\":[";
  for (uint8_t axis = 0; axis < 3; ++axis) {
    if (axis) body += ',';
    body += String(imuSample.accel[axis]);
  }
  body += "],\"accelG\":[";
  for (uint8_t axis = 0; axis < 3; ++axis) {
    if (axis) body += ',';
    body += String(imuSample.accel[axis] / 16384.0f, 4);
  }
  body += "],\"rawGyro\":[";
  for (uint8_t axis = 0; axis < 3; ++axis) {
    if (axis) body += ',';
    body += String(imuSample.gyro[axis]);
  }
  body += "],\"gyroDps\":[";
  for (uint8_t axis = 0; axis < 3; ++axis) {
    if (axis) body += ',';
    body += String(imuSample.gyro[axis] / 131.0f, 4);
  }
  body += "],\"rawTemperature\":" + String(imuSample.temperature);
  body += ",\"temperatureC\":" + String(25.0f + imuSample.temperature / 128.0f, 2);
  body += ",\"orientationReady\":" + String(imuOrientationReady ? "true" : "false");
  body += ",\"calibrationSamples\":" + String(imuCalibrationCount);
  body += ",\"calibrationTarget\":" + String(IMU_CALIBRATION_SAMPLES);
  body += ",\"orientationAgeMs\":" + String(millis() - imuIntegrationAt);
  body += ",\"gyroBiasDps\":[";
  for (uint8_t axis = 0; axis < 3; ++axis) {
    if (axis) body += ',';
    body += String(imuGyroBias[axis], 4);
  }
  body += "],\"orientationDeg\":";
  if (imuOrientationReady) {
    const float w = imuOrientation[0], x = imuOrientation[1];
    const float y = imuOrientation[2], z = imuOrientation[3];
    const float roll = atan2f(2.0f * (w * x + y * z),
      1.0f - 2.0f * (x * x + y * y));
    const float sinPitch = 2.0f * (w * y - z * x);
    const float pitch = asinf(constrain(sinPitch, -1.0f, 1.0f));
    const float yaw = atan2f(2.0f * (w * z + x * y),
      1.0f - 2.0f * (y * y + z * z));
    body += '[';
    body += String(roll * 180.0f / PI, 2) + ',';
    body += String(pitch * 180.0f / PI, 2) + ',';
    body += String(yaw * 180.0f / PI, 2) + ']';
  } else {
    body += "null";
  }
  body += '}';
  diagnosticServer.send(200, "application/json", body);
}

void zeroImuOrientation() {
  if (!imuOrientationReady || !imuSample.valid || millis() - imuSample.sampledAt > 500) {
    diagnosticServer.send(503, "application/json", "{\"ok\":false,\"error\":\"fresh calibrated IMU sample required\"}");
    return;
  }
  float gravityNorm = 0.0f;
  float gravity[3];
  float gyroNormSquared = 0.0f;
  for (uint8_t axis = 0; axis < 3; ++axis) {
    gravity[axis] = imuSample.accel[axis] / 16384.0f;
    gravityNorm += gravity[axis] * gravity[axis];
    const float rate = imuSample.gyro[axis] / 131.0f - imuGyroBias[axis];
    gyroNormSquared += rate * rate;
  }
  gravityNorm = sqrtf(gravityNorm);
  if (gravityNorm < 0.85f || gravityNorm > 1.15f || gyroNormSquared > 25.0f) {
    diagnosticServer.send(409, "application/json", "{\"ok\":false,\"error\":\"hold board still to zero orientation\"}");
    return;
  }
  for (uint8_t axis = 0; axis < 3; ++axis) imuGravityReference[axis] = gravity[axis] / gravityNorm;
  imuOrientation[0] = 1.0f;
  imuOrientation[1] = imuOrientation[2] = imuOrientation[3] = 0.0f;
  imuIntegrationAt = millis();
  diagnosticServer.send(200, "application/json", "{\"ok\":true,\"orientationDeg\":[0,0,0]}");
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

void cancelMicrophoneComparison() {
  micTraceRequested = false;
  if (micComparisonRx) {
    if (micComparisonRxEnabled) {
      markMicrophoneActivityDisable(false);
      const esp_err_t error = i2s_channel_disable(micComparisonRx);
      markMicrophoneActivityDisable(true);
      psfMicRestoreCheckpoint(nullptr, "disable diagnostic slave RX", error);
    }
    stopMicrophoneActivityMonitor();
    const esp_err_t deleted = i2s_del_channel(micComparisonRx);
    micComparisonRx = nullptr;
    psfMicRestoreCheckpoint(nullptr, "delete diagnostic slave RX", deleted);
  }
  micComparisonRxEnabled = false;
  if (micComparisonPhase) micComparisonResult = "cancelled";
  micComparisonPhase = 0;
}

void holdMicrophoneClock(uint8_t level) {
  cancelMicrophoneComparison();
  if (micIndependentClockRunning) {
    ledcDetach(MIC_PDM_CLK);
    micIndependentClockRunning = false;
  }
  micDataFloating = false;
  if (!micClockHeld) {
    if (!microphonesReady || !microphoneI2s.end()) {
      diagnosticServer.send(503, "application/json", "{\"ok\":false,\"error\":\"could not stop microphone I2S\"}");
      return;
    }
    microphonesReady = false;
  }
  gpio_reset_pin(static_cast<gpio_num_t>(MIC_PDM_DATA));
  micDataHeldLevel = -1;
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

bool restoreMicrophoneCapture() {
  psfMicRestoreCheckpoint(nullptr, "baseline: end of Phase 2 before restore", 0);
  cancelMicrophoneComparison();
  if (!micClockHeld) return microphonesReady;
  if (micIndependentClockRunning) {
    const bool detached = ledcDetach(MIC_PDM_CLK);
    micIndependentClockRunning = false;
    psfMicRestoreCheckpoint(nullptr, "detach LEDC clock on GPIO21", detached);
  }
  micIndependentClockRunning = false;
  micDataFloating = false;
  const esp_err_t resetClock = gpio_reset_pin(static_cast<gpio_num_t>(MIC_PDM_CLK));
  psfMicRestoreCheckpoint(nullptr, "gpio_reset_pin(GPIO21)", resetClock);
  const esp_err_t resetData = gpio_reset_pin(static_cast<gpio_num_t>(MIC_PDM_DATA));
  psfMicRestoreCheckpoint(nullptr, "gpio_reset_pin(GPIO14)", resetData);
  micDataHeldLevel = -1;
  micClockHeld = false;
  micClockHeldLevel = -1;
  initMicrophones();
  psfMicRestoreCheckpoint(nullptr, "normal initMicrophones returned", microphonesReady);
  return microphonesReady;
}

void restoreMicrophoneClock() {
  const bool ok = restoreMicrophoneCapture();
  diagnosticServer.send(ok ? 200 : 500, "application/json",
    "{\"ok\":" + String(ok ? "true" : "false") +
    ",\"held\":false,\"pdmCaptureRestored\":" + String(ok ? "true" : "false") + '}');
}

// Microphone Data/Clock line Test: persistent until restore or reboot.
// DATA remains an input with a weak pull; never actively drive mic outputs.
void sendMicrophoneLineHoldStatus() {
  String body = "{\"ok\":true,\"testActive\":" + String(micClockHeld ? "true" : "false");
  body += ",\"clockPin\":" + String(MIC_PDM_CLK);
  body += ",\"clockHeldLevel\":" + String(micClockHeldLevel);
  body += ",\"dataPin\":" + String(MIC_PDM_DATA);
  body += ",\"dataFloating\":" + String(micDataFloating ? "true" : "false");
  body += ",\"independentClockHz\":" + String(micIndependentClockRunning ? ledcReadFreq(MIC_PDM_CLK) : 0);
  body += ",\"dataPullLevel\":" + String(micDataHeldLevel);
  body += ",\"dataPadLevel\":" + String(gpio_get_level(static_cast<gpio_num_t>(MIC_PDM_DATA)));
  body += ",\"captureReady\":" + String(microphonesReady ? "true" : "false") + '}';
  diagnosticServer.send(200, "application/json", body);
}

void holdMicrophoneData(int level) {
  cancelMicrophoneComparison();
  if (!micClockHeld) {
    if (!microphonesReady || !microphoneI2s.end()) {
      diagnosticServer.send(503, "application/json", "{\"ok\":false,\"error\":\"could not stop microphone I2S\"}");
      return;
    }
    microphonesReady = false;
  }
  if (micIndependentClockRunning) ledcDetach(MIC_PDM_CLK);
  micIndependentClockRunning = false;
  pinMode(MIC_PDM_CLK, OUTPUT);
  digitalWrite(MIC_PDM_CLK, LOW);
  micClockHeld = true;
  micClockHeldLevel = 0;
  delay(25); // allow microphone outputs to release after clock stops
  gpio_reset_pin(static_cast<gpio_num_t>(MIC_PDM_DATA));
  pinMode(MIC_PDM_DATA, level < 0 ? INPUT : level ? INPUT_PULLUP : INPUT_PULLDOWN);
  micDataHeldLevel = level;
  micDataFloating = level < 0;
  delay(25);
  sendMicrophoneLineHoldStatus();
}

void holdMicrophoneDataHigh() { holdMicrophoneData(1); }
void holdMicrophoneDataLow() { holdMicrophoneData(0); }
void holdMicrophoneDataFloat() { holdMicrophoneData(-1); }

void startMicrophoneFloatingDataClock() {
  if (!micClockHeld || !micDataFloating) {
    diagnosticServer.send(409, "application/json", "{\"ok\":false,\"error\":\"activate data-float first\"}");
    return;
  }
  // Preserve GPIO14 exactly: only attach the clock generator on GPIO21.
  if (!micIndependentClockRunning) {
    const bool attached = ledcAttachChannel(MIC_PDM_CLK, MIC_PDM_CLOCK_HZ, 1, 7);
    const bool running = attached && ledcWrite(MIC_PDM_CLK, 1);
    if (!running) {
      if (attached) ledcDetach(MIC_PDM_CLK);
      pinMode(MIC_PDM_CLK, OUTPUT);
      digitalWrite(MIC_PDM_CLK, LOW);
      diagnosticServer.send(500, "application/json", "{\"ok\":false,\"error\":\"clock start failed; DATA unchanged\"}");
      return;
    }
    micIndependentClockRunning = true;
    micClockHeldLevel = -1; // clock is toggling rather than held at a DC level
  }
  delay(30);
  sendMicrophoneLineHoldStatus();
}

void sendMicrophoneRxComparison() {
  String body = "{\"ok\":true,\"phase\":\"" + micComparisonResult + "\"";
  body += ",\"phaseElapsedMs\":" + String(micComparisonPhase ? millis() - micComparisonPhaseAt : 0);
  body += ",\"clockSource\":\"LEDC continuous; PDM RX slave\"";
  body += ",\"clockHz\":" + String(micIndependentClockRunning ? ledcReadFreq(MIC_PDM_CLK) : 0);
  body += ",\"rxEnabled\":" + String(micComparisonRxEnabled ? "true" : "false");
  body += ",\"firstHoldMs\":" + String(micComparisonFirstDuration);
  body += ",\"secondHoldMs\":" + String(micComparisonSecondDuration);
  body += ",\"beforeRxEnable\":" + micComparisonBefore;
  body += ",\"afterRxEnable\":" + micComparisonAfter;
  body += ",\"endRxHold\":" + micComparisonEnd;
  body += ",\"error\":\"" + micComparisonError + "\"";
  body += ",\"normalCaptureReady\":" + String(microphonesReady ? "true" : "false") + '}';
  diagnosticServer.send(200, "application/json", body);
}

void startMicrophoneRxComparison() {
  if (micComparisonPhase) {
    diagnosticServer.send(409, "application/json", "{\"ok\":false,\"error\":\"comparison already running\"}");
    return;
  }
  if (micClockHeld) {
    diagnosticServer.send(409, "application/json", "{\"ok\":false,\"error\":\"restore other test holds before starting comparison\"}");
    return;
  }
  if (!microphonesReady || !microphoneI2s.end()) {
    diagnosticServer.send(503, "application/json", "{\"ok\":false,\"error\":\"normal capture must be ready; restore first\"}");
    return;
  }
  microphonesReady = false;
  micClockHeld = true;
  micClockHeldLevel = 0;
  micComparisonBefore = micComparisonAfter = micComparisonEnd = "null";
  micComparisonError = "";
  micComparisonFirstDuration = micComparisonSecondDuration = 0;
  // Prepare the disabled slave receiver before the first measurement phase.
  // clk=-1 prevents the I2S driver from touching the clock pad or generator.
  i2s_chan_config_t channel = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_SLAVE);
  esp_err_t error = i2s_new_channel(&channel, nullptr, &micComparisonRx);
  if (error == ESP_OK) {
    i2s_pdm_rx_config_t pdm = {};
    pdm.clk_cfg = I2S_PDM_RX_CLK_DEFAULT_CONFIG(MIC_SAMPLE_RATE);
    pdm.clk_cfg.dn_sample_mode = I2S_PDM_DSR_16S;
    pdm.slot_cfg = I2S_PDM_RX_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_STEREO);
    pdm.gpio_cfg.clk = static_cast<gpio_num_t>(-1);
    pdm.gpio_cfg.din = static_cast<gpio_num_t>(MIC_PDM_DATA);
    error = i2s_channel_init_pdm_rx_mode(micComparisonRx, &pdm);
  }
  if (error == ESP_OK) {
    gpio_config_t data = {};
    data.pin_bit_mask = 1ULL << MIC_PDM_DATA;
    data.mode = GPIO_MODE_INPUT;
    data.pull_up_en = GPIO_PULLUP_DISABLE;
    data.pull_down_en = GPIO_PULLDOWN_DISABLE;
    data.intr_type = GPIO_INTR_DISABLE;
    error = gpio_config(&data);
  }
  if (error == ESP_OK) {
    const bool attached = ledcAttachChannel(MIC_PDM_CLK, MIC_PDM_CLOCK_HZ, 1, 7);
    const bool running = attached && ledcWrite(MIC_PDM_CLK, 1);
    if (running) {
      micIndependentClockRunning = true;
      micClockHeldLevel = -1;
      gpio_input_enable(static_cast<gpio_num_t>(MIC_PDM_CLK));
      esp_rom_gpio_connect_in_signal(MIC_PDM_CLK, I2S0I_WS_IN_IDX, false);
    } else {
      if (attached) ledcDetach(MIC_PDM_CLK);
      error = ESP_FAIL;
    }
  }
  if (error != ESP_OK) {
    micComparisonError = esp_err_to_name(error);
    restoreMicrophoneCapture();
    micComparisonResult = "failed";
    diagnosticServer.send(500, "application/json", "{\"ok\":false,\"error\":\"comparison setup failed: " + micComparisonError + "\"}");
    return;
  }
  micDataHeldLevel = -1;
  micDataFloating = true;
  delay(100); // microphone wake-up before the full 30-second clock-only hold
  micComparisonBefore = readMicrophoneDataGpio();
  micComparisonPhaseAt = millis();
  micComparisonPhase = 1;
  micComparisonResult = "clock-only";
  Serial.printf("Mic RX comparison clock-only: %s\n", micComparisonBefore.c_str());
  sendMicrophoneRxComparison();
}



void releaseMicrophoneActivityCounter(MicActivityCounter &counter) {
  if (counter.started) pcnt_unit_stop(counter.unit);
  if (counter.enabled) pcnt_unit_disable(counter.unit);
  if (counter.channel) pcnt_del_channel(counter.channel);
  if (counter.unit) pcnt_del_unit(counter.unit);
  if (counter.signalIndex >= 0) GPIO.func_in_sel_cfg[counter.signalIndex].val = counter.originalRouting;
  counter.unit = nullptr;
  counter.channel = nullptr;
  counter.enabled = counter.started = false;
}

esp_err_t prepareMicrophoneActivityCounter(MicActivityCounter &counter, uint8_t pin, bool bothEdges) {
  counter = MicActivityCounter{};
  // Save only PCNT pulse-input routes; I2S matrix assignments are untouched.
  uint32_t original[SOC_PCNT_UNITS_PER_GROUP * SOC_PCNT_CHANNELS_PER_UNIT] = {};
  for (int unit = 0; unit < SOC_PCNT_UNITS_PER_GROUP; ++unit)
    for (int channel = 0; channel < SOC_PCNT_CHANNELS_PER_UNIT; ++channel) {
      const int signal = pcnt_periph_signals.groups[0].units[unit].channels[channel].pulse_sig;
      original[unit * SOC_PCNT_CHANNELS_PER_UNIT + channel] = GPIO.func_in_sel_cfg[signal].val;
    }
  pcnt_unit_config_t config = {};
  config.low_limit = -32768;
  config.high_limit = 32767;
  config.flags.accum_count = true;
  esp_err_t error = pcnt_new_unit(&config, &counter.unit);
  if (error != ESP_OK) return error;
  pcnt_chan_config_t channelConfig = {};
  channelConfig.edge_gpio_num = -1;
  channelConfig.level_gpio_num = -1;
  // First virtual ZERO, then recreate as virtual ONE. That produces a
  // deterministic routing-register delta identifying this allocated channel.
  error = pcnt_new_channel(counter.unit, &channelConfig, &counter.channel);
  if (error != ESP_OK) return error;
  uint32_t zeroRouting[SOC_PCNT_UNITS_PER_GROUP * SOC_PCNT_CHANNELS_PER_UNIT] = {};
  for (int unit = 0; unit < SOC_PCNT_UNITS_PER_GROUP; ++unit)
    for (int channel = 0; channel < SOC_PCNT_CHANNELS_PER_UNIT; ++channel) {
      const int signal = pcnt_periph_signals.groups[0].units[unit].channels[channel].pulse_sig;
      zeroRouting[unit * SOC_PCNT_CHANNELS_PER_UNIT + channel] = GPIO.func_in_sel_cfg[signal].val;
    }
  error = pcnt_del_channel(counter.channel);
  counter.channel = nullptr;
  if (error != ESP_OK) return error;
  channelConfig.flags.virt_edge_io_level = 1;
  error = pcnt_new_channel(counter.unit, &channelConfig, &counter.channel);
  if (error != ESP_OK) return error;
  int changed = 0;
  for (int unit = 0; unit < SOC_PCNT_UNITS_PER_GROUP; ++unit)
    for (int channel = 0; channel < SOC_PCNT_CHANNELS_PER_UNIT; ++channel) {
      const int signal = pcnt_periph_signals.groups[0].units[unit].channels[channel].pulse_sig;
      const int index = unit * SOC_PCNT_CHANNELS_PER_UNIT + channel;
      if (GPIO.func_in_sel_cfg[signal].val != zeroRouting[index]) {
        counter.signalIndex = signal;
        counter.originalRouting = original[index];
        ++changed;
      }
    }
  if (changed != 1) return ESP_ERR_INVALID_STATE;
  // This is the only connection to the real pad. It changes PCNT routing,
  // not GPIO direction, IO_MUX, pulls, output enable, or I2S input routing.
  esp_rom_gpio_connect_in_signal(pin, counter.signalIndex, false);
  error = pcnt_channel_set_edge_action(counter.channel, PCNT_CHANNEL_EDGE_ACTION_INCREASE,
    bothEdges ? PCNT_CHANNEL_EDGE_ACTION_INCREASE : PCNT_CHANNEL_EDGE_ACTION_HOLD);
  if (error == ESP_OK) error = pcnt_unit_set_glitch_filter(counter.unit, nullptr);
  if (error == ESP_OK) error = pcnt_unit_add_watch_point(counter.unit, 32767);
  if (error == ESP_OK) error = pcnt_unit_enable(counter.unit);
  counter.enabled = error == ESP_OK;
  if (error == ESP_OK) error = pcnt_unit_clear_count(counter.unit);
  if (error == ESP_OK) error = pcnt_unit_start(counter.unit);
  counter.started = error == ESP_OK;
  return error;
}

void sampleMicrophoneActivityCounter(MicActivityCounter &counter, uint32_t &delta, bool &cleared) {
  int raw = 0;
  const esp_err_t error = pcnt_unit_get_count(counter.unit, &raw);
  if (error != ESP_OK) {
    micActivityError = esp_err_to_name(error);
    micActivityStopRequested = true;
    delta = 0;
    return;
  }
  const uint32_t current = static_cast<uint32_t>(raw);
  delta = current - counter.previousRaw;
  counter.total += delta;
  counter.previousRaw = current;
  // Long-running monitors stay below the driver's signed 32-bit limit.
  // Clearing does not change any GPIO/clock state. Mark the small counting
  // discontinuity explicitly; never interpret that interval as zero activity.
  if (current >= 1000000000U) {
    pcnt_unit_clear_count(counter.unit);
    counter.previousRaw = 0;
    cleared = true;
    ++micActivityCounterClears;
  }
}

void runMicrophoneActivityMonitor(void *) {
  int64_t previousUs = micActivityStartedUs;
  while (!micActivityStopRequested) {
    vTaskDelay(pdMS_TO_TICKS(micActivityFirstCount < MIC_ACTIVITY_FIRST_CAPACITY ? 10 : 100));
    MicActivityBin bin = {};
    xSemaphoreTake(micActivityMutex, portMAX_DELAY);
    sampleMicrophoneActivityCounter(micActivityData, bin.dataEdges, bin.counterCleared);
    sampleMicrophoneActivityCounter(micActivityClock, bin.clockEdges, bin.counterCleared);
    bin.endUs = esp_timer_get_time();
    bin.durationUs = static_cast<uint32_t>(bin.endUs - previousUs);
    previousUs = bin.endUs;
    bin.rxEnabled = I2S0.rx_conf.rx_start;
    bin.dataLevel = gpio_get_level(static_cast<gpio_num_t>(MIC_PDM_DATA));
    if (bin.dataEdges) micActivityLastNonzeroUs = bin.endUs;
    if (micActivityFirstCount < MIC_ACTIVITY_FIRST_CAPACITY) micActivityFirst[micActivityFirstCount++] = bin;
    micActivityRecent[micActivityRecentHead] = bin;
    micActivityRecentHead = (micActivityRecentHead + 1) % MIC_ACTIVITY_RECENT_CAPACITY;
    if (micActivityRecentCount < MIC_ACTIVITY_RECENT_CAPACITY) ++micActivityRecentCount;
    xSemaphoreGive(micActivityMutex);
  }
  // No real pin was assigned to the PCNT driver, so deletion cannot alter
  // GPIO14 pulls. Release only the extra PCNT matrix taps.
  xSemaphoreTake(micActivityMutex, portMAX_DELAY);
  releaseMicrophoneActivityCounter(micActivityData);
  releaseMicrophoneActivityCounter(micActivityClock);
  micActivityActive = false;
  xSemaphoreGive(micActivityMutex);
  xSemaphoreGive(micActivityStopped);
  vTaskDelete(nullptr);
}

bool startMicrophoneActivityMonitor() {
  if (!micActivityMutex || !micActivityStopped || micActivityActive) return false;
  gpio_io_config_t data = {}, clock = {};
  gpio_get_io_config(static_cast<gpio_num_t>(MIC_PDM_DATA), &data);
  gpio_get_io_config(static_cast<gpio_num_t>(MIC_PDM_CLK), &clock);
  if (!data.ie || data.oe || data.pu || data.pd || !clock.ie || !micIndependentClockRunning) {
    micActivityError = "requires input-only DATA with no pulls and the independent clock running";
    return false;
  }
  micActivityGpioBefore = readMicrophoneDataGpio();
  micActivityError = "";
  micActivityFirstCount = micActivityRecentCount = micActivityRecentHead = 0;
  micActivityCounterClears = 0;
  micActivityLastNonzeroUs = micActivityDisableBeginUs = micActivityDisableEndUs = 0;
  micActivityEdgesAtDisableBegin = micActivityEdgesAtDisableEnd = 0;
  esp_err_t error = prepareMicrophoneActivityCounter(micActivityData, MIC_PDM_DATA, true);
  if (error == ESP_OK) error = prepareMicrophoneActivityCounter(micActivityClock, MIC_PDM_CLK, false);
  micActivityGpioAfter = readMicrophoneDataGpio();
  gpio_io_config_t after = {};
  gpio_get_io_config(static_cast<gpio_num_t>(MIC_PDM_DATA), &after);
  if (error == ESP_OK && (after.ie != data.ie || after.oe != data.oe || after.pu != data.pu || after.pd != data.pd || after.fun_sel != data.fun_sel)) error = ESP_ERR_INVALID_STATE;
  if (error != ESP_OK) {
    micActivityError = esp_err_to_name(error);
    releaseMicrophoneActivityCounter(micActivityData);
    releaseMicrophoneActivityCounter(micActivityClock);
    return false;
  }
  while (xSemaphoreTake(micActivityStopped, 0) == pdTRUE) {}
  int initialData = 0, initialClock = 0;
  pcnt_unit_get_count(micActivityData.unit, &initialData);
  pcnt_unit_get_count(micActivityClock.unit, &initialClock);
  micActivityData.previousRaw = static_cast<uint32_t>(initialData);
  micActivityClock.previousRaw = static_cast<uint32_t>(initialClock);
  micActivityStartedUs = esp_timer_get_time();
  micActivityStopRequested = false;
  micActivityActive = true;
  if (xTaskCreatePinnedToCore(runMicrophoneActivityMonitor, "mic-data-edges", 8192, nullptr, 3, nullptr, 1) != pdPASS) {
    micActivityActive = false;
    micActivityError = "could not create edge monitor task";
    releaseMicrophoneActivityCounter(micActivityData);
    releaseMicrophoneActivityCounter(micActivityClock);
    return false;
  }
  return true;
}

void stopMicrophoneActivityMonitor() {
  if (!micActivityActive) return;
  micActivityStopRequested = true;
  xSemaphoreTake(micActivityStopped, portMAX_DELAY);
}

void markMicrophoneActivityDisable(bool after) {
  if (!micActivityActive) return;
  xSemaphoreTake(micActivityMutex, portMAX_DELAY);
  if (!micActivityActive || !micActivityData.unit) { xSemaphoreGive(micActivityMutex); return; }
  int raw = 0;
  pcnt_unit_get_count(micActivityData.unit, &raw);
  const uint64_t total = micActivityData.total + (static_cast<uint32_t>(raw) - micActivityData.previousRaw);
  if (after) {
    micActivityDisableEndUs = esp_timer_get_time();
    micActivityEdgesAtDisableEnd = total;
  } else {
    micActivityDisableBeginUs = esp_timer_get_time();
    micActivityEdgesAtDisableBegin = total;
  }
  xSemaphoreGive(micActivityMutex);
}

String microphoneActivityBinJson(const MicActivityBin &bin) {
  String body = "{\"endUs\":" + String(static_cast<long long>(bin.endUs));
  body += ",\"durationUs\":" + String(bin.durationUs);
  body += ",\"dataTransitions\":" + String(bin.dataEdges);
  body += ",\"clockRisingEdges\":" + String(bin.clockEdges);
  body += ",\"rxEnabled\":" + String(bin.rxEnabled ? "true" : "false");
  body += ",\"dataLevel\":" + String(bin.dataLevel);
  body += ",\"counterCleared\":" + String(bin.counterCleared ? "true" : "false") + '}';
  return body;
}

void sendMicrophoneActivity() {
  const size_t bytes = (MIC_ACTIVITY_FIRST_CAPACITY + MIC_ACTIVITY_RECENT_CAPACITY) * sizeof(MicActivityBin);
  auto *copy = static_cast<MicActivityBin *>(heap_caps_malloc(bytes, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
  if (!copy) copy = static_cast<MicActivityBin *>(heap_caps_malloc(bytes, MALLOC_CAP_8BIT));
  if (!copy) { diagnosticServer.send(503, "application/json", "{\"ok\":false,\"error\":\"activity snapshot allocation failed\"}"); return; }
  xSemaphoreTake(micActivityMutex, portMAX_DELAY);
  String header = "{\"ok\":true,\"active\":" + String(micActivityActive ? "true" : "false");
  header += ",\"startedUs\":" + String(static_cast<long long>(micActivityStartedUs));
  header += ",\"disableBeginUs\":" + String(static_cast<long long>(micActivityDisableBeginUs));
  header += ",\"disableEndUs\":" + String(static_cast<long long>(micActivityDisableEndUs));
  header += ",\"dataTransitionsAtDisableBegin\":" + String(static_cast<unsigned long long>(micActivityEdgesAtDisableBegin));
  header += ",\"dataTransitionsAtDisableEnd\":" + String(static_cast<unsigned long long>(micActivityEdgesAtDisableEnd));
  header += ",\"totalDataTransitions\":" + String(static_cast<unsigned long long>(micActivityData.total));
  header += ",\"totalClockRisingEdges\":" + String(static_cast<unsigned long long>(micActivityClock.total));
  header += ",\"lastNonzeroDataWindowEndUs\":" + String(static_cast<long long>(micActivityLastNonzeroUs));
  header += ",\"counterClears\":" + String(micActivityCounterClears);
  header += ",\"error\":\"" + micActivityError + "\"";
  header += ",\"gpioBeforeArm\":" + micActivityGpioBefore + ",\"gpioAfterArm\":" + micActivityGpioAfter;
  header += ",\"currentGpio14\":" + readMicrophoneDataGpio() + ",\"firstWindows\":[";
  const uint16_t firstCount = micActivityFirstCount, recentCount = micActivityRecentCount;
  memcpy(copy, micActivityFirst, firstCount * sizeof(MicActivityBin));
  for (uint16_t offset = 0; offset < recentCount; ++offset) {
    const uint16_t index = (micActivityRecentHead + MIC_ACTIVITY_RECENT_CAPACITY - recentCount + offset) % MIC_ACTIVITY_RECENT_CAPACITY;
    copy[firstCount + offset] = micActivityRecent[index];
  }
  xSemaphoreGive(micActivityMutex); // network delivery must not block sampling
  diagnosticServer.setContentLength(CONTENT_LENGTH_UNKNOWN);
  diagnosticServer.send(200, "application/json", header);
  for (uint16_t index = 0; index < firstCount; ++index) {
    if (index) diagnosticServer.sendContent(",");
    diagnosticServer.sendContent(microphoneActivityBinJson(copy[index]));
  }
  diagnosticServer.sendContent("],\"recentWindows\":[");
  for (uint16_t offset = 0; offset < recentCount; ++offset) {
    if (offset) diagnosticServer.sendContent(",");
    diagnosticServer.sendContent(microphoneActivityBinJson(copy[firstCount + offset]));
  }
  diagnosticServer.sendContent("]}");
  diagnosticServer.sendContent("");
  heap_caps_free(copy);
}

void startMicrophoneActivityTrace() {
  if (micComparisonPhase || micTraceRunning || micClockHeld || !microphonesReady) {
    diagnosticServer.send(409, "application/json", "{\"ok\":false,\"error\":\"restore normal capture before starting an activity trace\"}");
    return;
  }
  micActivityRequested = true;
  startMicrophoneRestoreTrace();
  if (!micComparisonPhase) micActivityRequested = false;
}

void stopMicrophoneActivity() {
  micActivityRequested = false;
  stopMicrophoneActivityMonitor();
  sendMicrophoneActivity(); // leave checkpoint 1, clock and GPIO state held
}

void runMicrophoneRestoreTrace(void *) {
  micTraceTask = xTaskGetCurrentTaskHandle();
  micTraceRunning = true;
  const bool ok = restoreMicrophoneCapture();
  xSemaphoreTake(micTraceMutex, portMAX_DELAY);
  micTraceWaiting = false;
  micTraceState = ok ? (micTraceAbort ? "aborted-restored" : "complete") : "restore-failed";
  micTraceRunning = false;
  micTraceTask = nullptr;
  xSemaphoreGive(micTraceMutex);
  micComparisonResult = ok ? "complete" : "restore-failed";
  vTaskDelete(nullptr);
}

void startMicrophoneRestoreTrace() {
  if (!micTraceMutex || !micTraceProceed) { diagnosticServer.send(503, "application/json", "{\"ok\":false,\"error\":\"trace mutex unavailable\"}"); return; }
  if (micComparisonPhase || micTraceRunning || micClockHeld || !microphonesReady) {
    diagnosticServer.send(409, "application/json", "{\"ok\":false,\"error\":\"restore normal capture before starting a trace\"}");
    return;
  }
  xSemaphoreTake(micTraceMutex, portMAX_DELAY);
  for (auto &log : micTraceLogs) log = "";
  micTraceCount = 0;
  micTraceWaiting = false;
  micTraceState = "comparison-running";
  xSemaphoreGive(micTraceMutex);
  while (xSemaphoreTake(micTraceProceed, 0) == pdTRUE) {}
  micTraceRequested = true;
  startMicrophoneRxComparison();
  if (!micComparisonPhase) micTraceRequested = false;
}

void sendMicrophoneRestoreTrace() {
  xSemaphoreTake(micTraceMutex, portMAX_DELAY);
  String header = "{\"ok\":true,\"state\":\"" + micTraceState + "\"";
  header += ",\"waiting\":" + String(micTraceWaiting ? "true" : "false");
  header += ",\"currentStep\":" + String(micTraceCount ? micTraceCount - 1 : -1);
  header += ",\"checkpointAgeMs\":" + String(micTraceWaiting ? millis() - micTraceCheckpointAt : 0);
  header += ",\"checkpoints\":[";
  diagnosticServer.setContentLength(CONTENT_LENGTH_UNKNOWN);
  diagnosticServer.send(200, "application/json", header);
  for (uint8_t index = 0; index < micTraceCount; ++index) {
    if (index) diagnosticServer.sendContent(",");
    diagnosticServer.sendContent(micTraceLogs[index]);
  }
  diagnosticServer.sendContent("]}");
  diagnosticServer.sendContent("");
  xSemaphoreGive(micTraceMutex);
}

void advanceMicrophoneRestoreTrace() {
  xSemaphoreTake(micTraceMutex, portMAX_DELAY);
  if (!micTraceRunning || !micTraceWaiting || !diagnosticServer.hasArg("step") ||
      diagnosticServer.arg("step") != String(micTraceCount - 1) || millis() - micTraceCheckpointAt < 1000) {
    xSemaphoreGive(micTraceMutex);
    diagnosticServer.send(409, "application/json", "{\"ok\":false,\"error\":\"supply the current step; checkpoint must be paused for at least 1 second\"}");
    return;
  }
  micTraceWaiting = false;
  xSemaphoreGive(micTraceProceed);
  xSemaphoreGive(micTraceMutex);
  diagnosticServer.send(200, "application/json", "{\"ok\":true,\"advanced\":true}");
}

void abortMicrophoneRestoreTrace() {
  xSemaphoreTake(micTraceMutex, portMAX_DELAY);
  if (!micTraceRunning) {
    xSemaphoreGive(micTraceMutex);
    micTraceRequested = false;
    const bool ok = restoreMicrophoneCapture();
    diagnosticServer.send(ok ? 200 : 500, "application/json", "{\"ok\":" + String(ok ? "true" : "false") + '}');
    return;
  }
  micTraceAbort = true;
  micTraceWaiting = false;
  xSemaphoreGive(micTraceProceed);
  xSemaphoreGive(micTraceMutex);
  diagnosticServer.send(200, "application/json", "{\"ok\":true,\"restorationInProgress\":true}");
}

void pollMicrophoneRxComparison() {
  if (!micComparisonPhase || micComparisonPhase == 3 || millis() - micComparisonPhaseAt < 30000) return;
  if (micComparisonPhase == 1) {
    micComparisonFirstDuration = millis() - micComparisonPhaseAt;
    // This is the entire transition: no GPIO reconfiguration or clock change.
    micComparisonBefore = readMicrophoneDataGpio();
    const esp_err_t error = i2s_channel_enable(micComparisonRx);
    micComparisonAfter = readMicrophoneDataGpio();
    Serial.printf("Mic RX comparison before: %s\nafter: %s\n", micComparisonBefore.c_str(), micComparisonAfter.c_str());
    if (error != ESP_OK) {
      micComparisonError = esp_err_to_name(error);
      restoreMicrophoneCapture();
      micComparisonResult = "failed";
      return;
    }
    micComparisonRxEnabled = true;
    micComparisonPhase = 2;
    micComparisonPhaseAt = millis();
    micComparisonResult = "rx-enabled";
  } else {
    micComparisonSecondDuration = millis() - micComparisonPhaseAt;
    micComparisonEnd = readMicrophoneDataGpio();
    if (micTraceRequested) {
      micTraceRequested = false;
      micComparisonPhase = 3;
      micComparisonResult = "restore-trace";
      micTraceAbort = false;
      micTraceRunning = true;
      const BaseType_t created = xTaskCreatePinnedToCore(runMicrophoneRestoreTrace, "mic-restore-trace", 16384, nullptr, 1, nullptr, 1);
      if (created == pdPASS) return;
      micTraceRunning = false;
      micComparisonError = "could not create restore trace task";
    }
    // Both measurement windows are over. Restore normal master-mode capture.
    restoreMicrophoneCapture();
    micComparisonResult = microphonesReady ? "complete" : "restore-failed";
  }
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

void receiveSpeakerPcmFrom(WebServer &server, bool &accepted, bool dedicated) {
  HTTPUpload &upload = server.upload();
  if (upload.status == UPLOAD_FILE_START) {
    accepted = speakerControlMutex && xSemaphoreTake(speakerControlMutex, 0) == pdTRUE;
    if (!accepted) return;
    if (speakerPcmStreaming) { accepted = false; xSemaphoreGive(speakerControlMutex); return; }
    // Reserve the speaker before preparing it; diagnostic tones/chimes must
    // not reconfigure I2S while the dedicated upload is being initialized.
    speakerPcmPreparing = true;
    speakerPcmStreaming = true;
    speakerPcmQueuedBytes = 0;
    speakerPcmPlayedBytes = 0;
    speakerPcmPendingSize = 0;
    speakerPcmUploadComplete = false;
    if (dedicated) {
      const bool locked = xSemaphoreTake(boardIoMutex, pdMS_TO_TICKS(5000)) == pdTRUE;
      speakerPcmUploadFailed = !locked || !prepareSpeakerPcmStream();
      if (locked) xSemaphoreGive(boardIoMutex);
    } else speakerPcmUploadFailed = !prepareSpeakerPcmStream();
    if (speakerPcmUploadFailed) { speakerPcmStreaming = false; speakerPcmUploadComplete = true; }
    speakerPcmPreparing = false;
  } else if (!accepted) {
    return;
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
    // An aborted request may never reach the final response handler.
    accepted = false;
    xSemaphoreGive(speakerControlMutex);
  }
}

void sendSpeakerPcmResult(WebServer &server) {
  if (!speakerReady) {
    server.send(503, "application/json", "{\"ok\":false,\"error\":\"speaker I2S unavailable\"}");
    return;
  }
  if (!speakerAmpEnabled) {
    server.send(503, "application/json", "{\"ok\":false,\"error\":\"speaker amplifier P4 enable failed\"}");
    return;
  }
  speakerPcmUploadComplete = true;
  const uint32_t deadline = millis() + 5000;
  while (speakerPcmStreaming && millis() < deadline) delay(1);
  if (speakerPcmStreaming || speakerPcmUploadFailed || speakerPcmPendingSize || !speakerPcmQueuedBytes) {
    server.send(400, "application/json", "{\"ok\":false,\"error\":\"PCM missing, unaligned, or I2S write failed\"}");
    return;
  }
  server.send(200, "application/json",
    "{\"ok\":true,\"bytes\":" + String(speakerPcmPlayedBytes) +
    ",\"boardBufferBytes\":" + String(SPEAKER_BUFFER_CHUNKS * SPEAKER_CHUNK_BYTES) + "}");
}

void finishSpeakerPcm(WebServer &server, bool &accepted) {
  if (!accepted) {
    server.send(409, "application/json", "{\"ok\":false,\"error\":\"speaker already in use or upload aborted\"}");
    return;
  }
  sendSpeakerPcmResult(server);
  accepted = false;
  xSemaphoreGive(speakerControlMutex);
}

void speakerHttpTask(void *) {
  for (;;) { speakerServer.handleClient(); vTaskDelay(pdMS_TO_TICKS(2)); }
}

void handleSpeakerDiagnostic(void (*handler)()) {
  if (!speakerControlMutex || xSemaphoreTake(speakerControlMutex, 0) != pdTRUE) {
    diagnosticServer.send(409, "application/json", "{\"ok\":false,\"error\":\"speaker already in use\"}");
    return;
  }
  handler();
  xSemaphoreGive(speakerControlMutex);
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

void controlIrBank() {
  // Rev 1.3: P5 drives the single AO3400A gate through SW1 (positions 1–2).
  // Preserve sensor reset pins, speaker enable and auxiliary P6/P7 settings.
  static constexpr uint8_t irMask = 1U << 5;
  uint8_t output = 0, direction = 0;
  if (!readRegister8(TCA9534_ADDRESS, 0x01, &output) ||
      !readRegister8(TCA9534_ADDRESS, 0x03, &direction)) {
    diagnosticServer.send(503, "application/json", "{\"ok\":false,\"error\":\"IR expander unavailable\"}");
    return;
  }
  if (diagnosticServer.method() == HTTP_POST) {
    const String enabled = diagnosticServer.arg("enabled");
    if (enabled != "0" && enabled != "1") {
      diagnosticServer.send(400, "application/json", "{\"ok\":false,\"error\":\"enabled must be 0 or 1\"}");
      return;
    }
    const uint8_t nextOutput = enabled == "1" ? output | irMask : output & ~irMask;
    if (!writeExpander(0x01, nextOutput) || !writeExpander(0x03, direction & ~irMask)) {
      diagnosticServer.send(503, "application/json", "{\"ok\":false,\"error\":\"IR control failed\"}");
      return;
    }
    output = nextOutput;
    direction &= ~irMask;
  }
  diagnosticServer.send(200, "application/json", "{\"ok\":true,\"enabled\":" +
    String(!(direction & irMask) && (output & irMask) ? "true" : "false") +
    ",\"control\":\"expander P5; all three emitters; SW1 positions 1-2\"}");
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

String unoJsonEscape(const String &value) {
  String escaped;
  escaped.reserve(value.length() + 8);
  for (size_t index = 0; index < value.length(); ++index) {
    const char valueChar = value[index];
    if (valueChar == '"' || valueChar == '\\') escaped += '\\';
    escaped += valueChar >= 32 && valueChar <= 126 ? valueChar : ' ';
  }
  return escaped;
}

void pollUnoUart() {
  if (!unoUartReady) return;
  uint8_t count = 0;
  while (unoUart.available() && count++ < 96) {
    const char received = static_cast<char>(unoUart.read());
    unoLastRxAt = millis();
    if (received >= 32 && received <= 126) {
      unoRecentRx += received;
      if (unoRecentRx.length() > 160) unoRecentRx.remove(0, unoRecentRx.length() - 160);
    }
    if (received == '{') unoFrameBuffer = "{";
    else if (unoFrameBuffer.length() > 0 && received >= 32 && received <= 126) {
      unoFrameBuffer += received;
      if (received == '}') {
        unoLastFrame = unoFrameBuffer;
        unoFrameBuffer = "";
      } else if (unoFrameBuffer.length() > 128) {
        unoFrameBuffer = "";
      }
    }
  }
}

bool unoRequest(uint8_t command, const String &fields, String &reply, uint32_t timeoutMs = 350) {
  if (!unoUartReady) return false;
  pollUnoUart();
  const String id = "h" + String(++unoRequestId);
  const String prefix = "{" + id + "_";
  const String payload = "{\"N\":" + String(command) + fields + ",\"H\":\"" + id + "\"}";
  unoLastFrame = "";
  unoUart.print(payload);
  const uint32_t started = millis();
  while (millis() - started < timeoutMs) {
    pollUnoUart();
    if (unoLastFrame.startsWith(prefix) && unoLastFrame.endsWith("}")) {
      reply = unoLastFrame.substring(prefix.length(), unoLastFrame.length() - 1);
      return true;
    }
    delay(1);
  }
  return false;
}

bool unoSendWithoutReply(uint8_t command, const String &fields = "") {
  if (!unoUartReady) return false;
  const String id = "h" + String(++unoRequestId);
  const String payload = "{\"N\":" + String(command) + fields + ",\"H\":\"" + id + "\"}";
  return unoUart.print(payload) == payload.length();
}

void pollUnoDriveDeadline() {
  if (!unoDriveActive || static_cast<int32_t>(millis() - unoDriveDeadline) < 0) return;
  unoDriveActive = false;
  // The Uno's N2 timer is the primary bound. This is an independent ESP-side
  // stop in case its timer or parser does not behave as expected.
  unoSendWithoutReply(110);
}

void pollUnoStartupLedClear() {
  if (!unoUartReady || !unoStartupLedClearsRemaining || unoDriveActive ||
      static_cast<int32_t>(millis() - unoStartupLedNextAt) < 0) return;
  // The Uno's stock sketch powers up with its shield LED on. It does not
  // persist the off state, so clear it after both boards have booted. A few
  // bounded retries cover either board starting first without continuously
  // overriding later user-selected Uno modes.
  unoSendWithoutReply(110);
  unoSendWithoutReply(8, UNO_RGB_OFF_FIELDS);
  --unoStartupLedClearsRemaining;
  unoStartupLedNextAt = millis() + 1000;
}

bool unoUnsignedReply(const String &reply, uint16_t &value) {
  if (!reply.length() || reply.length() > 5) return false;
  uint32_t parsed = 0;
  for (size_t index = 0; index < reply.length(); ++index) {
    if (reply[index] < '0' || reply[index] > '9') return false;
    parsed = parsed * 10 + reply[index] - '0';
    if (parsed > UINT16_MAX) return false;
  }
  value = static_cast<uint16_t>(parsed);
  return true;
}

void sendUnoStatus() {
  pollUnoUart();
  String body = "{\"ok\":true,\"uartReady\":" + String(unoUartReady ? "true" : "false");
  body += ",\"baud\":" + String(unoUartBaud);
  body += ",\"servoCommandVersion\":2";
  body += ",\"driveCommandVersion\":1";
  body += ",\"rxPin\":" + String(unoUartRxPin) + ",\"txPin\":" + String(unoUartTxPin);
  body += ",\"lastRxAgeMs\":" + (unoLastRxAt ? String(millis() - unoLastRxAt) : "null");
  body += ",\"recentRx\":\"" + unoJsonEscape(unoRecentRx) + "\"}";
  diagnosticServer.send(200, "application/json", body);
}

void setUnoBaud() {
  const uint32_t baud = diagnosticServer.arg("baud").toInt();
  if (baud != 9600 && baud != 19200 && baud != 38400 && baud != 57600 && baud != 115200) {
    diagnosticServer.send(400, "application/json", "{\"ok\":false,\"error\":\"unsupported baud\"}");
    return;
  }
  unoUart.end();
  unoUartBaud = baud;
  unoUart.begin(unoUartBaud, SERIAL_8N1, unoUartRxPin, unoUartTxPin);
  unoUartReady = true;
  unoRecentRx = "";
  unoFrameBuffer = "";
  unoLastFrame = "";
  unoLastRxAt = 0;
  sendUnoStatus();
}

void setUnoPins() {
  const int rx = diagnosticServer.arg("rx").toInt();
  const int tx = diagnosticServer.arg("tx").toInt();
  if (!((rx == 43 && tx == 44) || (rx == 44 && tx == 43))) {
    diagnosticServer.send(400, "application/json",
      "{\"ok\":false,\"error\":\"use rx=43&tx=44 or rx=44&tx=43\"}");
    return;
  }
  unoUart.end();
  unoUartRxPin = static_cast<uint8_t>(rx);
  unoUartTxPin = static_cast<uint8_t>(tx);
  unoUart.begin(unoUartBaud, SERIAL_8N1, unoUartRxPin, unoUartTxPin);
  unoUartReady = true;
  unoRecentRx = "";
  unoFrameBuffer = "";
  unoLastFrame = "";
  unoLastRxAt = 0;
  sendUnoStatus();
}

void sendUnoUltrasonic() {
  String reply;
  const bool received = unoRequest(21, ",\"D1\":2", reply);
  uint16_t distanceCm = 0;
  const bool numeric = received && unoUnsignedReply(reply, distanceCm);
  if (!numeric) {
    diagnosticServer.send(503, "application/json", "{\"ok\":false,\"error\":\"Uno ultrasonic reply unavailable\"}");
    return;
  }
  diagnosticServer.send(200, "application/json",
    "{\"ok\":true,\"distanceCm\":" + String(distanceCm) + "}");
}

void sendUnoLine() {
  uint16_t values[3] = {};
  for (uint8_t index = 0; index < 3; ++index) {
    String reply;
    if (!unoRequest(22, ",\"D1\":" + String(index), reply) ||
        !unoUnsignedReply(reply, values[index])) {
      diagnosticServer.send(503, "application/json", "{\"ok\":false,\"error\":\"Uno line-sensor reply unavailable\"}");
      return;
    }
  }
  diagnosticServer.send(200, "application/json", "{\"ok\":true,\"raw\":[" +
    String(values[0]) + ',' + String(values[1]) + ',' + String(values[2]) + "]}");
}

void setUnoServo() {
  const int angle = diagnosticServer.arg("angle").toInt();
  const int channel = diagnosticServer.hasArg("channel") ? diagnosticServer.arg("channel").toInt() : 1;
  // Do not exceed 90 degrees from the 90-degree center. The stock ELEGOO
  // sketch imposes tighter limits on each physical servo channel.
  const int minimum = channel == 2 ? 30 : 10;
  const int maximum = channel == 2 ? 110 : 170;
  if ((channel != 1 && channel != 2) || angle < minimum || angle > maximum) {
    diagnosticServer.send(400, "application/json", "{\"ok\":false,\"error\":\"channel 1 angle 10..170 or channel 2 angle 30..110 required\"}");
    return;
  }
  // ELEGOO N5 takes D2 in degrees, then its sketch divides by ten and
  // commands the servo in ten-degree increments. Do not multiply here.
  const int appliedAngle = ((angle + 5) / 10) * 10;
  String reply;
  const bool received = unoRequest(5, ",\"D1\":" + String(channel) +
    ",\"D2\":" + String(appliedAngle), reply, 800);
  diagnosticServer.send(received ? 200 : 503, "application/json",
    "{\"ok\":" + String(received ? "true" : "false") + ",\"channel\":" +
    String(channel) + ",\"angle\":" +
    String(angle) + ",\"appliedAngle\":" + String(appliedAngle) +
    ",\"reply\":\"" + unoJsonEscape(reply) + "\"}");
}

void stopUnoMotors() {
  unoDriveActive = false;
  String reply;
  const bool received = unoRequest(110, "", reply, 500);
  diagnosticServer.send(received ? 200 : 503, "application/json",
    "{\"ok\":" + String(received ? "true" : "false") +
    ",\"command\":\"stop\",\"reply\":\"" + unoJsonEscape(reply) + "\"}");
}

void pulseUnoMotors() {
  const String direction = diagnosticServer.arg("direction");
  const int code = direction == "left" ? 1 : direction == "right" ? 2 :
    direction == "forward" ? 3 : direction == "reverse" ? 4 : 0;
  const int speed = diagnosticServer.arg("speed").toInt();
  const int duration = diagnosticServer.arg("ms").toInt();
  if (!code || speed < 0 || speed > 160 || duration < 100 || duration > 800) {
    diagnosticServer.send(400, "application/json",
      "{\"ok\":false,\"error\":\"direction left|right|forward|reverse, speed 0..160, ms 100..800 required\"}");
    return;
  }
  unoDriveActive = false;
  String reply;
  const bool received = unoRequest(2, ",\"D1\":" + String(code) +
    ",\"D2\":" + String(speed) + ",\"T\":" + String(duration), reply, duration + 500);
  String stopReply;
  const bool stopped = unoRequest(110, "", stopReply, 500);
  diagnosticServer.send(received && stopped ? 200 : 503, "application/json",
    "{\"ok\":" + String(received && stopped ? "true" : "false") +
    ",\"direction\":\"" + direction + "\",\"speed\":" + String(speed) +
    ",\"durationMs\":" + String(duration) + ",\"timedReply\":\"" +
    unoJsonEscape(reply) + "\",\"stopReply\":\"" + unoJsonEscape(stopReply) + "\"}");
}

void driveUnoMotors() {
  const String direction = diagnosticServer.arg("direction");
  const int code = direction == "left" ? 1 : direction == "right" ? 2 :
    direction == "forward" ? 3 : direction == "reverse" ? 4 : 0;
  const int speed = diagnosticServer.arg("speed").toInt();
  const int duration = diagnosticServer.arg("ms").toInt();
  if (!code || speed < 0 || speed > 160 || duration < 100 || duration > 800) {
    diagnosticServer.send(400, "application/json",
      "{\"ok\":false,\"error\":\"direction left|right|forward|reverse, speed 0..160, ms 100..800 required\"}");
    return;
  }
  const bool sent = unoSendWithoutReply(2, ",\"D1\":" + String(code) +
    ",\"D2\":" + String(speed) + ",\"T\":" + String(duration));
  if (!sent) {
    unoDriveActive = false;
    diagnosticServer.send(503, "application/json",
      "{\"ok\":false,\"error\":\"ESP UART write failed\"}");
    return;
  }
  unoDriveDeadline = millis() + duration;
  unoDriveActive = true;
  diagnosticServer.send(200, "application/json",
    "{\"ok\":true,\"sent\":true,\"unoAcknowledged\":false,\"direction\":\"" +
    direction + "\",\"speed\":" + String(speed) + ",\"durationMs\":" + String(duration) + "}");
}

void stopUnoDrive() {
  unoDriveActive = false;
  const bool sent = unoSendWithoutReply(110);
  diagnosticServer.send(sent ? 200 : 503, "application/json",
    "{\"ok\":" + String(sent ? "true" : "false") +
    ",\"sent\":" + String(sent ? "true" : "false") +
    ",\"unoAcknowledged\":false,\"command\":\"stop\"}");
}

void turnUnoRgbOff() {
  String reply;
  const bool received = unoRequest(8, UNO_RGB_OFF_FIELDS, reply, 500);
  diagnosticServer.send(received ? 200 : 503, "application/json",
    "{\"ok\":" + String(received ? "true" : "false") +
    ",\"target\":\"Uno shield RGB LED only\",\"reply\":\"" + unoJsonEscape(reply) + "\"}");
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
  xTaskCreatePinnedToCore(cameraTask, "camera-http", 8192, nullptr, 1, nullptr, 0);

  // Keep the camera reachable while the wide sensor loads its firmware over
  // I2C; this can take several seconds on the first initialization.
  initTofSensors();
  initImu();
  initMicrophones();
  initSpeaker();
  boardIoMutex = xSemaphoreCreateMutex();
  speakerControlMutex = xSemaphoreCreateMutex();
  if (boardIoMutex && speakerControlMutex && speakerReady) {
    speakerServer.on("/health", HTTP_GET, [] {
      speakerServer.send(200, "application/json", "{\"ok\":true,\"service\":\"psf-speaker\",\"port\":83}");
    });
    speakerServer.on("/speaker-pcm", HTTP_POST,
      [] { finishSpeakerPcm(speakerServer, dedicatedSpeakerUploadAccepted); },
      [] { receiveSpeakerPcmFrom(speakerServer, dedicatedSpeakerUploadAccepted, true); });
    speakerServer.begin();
    speakerHttpReady = xTaskCreatePinnedToCore(speakerHttpTask, "speaker-http", 8192, nullptr, 1, nullptr, 0) == pdPASS;
    if (!speakerHttpReady) speakerServer.close();
  }

  diagnosticServer.on("/diagnostics", HTTP_GET, sendDiagnostics);
  diagnosticServer.on("/camera/mirror", HTTP_POST, setCameraMirror);
  diagnosticServer.on("/ranges", HTTP_GET, sendRanges);
  diagnosticServer.on("/tof-mode", HTTP_GET, sendTofMode);
  diagnosticServer.on("/tof-mode", HTTP_POST, setTofMode);
  diagnosticServer.on("/wide-range", HTTP_GET, sendWideRange);
  diagnosticServer.on("/wide-tof-resolution", HTTP_GET, sendWideResolution);
  diagnosticServer.on("/wide-tof-resolution", HTTP_POST, setWideResolution);
  diagnosticServer.on("/wide-tof-config", HTTP_GET, sendWideResolution);
  diagnosticServer.on("/wide-tof-config", HTTP_POST, setWideResolution);
  diagnosticServer.on("/imu", HTTP_GET, sendImu);
  diagnosticServer.on("/imu/zero", HTTP_POST, zeroImuOrientation);
  micTraceMutex = xSemaphoreCreateMutex();
  micTraceProceed = xSemaphoreCreateBinary();
  micActivityMutex = xSemaphoreCreateMutex();
  micActivityStopped = xSemaphoreCreateBinary();
  diagnosticServer.on("/mic-data-activity", HTTP_GET, sendMicrophoneActivity);
  diagnosticServer.on("/mic-data-activity", HTTP_POST, startMicrophoneActivityTrace);
  diagnosticServer.on("/mic-data-activity-stop", HTTP_POST, stopMicrophoneActivity);
  diagnosticServer.on("/mic-restore-trace", HTTP_GET, sendMicrophoneRestoreTrace);
  diagnosticServer.on("/mic-restore-trace", HTTP_POST, startMicrophoneRestoreTrace);
  diagnosticServer.on("/mic-restore-trace-next", HTTP_POST, advanceMicrophoneRestoreTrace);
  diagnosticServer.on("/mic-restore-trace-abort", HTTP_POST, abortMicrophoneRestoreTrace);
  diagnosticServer.on("/mic-rx-comparison", HTTP_GET, sendMicrophoneRxComparison);
  diagnosticServer.on("/mic-rx-comparison", HTTP_POST, [] { if (micTraceRunning) { diagnosticServer.send(409, "application/json", "{\"ok\":false,\"error\":\"restore trace owns microphone; use trace-abort\"}"); return; } startMicrophoneRxComparison(); });
  diagnosticServer.on("/mic-gpio", HTTP_GET, sendMicrophoneGpio);
  diagnosticServer.on("/mic-levels", HTTP_GET, [] { if (micTraceRunning) { diagnosticServer.send(409, "application/json", "{\"ok\":false,\"error\":\"restore trace owns microphone; use trace-abort\"}"); return; } sendMicrophoneLevels(); });
  diagnosticServer.on("/mic-pin-test", HTTP_GET, [] { if (micTraceRunning) { diagnosticServer.send(409, "application/json", "{\"ok\":false,\"error\":\"restore trace owns microphone; use trace-abort\"}"); return; } sendMicrophonePinTest(); });
  diagnosticServer.on("/mic-live-pull-test", HTTP_GET, [] { if (micTraceRunning) { diagnosticServer.send(409, "application/json", "{\"ok\":false,\"error\":\"restore trace owns microphone; use trace-abort\"}"); return; } sendMicrophoneLivePullTest(); });
  diagnosticServer.on("/mic-line-test", HTTP_GET, [] { if (micTraceRunning) { diagnosticServer.send(409, "application/json", "{\"ok\":false,\"error\":\"restore trace owns microphone; use trace-abort\"}"); return; } sendMicrophoneLineTest(); });
  diagnosticServer.on("/mic-raw-clock-test", HTTP_GET, [] { if (micTraceRunning) { diagnosticServer.send(409, "application/json", "{\"ok\":false,\"error\":\"restore trace owns microphone; use trace-abort\"}"); return; } sendMicrophoneRawClockTest(); });
  diagnosticServer.on("/mic-pcnt-test", HTTP_GET, [] { if (micTraceRunning) { diagnosticServer.send(409, "application/json", "{\"ok\":false,\"error\":\"restore trace owns microphone; use trace-abort\"}"); return; } sendMicrophonePcntTest(); });
  diagnosticServer.on("/mic-line-hold", HTTP_GET, sendMicrophoneLineHoldStatus);
  diagnosticServer.on("/mic-data-high", HTTP_POST, [] { if (micTraceRunning) { diagnosticServer.send(409, "application/json", "{\"ok\":false,\"error\":\"restore trace owns microphone; use trace-abort\"}"); return; } holdMicrophoneDataHigh(); });
  diagnosticServer.on("/mic-data-low", HTTP_POST, [] { if (micTraceRunning) { diagnosticServer.send(409, "application/json", "{\"ok\":false,\"error\":\"restore trace owns microphone; use trace-abort\"}"); return; } holdMicrophoneDataLow(); });
  diagnosticServer.on("/mic-data-float", HTTP_POST, [] { if (micTraceRunning) { diagnosticServer.send(409, "application/json", "{\"ok\":false,\"error\":\"restore trace owns microphone; use trace-abort\"}"); return; } holdMicrophoneDataFloat(); });
  diagnosticServer.on("/mic-data-clock", HTTP_POST, [] { if (micTraceRunning) { diagnosticServer.send(409, "application/json", "{\"ok\":false,\"error\":\"restore trace owns microphone; use trace-abort\"}"); return; } startMicrophoneFloatingDataClock(); });
  diagnosticServer.on("/mic-line-restore", HTTP_POST, [] { if (micTraceRunning) { diagnosticServer.send(409, "application/json", "{\"ok\":false,\"error\":\"restore trace owns microphone; use trace-abort\"}"); return; } restoreMicrophoneClock(); });
  diagnosticServer.on("/mic-clock-low", HTTP_POST, [] { if (micTraceRunning) { diagnosticServer.send(409, "application/json", "{\"ok\":false,\"error\":\"restore trace owns microphone; use trace-abort\"}"); return; } holdMicrophoneClockLow(); });
  diagnosticServer.on("/mic-clock-high", HTTP_POST, [] { if (micTraceRunning) { diagnosticServer.send(409, "application/json", "{\"ok\":false,\"error\":\"restore trace owns microphone; use trace-abort\"}"); return; } holdMicrophoneClockHigh(); });
  diagnosticServer.on("/mic-clock-edges", HTTP_GET, [] { if (micTraceRunning) { diagnosticServer.send(409, "application/json", "{\"ok\":false,\"error\":\"restore trace owns microphone; use trace-abort\"}"); return; } sendMicrophoneHeldClockEdges(); });
  diagnosticServer.on("/mic-clock-restore", HTTP_POST, [] { if (micTraceRunning) { diagnosticServer.send(409, "application/json", "{\"ok\":false,\"error\":\"restore trace owns microphone; use trace-abort\"}"); return; } restoreMicrophoneClock(); });
  diagnosticServer.on("/mic-capture.wav", HTTP_GET, [] { if (micTraceRunning) { diagnosticServer.send(409, "application/json", "{\"ok\":false,\"error\":\"restore trace owns microphone; use trace-abort\"}"); return; } sendMicrophoneWav(); });
  diagnosticServer.on("/speaker-test", HTTP_POST, [] { handleSpeakerDiagnostic(sendSpeakerTest); });
  diagnosticServer.on("/speaker-chime", HTTP_POST, [] { handleSpeakerDiagnostic(sendSpeakerChime); });
  diagnosticServer.on("/startup-sequence", HTTP_POST, [] { handleSpeakerDiagnostic(sendStartupSequence); });
  diagnosticServer.on("/speaker-pcm", HTTP_POST,
    [] { finishSpeakerPcm(diagnosticServer, legacySpeakerUploadAccepted); },
    [] { receiveSpeakerPcmFrom(diagnosticServer, legacySpeakerUploadAccepted, false); });
  diagnosticServer.on("/led", HTTP_GET, setLed);
  diagnosticServer.on("/ir", HTTP_GET, controlIrBank);
  diagnosticServer.on("/ir", HTTP_POST, controlIrBank);
  diagnosticServer.on("/uno/status", HTTP_GET, sendUnoStatus);
  diagnosticServer.on("/uno/baud", HTTP_POST, setUnoBaud);
  diagnosticServer.on("/uno/pins", HTTP_POST, setUnoPins);
  diagnosticServer.on("/uno/ultrasonic", HTTP_GET, sendUnoUltrasonic);
  diagnosticServer.on("/uno/line", HTTP_GET, sendUnoLine);
  diagnosticServer.on("/uno/servo", HTTP_POST, setUnoServo);
  diagnosticServer.on("/uno/motor-pulse", HTTP_POST, pulseUnoMotors);
  diagnosticServer.on("/uno/drive", HTTP_POST, driveUnoMotors);
  diagnosticServer.on("/uno/drive-stop", HTTP_POST, stopUnoDrive);
  diagnosticServer.on("/uno/stop", HTTP_POST, stopUnoMotors);
  diagnosticServer.on("/uno/rgb-off", HTTP_POST, turnUnoRgbOff);
  diagnosticServer.begin();
  Serial.printf("Camera port %u, diagnostics port %u\n", CAMERA_PORT, DIAGNOSTIC_PORT);
  // GPIO43/44 are also the ESP32-S3's default UART0 console pins. Release
  // them before assigning UART1 to the ELEGOO shield's 9600-baud link.
  Serial.flush();
  Serial.end();
  unoUart.setRxBufferSize(512);
  unoUart.begin(unoUartBaud, SERIAL_8N1, unoUartRxPin, unoUartTxPin);
  unoUartReady = true;
  unoStartupLedClearsRemaining = 3;
  unoStartupLedNextAt = millis() + 200;
}

void loop() {
  // Arduino's loop task is pinned to core 1. Package sensor responses here
  // alongside acquisition; camera serving and TCP/IP run on core 0.
  if (boardIoMutex) xSemaphoreTake(boardIoMutex, portMAX_DELAY);
  diagnosticServer.handleClient();
  pollMicrophoneRxComparison();
  pollUnoDriveDeadline();
  pollUnoStartupLedClear();
  pollUnoUart();
  pollNarrowTof(frontTof, frontTofReady, frontTofSample,
    frontTofMode, frontTofAuto, frontTofInvalidSince);
  pollNarrowTof(rearTof, rearTofReady, rearTofSample,
    rearTofMode, rearTofAuto, rearTofInvalidSince);
  pollImu();
  if (wideTofReady && millis() - wideLastPollAt >= 5) {
    wideLastPollAt = millis();
    if (wideTof.isDataReady() && wideTof.getRangingData(&wideResults)) {
      const uint32_t capturedAt = millis();
      wideFramePeriodMs = wideHasFrame ? capturedAt - wideCapturedAt : 0;
      ++wideFrameSequence;
      wideHasFrame = true;
      wideCapturedAt = capturedAt;
    }
  }
  if (boardIoMutex) xSemaphoreGive(boardIoMutex);
  delay(2);
}
