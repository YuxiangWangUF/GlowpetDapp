import assert from "node:assert/strict";
import test from "node:test";
import { getPlushIdlePose } from "../src/plush-idle-motion.js";

const PERIOD = 17;
const MODELS = ["rabbit", "cat", "fox", "mouse", "sheep"];
const REST = { blink: 0, leftEar: 0, rightEar: 0 };
const toDegrees = (radians) => radians * 180 / Math.PI;
const near = (actual, expected, tolerance = 1e-10) => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected}`);
};

test("invalid elapsed times return a safe resting pose, and model fallback is stable", () => {
  for (const time of [NaN, Infinity, -Infinity, -1, undefined, null, "2.5"]) {
    assert.deepEqual(getPlushIdlePose(time, "cat"), REST);
  }
  for (const model of [...MODELS, "unknown", "__proto__", null]) {
    assert.deepEqual(getPlushIdlePose(0, model), REST);
  }
  for (const time of [2.5, 4.5, 7.4, 14.6]) {
    assert.deepEqual(getPlushIdlePose(time, "unknown"), getPlushIdlePose(time, "rabbit"));
    assert.deepEqual(getPlushIdlePose(time, "__proto__"), getPlushIdlePose(time, "rabbit"));
  }
});

test("poses are deterministic and bounded, with smaller movement for long and floppy ears", () => {
  const maximumAngles = {};
  for (const model of MODELS) {
    let maximumAngle = 0;
    for (let sample = 0; sample <= PERIOD * 500; sample++) {
      const time = sample / 500;
      const pose = getPlushIdlePose(time, model);
      assert.ok(Number.isFinite(pose.blink) && pose.blink >= 0 && pose.blink <= 1);
      for (const angle of [pose.leftEar, pose.rightEar]) {
        assert.ok(Number.isFinite(angle));
        maximumAngle = Math.max(maximumAngle, Math.abs(toDegrees(angle)));
        assert.ok(Math.abs(toDegrees(angle)) <= 2.25 + 1e-10);
      }
      if (model === "rabbit") assert.ok(Math.abs(toDegrees(pose.rightEar)) <= 1.375);
      if (sample % 137 === 0) assert.deepEqual(pose, getPlushIdlePose(time, model));
    }
    maximumAngles[model] = maximumAngle;
    assert.ok(maximumAngle > 1, `${model} has a visible but subtle gesture`);
  }
  assert.ok(maximumAngles.rabbit < maximumAngles.cat);
  assert.ok(maximumAngles.sheep < maximumAngles.cat);
});

test("the repeated loop and each gesture boundary remain continuous", () => {
  for (const model of MODELS) {
    for (const time of [0, 1.3, 2.51, 4.6, 7.44, 10.8, 14.3, PERIOD - 1e-7]) {
      const pose = getPlushIdlePose(time, model);
      const repeated = getPlushIdlePose(time + PERIOD, model);
      for (const property of Object.keys(REST)) near(pose[property], repeated[property]);
    }
    for (const property of Object.keys(REST)) {
      near(getPlushIdlePose(PERIOD - 1e-7, model)[property], getPlushIdlePose(PERIOD + 1e-7, model)[property]);
    }
    // Sampling the whole loop also covers phase-shifted internal boundaries.
    let previous = getPlushIdlePose(0, model);
    for (let sample = 1; sample <= PERIOD * 1000; sample++) {
      const next = getPlushIdlePose(sample / 1000, model);
      assert.ok(Math.abs(next.blink - previous.blink) < 0.018, "a blink never snaps between frames");
      assert.ok(Math.abs(next.leftEar - previous.leftEar) < 0.0002);
      assert.ok(Math.abs(next.rightEar - previous.rightEar) < 0.0002);
      previous = next;
    }
  }
});

test("blinks have a small duty cycle, open between a light double blink, and close faster than they open", () => {
  for (const model of MODELS) {
    let blinking = 0;
    let longestBlink = 0;
    let currentBlink = 0;
    let almostClosed = 0;
    const intervals = [];
    for (let sample = 0; sample <= PERIOD * 1000; sample++) {
      const blink = getPlushIdlePose(sample / 1000, model).blink;
      if (blink > 0) {
        if (currentBlink === 0) intervals.push({ start: sample / 1000 });
        blinking++;
        currentBlink++;
        longestBlink = Math.max(longestBlink, currentBlink);
      } else if (currentBlink > 0) {
        intervals.at(-1).duration = currentBlink / 1000;
        currentBlink = 0;
      }
      if (blink > 0.98) almostClosed++;
    }
    assert.equal(intervals.length, 4);
    assert.ok(blinking / (PERIOD * 1000) < 0.08);
    assert.ok(longestBlink / 1000 <= 0.321);
    assert.ok(almostClosed / 1000 < 0.16, "eyes do not stay closed");
    for (const interval of intervals) {
      assert.ok(interval.duration >= 0.25 && interval.duration <= 0.321);
    }
    const gaps = intervals.slice(1).map((interval, index) => (
      interval.start - intervals[index].start - intervals[index].duration
    ));
    assert.ok(gaps.some((gap) => gap > 0.05 && gap < 0.15), "double blink has a brief open gap");
    assert.ok(gaps.some((gap) => gap > 4), "other blinks are well separated");
  }
  const peak = 2.4 + 0.28 * 0.36;
  near(getPlushIdlePose(peak).blink, 1);
  assert.ok(getPlushIdlePose(peak - 0.08).blink < getPlushIdlePose(peak + 0.08).blink);
  assert.deepEqual(getPlushIdlePose(7.28), REST);
  assert.ok(getPlushIdlePose(7.33 + 0.26 * 0.36).blink < 0.9, "second blink is lighter");
});

test("ears rest for most of each cycle and move independently with stable per-model phase offsets", () => {
  const starts = new Map();
  for (const model of MODELS) {
    let eitherEarMoving = 0;
    let leftOnly = 0;
    let rightOnly = 0;
    for (let sample = 0; sample < PERIOD * 500; sample++) {
      const pose = getPlushIdlePose(sample / 500, model);
      const leftMoving = pose.leftEar !== 0;
      const rightMoving = pose.rightEar !== 0;
      if (leftMoving || rightMoving) eitherEarMoving++;
      if (leftMoving && !rightMoving) leftOnly++;
      if (rightMoving && !leftMoving) rightOnly++;
      if (leftMoving && !starts.has(model)) starts.set(model, sample / 500);
    }
    assert.ok(eitherEarMoving / (PERIOD * 500) < 0.4);
    assert.ok(leftOnly / 500 > 2);
    assert.ok(rightOnly / 500 > 2);
  }
  assert.equal(new Set(starts.values()).size, MODELS.length, "characters do not twitch in unison");
});
