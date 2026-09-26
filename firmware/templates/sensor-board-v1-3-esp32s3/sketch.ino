// PSF Sensor Board v1.3 bench bring-up firmware.
// Camera endpoints are on port 81; sensors and LED diagnostics are on port 82.
// No motor endpoint is provided. IMU samples, microphones, speaker, IR
// emitters, and UART telemetry are not reported until their drivers are tested.

#include <WiFi.h>
#include <WebServer.h>
#include <Wire.h>
#include <ESPmDNS.h>
#include <esp_camera.h>
#include <esp32-hal-rmt.h>
#include <VL53L1X.h>
#include <Adafruit_VL53L5CX.h>

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
static constexpr uint8_t FRONT_TOF_ADDRESS = 0x30;
static constexpr uint8_t REAR_TOF_ADDRESS = 0x31;
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
uint32_t bootMs = 0;
uint8_t ledValues[LED_COUNT][4] = {};
VL53L1X frontTof;
VL53L1X rearTof;
Adafruit_VL53L5CX wideTof;
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

void initExpander() {
  expanderReady = false;
  if (!i2cPresent(TCA9534_ADDRESS)) return;
  // Hold all ToFs in reset while assigning distinct addresses to the two
  // VL53L1CB devices. P3 high also held the wide VL53L5CX off on the bench.
  // P4-P7 stay inputs until the remaining board-control nets are verified.
  const bool outputSet = writeExpander(0x01, 0x08);
  const bool directionSet = writeExpander(0x03, 0xF0);
  uint8_t output = 0, direction = 0;
  const bool outputVerified = readRegister8(TCA9534_ADDRESS, 0x01, &output) && output == 0x08;
  const bool directionVerified = readRegister8(TCA9534_ADDRESS, 0x03, &direction) && direction == 0xF0;
  expanderReady = outputSet && directionSet && outputVerified && directionVerified;
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
  body += ",\"firmware\":\"bring-up-2\",\"uptimeMs\":" + String(millis() - bootMs);
  body += ",\"cameraReady\":" + String(cameraReady ? "true" : "false");
  body += ",\"expanderReady\":" + String(expanderReady ? "true" : "false");
  body += ",\"frontTofReady\":" + String(frontTofReady ? "true" : "false");
  body += ",\"rearTofReady\":" + String(rearTofReady ? "true" : "false");
  body += ",\"wideTofReady\":" + String(wideTofReady ? "true" : "false");
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
  uint8_t expanderOutput = 0, expanderConfig = 0;
  const bool outputReadable = readRegister8(TCA9534_ADDRESS, 0x01, &expanderOutput);
  const bool configReadable = readRegister8(TCA9534_ADDRESS, 0x03, &expanderConfig);
  body += ",\"expanderPresent\":" + String(i2cPresent(TCA9534_ADDRESS) ? "true" : "false");
  body += ",\"expanderOutput\":" + String(outputReadable ? String(expanderOutput) : "null");
  body += ",\"expanderConfig\":" + String(configReadable ? String(expanderConfig) : "null");
  body += ",\"expanderReady\":" + String(expanderReady ? "true" : "false");
  body += ",\"frontTofReady\":" + String(frontTofReady ? "true" : "false");
  body += ",\"rearTofReady\":" + String(rearTofReady ? "true" : "false");
  body += ",\"wideTofReady\":" + String(wideTofReady ? "true" : "false");
  body += ",\"frontAddressResponds\":" + String(i2cPresent(FRONT_TOF_ADDRESS) ? "true" : "false");
  body += ",\"rearAddressResponds\":" + String(i2cPresent(REAR_TOF_ADDRESS) ? "true" : "false");
  body += ",\"tofDefaultAddressResponds\":" + String(i2cPresent(0x29) ? "true" : "false");
  body += ",\"imuAddressResponds\":" + String((i2cPresent(0x68) || i2cPresent(0x69)) ? "true" : "false");
  body += ",\"distanceMm\":null,\"imuSample\":null}";
  diagnosticServer.send(200, "application/json", body);
}

void appendNarrowRange(String &body, const char *name,
                       VL53L1X &sensor, bool ready) {
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
  body += "{\"name\":\"" + String(name) + "\",\"ready\":";
  body += ready ? "true" : "false";
  body += ",\"timeout\":";
  body += timedOut ? "true" : "false";
  body += ",\"rangeStatus\":" + String(status);
  body += ",\"distanceMm\":";
  body += valid ? String(mm) : "null";
  body += '}';
}

void sendRanges() {
  String body = "{\"ok\":true,\"singleZone\":[";
  appendNarrowRange(body, "front", frontTof, frontTofReady);
  body += ',';
  appendNarrowRange(body, "rear", rearTof, rearTofReady);
  body += "],\"wideReady\":" + String(wideTofReady ? "true" : "false") + '}';
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

  diagnosticServer.on("/diagnostics", HTTP_GET, sendDiagnostics);
  diagnosticServer.on("/ranges", HTTP_GET, sendRanges);
  diagnosticServer.on("/wide-range", HTTP_GET, sendWideRange);
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
