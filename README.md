# led_light_controls

Simple web app created to control LED rope lights.

## Neon local light control

A dependency-free local web app for compatible Lotus Lantern Bluetooth RGB
controllers. Supports one connected string at a time, power, RGB color, color
presets, brightness, and saved color sequences. Hardware compatibility has not yet been confirmed with
your particular lights.

## Python background service (recommended on this Mac)

The Python mode controls Bluetooth through macOS CoreBluetooth using Bleak.
The existing sequence editor is just a local control panel: playback continues
with the browser minimized, hidden, or closed, and works in Safari too.
The original standalone browser mode remains available below.

Setup from this folder (already installed on the development Mac):

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python mac_service.py
```

Open **http://lotuslantern.localhost:49174**. This uses a different port from
the original Node app so both can coexist, but do not connect both to the lights.
Close LotusLanternX and disconnect any Chrome Bluetooth session first.
Click **Scan for lights**, choose your office string, and **Select these lights**.
Allow Bluetooth access for Python or the launching terminal in macOS
System Settings > Privacy & Security > Bluetooth if prompted.

Load a preset (including your tuned colors) or edit a sequence, then click
**Play sequence**. This saves the exact sequence and enables automatic playback.
When the selected device is absent at home, the service performs bounded scans
about every 20 seconds (plus scan time), quietly waiting rather than connecting
to another string. On returning to the office, it connects to the **same saved
macOS device identifier** and restarts the sequence at its first color.
Transient Bluetooth errors are shown and logged, then retried.

**Stop** disables automatic playback on disk, including after service restarts
or returning to the office. **Disconnect** also disables playback and releases
the device; it remains remembered. Selecting any device disables the previous
playback intent. Click Play to enable it again. One-shot sequences disable their
playback intent after finishing; only unfinished playback resumes automatically.
Normal service shutdown leaves enabled playback remembered for the next start.

Saves and playback settings live in
`~/Library/Application Support/LotusLantern/state.json`, written atomically with
owner-only permissions. Invalid state is a startup error and is not overwritten.
Multiple pages share the same service and disk saves. Presets are still bundled
with the app; custom saves are local to this Mac, not synchronized to your website.
No website credentials, Wi-Fi detection, or location access are needed.
An absent device is the office/home signal.

### Start automatically at login

After confirming Bluetooth works in foreground mode, stop that foreground
process with Ctrl+C and run:

```sh
.venv/bin/python setup_mac.py install
```

This explicitly installs and starts the per-user
`~/Library/LaunchAgents/com.local.lotuslantern.plist`. It runs at login and
restarts after an unexpected exit. It does not require sudo. Keep this folder
and `.venv` in place. macOS may request additional permissions when launched
outside the terminal; check Bluetooth permissions and the logs if it cannot
access Bluetooth or this Documents folder. The service only listens on
`127.0.0.1`, validates same-origin requests, and does not expose remote control.

To stop and remove the login service (retaining all settings):

```sh
.venv/bin/python setup_mac.py remove
```

If playback was enabled, removal does not clear that intent: use **Stop** first
if it should not resume on a later manual start or reinstall.
Logs are under `~/Library/Logs/LotusLantern/`; Bluetooth logs rotate at 2 MB.
The service does not prevent system sleep. Keep your Mac awake during playback;
the display can turn off. Bluetooth cannot run while the Mac is asleep or off.

### Import existing browser saves

Browser storage is origin-specific. To import saves from the original app, stop
the server using that port and run Python there temporarily:

```sh
.venv/bin/python mac_service.py --port 49173
```

Open **http://lotuslantern.localhost:49173** in the original browser profile,
then click **Import browser saves to Mac**. Matching names require confirmation
before replacement; browser saves remain intact. For older saves, use
`--port 8080` and **http://localhost:8080** instead. For saves on the public
website, recreate the sequence in the local editor; automatic cross-origin
access is not supported. Stop this temporary service before starting the
normal port or installing the login service: use only one Python service at a time.

Run service tests with `.venv/bin/python -m unittest -v test_mac_service`.
They use mock Bluetooth devices to cover out-of-range waiting, reconnect,
automatic resume after restarts, Stop persistence, one-shot completion, and
local API isolation. Real macOS Bluetooth permission and device behavior still
need confirmation with the office string.

## Original browser-only mode

For public static hosting, deploy `index.html`, `styles.css`, `app.js`,
`lights.js`, `sequences.js`, and **`python-client.js`** together. The last module
must be present because it is imported by the shared app even in browser-only
mode. Do not upload `.venv`, Python service files, local state, or log files.
Public hosting still uses Web Bluetooth; it does not access the local Python
service.

Use an installed Node.js runtime (Node 20 or later recommended). From this folder:

```sh
npm start
```

Open **http://lotuslantern.localhost:49173** in **Chrome** or Edge. No `npm install` is needed.
Keep the terminal running; press Ctrl+C to stop. The server listens only on the
loopback interface, not your network. Opening `index.html` directly is not supported.

### How the app is served

`npm start` runs `server.js` using Node.js. It serves the HTML, CSS, and JavaScript
files directly from this folder on port **49173**; the browser connects to the
lights using Web Bluetooth. No build step or cloud host is involved. The server
does not automatically start at login or after a reboot; start it from the
terminal whenever needed. Closing its terminal or pressing Ctrl+C stops it.

Chrome resolves names ending in `.localhost` to the local machine and treats
them as trustworthy for Web Bluetooth over HTTP. No `/etc/hosts` modification
or HTTPS certificate is needed. Enter the full URL including the port, or
bookmark it. Typing just `lotuslantern` may run a search and cannot select this
port. A plain HTTP hosts-file alias named `lotuslantern` would not meet Chrome's
secure-context requirement for Bluetooth.

Use the same address consistently: browser storage and Bluetooth permissions are
specific to the hostname and port. The move from `http://localhost:8080` does not
migrate saved sequences, but it does not delete them either. To access old saves,
stop the default server and run:

```sh
PORT=8080 npm start
```

Then open **http://localhost:8080** in the original Chrome profile. To return to
the new address, stop that process and run `npm start` again.
Any valid port from 1 to 65535 can be specified with `PORT`; higher unprivileged
ports are recommended. If a port is occupied, the server reports an error rather
than silently choosing another port.

1. Power the lights and enable Bluetooth on your Mac.
2. Close LotusLanternX on your phone; many controllers accept one connection only.
3. Click **Connect lights** and select your controller in Chrome's chooser.
4. If prompted, allow Chrome access under macOS System Settings > Privacy &
   Security > Bluetooth.
5. Start with the **Lotus Lantern** protocol. Apply a color and confirm that the
   actual lights change, then try brightness and power.

Connection alone does not send commands or synchronize the displayed controls.
Color and brightness selections are sent only when applied; preset buttons send
their color immediately. The displayed values are selections, not device readings.
A successful Bluetooth write does not prove the hardware recognized the command.

## Programming color sequences

Choose a **Built-in preset** and click **Load preset**, then **Play sequence**:

- **Halloween Fade:** `#FF1900` -> `#C800FF`.
- **Patriotic Fade:** `#FF0000` -> `#FFFFFF` -> `#C800FF` (purple, as requested).
- **Christmas Classic:** `#FF0000` -> `#F9644F` -> `#00C832` -> `#F9644F`.
- **Christmas Frost:** `#0064FF` -> `#80E8FF` -> `#FFFFFF`.
- **Easter Pastels:** `#FF80B5` -> `#B080FF` -> `#80FFB0` -> `#FFE680`.
- **Valentine's Glow:** `#FF0000` -> `#FF3399` -> `#FF80B0`.
- **St. Patrick's Day:** `#00C832` -> `#FFB800` -> `#FFFFFF`.
- **Thanksgiving Harvest:** `#FF8800` -> `#FFCC00` -> `#FF3300`.
- **Hanukkah Lights:** `#0055FF` -> `#FFFFFF`.
- **New Year's Gold:** `#FFB800` -> `#FFDCA0` -> `#FFFFFF`.
- **Independence Day:** `#FF0000` -> `#FFFFFF` -> `#0000FF`.

Most presets hold every color for **5 seconds**, then fade to the next over
**5 seconds**. Thanksgiving Harvest uses an **8-second hold / 6-second fade**;
New Year's Gold uses a **3-second hold / 3-second fade**. All repeat continuously
including the fade back to the first color.
They are bundled with the website and available at any hosting address without
browser storage. Loading requires confirmation before replacing the editor;
it does not change or overwrite saved sequences. You can edit a loaded preset
and use **Save sequence** to keep a custom version in this browser.
RGB lights may render hex colors differently, especially pastels and warm white.
Adjust the loaded preset's color pickers to match your string, then save your
version; the built-in defaults remain unchanged.

The **Color sequences** editor starts with white -> blue -> red, holding each
color for 1 second and fading to the next over 3 seconds. You can edit colors,
add/remove/reorder steps, and set each step's hold and fade times from 0 to 3600
seconds. Up to 50 steps are supported. Fade is an RGB interpolation from the
current step to the next; zero fade switches directly (with a minimum 150ms
command interval).

Each sequence slot has a **Use Light controls color** button. It copies the
currently selected color from the Light controls picker into that slot without
changing its hold/fade times or sending a Bluetooth command. This is the selected
picker value, not a reading from the lights. Click **Save sequence** to retain
the edit. Copying is disabled with the sequence editor during playback.

Give the sequence a name and click **Save sequence**. Saves use browser local
storage at this origin and survive reloads/restarts. The same name replaces an
existing save after confirmation; a new name creates another save. Select a
saved sequence and click **Load** to edit/play it, or **Delete saved** to remove
it. Saving and editing work without Bluetooth. Clearing browser data, changing
browsers/profiles, or using a different hostname/port will remove or separate
your saves. Storage errors are displayed; damaged data is not silently overwritten.

Connect the lights, set power and brightness as desired, and click **Play
sequence**. You can play unsaved edits too. **Repeat continuously** fades from
the last color back to the first; without repeat, playback ends after the final
hold (the final fade is unused). Playback starts at the first color, not from an
unknown current device color. It preserves brightness and does not automatically
turn the controller on. A one-color repeating sequence simply holds that color.

Playback is generated by this browser, not uploaded to the controller. Keep the
tab visible and the Mac awake/connected. Hiding the tab, closing the page,
disconnecting, or a Bluetooth error stops playback; it does not automatically
resume. Browser/device scheduling can affect timing. Fades send at most about
6-7 updates per second; actual smoothness depends on the controller.
**Stop** leaves the last transmitted color in place, and may wait for a pending
Bluetooth operation to settle before manual controls are available again.
Manual controls and sequence editing are disabled during playback to prevent
conflicting writes. The command log records playback events/errors, not every
fade frame.

## Compatibility and troubleshooting

Web Bluetooth requires a supported browser and a secure context, including
localhost. Safari and Firefox are not supported. Everything runs locally;
there are no accounts, external scripts, analytics, or remote services.

The app requests the `FFF0` service and writes to characteristic `FFF3`. It
shows only devices whose advertised names start with **BLEDOM** or **ELK-BLEDOM**
(case-sensitive). Chrome supports name-prefix filters, not arbitrary substring
matching. Unnamed devices and controllers named LED BLE, MELK, or anything else
are excluded, even if they otherwise support the protocol. Only select a device
you own.
Commands are spaced at least 150ms apart, never written concurrently, and errors
are shown with a bounded diagnostic log.

Two protocol profiles are included because app branding alone does not identify
the hardware:

- **Lotus Lantern:** standard RGB frame, brightness scaled from 0-100% to
  0-255, and standard power commands.
- **Lotus Lamp X / MELK:** the same RGB frame, with an alternate brightness
  frame using 0-100. Power buttons are disabled because a power command for
  this variant has not been verified from the referenced documentation.

The MELK profile is an alternate hardware family, not a guarantee of
LotusLanternX compatibility. Do not assume either profile works with all devices.
Built-in controller effects, music synchronization, schedules, and configuration commands
are intentionally omitted pending model identification.

If the device is missing, close the phone app, move nearby, and power-cycle the
lights. If service discovery fails, the device likely uses a different service
or protocol. If commands write successfully but do nothing, record the selected
profile and device name. Useful follow-up information:

- The Bluetooth device name shown in the chooser.
- Which of color, brightness, and power actually work.
- The error or relevant command-log entries.
- The product listing or a photo of the controller/model label.

Do not share unrelated nearby device names or personal information.

## Protocol references

Command packets were implemented from public protocol descriptions:

- [Lotus Lantern command reference](https://github.com/Rxflex/LotusLantern/blob/main/commands.go)
- [MELK / Lotus Lamp X protocol documentation](https://github.com/wporter82/lotus-lamp-python/blob/main/docs/PROTOCOL.md)

## Development

```sh
npm test
```

Tests cover frame bytes, input validation, characteristic discovery, both write
methods, rate limiting, disconnection, cancellation, and error propagation with
mock Bluetooth devices. Sequence tests cover local persistence, invalid data,
RGB interpolation, exact fade endpoints, hold timing, repeat wraparound,
instant transitions, one-shot completion, and cancellation/errors.
Actual Bluetooth interoperability requires the lights
and a manual Chrome session; it cannot be established by mock tests.
