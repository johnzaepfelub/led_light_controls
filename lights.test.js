import test from "node:test";
import assert from "node:assert/strict";
import { Lights, SERVICE_UUID, WRITE_UUID, colorCommand, brightnessCommand, powerCommand } from "./lights.js";

const bytes = (command) => Array.from(command);

test("RGB frames match the documented protocol", () => {
  assert.deepEqual(bytes(colorCommand("#ff0099")), [0x7e, 7, 5, 3, 255, 0, 153, 16, 0xef]);
  assert.deepEqual(bytes(colorCommand("#FFFFFF")), [0x7e, 7, 5, 3, 255, 255, 255, 16, 0xef]);
  for (const invalid of ["red", "#fff", "#gg0000", "", null]) {
    assert.throws(() => colorCommand(invalid), TypeError);
  }
});

test("brightness preserves profile-specific scaling and frame shape", () => {
  assert.deepEqual(bytes(brightnessCommand(100, "lantern")), [0x7e, 4, 1, 255, 0, 255, 255, 0, 0xef]);
  assert.equal(brightnessCommand(50, "lantern")[3], 128);
  assert.deepEqual(bytes(brightnessCommand(75, "melk")), [0x7e, 7, 1, 75, 255, 255, 255, 0, 0xef]);
  for (const profile of ["lantern", "melk"]) {
    assert.equal(brightnessCommand(0, profile)[3], 0);
    for (const value of [-1, 101, 0.5, NaN, "50"]) {
      assert.throws(() => brightnessCommand(value, profile), RangeError);
    }
  }
  assert.throws(() => brightnessCommand(50, "unknown"), TypeError);
});

test("power uses verified standard frames only", () => {
  assert.deepEqual(bytes(powerCommand(true, "lantern")), [0x7e, 4, 4, 1, 0, 1, 255, 0, 0xef]);
  assert.deepEqual(bytes(powerCommand(false, "lantern")), [0x7e, 4, 4, 0, 0, 0, 255, 0, 0xef]);
  assert.throws(() => powerCommand(true, "melk"), TypeError);
  assert.throws(() => powerCommand(1, "lantern"), TypeError);
});

function fixture({ response = false, discoveryError = null, writeError = null } = {}) {
  const writes = [];
  const characteristic = {
    properties: { writeWithoutResponse: !response, write: response },
    async writeValueWithoutResponse(command) {
      if (writeError) throw writeError;
      writes.push({ method: "withoutResponse", command, at: Date.now() });
    },
    async writeValueWithResponse(command) {
      if (writeError) throw writeError;
      writes.push({ method: "withResponse", command, at: Date.now() });
    },
  };
  const device = new EventTarget();
  device.name = "ELK-BLEDOM";
  device.gatt = {
    connected: false,
    async connect() {
      this.connected = true;
      return this;
    },
    disconnect() {
      this.connected = false;
      device.dispatchEvent(new Event("gattserverdisconnected"));
    },
    async getPrimaryService(uuid) {
      assert.equal(uuid, SERVICE_UUID);
      if (discoveryError) throw discoveryError;
      return {
        async getCharacteristic(characteristicUUID) {
          assert.equal(characteristicUUID, WRITE_UUID);
          return characteristic;
        },
      };
    },
  };
  const bluetooth = {
    async requestDevice(options) {
      assert.deepEqual(options, {
        filters: [{ namePrefix: "BLEDOM" }, { namePrefix: "ELK-BLEDOM" }],
        optionalServices: [SERVICE_UUID],
      });
      return device;
    },
  };
  let disconnects = 0;
  const lights = new Lights(bluetooth, () => { disconnects += 1; });
  return { lights, writes, device, characteristic, disconnects: () => disconnects };
}

test("connection discovers the service without changing the lights", async () => {
  const { lights, writes, device, disconnects } = fixture();
  assert.equal(await lights.connect(), "ELK-BLEDOM");
  assert.equal(lights.connected, true);
  assert.equal(writes.length, 0);
  device.gatt.disconnect();
  assert.equal(lights.connected, false);
  assert.equal(disconnects(), 1);
  await assert.rejects(lights.send(colorCommand("#ffffff")), /Connect/);
  await lights.connect();
  lights.disconnect();
  assert.equal(lights.connected, false);
  assert.equal(disconnects(), 1);
});

test("service discovery failure releases the connection", async () => {
  const { lights, device } = fixture({ discoveryError: new Error("Service unavailable") });
  await assert.rejects(lights.connect(), /Service unavailable/);
  assert.equal(lights.connected, false);
  assert.equal(device.gatt.connected, false);
});

test("writes use the characteristic's supported method", async () => {
  for (const response of [false, true]) {
    const { lights, writes } = fixture({ response });
    await lights.connect();
    const command = colorCommand("#0000ff");
    await lights.send(command);
    assert.equal(writes[0].method, response ? "withResponse" : "withoutResponse");
    assert.deepEqual(writes[0].command, command);
    lights.disconnect();
  }
});

test("unsupported write properties fail explicitly", async () => {
  const { lights, characteristic } = fixture();
  characteristic.properties = { write: false, writeWithoutResponse: false };
  await assert.rejects(lights.connect(), /does not support writing/);
  assert.equal(lights.connected, false);
});

test("write errors propagate and release the busy guard", async () => {
  const { lights } = fixture({ writeError: new Error("Write failed") });
  await lights.connect();
  await assert.rejects(lights.send(colorCommand("#0000ff")), /Write failed/);
  assert.equal(lights.writing, false);
  lights.disconnect();
});

test("writes are spaced at least 150ms apart and reject overlapping operations", async () => {
  const { lights, writes } = fixture();
  await lights.connect();
  const command = colorCommand("#0000ff");
  await lights.send(command);
  const pending = lights.send(command);
  await assert.rejects(lights.send(command), /already being sent/);
  await pending;
  assert.ok(writes[1].at - writes[0].at >= 150);
  lights.disconnect();
});

test("disconnect during rate-limit wait prevents stale writes", async () => {
  const { lights, writes, device } = fixture();
  await lights.connect();
  const command = colorCommand("#0000ff");
  await lights.send(command);
  const pending = lights.send(command);
  device.gatt.disconnect();
  await assert.rejects(pending, /disconnected before/);
  assert.equal(writes.length, 1);
  assert.equal(lights.writing, false);
});

test("Bluetooth chooser cancellation propagates without retaining a device", async () => {
  const lights = new Lights({
    async requestDevice() { throw new DOMException("No device selected", "NotFoundError"); },
  }, () => {});
  await assert.rejects(lights.connect(), /No device selected/);
  assert.equal(lights.device, null);
  assert.equal(lights.connected, false);
});

test("sequence stop cancels a rate-limited command before it reaches Bluetooth", async () => {
  const { lights, writes } = fixture();
  const controller = new AbortController();
  await lights.connect();
  await lights.send(colorCommand("#ffffff"));
  const pending = lights.send(colorCommand("#0000ff"), controller.signal);
  controller.abort();
  await assert.rejects(pending, (error) => error === controller.signal.reason);
  assert.equal(writes.length, 1);
  assert.equal(lights.writing, false);
  lights.disconnect();
});
