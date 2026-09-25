// PSF Sensor Board v1.3: first hardware bring-up firmware.
// The drive ESP32 continues to own motors, its IR guard, and the deadman.
// This image provides camera endpoints on port 81 and diagnostics on port 82.
// ToF distance, IMU samples, microphones, speaker, IR emitters, and UART
// telemetry are deliberately not reported as working until their drivers
// have been brought up on the physical board.

#include <WiFi.h>
#include <WebServer.h>
#include <Wire.h>
#include <ESPmDNS.h>
#include <esp_camera.h>
#include <esp32-hal-rmt.h>

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
uint32_t bootMs = 0;
uint8_t ledValues[LED_COUNT][4] = {};

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

void initExpander() {
  if (!i2cPresent(TCA9534_ADDRESS)) return;
  // Configure only the four pins documented in the v1.3 pinout. P0/P1
  // hold the two VL53L1CB sensors in reset; P2/P3 release the VL53L5CX.
  // P4-P7 stay inputs until the remaining board-control nets are verified.
  const bool outputSet = writeExpander(0x01, 0x0C);
  const bool directionSet = writeExpander(0x03, 0xF0);
  expanderReady = outputSet && directionSet;
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
  body += ",\"firmware\":\"bring-up-1\",\"uptimeMs\":" + String(millis() - bootMs);
  body += ",\"cameraReady\":" + String(cameraReady ? "true" : "false");
  body += ",\"expanderReady\":" + String(expanderReady ? "true" : "false");
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
  body += ",\"expanderReady\":" + String(expanderReady ? "true" : "false");
  body += ",\"tofWideDetected\":" + String(i2cPresent(0x29) ? "true" : "false");
  body += ",\"imuDetected\":" + String((i2cPresent(0x68) || i2cPresent(0x69)) ? "true" : "false");
  body += ",\"distanceMm\":null,\"imuSample\":null}";
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
  initExpander();
  ledsReady = rmtInit(LED_PIN, RMT_TX_MODE, RMT_MEM_NUM_BLOCKS_1, 10000000);
  if (ledsReady) showLeds(); // all off at boot
  cameraReady = initCamera();
  connectWifi();

  cameraServer.on("/health", HTTP_GET, sendHealth);
  cameraServer.on("/capture", HTTP_GET, sendCapture);
  cameraServer.on("/stream", HTTP_GET, sendStream);
  cameraServer.begin();
  xTaskCreatePinnedToCore(cameraTask, "camera-http", 8192, nullptr, 1, nullptr, 1);

  diagnosticServer.on("/diagnostics", HTTP_GET, sendDiagnostics);
  diagnosticServer.on("/led", HTTP_GET, setLed);
  diagnosticServer.begin();
  Serial.printf("Camera port %u, diagnostics port %u\n", CAMERA_PORT, DIAGNOSTIC_PORT);
}

void loop() {
  diagnosticServer.handleClient();
  delay(2);
}
