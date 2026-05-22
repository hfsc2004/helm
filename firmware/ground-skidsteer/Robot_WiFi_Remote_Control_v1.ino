// ESP32 Wi-Fi Remote Control (Skid-Steer)
// - Connects to home Wi-Fi
// - HTTP command endpoint for drive control
// - Deadman timeout auto-stops motors
// - Telemetry endpoint for status

#include <WiFi.h>
#include <WebServer.h>
#include <ESPmDNS.h>

// ===== Wi-Fi =====
const char* WIFI_SSID = "YOUR_WIFI_SSID";
const char* WIFI_PASS = "YOUR_WIFI_PASSWORD";

// mDNS hostname — the robot will be reachable as "<MDNS_NAME>.local"
// from any host on the same LAN, even if DHCP hands it a new IP.
const char* MDNS_NAME = "psf-robot";

// Network mode:
// - false: DHCP (router assigns IP/subnet/gateway/DNS)
// - true : Static IP using values below
const bool USE_STATIC_IP = false;
const IPAddress STATIC_IP(192, 168, 1, 50);

// Primary static network form (recommended): CIDR prefix
// Example: /24 => 255.255.255.0
const int STATIC_CIDR = 24; // valid 0..32

// Optional static network overrides.
// If USE_STATIC_GATEWAY=false, gateway is auto-derived from STATIC_IP (.1 host).
// STATIC_SUBNET still exists as fallback if STATIC_CIDR is invalid.
const bool USE_STATIC_GATEWAY = false;
const IPAddress STATIC_GATEWAY(192, 168, 1, 1);
const IPAddress STATIC_SUBNET(255, 255, 255, 0); // fallback only
const IPAddress STATIC_DNS1(1, 1, 1, 1);
const IPAddress STATIC_DNS2(8, 8, 8, 8);

const unsigned long WIFI_CONNECT_TIMEOUT_MS = 30000;
const unsigned long WIFI_RETRY_DELAY_MS = 500;

// ===== Motor pins (L298N) =====
const int ENA = 12; // left PWM
const int IN1 = 13; // left dir A
const int IN2 = 14; // left dir B
const int ENB = 25; // right PWM
const int IN3 = 26; // right dir A
const int IN4 = 27; // right dir B

const int MOTOR_PWM_FREQ = 1000;
const int MOTOR_PWM_RESOLUTION = 8;

// ===== Calibration =====
const bool INVERT_LEFT_MOTOR = false;
const bool INVERT_RIGHT_MOTOR = false;
const int LEFT_TRIM = 0;     // +/- speed bias
const int RIGHT_TRIM = -20;  // start with slight right reduction if clockwise drift exists

// ===== HTTP + Safety =====
const int HTTP_PORT = 8080;
const unsigned long DEADMAN_MS = 800; // stop if no command within this window
const int MAX_SPEED = 200;

// ===== IR distance sensors (Sharp GP2Y0A21YK0F via LM358 buffer) =====
// All four channels are on ADC1 so they coexist with Wi-Fi (ADC2 is
// shared with the radio and unreliable while connected).
// The PCB buffers each Sharp output through its own op-amp, so the
// ESP32 sees a clean 0–3.3V signal; we run ADC at 11dB attenuation
// to map that range into the full 0–4095 count space.
//
// We publish raw ADC counts on /telemetry. The voltage→distance curve
// for the GP2Y0A21 is non-linear and has a confusing "dead zone" below
// ~8cm where the reading folds back. The conversion is done on the
// Helm side so it can be tuned without re-flashing.
const int IR_PIN_FL = 34; // front-left  (~45° W of center)
const int IR_PIN_FC = 32; // front-center (0°)
const int IR_PIN_FR = 33; // front-right (~45° E of center)
const int IR_PIN_RR = 35; // rear        (0° S)
const int IR_SAMPLES = 4; // tiny rolling average — the Sharps are jittery

// ===== Collision guard =====
// Refuses drive commands when an obstacle is too close to the direction
// of travel. Only the dead-ahead and dead-behind sensors gate the guard
// — the 45° sensors are "peripheral vision" and would over-trigger on
// walls we're driving alongside (parking, doorframes, etc).
//
// Threshold defaults to ~2-3cm (Sharp GP2Y0A21 reads ~2800 counts at
// that range, at 11dB attenuation). Editable at runtime via
// /config/guard?threshold=N — in-RAM only (resets on boot); re-flash
// to change the default. Hysteresis prevents block/unblock chatter
// when the reading hovers right at the threshold.
const int GUARD_DEFAULT_THRESHOLD = 2800;
const int GUARD_HYSTERESIS = 200; // release when reading drops this far below threshold
volatile int gGuardThreshold = GUARD_DEFAULT_THRESHOLD;
volatile bool gGuardForwardBlocked = false;
volatile bool gGuardReverseBlocked = false;

WebServer server(HTTP_PORT);

volatile int gLeftCmd = 0;   // -255..255
volatile int gRightCmd = 0;  // -255..255
volatile unsigned long gLastCmdMs = 0;

int readIrAveraged(int pin) {
  uint32_t sum = 0;
  for (int i = 0; i < IR_SAMPLES; i++) {
    sum += analogRead(pin);
  }
  return (int)(sum / IR_SAMPLES);
}

// Re-evaluate the forward/reverse guards from the latest sensor readings.
// Uses Schmitt-style hysteresis: trip when reading >= threshold, release
// only after it drops to (threshold - HYSTERESIS). Without this, a value
// that oscillates around the threshold causes block/unblock chatter.
void updateGuards(int irFrontCenter, int irRear) {
  const int releaseThreshold = gGuardThreshold - GUARD_HYSTERESIS;
  if (gGuardForwardBlocked) {
    if (irFrontCenter < releaseThreshold) gGuardForwardBlocked = false;
  } else {
    if (irFrontCenter >= gGuardThreshold) gGuardForwardBlocked = true;
  }
  if (gGuardReverseBlocked) {
    if (irRear < releaseThreshold) gGuardReverseBlocked = false;
  } else {
    if (irRear >= gGuardThreshold) gGuardReverseBlocked = true;
  }
}

IPAddress cidrToMask(int cidr) {
  int bits = cidr;
  if (bits < 0) bits = 0;
  if (bits > 32) bits = 32;
  uint32_t mask = (bits == 0) ? 0 : (0xFFFFFFFFu << (32 - bits));
  return IPAddress(
    (mask >> 24) & 0xFF,
    (mask >> 16) & 0xFF,
    (mask >> 8) & 0xFF,
    mask & 0xFF
  );
}

IPAddress deriveGatewayFromIp(const IPAddress& ip) {
  return IPAddress(ip[0], ip[1], ip[2], 1);
}

int clamp255(int v) {
  if (v > 255) return 255;
  if (v < -255) return -255;
  return v;
}

int clampPWM(int v) {
  if (v < 0) return 0;
  if (v > 255) return 255;
  return v;
}

int applyLeftTrim(int speedAbs) {
  return clampPWM(speedAbs + LEFT_TRIM);
}

int applyRightTrim(int speedAbs) {
  return clampPWM(speedAbs + RIGHT_TRIM);
}

void setLeftDir(bool forward) {
  bool fwd = INVERT_LEFT_MOTOR ? !forward : forward;
  digitalWrite(IN1, fwd ? HIGH : LOW);
  digitalWrite(IN2, fwd ? LOW : HIGH);
}

void setRightDir(bool forward) {
  bool fwd = INVERT_RIGHT_MOTOR ? !forward : forward;
  digitalWrite(IN3, fwd ? HIGH : LOW);
  digitalWrite(IN4, fwd ? LOW : HIGH);
}

void stopMotors() {
  digitalWrite(IN1, LOW);
  digitalWrite(IN2, LOW);
  digitalWrite(IN3, LOW);
  digitalWrite(IN4, LOW);
  ledcWrite(ENA, 0);
  ledcWrite(ENB, 0);
}

void applyMotorCommand(int left, int right) {
  left = clamp255(left);
  right = clamp255(right);

  if (left == 0 && right == 0) {
    stopMotors();
    return;
  }

  setLeftDir(left >= 0);
  setRightDir(right >= 0);

  int leftAbs = applyLeftTrim(abs(left));
  int rightAbs = applyRightTrim(abs(right));

  ledcWrite(ENA, leftAbs);
  ledcWrite(ENB, rightAbs);
}

void handleHealth() {
  String json = "{";
  json += "\"ok\":true,";
  json += "\"mode\":\"" + String(USE_STATIC_IP ? "static" : "dhcp") + "\",";
  json += "\"ip\":\"" + WiFi.localIP().toString() + "\",";
  json += "\"gateway\":\"" + WiFi.gatewayIP().toString() + "\",";
  json += "\"subnet\":\"" + WiFi.subnetMask().toString() + "\",";
  json += "\"dns1\":\"" + WiFi.dnsIP(0).toString() + "\",";
  json += "\"dns2\":\"" + WiFi.dnsIP(1).toString() + "\",";
  json += "\"port\":" + String(HTTP_PORT) + ",";
  json += "\"mdns\":\"" + String(MDNS_NAME) + ".local\"";
  json += "}";
  server.send(200, "application/json", json);
}

void handleTelemetry() {
  unsigned long age = millis() - gLastCmdMs;
  int irFL = readIrAveraged(IR_PIN_FL);
  int irFC = readIrAveraged(IR_PIN_FC);
  int irFR = readIrAveraged(IR_PIN_FR);
  int irRR = readIrAveraged(IR_PIN_RR);
  updateGuards(irFC, irRR);
  String json = "{";
  json += "\"left\":" + String(gLeftCmd) + ",";
  json += "\"right\":" + String(gRightCmd) + ",";
  json += "\"deadmanMs\":" + String(DEADMAN_MS) + ",";
  json += "\"lastCmdAgeMs\":" + String(age) + ",";
  json += "\"wifiRssi\":" + String(WiFi.RSSI()) + ",";
  json += "\"ip\":\"" + WiFi.localIP().toString() + "\",";
  json += "\"gateway\":\"" + WiFi.gatewayIP().toString() + "\",";
  json += "\"subnet\":\"" + WiFi.subnetMask().toString() + "\",";
  json += "\"irFrontLeft\":" + String(irFL) + ",";
  json += "\"irFrontCenter\":" + String(irFC) + ",";
  json += "\"irFrontRight\":" + String(irFR) + ",";
  json += "\"irRear\":" + String(irRR) + ",";
  json += "\"guardThreshold\":" + String(gGuardThreshold) + ",";
  json += "\"guardForwardBlocked\":" + String(gGuardForwardBlocked ? "true" : "false") + ",";
  json += "\"guardReverseBlocked\":" + String(gGuardReverseBlocked ? "true" : "false");
  json += "}";
  server.send(200, "application/json", json);
}

// /cmd?left=120&right=120
// /cmd?fwd=160
// /cmd?rev=140
// /cmd?turn=120   (right turn)
// /cmd?turn=-120  (left turn)
// /cmd?stop=1
void handleCmd() {
  bool hasAny = false;
  int left = gLeftCmd;
  int right = gRightCmd;

  if (server.hasArg("stop")) {
    left = 0;
    right = 0;
    hasAny = true;
  }

  if (server.hasArg("left") || server.hasArg("right")) {
    left = server.hasArg("left") ? server.arg("left").toInt() : left;
    right = server.hasArg("right") ? server.arg("right").toInt() : right;
    hasAny = true;
  }

  if (server.hasArg("fwd")) {
    int s = server.arg("fwd").toInt();
    left = s;
    right = s;
    hasAny = true;
  }

  if (server.hasArg("rev")) {
    int s = abs(server.arg("rev").toInt());
    left = -s;
    right = -s;
    hasAny = true;
  }

  if (server.hasArg("turn")) {
    int s = server.arg("turn").toInt();
    if (s >= 0) {
      // right turn
      left = abs(s);
      right = -abs(s);
    } else {
      // left turn
      left = -abs(s);
      right = abs(s);
    }
    hasAny = true;
  }

  if (!hasAny) {
    server.send(400, "application/json", "{\"ok\":false,\"error\":\"no command args\"}");
    return;
  }

  left = constrain(left, -MAX_SPEED, MAX_SPEED);
  right = constrain(right, -MAX_SPEED, MAX_SPEED);

  // Collision guard: refresh from latest sensor reads, then refuse the
  // command if it would drive the chassis into something.
  //
  // The guard has to ask "will the chassis physically translate forward
  // or backward" — NOT "are the raw command signs both positive". This
  // robot's motors are mounted in matching rotational direction (both
  // cw → spin) rather than mirror-symmetric (left ccw + right cw →
  // translate), so equal-sign PWM spins and opposite-sign PWM
  // translates. Empirically: left<0, right>0 drives the chassis forward;
  // the opposite pair drives it backward; equal-sign is always an
  // in-place spin (allowed as the escape hatch).
  //
  // TODO: lift this to a per-chassis config when we add a second robot
  // whose motors are mounted the conventional mirror-symmetric way.
  // Right now it's hard-coded for the Truck so the guard is real.
  updateGuards(readIrAveraged(IR_PIN_FC), readIrAveraged(IR_PIN_RR));
  const bool wantForward = (left < 0 && right > 0);
  const bool wantReverse = (left > 0 && right < 0);
  if (wantForward && gGuardForwardBlocked) {
    server.send(409, "application/json",
      "{\"ok\":false,\"blocked\":\"forward\",\"reason\":\"front IR over threshold\"}");
    return;
  }
  if (wantReverse && gGuardReverseBlocked) {
    server.send(409, "application/json",
      "{\"ok\":false,\"blocked\":\"reverse\",\"reason\":\"rear IR over threshold\"}");
    return;
  }

  gLeftCmd = left;
  gRightCmd = right;
  gLastCmdMs = millis();

  applyMotorCommand(gLeftCmd, gRightCmd);

  String json = "{";
  json += "\"ok\":true,";
  json += "\"left\":" + String(gLeftCmd) + ",";
  json += "\"right\":" + String(gRightCmd);
  json += "}";
  server.send(200, "application/json", json);
}

// Runtime tuning for the collision guard. In-RAM only; resets on boot.
// Use this to walk the truck up to an obstacle, read irFrontCenter from
// /telemetry, and set the threshold without re-flashing.
//   GET /config/guard?threshold=2800
void handleConfigGuard() {
  if (!server.hasArg("threshold")) {
    String json = "{";
    json += "\"threshold\":" + String(gGuardThreshold) + ",";
    json += "\"hysteresis\":" + String(GUARD_HYSTERESIS);
    json += "}";
    server.send(200, "application/json", json);
    return;
  }
  int v = server.arg("threshold").toInt();
  // ADC range is 0..4095. Clamp into something that can't disable the
  // guard by accident (0) or set it above the max readable value.
  if (v < 100) v = 100;
  if (v > 4000) v = 4000;
  gGuardThreshold = v;
  String json = "{\"ok\":true,\"threshold\":" + String(gGuardThreshold) + "}";
  server.send(200, "application/json", json);
}

void handleRoot() {
  String help;
  help += "ESP32 Remote Control online\\n";
  help += "GET /health\\n";
  help += "GET /telemetry\\n";
  help += "GET /cmd?fwd=160\\n";
  help += "GET /cmd?rev=140\\n";
  help += "GET /cmd?turn=120 (right)\\n";
  help += "GET /cmd?turn=-120 (left)\\n";
  help += "GET /cmd?left=120&right=90\\n";
  help += "GET /cmd?stop=1\\n";
  help += "GET /config/guard            (show current threshold)\\n";
  help += "GET /config/guard?threshold=N (tune collision guard)\\n";
  server.send(200, "text/plain", help);
}

void connectWifi() {
  WiFi.mode(WIFI_STA);
  if (USE_STATIC_IP) {
    IPAddress subnet = (STATIC_CIDR >= 0 && STATIC_CIDR <= 32) ? cidrToMask(STATIC_CIDR) : STATIC_SUBNET;
    IPAddress gateway = USE_STATIC_GATEWAY ? STATIC_GATEWAY : deriveGatewayFromIp(STATIC_IP);
    const bool configured = WiFi.config(STATIC_IP, gateway, subnet, STATIC_DNS1, STATIC_DNS2);
    if (!configured) {
      Serial.println("Static IP config failed; falling back to DHCP.");
    } else {
      Serial.print("Static IP requested: ");
      Serial.println(STATIC_IP);
      Serial.print("Static Subnet: ");
      Serial.println(subnet);
      Serial.print("Static Gateway: ");
      Serial.println(gateway);
    }
  }
  WiFi.begin(WIFI_SSID, WIFI_PASS);

  Serial.print("Connecting Wi-Fi");
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED) {
    delay(400);
    Serial.print(".");
    if ((millis() - start) > WIFI_CONNECT_TIMEOUT_MS) {
      Serial.println("\\nWi-Fi timeout, retrying...");
      WiFi.disconnect(true);
      delay(WIFI_RETRY_DELAY_MS);
      if (USE_STATIC_IP) {
        IPAddress subnet = (STATIC_CIDR >= 0 && STATIC_CIDR <= 32) ? cidrToMask(STATIC_CIDR) : STATIC_SUBNET;
        IPAddress gateway = USE_STATIC_GATEWAY ? STATIC_GATEWAY : deriveGatewayFromIp(STATIC_IP);
        WiFi.config(STATIC_IP, gateway, subnet, STATIC_DNS1, STATIC_DNS2);
      }
      WiFi.begin(WIFI_SSID, WIFI_PASS);
      start = millis();
    }
  }
  Serial.println();
  Serial.println("Wi-Fi connected.");
  Serial.print("  Mode: "); Serial.println(USE_STATIC_IP ? "STATIC" : "DHCP");
  Serial.print("  SSID: "); Serial.println(WIFI_SSID);
  Serial.print("  IP: "); Serial.println(WiFi.localIP());
  Serial.print("  Gateway: "); Serial.println(WiFi.gatewayIP());
  Serial.print("  Subnet: "); Serial.println(WiFi.subnetMask());
  Serial.print("  DNS1: "); Serial.println(WiFi.dnsIP(0));
  Serial.print("  DNS2: "); Serial.println(WiFi.dnsIP(1));

  // Start the mDNS responder so the robot is reachable by hostname.
  // We advertise the HTTP control port as well so service browsers
  // (and our own helm discovery) can find the device by service type.
  if (MDNS.begin(MDNS_NAME)) {
    MDNS.addService("http", "tcp", HTTP_PORT);
    Serial.print("  mDNS: http://"); Serial.print(MDNS_NAME); Serial.println(".local");
  } else {
    Serial.println("  mDNS: failed to start (continuing without it)");
  }
}

void setup() {
  Serial.begin(115200);

  pinMode(IN1, OUTPUT);
  pinMode(IN2, OUTPUT);
  pinMode(IN3, OUTPUT);
  pinMode(IN4, OUTPUT);

  ledcAttach(ENA, MOTOR_PWM_FREQ, MOTOR_PWM_RESOLUTION);
  ledcAttach(ENB, MOTOR_PWM_FREQ, MOTOR_PWM_RESOLUTION);

  // IR distance ADC channels — all on ADC1 so they coexist with Wi-Fi.
  // 11dB attenuation maps the buffered 0–3.3V range to the full
  // 0–4095 count space (the default 0dB clips around ~1.1V).
  analogReadResolution(12);
  analogSetPinAttenuation(IR_PIN_FL, ADC_11db);
  analogSetPinAttenuation(IR_PIN_FC, ADC_11db);
  analogSetPinAttenuation(IR_PIN_FR, ADC_11db);
  analogSetPinAttenuation(IR_PIN_RR, ADC_11db);

  stopMotors();

  connectWifi();

  server.on("/", HTTP_GET, handleRoot);
  server.on("/health", HTTP_GET, handleHealth);
  server.on("/telemetry", HTTP_GET, handleTelemetry);
  server.on("/cmd", HTTP_GET, handleCmd);
  server.on("/config/guard", HTTP_GET, handleConfigGuard);
  server.begin();

  gLeftCmd = 0;
  gRightCmd = 0;
  gLastCmdMs = millis();

  Serial.print("HTTP control server running on port ");
  Serial.println(HTTP_PORT);
}

void loop() {
  server.handleClient();

  // Deadman safety
  if ((millis() - gLastCmdMs) > DEADMAN_MS) {
    if (gLeftCmd != 0 || gRightCmd != 0) {
      gLeftCmd = 0;
      gRightCmd = 0;
      stopMotors();
      Serial.println("Deadman stop triggered");
    }
  }

  delay(5);
}
