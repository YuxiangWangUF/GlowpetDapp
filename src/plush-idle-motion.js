const PERIOD_SECONDS = 17;
const DEGREES_TO_RADIANS = Math.PI / 180;
const EAR_SWAY_GAIN = 1.25;

// Fixed phases keep repeated renders stable and companions from moving in sync.
// Short, separated gestures leave most of the loop at the original pose.
const MODEL_MOTION = Object.freeze({
  rabbit: { phase: 0, leftEarDegrees: 1.6, rightEarDegrees: 1.1 },
  cat: { phase: 0.63, leftEarDegrees: 1.8, rightEarDegrees: 1.8 },
  fox: { phase: 1.17, leftEarDegrees: 1.65, rightEarDegrees: 1.65 },
  mouse: { phase: 0.32, leftEarDegrees: 1.5, rightEarDegrees: 1.5 },
  sheep: { phase: 0.91, leftEarDegrees: 1.35, rightEarDegrees: 1.35 },
});

const BLINKS = [
  { start: 2.4, duration: 0.28, strength: 1 },
  { start: 6.95, duration: 0.3, strength: 1 },
  { start: 7.33, duration: 0.26, strength: 0.88 },
  { start: 12.8, duration: 0.32, strength: 1 },
];

function smoothstep(value) {
  return value * value * (3 - 2 * value);
}

// A smooth pulse with no closed-eye hold. The first part reaches the peak;
// the remainder eases back to rest, with zero velocity at both ends.
function pulse(time, start, duration, peakAt = 0.5) {
  const progress = (time - start) / duration;
  if (progress <= 0 || progress >= 1) return 0;
  return progress < peakAt
    ? smoothstep(progress / peakAt)
    : 1 - smoothstep((progress - peakAt) / (1 - peakAt));
}

/**
 * Return a deterministic idle pose without changing the pet or its care state.
 * `blink` is 0 for open eyes and 1 for closed eyes; ear angles are in radians.
 * Call with animation elapsed time (seconds), not a wall-clock timestamp.
 */
export function getPlushIdlePose(elapsedSeconds, modelId = "rabbit") {
  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds < 0) {
    return { blink: 0, leftEar: 0, rightEar: 0 };
  }

  const model = Object.hasOwn(MODEL_MOTION, modelId)
    ? MODEL_MOTION[modelId]
    : MODEL_MOTION.rabbit;
  const time = ((elapsedSeconds % PERIOD_SECONDS) + model.phase) % PERIOD_SECONDS;
  let blink = 0;
  for (const event of BLINKS) {
    blink = Math.max(blink, event.strength * pulse(time, event.start, event.duration, 0.36));
  }

  const leftEar = model.leftEarDegrees * EAR_SWAY_GAIN * DEGREES_TO_RADIANS * (
    pulse(time, 3.9, 1.6, 0.4)
    - 0.55 * pulse(time, 10.55, 1.8, 0.43)
  );
  const rightEar = model.rightEarDegrees * EAR_SWAY_GAIN * DEGREES_TO_RADIANS * (
    -0.85 * pulse(time, 5.05, 1.6, 0.43)
    + 0.55 * pulse(time, 13.95, 1.75, 0.4)
  );

  return { blink, leftEar, rightEar };
}
