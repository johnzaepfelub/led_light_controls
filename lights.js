export const SERVICE_UUID = "0000fff0-0000-1000-8000-00805f9b34fb";
export const WRITE_UUID = "0000fff3-0000-1000-8000-00805f9b34fb";

function percent(value) {
  if (!Number.isInteger(value) || value < 0 || value > 100) {
    throw new RangeError("Brightness must be an integer between 0 and 100.");
  }
}

export function colorCommand(hex) {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) {
    throw new TypeError("Color must be a six-digit hex color.");
  }
  const rgb = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
  return Uint8Array.of(0x7e, 0x07, 0x05, 0x03, ...rgb, 0x10, 0xef);
}

export function brightnessCommand(value, profile) {
  percent(value);
  if (profile === "lantern") {
    return Uint8Array.of(0x7e, 0x04, 0x01, Math.round(value * 255 / 100), 0x00, 0xff, 0xff, 0x00, 0xef);
  }
  if (profile === "melk") {
    return Uint8Array.of(0x7e, 0x07, 0x01, value, 0xff, 0xff, 0xff, 0x00, 0xef);
  }
  throw new TypeError("Unknown controller profile.");
}

export function powerCommand(on, profile) {
  if (typeof on !== "boolean") throw new TypeError("Power must be true or false.");
  const value = Number(on);
  if (profile === "lantern") {
    return Uint8Array.of(0x7e, 0x04, 0x04, value, 0x00, value, 0xff, 0x00, 0xef);
  }
  throw new TypeError("Power commands are only supported for the Lotus Lantern profile.");
}

export class Lights {
  constructor(bluetooth, onDisconnect) {
    this.bluetooth = bluetooth;
    this.onDisconnect = onDisconnect;
    this.device = null;
    this.characteristic = null;
    this.lastWrite = 0;
    this.writing = false;
    this.handleDisconnect = () => {
      this.characteristic = null;
      this.onDisconnect();
    };
  }

  get connected() {
    return Boolean(this.device?.gatt?.connected && this.characteristic);
  }

  async connect() {
    this.disconnect();
    const device = await this.bluetooth.requestDevice({
      filters: [{ namePrefix: "BLEDOM" }, { namePrefix: "ELK-BLEDOM" }],
      optionalServices: [SERVICE_UUID],
    });
    this.device = device;
    device.addEventListener("gattserverdisconnected", this.handleDisconnect);
    try {
      const server = await device.gatt.connect();
      const service = await server.getPrimaryService(SERVICE_UUID);
      const characteristic = await service.getCharacteristic(WRITE_UUID);
      if (!characteristic.properties.writeWithoutResponse && !characteristic.properties.write) {
        throw new Error("This controller characteristic does not support writing.");
      }
      if (!device.gatt.connected) throw new Error("The lights disconnected during setup.");
      this.characteristic = characteristic;
      this.lastWrite = 0;
      return device.name || "Unnamed Bluetooth controller";
    } catch (error) {
      this.disconnect();
      throw error;
    }
  }

  disconnect() {
    this.characteristic = null;
    if (this.device) {
      this.device.removeEventListener("gattserverdisconnected", this.handleDisconnect);
      if (this.device.gatt?.connected) this.device.gatt.disconnect();
      this.device = null;
    }
  }

  async send(command, signal) {
    signal?.throwIfAborted();
    if (!this.connected) throw new Error("Connect to your lights first.");
    if (this.writing) throw new Error("A command is already being sent.");
    this.writing = true;
    const characteristic = this.characteristic;
    try {
      const delay = Math.max(0, 150 - (Date.now() - this.lastWrite));
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      signal?.throwIfAborted();
      if (!this.connected || this.characteristic !== characteristic) {
        throw new Error("The lights disconnected before the command could be sent.");
      }
      this.lastWrite = Date.now();
      if (characteristic.properties.writeWithoutResponse) {
        await characteristic.writeValueWithoutResponse(command);
      } else {
        await characteristic.writeValueWithResponse(command);
      }
      if (!this.connected || this.characteristic !== characteristic) {
        throw new Error("The lights disconnected while sending the command.");
      }
    } finally {
      this.writing = false;
    }
  }
}
