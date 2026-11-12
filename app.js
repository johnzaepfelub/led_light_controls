import { Lights, colorCommand, brightnessCommand, powerCommand } from "./lights.js";
import { MAX_STEPS, getSequencePresets, loadSequences, storeSequences, validateSequence, playSequence } from "./sequences.js";
import { PythonLights, serviceRequest } from "./python-client.js";

const element = (id) => document.getElementById(id);
const connect = element("connect");
const disconnect = element("disconnect");
const controls = element("controls");
const profile = element("profile");
const status = element("status");
const log = element("log");
const color = element("color");
const brightness = element("brightness");
const entries = [];
let busy = false;
let playback = null;
let saved = [];
let storageAvailable = true;
const pythonMode = document.body.dataset.backend === "python";
let serviceState = null;
let serviceOffline = false;

function message(text, error = false) {
  status.textContent = text;
  status.classList.toggle("error", error);
}

function record(text) {
  entries.unshift(`${new Date().toLocaleTimeString()}  ${text}`);
  entries.length = Math.min(entries.length, 30);
  log.textContent = entries.join("\n");
}

const supported = pythonMode || Boolean(navigator.bluetooth && window.isSecureContext);
const lights = pythonMode ? new PythonLights((state) => {
  serviceState = state;
  serviceOffline = false;
  update();
}) : new Lights(navigator.bluetooth, () => {
  if (playback) playback.controller.abort();
  update();
  message("Bluetooth disconnected. Reconnect to send more commands.", true);
  record("Bluetooth disconnected.");
});

function update() {
  const playing = Boolean(playback) || Boolean(serviceState?.enabled);
  controls.disabled = busy || playing || !lights.connected || serviceOffline;
  profile.disabled = busy || playing;
  connect.disabled = busy || lights.connected || !supported;
  disconnect.disabled = busy || (pythonMode ? !serviceState?.device || serviceOffline : !lights.connected);
  element("sequence-editor").disabled = playing;
  element("play-sequence").disabled = busy || playing || (pythonMode ? !serviceState?.device || serviceOffline : !lights.connected);
  element("stop-sequence").disabled = pythonMode ? busy || !serviceState?.enabled || serviceOffline : !playback || playback.controller.signal.aborted;
  element("save-sequence").disabled = !storageAvailable;
  element("delete-sequence").disabled = !storageAvailable || !element("saved-sequences").value;
  element("load-sequence").disabled = !element("saved-sequences").value;
  element("power-on").disabled = profile.value !== "lantern";
  element("power-off").disabled = profile.value !== "lantern";
  element("power-note").hidden = profile.value === "lantern";
  const badge = element("connection-state");
  badge.textContent = lights.connected ? "Connected" : "Disconnected";
  badge.classList.toggle("connected", lights.connected);
  if (!lights.connected) element("device-name").textContent = "Close LotusLanternX on your phone before connecting.";
  if (pythonMode) {
    element("browser-help").hidden = true;
    element("python-help").hidden = false;
    document.querySelector("footer").textContent = "Local Python Bluetooth service. Closing the browser does not stop playback.";
    connect.textContent = "Scan for lights";
    connect.disabled = busy || playing || serviceOffline;
    element("select-service-device").disabled = busy || playing || serviceOffline || !element("service-devices").value;
    badge.textContent = serviceOffline ? "Service unavailable" : (serviceState?.phase || "Loading service");
    element("device-name").textContent = serviceState?.device
      ? `${serviceState.device.name} (${serviceState.device.address})`
      : "Select your office lights once; the service will remember this device.";
    if (serviceState) {
      element("sequence-state").textContent = serviceState.enabled
        ? `${serviceState.phase}: "${serviceState.sequence.name}"${serviceState.step === null ? "" : ` - color ${serviceState.step + 1}`}. Automatic resume enabled.`
        : "Playback stopped. Automatic playback is disabled.";
      if (serviceState.error) element("sequence-state").textContent += ` Error: ${serviceState.error}`;
    }
  }
}

function report(error) {
  console.error(error);
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  message(`Unable to complete the operation. ${detail}`, true);
  record(`ERROR ${detail}`);
}

connect.addEventListener("click", async () => {
  busy = true;
  update();
  message("Select your lights in Chrome's Bluetooth chooser...");
  try {
    if (pythonMode) {
      message("Scanning for nearby BLEDOM lights...");
      const devices = await lights.scan();
      const select = element("service-devices");
      select.replaceChildren(new Option(devices.length ? "Choose your lights" : "No lights in range; try again in the office", ""));
      devices.forEach((device) => select.add(new Option(`${device.name} (${device.address})`, device.address)));
      message(devices.length ? "Choose your string, then click Select these lights." : "No BLEDOM lights found. Your remembered device and playback settings have not changed.");
      return;
    }
    const name = await lights.connect();
    element("device-name").textContent = name;
    message("Connected. Choose a color or brightness, then apply it.");
    record(`Connected to ${name}.`);
  } catch (error) {
    report(error);
  } finally {
    busy = false;
    update();
  }
});

disconnect.addEventListener("click", async () => {
  if (pythonMode) {
    try {
      await lights.disconnect();
      message("Disconnected and automatic playback disabled.");
    } catch (error) { report(error); }
    return;
  }
  if (playback) playback.controller.abort();
  lights.disconnect();
  update();
  message("Disconnected. The lights retain their last setting.");
  record("Disconnected by user.");
});

async function send(build, label) {
  if (playback || busy) return;
  busy = true;
  update();
  message(`Sending ${label}...`);
  try {
    const command = build();
    await lights.send(command);
    const hex = Array.from(command, (byte) => byte.toString(16).padStart(2, "0")).join(" ");
    record(`${label} [${profile.value}] ${hex}`);
    message(`Sent ${label}. Check the lights; their actual state is not reported by this controller.`);
  } catch (error) {
    report(error);
  } finally {
    busy = false;
    update();
  }
}

function previewColor() {
  element("color-value").textContent = color.value.toUpperCase();
}
color.addEventListener("input", previewColor);
brightness.addEventListener("input", () => {
  element("brightness-value").textContent = `${brightness.value}%`;
});
element("apply-color").addEventListener("click", () => send(() => colorCommand(color.value), `color ${color.value.toUpperCase()}`));
element("apply-brightness").addEventListener("click", () => send(() => brightnessCommand(Number(brightness.value), profile.value), `brightness ${brightness.value}%`));
element("power-on").addEventListener("click", () => send(() => powerCommand(true, profile.value), "power on"));
element("power-off").addEventListener("click", () => send(() => powerCommand(false, profile.value), "power off"));
document.querySelectorAll("[data-color]").forEach((button) => {
  button.addEventListener("click", () => {
    color.value = button.dataset.color;
    previewColor();
    send(() => colorCommand(color.value), `color ${color.value.toUpperCase()}`);
  });
});
profile.addEventListener("change", () => {
  update();
  message("Protocol changed. No command has been sent; apply a control to try it.");
  record(`Protocol selected: ${profile.value}.`);
});

const stepsList = element("sequence-steps");
let rowId = 0;
function updateStepButtons() {
  const rows = Array.from(stepsList.children);
  rows.forEach((row, index) => {
    row.querySelector('[data-action="up"]').disabled = index === 0;
    row.querySelector('[data-action="down"]').disabled = index === rows.length - 1;
    row.querySelector('[data-action="remove"]').disabled = rows.length === 1;
  });
  element("add-step").disabled = rows.length >= MAX_STEPS;
}

function addStep(step) {
  const row = element("sequence-step-template").content.firstElementChild.cloneNode(true);
  rowId += 1;
  for (const field of ["color", "hold", "fade"]) {
    const input = row.querySelector(`[data-field="${field}"]`);
    input.id = `step-${rowId}-${field}`;
    input.value = step[field];
    row.querySelector(`[data-label="${field}"]`).htmlFor = input.id;
  }
  const input = row.querySelector('[data-field="color"]');
  const preview = () => { row.querySelector(".step-hex").textContent = input.value.toUpperCase(); };
  input.addEventListener("input", preview);
  preview();
  row.querySelector('[data-action="copy-color"]').addEventListener("click", () => {
    input.value = color.value;
    preview();
    const position = Array.from(stepsList.children).indexOf(row) + 1;
    message(`Copied ${color.value.toUpperCase()} to sequence color ${position}. Timing is unchanged; save the sequence to keep this edit.`);
  });
  row.querySelector('[data-action="up"]').addEventListener("click", () => {
    if (row.previousElementSibling) stepsList.insertBefore(row, row.previousElementSibling);
    updateStepButtons();
  });
  row.querySelector('[data-action="down"]').addEventListener("click", () => {
    if (row.nextElementSibling) stepsList.insertBefore(row.nextElementSibling, row);
    updateStepButtons();
  });
  row.querySelector('[data-action="remove"]').addEventListener("click", () => {
    if (stepsList.children.length > 1) row.remove();
    updateStepButtons();
  });
  stepsList.append(row);
  updateStepButtons();
}

function displaySequence(sequence) {
  element("sequence-name").value = sequence.name;
  element("repeat-sequence").checked = sequence.repeat;
  stepsList.replaceChildren();
  sequence.steps.forEach(addStep);
}

function readSequence() {
  for (const input of element("sequence-editor").querySelectorAll("input")) {
    if (!input.reportValidity()) throw new TypeError("Correct the highlighted sequence field.");
  }
  return validateSequence({
    name: element("sequence-name").value,
    repeat: element("repeat-sequence").checked,
    steps: Array.from(stepsList.children, (row) => ({
      color: row.querySelector('[data-field="color"]').value,
      hold: row.querySelector('[data-field="hold"]').valueAsNumber,
      fade: row.querySelector('[data-field="fade"]').valueAsNumber,
    })),
  });
}

function refreshSaved(selected = "") {
  const select = element("saved-sequences");
  select.replaceChildren(new Option(saved.length ? "Choose a saved sequence" : "No saved sequences", ""));
  saved.forEach((sequence) => select.add(new Option(sequence.name, sequence.name)));
  select.value = selected;
  update();
}

function example() {
  displaySequence({
    name: "White to blue to red",
    repeat: true,
    steps: ["#ffffff", "#0000ff", "#ff0000"].map((hex) => ({ color: hex, hold: 1, fade: 3 })),
  });
}

element("add-step").addEventListener("click", () => {
  if (stepsList.children.length < MAX_STEPS) addStep({ color: "#ffffff", hold: 1, fade: 3 });
});
element("example-sequence").addEventListener("click", () => {
  if (window.confirm("Replace the current editor with the white / blue / red example? Unsaved edits will be lost.")) example();
});
const presets = getSequencePresets();
presets.forEach((preset) => element("sequence-presets").add(new Option(preset.name, preset.name)));
element("load-preset").addEventListener("click", () => {
  const preset = presets.find((item) => item.name === element("sequence-presets").value);
  if (preset && window.confirm(`Load "${preset.name}"? Unsaved edits in the editor will be lost.`)) {
    displaySequence(preset);
    message(`Loaded preset "${preset.name}". Connect the lights and click Play sequence to start.`);
  }
});
element("saved-sequences").addEventListener("change", update);
element("load-sequence").addEventListener("click", () => {
  const sequence = saved.find((item) => item.name === element("saved-sequences").value);
  if (sequence && window.confirm("Load this saved sequence? Unsaved edits in the editor will be lost.")) {
    displaySequence(sequence);
    message(`Loaded "${sequence.name}".`);
  }
});
async function persistSaved(next) {
  if (pythonMode) await serviceRequest("sequences", { sequences: next });
  else storeSequences(window.localStorage, next);
}

element("save-sequence").addEventListener("click", async () => {
  try {
    const sequence = readSequence();
    if (saved.some((item) => item.name === sequence.name) && !window.confirm(`Replace the saved sequence "${sequence.name}"?`)) return;
    const next = [...saved.filter((item) => item.name !== sequence.name), sequence];
    await persistSaved(next);
    saved = next;
    refreshSaved(sequence.name);
    message(`Saved "${sequence.name}" ${pythonMode ? "on this Mac" : "in this browser"}.`);
  } catch (error) {
    report(error);
  }
});
element("delete-sequence").addEventListener("click", async () => {
  const name = element("saved-sequences").value;
  if (!name || !window.confirm(`Delete the saved sequence "${name}"?`)) return;
  try {
    const next = saved.filter((item) => item.name !== name);
    await persistSaved(next);
    saved = next;
    refreshSaved();
    message(`Deleted saved sequence "${name}". The editor is unchanged.`);
  } catch (error) {
    report(error);
  }
});

element("play-sequence").addEventListener("click", async () => {
  if (pythonMode) {
    try {
      await lights.play(readSequence());
      message("Automatic playback enabled. You can close this page; the service will wait and resume when the office lights are in range.");
    } catch (error) { report(error); }
    return;
  }
  if (playback || busy) return;
  let sequence;
  try {
    sequence = readSequence();
    if (document.hidden) throw new Error("Keep this tab visible to start playback.");
  } catch (error) {
    report(error);
    return;
  }
  const current = { controller: new AbortController() };
  playback = current;
  update();
  message(`Playing "${sequence.name}".`);
  record(`Sequence started: ${sequence.name}.`);
  try {
    await playSequence(sequence, {
      send: (command, signal) => lights.send(command, signal),
      signal: current.controller.signal,
      onStep: (index) => {
        element("sequence-state").textContent = `Playing "${sequence.name}" - color ${index + 1} of ${sequence.steps.length}${sequence.repeat ? " (repeating)" : ""}.`;
      },
    });
    element("sequence-state").textContent = "Sequence finished.";
    message(`Finished "${sequence.name}". The last color remains on the lights.`);
    record(`Sequence finished: ${sequence.name}.`);
  } catch (error) {
    if (current.controller.signal.aborted && error === current.controller.signal.reason) {
      element("sequence-state").textContent = "Playback stopped.";
      record(`Sequence stopped: ${sequence.name}.`);
    } else {
      element("sequence-state").textContent = "Playback stopped because of an error.";
      report(error);
    }
  } finally {
    playback = null;
    update();
  }
});

function stopPlayback(reason) {
  if (!playback || playback.controller.signal.aborted) return;
  playback.controller.abort();
  element("sequence-state").textContent = "Stopping playback...";
  message(reason);
  update();
}
element("stop-sequence").addEventListener("click", async () => {
  if (pythonMode) {
    try {
      await lights.stop();
      message("Playback stopped. Automatic resume is disabled until you click Play again.");
    } catch (error) { report(error); }
    return;
  }
  stopPlayback("Playback stopped. The last transmitted color remains on the lights.");
});
document.addEventListener("visibilitychange", () => {
  if (!pythonMode && document.hidden) stopPlayback("Playback stopped because the tab was hidden. Keep it visible while playing.");
});
window.addEventListener("pagehide", () => {
  if (pythonMode) return;
  if (playback) playback.controller.abort();
  lights.disconnect();
});

element("service-devices").addEventListener("change", update);
element("select-service-device").addEventListener("click", async () => {
  try {
    await lights.connect(element("service-devices").value);
    message("Device remembered. It will connect when in range. Load a sequence and click Play to enable automatic playback.");
  } catch (error) { report(error); }
});
element("import-browser-sequences").addEventListener("click", async () => {
  try {
    const imported = loadSequences(window.localStorage);
    if (!imported.length) {
      message("No browser saves at this address. Open the Python service on the original hostname and port to import those saves (stop the Node server first).");
      return;
    }
    if (!window.confirm("Import browser saves onto this Mac? Matching sequence names on disk will be replaced.")) return;
    const names = new Set(imported.map((sequence) => sequence.name));
    const next = [...saved.filter((sequence) => !names.has(sequence.name)), ...imported];
    await persistSaved(next);
    saved = next;
    refreshSaved();
    message(`Imported ${imported.length} browser saves onto this Mac.`);
  } catch (error) { report(error); }
});

example();
try {
  saved = pythonMode ? await serviceRequest("sequences") : loadSequences(window.localStorage);
} catch (error) {
  storageAvailable = false;
  report(new Error(`Cannot load saved sequences; saving is disabled to protect existing data. ${error.message}`));
}
refreshSaved();
update();
if (!supported) {
  message("Web Bluetooth is unavailable. Use Chrome or Edge on your Mac at a localhost address, such as http://lotuslantern.localhost:49173.", true);
}
if (pythonMode) {
  element("python-note").hidden = false;
  element("python-devices").hidden = false;
  element("import-browser-sequences").hidden = false;
  element("saved-sequences-label").textContent = "Saved on this Mac";
  element("playback-help").textContent = "Python playback continues when this tab is hidden or closed. Your Mac must stay awake and within range. When out of range, the service waits and retries the same device; returning to the office restarts the selected sequence from its first color. Stop disables automatic playback. Saves and playback intent are stored on disk.";
  async function pollService() {
    try {
      await lights.refresh();
    } catch (error) {
      if (!serviceOffline) report(error);
      serviceOffline = true;
      lights.connected = false;
      update();
    } finally {
      setTimeout(pollService, 2000);
    }
  }
  pollService();
}
