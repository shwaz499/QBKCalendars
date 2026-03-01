# Beach Volleyball Scoring App

Standalone scoring app for one court with two sides.

## Behavior
- Single press: add 1 point to that side
- Double press: subtract 1 point from that side (never below 0)
- Hold (~2+ seconds): reset both sides to 0

## Run
From this folder:

```bash
cd "/Users/joshschwartz/Documents/New project/beach-volleyball-scoreboard"
node server.js
```

Open:
- Operator/testing view: [http://localhost:8080](http://localhost:8080)
- TV display-only view: [http://localhost:8080/?display=1](http://localhost:8080/?display=1)

## API for physical buttons
Endpoint:

```http
POST /api/button
Content-Type: application/json
```

### Option A: Device sends complete events
Single press:

```json
{ "side": "left", "event": "tap" }
```

Double press:

```json
{ "side": "left", "event": "double" }
```

Hold reset:

```json
{ "side": "left", "event": "hold" }
```

### Option B: Device sends raw press/release
Press down:

```json
{ "side": "right", "event": "press" }
```

Release:

```json
{ "side": "right", "event": "release" }
```

The server measures hold time and handles single vs double press logic.

## Notes for wiring
- Any microcontroller that can do HTTP POST works (ESP32, Raspberry Pi, etc.)
- Debounce physical button input in firmware (20-50 ms is typical)
- If buttons are on a different network, expose this server IP and port 8080 to that network

## ESP32 firmware example
Sketch path:

`/Users/joshschwartz/Documents/New project/beach-volleyball-scoreboard/firmware/esp32_dual_button_sender/esp32_dual_button_sender.ino`

What it does:
- Uses two GPIO inputs with `INPUT_PULLUP` (button to GND)
- Sends `press` when button is pushed and `release` when button is let go
- Server converts those events into single press (+1), double press (-1), and hold reset

Setup:
1. Open the sketch in Arduino IDE.
2. Install board support for ESP32 if needed.
3. Edit these values in the sketch:
   - `WIFI_SSID`
   - `WIFI_PASSWORD`
   - `BUTTON_API_URL` (example: `http://192.168.1.50:8080/api/button`)
4. Verify pin choices (`LEFT_BUTTON_PIN`, `RIGHT_BUTTON_PIN`) match your wiring.
5. Upload to ESP32 and open Serial Monitor at `115200` baud.

Default wiring in the sketch:
- Left button: GPIO `14` to button to GND
- Right button: GPIO `27` to button to GND

If you use external pull-down wiring instead, update pin mode/pressed level in the sketch.
