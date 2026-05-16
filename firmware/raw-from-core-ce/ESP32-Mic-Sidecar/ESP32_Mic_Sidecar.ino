// ESP32 Roving Microphone Sidecar (STARTER — UNTESTED ON HARDWARE)
//
// Reads I2S audio from an INMP441 (or compatible) MEMS microphone and
// streams it as chunked HTTP. Helm's <AudioFeed> component plays the stream
// in the desktop UI.
//
// Wiring (INMP441 → ESP32):
//   VDD  → 3.3V
//   GND  → GND
//   SD   → GPIO 32  (DATA_IN)
//   SCK  → GPIO 33  (BIT_CLOCK / BCLK)
//   WS   → GPIO 25  (LRCK / WORD_SELECT)
//   L/R  → GND      (left channel only, mono)
//
// Format on the wire: 16 kHz, mono, signed 16-bit little-endian PCM.
// HTTP path: GET /audio  (chunked, never closes voluntarily)
// HTTP path: GET /health (one-shot JSON)
//
// Audio stays on the LAN. Helm does not record, transcribe, or transmit
// it off the local network — see core/privacy.ts.
//
// STATUS: starter sketch. Not yet bench-tested. The pin assignments,
// I2S configuration, and Arduino HTTP chunking pattern are right in
// principle but each line should be verified against your specific
// ESP32 board + Arduino-ESP32 core version before relying on it in
// production.

#include <WiFi.h>
#include <WebServer.h>
#include <driver/i2s.h>

// ===== Wi-Fi =====
const char* WIFI_SSID = "YOUR_WIFI_SSID";
const char* WIFI_PASS = "YOUR_WIFI_PASSWORD";

// ===== I2S Pins (INMP441) =====
const i2s_port_t I2S_PORT = I2S_NUM_0;
const int PIN_I2S_DATA_IN = 32;
const int PIN_I2S_BIT_CLOCK = 33;
const int PIN_I2S_WORD_SELECT = 25;

// ===== Audio format =====
const uint32_t SAMPLE_RATE_HZ = 16000;
const int BITS_PER_SAMPLE = 16;
const int CHANNELS = 1;

// ===== HTTP =====
const int HTTP_PORT = 82;
WebServer server(HTTP_PORT);

// I2S read buffer.
static const size_t I2S_READ_FRAMES = 256;
static int16_t i2sBuffer[I2S_READ_FRAMES];

void setupI2S() {
  i2s_config_t cfg = {};
  cfg.mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_RX);
  cfg.sample_rate = SAMPLE_RATE_HZ;
  cfg.bits_per_sample = I2S_BITS_PER_SAMPLE_16BIT;
  cfg.channel_format = I2S_CHANNEL_FMT_ONLY_LEFT;
  cfg.communication_format = I2S_COMM_FORMAT_STAND_I2S;
  cfg.intr_alloc_flags = ESP_INTR_FLAG_LEVEL1;
  cfg.dma_buf_count = 4;
  cfg.dma_buf_len = 256;
  cfg.use_apll = false;
  cfg.tx_desc_auto_clear = false;
  cfg.fixed_mclk = 0;

  i2s_pin_config_t pins = {};
  pins.bck_io_num = PIN_I2S_BIT_CLOCK;
  pins.ws_io_num = PIN_I2S_WORD_SELECT;
  pins.data_out_num = I2S_PIN_NO_CHANGE;
  pins.data_in_num = PIN_I2S_DATA_IN;

  i2s_driver_install(I2S_PORT, &cfg, 0, NULL);
  i2s_set_pin(I2S_PORT, &pins);
  i2s_zero_dma_buffer(I2S_PORT);
}

void connectWifi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.print("Connecting WiFi");
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED) {
    delay(300);
    Serial.print(".");
    if (millis() - start > 30000) {
      Serial.println("\nWiFi timeout, retrying...");
      WiFi.disconnect(true);
      delay(500);
      WiFi.begin(WIFI_SSID, WIFI_PASS);
      start = millis();
    }
  }
  Serial.println();
  Serial.print("WiFi connected. IP: ");
  Serial.println(WiFi.localIP());
}

void handleHealth() {
  String body = "{";
  body += "\"ok\":true,";
  body += "\"ip\":\"" + WiFi.localIP().toString() + "\",";
  body += "\"sampleRate\":" + String(SAMPLE_RATE_HZ) + ",";
  body += "\"bitsPerSample\":" + String(BITS_PER_SAMPLE) + ",";
  body += "\"channels\":" + String(CHANNELS) + ",";
  body += "\"format\":\"pcm-s16le\"";
  body += "}";
  server.send(200, "application/json", body);
}

void handleAudio() {
  WiFiClient client = server.client();
  if (!client) return;

  // Manual HTTP/1.1 chunked response so we can stream indefinitely.
  client.print(
    "HTTP/1.1 200 OK\r\n"
    "Content-Type: audio/L16;rate=16000;channels=1\r\n"
    "Cache-Control: no-cache\r\n"
    "Connection: close\r\n"
    "Transfer-Encoding: chunked\r\n"
    "\r\n"
  );

  size_t bytesRead = 0;
  // Stream until the client disconnects.
  while (client.connected()) {
    esp_err_t err = i2s_read(
      I2S_PORT,
      (void*)i2sBuffer,
      sizeof(i2sBuffer),
      &bytesRead,
      portMAX_DELAY
    );
    if (err != ESP_OK || bytesRead == 0) {
      // I2S hiccup — keep the connection but yield briefly.
      delay(2);
      continue;
    }

    // INMP441 returns 16-bit samples in the upper bits of a 32-bit word
    // when reading 16-bit; some boards return 16-bit directly. Adjust
    // here if levels are wrong on your specific hardware.

    // Chunked-encoding frame: hex-size CRLF data CRLF
    char sizeBuf[8];
    snprintf(sizeBuf, sizeof(sizeBuf), "%X\r\n", (unsigned int)bytesRead);
    client.print(sizeBuf);
    client.write((const uint8_t*)i2sBuffer, bytesRead);
    client.print("\r\n");
  }

  // Final zero-length chunk.
  client.print("0\r\n\r\n");
  client.stop();
}

void setup() {
  Serial.begin(115200);
  delay(50);

  setupI2S();
  connectWifi();

  server.on("/health", HTTP_GET, handleHealth);
  server.on("/audio", HTTP_GET, handleAudio);
  server.begin();

  Serial.print("Mic sidecar ready on port ");
  Serial.println(HTTP_PORT);
  Serial.println("Endpoints: GET /health, GET /audio");
}

void loop() {
  server.handleClient();
  delay(2);
}
