import test from "node:test";
import assert from "node:assert/strict";
import {
  FRAME_MS, getSequencePresets, interpolateColor, loadSequences, storeSequences, validateSequence, playSequence, wait,
} from "./sequences.js";

function sequence(overrides = {}) {
  return {
    name: "White / blue / red",
    repeat: false,
    steps: ["#ffffff", "#0000ff", "#ff0000"].map((color) => ({ color, hold: 1, fade: 0.3 })),
    ...overrides,
  };
}

test("original presets retain their requested colors, five-second holds/fades, and repeat", () => {
  const presets = getSequencePresets();
  assert.deepEqual(presets.slice(0, 2), [
    {
      name: "Halloween Fade", repeat: true,
      steps: [
        { color: "#ff1900", hold: 5, fade: 5 },
        { color: "#c800ff", hold: 5, fade: 5 },
      ],
    },
    {
      name: "Patriotic Fade", repeat: true,
      steps: [
        { color: "#ff0000", hold: 5, fade: 5 },
        { color: "#ffffff", hold: 5, fade: 5 },
        { color: "#c800ff", hold: 5, fade: 5 },
      ],
    },
  ]);
  presets.forEach((preset) => assert.deepEqual(validateSequence(preset), preset));
  presets[0].steps[0].color = "#000000";
  assert.equal(getSequencePresets()[0].steps[0].color, "#ff1900");
});

test("additional holiday presets match the recommended colors and timing", () => {
  const expected = [
    ["Christmas Classic", ["#ff0000", "#f9644f", "#00c832", "#f9644f"], 5, 5],
    ["Christmas Frost", ["#0064ff", "#80e8ff", "#ffffff"], 5, 5],
    ["Easter Pastels", ["#ff80b5", "#b080ff", "#80ffb0", "#ffe680"], 5, 5],
    ["Valentine's Glow", ["#ff0000", "#ff3399", "#ff80b0"], 5, 5],
    ["St. Patrick's Day", ["#00c832", "#ffb800", "#ffffff"], 5, 5],
    ["Thanksgiving Harvest", ["#ff8800", "#ffcc00", "#ff3300"], 8, 6],
    ["Hanukkah Lights", ["#0055ff", "#ffffff"], 5, 5],
    ["New Year's Gold", ["#ffb800", "#ffdca0", "#ffffff"], 3, 3],
    ["Independence Day", ["#ff0000", "#ffffff", "#0000ff"], 5, 5],
  ].map(([name, colors, hold, fade]) => ({
    name, repeat: true, steps: colors.map((color) => ({ color, hold, fade })),
  }));
  assert.deepEqual(getSequencePresets().slice(2), expected);
  assert.equal(new Set(getSequencePresets().map((preset) => preset.name)).size, 11);
});

test("each preset honors hold and fade times including the repeating wraparound", async () => {
  for (const preset of getSequencePresets()) {
    const { options, controller, writes, steps } = playerFixture();
    options.onStep = (index) => {
      steps.push(index);
      if (steps.length === preset.steps.length + 1) controller.abort();
    };
    await assert.rejects(playSequence(preset, options), (error) => error === controller.signal.reason);
    let start = 0;
    for (let index = 0; index < preset.steps.length; index += 1) {
      const step = preset.steps[index];
      const end = start + (step.hold + step.fade) * 1000;
      const firstFrame = writes.find((write) => write.time > start);
      assert.equal(firstFrame.time, start + step.hold * 1000 + FRAME_MS);
      const endpoint = writes.find((write) => write.time === end);
      assert.equal(endpoint.color, preset.steps[(index + 1) % preset.steps.length].color);
      start = end;
    }
    assert.equal(writes.at(-1).time, start);
    assert.equal(writes.at(-1).color, preset.steps[0].color);
  }
});

function storageFixture() {
  let value = null;
  return {
    getItem: () => value,
    setItem: (_key, next) => { value = next; },
  };
}

function playerFixture() {
  const controller = new AbortController();
  const writes = [];
  const pauses = [];
  const steps = [];
  let time = 0;
  const options = {
    signal: controller.signal,
    now: () => time,
    sleep: async (ms, signal) => {
      signal.throwIfAborted();
      time += ms;
      pauses.push(ms);
    },
    send: async (command, signal) => {
      signal.throwIfAborted();
      const color = "#" + Array.from(command.slice(4, 7), (byte) => byte.toString(16).padStart(2, "0")).join("");
      writes.push({ color, time });
    },
    onStep: (index) => steps.push(index),
  };
  return { controller, writes, pauses, steps, options };
}

test("validates and clones sequence values without mutating the draft", () => {
  const draft = sequence({ name: "  Example  " });
  draft.steps[0].color = "#FFFFFF";
  const result = validateSequence(draft);
  assert.equal(result.name, "Example");
  assert.equal(result.steps[0].color, "#ffffff");
  result.steps[0].hold = 5;
  assert.equal(draft.steps[0].hold, 1);
});

test("rejects missing names, malformed colors, invalid durations, and invalid step counts", () => {
  for (const name of ["", "  ", "x".repeat(81), null]) {
    assert.throws(() => validateSequence(sequence({ name })));
  }
  for (const repeat of [0, "yes", undefined]) {
    assert.throws(() => validateSequence(sequence({ repeat })));
  }
  for (const steps of [[], null, Array(51).fill({ color: "#ffffff", hold: 1, fade: 1 })]) {
    assert.throws(() => validateSequence(sequence({ steps })));
  }
  for (const value of [-1, 3601, NaN, Infinity, "2", null]) {
    for (const field of ["hold", "fade"]) {
      assert.throws(() => validateSequence(sequence({
        steps: [{ color: "#ffffff", hold: 1, fade: 1, [field]: value }],
      })));
    }
  }
  assert.throws(() => validateSequence(sequence({ steps: [{ color: "#xyzxyz", hold: 1, fade: 1 }] })));
  assert.doesNotThrow(() => validateSequence(sequence({ steps: [{ color: "#ffffff", hold: 3600, fade: 0.125 }] })));
});

test("saved sequences survive a fresh load, can be replaced, and can be deleted", () => {
  const storage = storageFixture();
  assert.deepEqual(loadSequences(storage), []);
  const first = sequence();
  const second = sequence({ name: "Another" });
  storeSequences(storage, [first, second]);
  assert.deepEqual(loadSequences(storage), [first, second]);
  const modified = sequence({ repeat: true });
  storeSequences(storage, [modified, second]);
  assert.deepEqual(loadSequences(storage), [modified, second]);
  storeSequences(storage, [second]);
  assert.deepEqual(loadSequences(storage), [second]);
  storeSequences(storage, []);
  assert.deepEqual(loadSequences(storage), []);
});

test("invalid saves do not replace existing storage; corruption and storage errors propagate", () => {
  const storage = storageFixture();
  storeSequences(storage, [sequence()]);
  const original = storage.getItem();
  assert.throws(() => storeSequences(storage, [sequence(), sequence()]), /unique/);
  assert.equal(storage.getItem(), original);
  assert.throws(() => storeSequences(storage, [sequence({ name: "" })]));
  assert.equal(storage.getItem(), original);
  for (const data of ["{", "null", '{"version":2,"sequences":[]}', '{"version":1,"sequences":[{}]}']) {
    assert.throws(() => loadSequences({ getItem: () => data }));
  }
  assert.throws(() => loadSequences({
    getItem: () => JSON.stringify({ version: 1, sequences: [sequence(), sequence()] }),
  }), /duplicate/);
  assert.throws(() => loadSequences({ getItem() { throw new Error("Storage unavailable"); } }), /Storage unavailable/);
  assert.throws(() => storeSequences({ setItem() { throw new Error("Quota exceeded"); } }, [sequence()]), /Quota exceeded/);
});

test("RGB interpolation produces exact endpoints and rounded intermediate values", () => {
  assert.equal(interpolateColor("#ffffff", "#0000ff", 0), "#ffffff");
  assert.equal(interpolateColor("#ffffff", "#0000ff", 0.5), "#8080ff");
  assert.equal(interpolateColor("#ffffff", "#0000ff", 1), "#0000ff");
  assert.equal(interpolateColor("#0000ff", "#ff0000", 0.5), "#800080");
  for (const value of [-1, 1.1, NaN]) {
    assert.throws(() => interpolateColor("#ffffff", "#0000ff", value));
  }
});

test("white -> blue -> red fades and finishes after the final hold without wrapping", async () => {
  const { options, writes, pauses, steps } = playerFixture();
  await playSequence(sequence(), options);
  assert.deepEqual(writes.map((write) => write.color), ["#ffffff", "#8080ff", "#0000ff", "#800080", "#ff0000"]);
  assert.deepEqual(steps, [0, 1, 2]);
  assert.equal(writes[2].time, 1300);
  assert.equal(writes[4].time, 2600);
  assert.equal(pauses.reduce((sum, ms) => sum + ms, 0), 3600);
});

test("repeat fades the last color back to the first and stopping sends no more frames", async () => {
  const { options, controller, writes, steps } = playerFixture();
  options.onStep = (index) => {
    steps.push(index);
    if (steps.length === 4) controller.abort();
  };
  await assert.rejects(playSequence(sequence({ repeat: true }), options), (error) => error === controller.signal.reason);
  assert.deepEqual(steps, [0, 1, 2, 0]);
  assert.deepEqual(writes.slice(-2).map((write) => write.color), ["#ff8080", "#ffffff"]);
  assert.equal(writes.length, 7);
});

test("zero hold and zero fade loops are rate-limited, ordered, and cancellable", async () => {
  const { options, controller, writes } = playerFixture();
  const original = options.send;
  options.send = async (command, signal) => {
    await original(command, signal);
    if (writes.length === 5) controller.abort();
  };
  await assert.rejects(playSequence(sequence({
    repeat: true,
    steps: ["#ffffff", "#0000ff", "#ff0000"].map((color) => ({ color, hold: 0, fade: 0 })),
  }), options), (error) => error === controller.signal.reason);
  assert.deepEqual(writes.map((write) => write.color), ["#ffffff", "#0000ff", "#ff0000", "#ffffff", "#0000ff"]);
  for (let index = 1; index < writes.length; index += 1) {
    assert.ok(writes[index].time - writes[index - 1].time >= FRAME_MS);
  }
});

test("one color runs once; pre-aborted playback sends nothing", async () => {
  const { options, writes, controller } = playerFixture();
  await playSequence(sequence({ steps: [{ color: "#ffffff", hold: 0, fade: 3 }] }), options);
  assert.equal(writes.length, 1);
  controller.abort();
  await assert.rejects(playSequence(sequence(), options), (error) => error === controller.signal.reason);
  assert.equal(writes.length, 1);
});

test("write errors terminate playback without issuing subsequent commands", async () => {
  const { options, writes } = playerFixture();
  const original = options.send;
  options.send = async (command, signal) => {
    if (writes.length === 2) throw new Error("Bluetooth write failed");
    await original(command, signal);
  };
  await assert.rejects(playSequence(sequence({ repeat: true }), options), /Bluetooth write failed/);
  assert.equal(writes.length, 2);
});

test("abort interrupts long holds immediately and prevents the next color", async () => {
  const controller = new AbortController();
  let writes = 0;
  const pending = playSequence(sequence(), {
    signal: controller.signal,
    send: async () => { writes += 1; },
    onStep: () => queueMicrotask(() => controller.abort()),
  });
  await assert.rejects(pending, (error) => error === controller.signal.reason);
  assert.equal(writes, 1);
});

test("abort during a fade prevents subsequent writes", async () => {
  const { options, writes, controller } = playerFixture();
  options.sleep = async (ms, signal) => {
    if (ms > 0) controller.abort();
    signal.throwIfAborted();
  };
  await assert.rejects(playSequence(sequence({
    steps: [{ color: "#ffffff", hold: 0, fade: 3 }, { color: "#0000ff", hold: 0, fade: 0 }],
  }), options), (error) => error === controller.signal.reason);
  assert.equal(writes.length, 1);
});

test("wait rejects already-aborted signals", async () => {
  const controller = new AbortController();
  controller.abort();
  assert.throws(() => wait(1000, controller.signal), (error) => error === controller.signal.reason);
});
