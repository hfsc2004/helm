// ESP32-S3 Video Board for PSF Helm.
//
// Exposes the three endpoints Helm expects from a camera sidecar:
//   GET /stream    - multipart/x-mixed-replace MJPEG stream
//   GET /capture   - single JPEG snapshot
//   GET /health    - {"ok":true,"uptimeMs":...,"sensor":"OV2640",...}
//
// Joins the LAN as STA (configurable static IP) so Helm can reach the board
// at a stable address. No AP mode and no host-discovery handshake — keeps
// the firmware tiny and the data path predictable.
//
// Pin profile is selected at flash time via the template var
// `camera.pinProfile`. Add more profiles by extending the #if/#elif chain
// below; values map to a single CAMERA_MODEL_* define.

#include <WiFi.h>
#include <WebServer.h>
#include "esp_camera.h"

// ===== Wi-Fi =====
const char* WIFI_SSID = "{{wifi.ssid}}";
const char* WIFI_PASS = "{{wifi.password}}";

const bool USE_STATIC_IP = {{wifi.useStatic}};
const IPAddress STATIC_IP({{wifi.staticIp.octets}});
const int STATIC_CIDR = {{wifi.staticCidr}};
const IPAddress STATIC_DNS1(1, 1, 1, 1);
const IPAddress STATIC_DNS2(8, 8, 8, 8);
const unsigned long WIFI_CONNECT_TIMEOUT_MS = 30000;
const unsigned long WIFI_RETRY_DELAY_MS = 500;

// ===== HTTP =====
const int HTTP_PORT = {{http.port}};
WebServer server(HTTP_PORT);

// ===== Camera =====
// Pin profile is a string in the template; the render step substitutes
// it into the #define below and the right block of pin assignments is
// selected at compile time.
#define CAMERA_PIN_PROFILE "{{camera.pinProfile}}"
#define CAMERA_FRAME_SIZE_NAME "{{camera.frameSize}}"
const int CAMERA_JPEG_QUALITY = {{camera.jpegQuality}};

// Resolve frame size name -> framesize_t at runtime once, in setup().
framesize_t resolveFrameSize(const char* name) {
  if (strcmp(name, "QVGA") == 0) return FRAMESIZE_QVGA;
  if (strcmp(name, "VGA")  == 0) return FRAMESIZE_VGA;
  if (strcmp(name, "SVGA") == 0) return FRAMESIZE_SVGA;
  if (strcmp(name, "XGA")  == 0) return FRAMESIZE_XGA;
  if (strcmp(name, "HD")   == 0) return FRAMESIZE_HD;
  return FRAMESIZE_VGA;
}

// ---------------- Pin maps ----------------
// Three profiles supported out of the box. Picked via CAMERA_PIN_PROFILE.
// Values are the standard pin maps from Espressif's esp32-camera examples;
// override at flash time with --build-property if you have a board not
// listed here, then push a new profile back upstream.

#if defined(CAMERA_PIN_PROFILE_ESP32S3_EYE) || \
    (defined(CAMERA_PIN_PROFILE_DEFAULT)   && !defined(CAMERA_PIN_PROFILE_AI_THINKER_S3) && !defined(CAMERA_PIN_PROFILE_ELEGOO_S3))
// ESP32-S3-EYE (Espressif dev board)
#define PWDN_GPIO_NUM     -1
#define RESET_GPIO_NUM    -1
#define XCLK_GPIO_NUM     15
#define SIOD_GPIO_NUM      4
#define SIOC_GPIO_NUM      5
#define Y2_GPIO_NUM       11
#define Y3_GPIO_NUM        9
#define Y4_GPIO_NUM        8
#define Y5_GPIO_NUM       10
#define Y6_GPIO_NUM       12
#define Y7_GPIO_NUM       18
#define Y8_GPIO_NUM       17
#define Y9_GPIO_NUM       16
#define VSYNC_GPIO_NUM     6
#define HREF_GPIO_NUM      7
#define PCLK_GPIO_NUM     13
#endif

#ifdef CAMERA_PIN_PROFILE_AI_THINKER_S3
// AI-Thinker ESP32-S3-CAM
#define PWDN_GPIO_NUM     -1
#define RESET_GPIO_NUM    -1
#define XCLK_GPIO_NUM     10
#define SIOD_GPIO_NUM     40
#define SIOC_GPIO_NUM     39
#define Y2_GPIO_NUM       15
#define Y3_GPIO_NUM       17
#define Y4_GPIO_NUM       18
#define Y5_GPIO_NUM       16
#define Y6_GPIO_NUM       14
#define Y7_GPIO_NUM       12
#define Y8_GPIO_NUM       11
#define Y9_GPIO_NUM       48
#define VSYNC_GPIO_NUM    38
#define HREF_GPIO_NUM     47
#define PCLK_GPIO_NUM     13
#endif

#ifdef CAMERA_PIN_PROFILE_ELEGOO_S3
// Elegoo ESP32-S3-WROOM-1 camera shield
#define PWDN_GPIO_NUM     -1
#define RESET_GPIO_NUM    -1
#define XCLK_GPIO_NUM     15
#define SIOD_GPIO_NUM      4
#define SIOC_GPIO_NUM      5
#define Y2_GPIO_NUM       11
#define Y3_GPIO_NUM        9
#define Y4_GPIO_NUM        8
#define Y5_GPIO_NUM       10
#define Y6_GPIO_NUM       12
#define Y7_GPIO_NUM       18
#define Y8_GPIO_NUM       17
#define Y9_GPIO_NUM       16
#define VSYNC_GPIO_NUM     6
#define HREF_GPIO_NUM      7
#define PCLK_GPIO_NUM     13
#endif

// Fall-through: if no profile macro was set via --build-property, default to S3-EYE.
#ifndef XCLK_GPIO_NUM
#define PWDN_GPIO_NUM     -1
#define RESET_GPIO_NUM    -1
#define XCLK_GPIO_NUM     15
#define SIOD_GPIO_NUM      4
#define SIOC_GPIO_NUM      5
#define Y2_GPIO_NUM       11
#define Y3_GPIO_NUM        9
#define Y4_GPIO_NUM        8
#define Y5_GPIO_NUM       10
#define Y6_GPIO_NUM       12
#define Y7_GPIO_NUM       18
#define Y8_GPIO_NUM       17
#define Y9_GPIO_NUM       16
#define VSYNC_GPIO_NUM     6
#define HREF_GPIO_NUM      7
#define PCLK_GPIO_NUM     13
#endif

unsigned long bootMillis = 0;

bool initCamera() {
  camera_config_t config;
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer   = LEDC_TIMER_0;
  config.pin_d0       = Y2_GPIO_NUM;
  config.pin_d1       = Y3_GPIO_NUM;
  config.pin_d2       = Y4_GPIO_NUM;
  config.pin_d3       = Y5_GPIO_NUM;
  config.pin_d4       = Y6_GPIO_NUM;
  config.pin_d5       = Y7_GPIO_NUM;
  config.pin_d6       = Y8_GPIO_NUM;
  config.pin_d7       = Y9_GPIO_NUM;
  config.pin_xclk     = XCLK_GPIO_NUM;
  config.pin_pclk     = PCLK_GPIO_NUM;
  config.pin_vsync    = VSYNC_GPIO_NUM;
  config.pin_href     = HREF_GPIO_NUM;
  config.pin_sccb_sda = SIOD_GPIO_NUM;
  config.pin_sccb_scl = SIOC_GPIO_NUM;
  config.pin_pwdn     = PWDN_GPIO_NUM;
  config.pin_reset    = RESET_GPIO_NUM;
  config.xclk_freq_hz = 20000000;
  config.pixel_format = PIXFORMAT_JPEG;
  config.frame_size   = resolveFrameSize(CAMERA_FRAME_SIZE_NAME);
  config.jpeg_quality = CAMERA_JPEG_QUALITY;
  config.fb_count     = psramFound() ? 2 : 1;
  config.fb_location  = psramFound() ? CAMERA_FB_IN_PSRAM : CAMERA_FB_IN_DRAM;
  config.grab_mode    = CAMERA_GRAB_LATEST;

  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) {
    Serial.printf("Camera init failed: 0x%x\n", err);
    return false;
  }
  return true;
}

// ---------------- HTTP handlers ----------------

void sendJpegSnapshot() {
  camera_fb_t* fb = esp_camera_fb_get();
  if (!fb) {
    server.send(500, "text/plain", "fb capture failed");
    return;
  }
  WiFiClient client = server.client();
  client.printf("HTTP/1.1 200 OK\r\n");
  client.printf("Content-Type: image/jpeg\r\n");
  client.printf("Content-Length: %u\r\n", fb->len);
  client.printf("Access-Control-Allow-Origin: *\r\n\r\n");
  client.write(fb->buf, fb->len);
  esp_camera_fb_return(fb);
}

void streamMjpeg() {
  WiFiClient client = server.client();
  String boundary = "psfhelmboundary";
  client.printf("HTTP/1.1 200 OK\r\n");
  client.printf("Content-Type: multipart/x-mixed-replace; boundary=%s\r\n", boundary.c_str());
  client.printf("Access-Control-Allow-Origin: *\r\n\r\n");

  while (client.connected()) {
    camera_fb_t* fb = esp_camera_fb_get();
    if (!fb) break;
    client.printf("--%s\r\nContent-Type: image/jpeg\r\nContent-Length: %u\r\n\r\n",
                  boundary.c_str(), fb->len);
    client.write(fb->buf, fb->len);
    client.print("\r\n");
    esp_camera_fb_return(fb);
    if (!client.connected()) break;
    delay(15);
  }
}

void sendHealth() {
  sensor_t* s = esp_camera_sensor_get();
  const char* sensorName = "unknown";
  if (s) {
    switch (s->id.PID) {
      case OV2640_PID: sensorName = "OV2640"; break;
      case OV3660_PID: sensorName = "OV3660"; break;
      case OV5640_PID: sensorName = "OV5640"; break;
      default: sensorName = "other"; break;
    }
  }
  String body = "{\"ok\":true,\"uptimeMs\":";
  body += String(millis() - bootMillis);
  body += ",\"sensor\":\"";
  body += sensorName;
  body += "\",\"profile\":\"";
  body += CAMERA_PIN_PROFILE;
  body += "\",\"rssi\":";
  body += String(WiFi.RSSI());
  body += "}";
  server.send(200, "application/json", body);
}

// ---------------- Wi-Fi ----------------

IPAddress cidrToMask(int cidr) {
  if (cidr < 0) cidr = 0;
  if (cidr > 32) cidr = 32;
  uint32_t mask = cidr == 0 ? 0 : (0xFFFFFFFFu << (32 - cidr));
  return IPAddress((mask >> 24) & 0xFF, (mask >> 16) & 0xFF, (mask >> 8) & 0xFF, mask & 0xFF);
}

IPAddress derivedGateway(IPAddress ip) {
  return IPAddress(ip[0], ip[1], ip[2], 1);
}

bool connectWifi() {
  WiFi.mode(WIFI_STA);
  if (USE_STATIC_IP) {
    IPAddress mask = cidrToMask(STATIC_CIDR);
    IPAddress gw = derivedGateway(STATIC_IP);
    if (!WiFi.config(STATIC_IP, gw, mask, STATIC_DNS1, STATIC_DNS2)) {
      Serial.println("WiFi.config() failed");
    }
  }
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED) {
    if (millis() - start > WIFI_CONNECT_TIMEOUT_MS) return false;
    delay(WIFI_RETRY_DELAY_MS);
    Serial.print(".");
  }
  Serial.println();
  Serial.print("WiFi up at ");
  Serial.println(WiFi.localIP());
  return true;
}

void setup() {
  Serial.begin(115200);
  delay(100);
  Serial.println("PSF Helm video board booting");
  bootMillis = millis();

  if (!initCamera()) {
    Serial.println("camera init failed; halting");
    while (true) delay(1000);
  }

  if (!connectWifi()) {
    Serial.println("wifi failed; rebooting in 5s");
    delay(5000);
    ESP.restart();
  }

  server.on("/stream",  HTTP_GET, streamMjpeg);
  server.on("/capture", HTTP_GET, sendJpegSnapshot);
  server.on("/health",  HTTP_GET, sendHealth);
  server.onNotFound([]() { server.send(404, "text/plain", "not found"); });
  server.begin();
  Serial.printf("HTTP up on port %d\n", HTTP_PORT);
}

void loop() {
  server.handleClient();
}
