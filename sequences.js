import { colorCommand } from "./lights.js";

const STORAGE_KEY = "neon-color-sequences-v1";
export const MAX_STEPS = 50;
export const FRAME_MS = 150;

export function getSequencePresets() {
  return [
    { name: "Halloween Spooky", colors: ["#ff1900", "#c800ff"] },
    { name: "Christmas Classic", colors: ["#ff0000", "#f9644f", "#F9644F", "#f9644f"] },
    { name: "Winter Frost", colors: ["#1100FF", "#80e8ff", "#FD6868"] },
    { name: "Easter Pastels", colors: ["#ff80b5", "#b080ff", "#80ffb0", "#ffe680"] },
    { name: "Valentine's Glow", colors: ["#ff0000", "#ff3399", "#ff80b0"] },
    { name: "St. Patrick's Day", colors: ["#00c832", "#ffb800", "#FD6868"] },
    { name: "Thanksgiving Harvest", colors: ["#ff8800", "#ffcc00", "#ff3300"], hold: 8, fade: 6 },
    { name: "Hanukkah Lights", colors: ["#0055ff", "#FD6868"] },
    { name: "New Year's Gold", colors: ["#ffb800", "#ffdca0", "#FD6868"], hold: 3, fade: 3 },
    { name: "Independence Day", colors: ["#ff0000", "#FD6868", "#0000ff"] },
  ].map(({ name, colors, hold = 5, fade = 5 }) => ({
    name,
    repeat: true,
    steps: colors.map((color) => ({ color, hold, fade })),
  }));
}

export function validateSequence(sequence) {
  if (!sequence || typeof sequence.name !== "string" || !sequence.name.trim() || sequence.name.trim().length > 80) {
    throw new TypeError("Give the sequence a name between 1 and 80 characters.");
  }
  if (typeof sequence.repeat !== "boolean") throw new TypeError("Repeat must be enabled or disabled.");
  if (!Array.isArray(sequence.steps) || sequence.steps.length < 1 || sequence.steps.length > MAX_STEPS) {
    throw new RangeError(`A sequence must contain 1 to ${MAX_STEPS} colors.`);
  }
  const steps = sequence.steps.map((step, index) => {
    if (!step || typeof step.color !== "string") throw new TypeError(`Color ${index + 1} is invalid.`);
    colorCommand(step.color);
    for (const key of ["hold", "fade"]) {
      if (typeof step[key] !== "number" || !Number.isFinite(step[key]) || step[key] < 0 || step[key] > 3600) {
        throw new RangeError(`Color ${index + 1}: ${key} time must be between 0 and 3600 seconds.`);
      }
    }
    return { color: step.color.toLowerCase(), hold: step.hold, fade: step.fade };
  });
  return { name: sequence.name.trim(), repeat: sequence.repeat, steps };
}

export function loadSequences(storage) {
  const raw = storage.getItem(STORAGE_KEY);
  if (raw === null) return [];
  const data = JSON.parse(raw);
  if (!data || data.version !== 1 || !Array.isArray(data.sequences)) {
    throw new TypeError("Saved sequence data has an unsupported format.");
  }
  const sequences = data.sequences.map(validateSequence);
  if (new Set(sequences.map((sequence) => sequence.name)).size !== sequences.length) {
    throw new TypeError("Saved sequences contain duplicate names.");
  }
  return sequences;
}

export function storeSequences(storage, sequences) {
  const validated = sequences.map(validateSequence);
  if (new Set(validated.map((sequence) => sequence.name)).size !== validated.length) {
    throw new TypeError("Sequence names must be unique.");
  }
  storage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, sequences: validated }));
}

export function interpolateColor(from, to, fraction) {
  colorCommand(from);
  colorCommand(to);
  if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) {
    throw new RangeError("Fade progress must be between 0 and 1.");
  }
  return "#" + [1, 3, 5].map((offset) => {
    const start = Number.parseInt(from.slice(offset, offset + 2), 16);
    const end = Number.parseInt(to.slice(offset, offset + 2), 16);
    return Math.round(start + (end - start) * fraction).toString(16).padStart(2, "0");
  }).join("");
}

export function wait(milliseconds, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
  });
}

export async function playSequence(sequence, {
  send, signal, onStep = () => {}, now = () => performance.now(), sleep = wait,
}) {
  const { steps, repeat } = validateSequence(sequence);
  const write = async (hex) => {
    signal.throwIfAborted();
    await send(colorCommand(hex), signal);
    signal.throwIfAborted();
  };
  await write(steps[0].color);
  let index = 0;
  while (true) {
    signal.throwIfAborted();
    const step = steps[index];
    onStep(index);
    await sleep(step.hold * 1000, signal);
    if (index === steps.length - 1 && !repeat) return;
    const next = (index + 1) % steps.length;
    const duration = step.fade * 1000;
    if (duration === 0) {
      // Also rate-limit instant transitions when every hold time is zero.
      await sleep(FRAME_MS, signal);
      await write(steps[next].color);
    } else {
      const start = now();
      let progress = 0;
      while (progress < 1) {
        await sleep(Math.min(FRAME_MS, Math.max(0, duration - (now() - start))), signal);
        progress = Math.min(1, (now() - start) / duration);
        await write(interpolateColor(step.color, steps[next].color, progress));
      }
    }
    index = next;
  }
}
