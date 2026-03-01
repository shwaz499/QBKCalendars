#include <WiFi.h>
#include <HTTPClient.h>

// =====================
// User configuration
// =====================
const char* WIFI_SSID = "YOUR_WIFI_SSID";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";

// Example: "http://192.168.1.50:8080/api/button"
const char* BUTTON_API_URL = "http://YOUR_SERVER_IP:8080/api/button";

// Use pins that are safe for your ESP32 board.
const int LEFT_BUTTON_PIN = 14;
const int RIGHT_BUTTON_PIN = 27;

// INPUT_PULLUP expected wiring:
// pin -> button -> GND
// Not pressed = HIGH, pressed = LOW
const bool PRESSED_LEVEL = LOW;

const unsigned long DEBOUNCE_MS = 35;
const unsigned long WIFI_RETRY_MS = 5000;

struct ButtonState {
  const char* side;
  int pin;
  bool stableLevel;
  bool lastReadLevel;
  unsigned long lastChangeMs;
};

ButtonState leftButton = {"left", LEFT_BUTTON_PIN, HIGH, HIGH, 0};
ButtonState rightButton = {"right", RIGHT_BUTTON_PIN, HIGH, HIGH, 0};

unsigned long lastWifiAttemptMs = 0;

void ensureWifiConnected() {
  if (WiFi.status() == WL_CONNECTED) {
    return;
  }

  unsigned long now = millis();
  if (now - lastWifiAttemptMs < WIFI_RETRY_MS) {
    return;
  }

  lastWifiAttemptMs = now;
  Serial.println("[WiFi] Connecting...");
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
}

bool postButtonEvent(const char* side, const char* eventType) {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[HTTP] Skipped send (WiFi disconnected)");
    return false;
  }

  HTTPClient http;
  http.begin(BUTTON_API_URL);
  http.addHeader("Content-Type", "application/json");

  String payload = "{\"side\":\"" + String(side) + "\",\"event\":\"" + String(eventType) + "\"}";

  int code = http.POST(payload);
  if (code > 0) {
    Serial.print("[HTTP] ");
    Serial.print(side);
    Serial.print(":");
    Serial.print(eventType);
    Serial.print(" -> ");
    Serial.println(code);
  } else {
    Serial.print("[HTTP] POST failed for ");
    Serial.print(side);
    Serial.print(":");
    Serial.print(eventType);
    Serial.print(" error=");
    Serial.println(http.errorToString(code));
  }

  http.end();
  return code > 0;
}

void emitPressRelease(ButtonState& button, bool nowPressed) {
  if (nowPressed) {
    postButtonEvent(button.side, "press");
  } else {
    postButtonEvent(button.side, "release");
  }
}

void updateButton(ButtonState& button) {
  bool raw = digitalRead(button.pin);
  unsigned long now = millis();

  if (raw != button.lastReadLevel) {
    button.lastReadLevel = raw;
    button.lastChangeMs = now;
  }

  if ((now - button.lastChangeMs) < DEBOUNCE_MS) {
    return;
  }

  if (button.stableLevel == button.lastReadLevel) {
    return;
  }

  button.stableLevel = button.lastReadLevel;
  bool isPressed = (button.stableLevel == PRESSED_LEVEL);
  emitPressRelease(button, isPressed);
}

void setupButton(ButtonState& button) {
  pinMode(button.pin, INPUT_PULLUP);
  button.stableLevel = digitalRead(button.pin);
  button.lastReadLevel = button.stableLevel;
  button.lastChangeMs = millis();
}

void setup() {
  Serial.begin(115200);
  delay(250);

  setupButton(leftButton);
  setupButton(rightButton);

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  Serial.println("ESP32 beach volleyball button sender started");
}

void loop() {
  ensureWifiConnected();

  updateButton(leftButton);
  updateButton(rightButton);

  delay(2);
}
