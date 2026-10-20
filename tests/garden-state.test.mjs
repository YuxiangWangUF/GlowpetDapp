import assert from "node:assert/strict";
import test from "node:test";
import {
  CROPS, FEED_FULLNESS_LIMIT, PLAY_COOLDOWN_MS, PLOT_COUNT, SEED_CAP,
  advanceGame, createGame, getCareProgress, isGardenState, makeGardenKey, normalizeGame,
  reduceGame, upgradeGame,
} from "../src/garden-state.js";
import { createGardenStore } from "../src/useGardenGame.js";

const START = 1_000_000;
const buy = (cropId = CROPS[0].id) => ({ type: "buy", cropId });
const plant = (cropId = CROPS[0].id, plotIndex = 0) => ({ type: "plant", cropId, plotIndex });
const harvest = (plotIndex = 0) => ({ type: "harvest", plotIndex });
const clone = (value) => structuredClone(value);
const withSeeds = (state, counts = {}) => ({
  ...state,
  seeds: { ...state.seeds, [CROPS[0].id]: 1, ...counts },
});

function storageFixture(initial) {
  const values = new Map(initial === undefined ? [] : [["garden", JSON.stringify(initial)]]);
  return {
    values,
    writes: 0,
    failRead: false,
    failWrite: false,
    getItem(key) {
      if (this.failRead) throw new Error("Access denied");
      return this.values.get(key) ?? null;
    },
    setItem(key, value) {
      if (this.failWrite) throw new Error("Quota exceeded");
      this.writes++;
      this.values.set(key, value);
    },
  };
}

function exclusiveLocks() {
  const queues = new Map();
  return {
    calls: 0,
    request(name, options, callback) {
      assert.equal(options.mode, "exclusive");
      this.calls++;
      const previous = queues.get(name) ?? Promise.resolve();
      const operation = previous.then(callback);
      queues.set(name, operation.catch(() => {}));
      return operation;
    },
  };
}

test("new gardens have three plots, no seeds, and free seeds can always be bought", () => {
  const initial = createGame(START);
  assert.equal(initial.coins, 20);
  assert.equal(initial.food, 1);
  assert.equal(initial.plots.length, PLOT_COUNT);
  assert.deepEqual(initial.seeds, { carrot: 0, glowberry: 0, moonbloom: 0 });
  const broke = { ...initial, coins: 0, food: 0 };
  const free = CROPS.find((crop) => crop.cost === 0);
  assert.ok(free);
  assert.strictEqual(reduceGame(broke, plant(free.id), START), broke, "cannot plant without a seed packet");
  const stocked = reduceGame(broke, buy(free.id), START);
  assert.equal(stocked.coins, 0, "free packets do not require coins");
  assert.equal(stocked.seeds[free.id], 1);
  const growing = reduceGame(stocked, plant(free.id), START);
  const ready = reduceGame(growing, harvest(), START + free.growMs);
  assert.equal(ready.coins, free.coins);
  assert.equal(ready.food, free.food);
  assert.equal(ready.xp, free.xp);
  assert.equal(ready.harvests, 1);
  assert.equal(ready.plots[0], null);
});

test("seed packets are paid for at purchase and planting only spends the packet", () => {
  for (const crop of CROPS) {
    const initial = createGame(START);
    assert.strictEqual(reduceGame(initial, plant(crop.id), START), initial, "planting needs stock");
    const bought = reduceGame(initial, buy(crop.id), START);
    assert.equal(bought.coins, initial.coins - crop.cost);
    assert.equal(bought.seeds[crop.id], 1);
    const growing = reduceGame(bought, plant(crop.id), START);
    assert.equal(growing.coins, initial.coins - crop.cost, "planting does not charge again");
    assert.equal(growing.seeds[crop.id], 0, "planting consumes one packet");
    assert.deepEqual(growing.plots[0], { cropId: crop.id, plantedAt: START, readyAt: START + crop.growMs });
    assert.strictEqual(reduceGame(growing, plant(), START), growing);
    assert.strictEqual(reduceGame(growing, harvest(), START + crop.growMs - 1), growing);
    const ready = reduceGame(growing, harvest(), START + crop.growMs);
    assert.equal(ready.coins, initial.coins - crop.cost + crop.coins);
    assert.equal(ready.food, initial.food + crop.food);
    assert.equal(ready.xp, crop.xp);
    assert.equal(ready.revision, 3);
    assert.strictEqual(reduceGame(ready, harvest(), START + crop.growMs), ready);
    assert.equal(growing.plots[0].cropId, crop.id, "the previous state remains unchanged");
  }
});

test("buying enforces coins and shelf capacity", () => {
  const expensive = CROPS.find((crop) => crop.cost > 0);
  const poor = { ...createGame(START), coins: expensive.cost - 1 };
  assert.strictEqual(reduceGame(poor, buy(expensive.id), START), poor);
  const full = withSeeds(createGame(START), { [expensive.id]: SEED_CAP });
  assert.strictEqual(reduceGame(full, buy(expensive.id), START), full);
  const bought = reduceGame(createGame(START), buy(expensive.id), START);
  assert.equal(bought.seeds[expensive.id], 1);
  assert.equal(bought.coins, 20 - expensive.cost);
});

test("invalid actions neither mutate state nor grant rewards", () => {
  const state = Object.freeze({ ...createGame(START), plots: Object.freeze([null, null, null]) });
  for (const action of [
    null, undefined, {}, { type: "mint" }, buy("missing"), plant("missing"), plant("carrot", -1),
    plant("carrot", 3), plant("carrot", 0.5), harvest(7), harvest(),
  ]) {
    assert.strictEqual(reduceGame(state, action, START), state);
  }
  assert.strictEqual(reduceGame(null, { type: "feed" }, START), null);
});

test("feeding spends one food, improves care, and cannot be repeated after one second of decay", () => {
  const initial = { ...createGame(START), food: 3 };
  const fed = reduceGame(initial, { type: "feed" }, START);
  assert.equal(fed.food, 2);
  assert.equal(fed.xp, 20);
  assert.equal(fed.fullness, 100);
  assert.equal(fed.happiness, 75);
  assert.equal(fed.feeds, 1);
  assert.strictEqual(reduceGame(fed, { type: "feed" }, START + 1000), fed);
  const threshold = { ...initial, fullness: FEED_FULLNESS_LIMIT };
  assert.strictEqual(reduceGame(threshold, { type: "feed" }, START), threshold);
  const hungry = { ...initial, fullness: 0, happiness: 99 };
  const fedHungry = reduceGame(hungry, { type: "feed" }, START);
  assert.equal(fedHungry.fullness, 25);
  assert.equal(fedHungry.happiness, 100);
  const noFood = { ...hungry, food: 0 };
  assert.strictEqual(reduceGame(noFood, { type: "feed" }, START), noFood);
  const rested = advanceGame(fed, START + 6_000_001);
  assert.ok(rested.fullness < FEED_FULLNESS_LIMIT);
  assert.notStrictEqual(reduceGame(rested, { type: "feed" }, START + 6_000_001), rested);
});

test("play is immediately available, then has a real 30-second cooldown even at epoch zero", () => {
  const first = reduceGame(createGame(0), { type: "play" }, 0);
  assert.equal(first.xp, 5);
  assert.equal(first.happiness, 82);
  assert.equal(first.plays, 1);
  assert.strictEqual(reduceGame(first, { type: "play" }, PLAY_COOLDOWN_MS - 1), first);
  const second = reduceGame(first, { type: "play" }, PLAY_COOLDOWN_MS);
  assert.equal(second.plays, 2);
  assert.equal(second.xp, 10);
  assert.equal(second.lastPlayAt, PLAY_COOLDOWN_MS);
  assert.strictEqual(reduceGame(second, { type: "play" }, 0), second);
});

test("offline time matures crops without auto-harvesting, and hunger stays within bounds", () => {
  const growing = reduceGame(reduceGame(createGame(START), buy(), START), plant(), START);
  const later = advanceGame(growing, START + 4 * 3_600_000);
  assert.equal(later.fullness, 56);
  assert.equal(later.happiness, 54);
  assert.equal(later.xp, 0);
  assert.equal(later.harvests, 0);
  assert.equal(later.revision, growing.revision);
  assert.notEqual(later.plots[0], null);
  const harvested = reduceGame(later, harvest(), later.lastUpdated);
  assert.equal(harvested.harvests, 1);
  const longAbsence = advanceGame(growing, START + 365 * 24 * 3_600_000);
  assert.equal(longAbsence.fullness, 0);
  assert.equal(longAbsence.happiness, 0);
  assert.equal(longAbsence.food, 1);
});

test("clock rollback does not restore care, make a crop ready, or bypass cooldown", () => {
  let state = reduceGame(createGame(START), buy(), START);
  state = reduceGame(state, plant(), START);
  state = reduceGame(state, { type: "play" }, START);
  const before = clone(state);
  assert.strictEqual(advanceGame(state, START - 10_000), state);
  assert.strictEqual(reduceGame(state, harvest(), START - 10_000), state);
  assert.strictEqual(reduceGame(state, { type: "play" }, START - 10_000), state);
  assert.deepEqual(normalizeGame(state, START - 10_000), before);
  assert.deepEqual(state, before);
});

test("normalization requires the full versioned schema and rejects broken crop timing", () => {
  const good = reduceGame(reduceGame(createGame(START), buy(), START), plant(), START);
  assert.ok(isGardenState(good));
  const restored = normalizeGame({ ...good, untrustedExtra: "discard" }, START);
  assert.deepEqual(restored, good);
  assert.notStrictEqual(restored.plots, good.plots);
  assert.notStrictEqual(restored.seeds, good.seeds);
  const missing = clone(good);
  delete missing.food;
  const missingSeeds = clone(good);
  delete missingSeeds.seeds;
  const badSeeds = clone(good);
  badSeeds.seeds.carrot = "1";
  const extraSeeds = clone(good);
  extraSeeds.seeds.tulip = 5;
  const early = clone(good);
  early.plots[0].readyAt = START - 1;
  const future = clone(good);
  future.plots[0].readyAt += 365 * 24 * 3_600_000;
  const futurePlant = clone(good);
  futurePlant.plots[0].plantedAt += 60_000;
  futurePlant.plots[0].readyAt += 60_000;
  for (const invalid of [
    null, [], {}, missing, missingSeeds, badSeeds, { ...good, version: 1 }, { ...good, coins: Infinity },
    { ...good, xp: -1 }, { ...good, food: "3" }, { ...good, fullness: NaN },
    { ...good, revision: Number.MAX_SAFE_INTEGER }, { ...good, plots: [null] }, { ...good, plots: Array(3) },
    { ...good, lastUpdated: -1 }, { ...good, lastPlayAt: START + 1 }, early, future, futurePlant,
  ]) {
    assert.equal(isGardenState(invalid), false);
    const reset = normalizeGame(invalid, START);
    assert.deepEqual(reset, createGame(START));
    assert.strictEqual(reduceGame(reset, harvest(), START), reset);
  }
  assert.equal(normalizeGame(extraSeeds, START).seeds.tulip, undefined, "unknown seed ids are stripped");
});

test("v1 saves are upgraded with zero seed stock and keep their progress", () => {
  const legacy = reduceGame(reduceGame(createGame(START), buy(), START), plant(), START);
  legacy.version = 1;
  delete legacy.seeds;
  assert.equal(isGardenState(legacy), false);
  const upgraded = upgradeGame(legacy, START);
  assert.ok(upgraded);
  assert.equal(upgraded.version, 2);
  assert.deepEqual(upgraded.seeds, { carrot: 0, glowberry: 0, moonbloom: 0 });
  assert.equal(upgraded.coins, legacy.coins);
  assert.equal(upgraded.food, legacy.food);
  assert.deepEqual(upgraded.plots, legacy.plots);
  assert.equal(upgradeGame({ ...legacy, food: -1 }, START), null);
});

test("care levels and milestones are local progress at the exact XP boundaries", () => {
  assert.deepEqual(getCareProgress({ xp: 49 }), { level: 1, xpIntoLevel: 49, xpForNextLevel: 50, milestoneTarget: 150, milestoneReady: false });
  assert.equal(getCareProgress({ xp: 50 }).level, 2);
  assert.equal(getCareProgress({ xp: 150 }).xpIntoLevel, 0);
  for (const [xp, target, ready] of [[0, 150, false], [149, 150, false], [150, 150, true], [399, 150, true], [400, 400, true], [899, 400, true], [900, 900, true]]) {
    const progress = getCareProgress({ xp });
    assert.equal(progress.milestoneTarget, target);
    assert.equal(progress.milestoneReady, ready);
  }
});

test("garden keys isolate guest, chain, contract, token, and current owner", () => {
  const pet = { chainId: 31337, contractAddress: `0x${"Ab".repeat(20)}`, tokenId: "1000001", owner: `0x${"Cd".repeat(20)}` };
  const base = makeGardenKey(pet);
  assert.equal(makeGardenKey(), "glowpet:garden:v1:guest");
  assert.notEqual(base, makeGardenKey());
  assert.equal(base, makeGardenKey({ ...pet, chainId: "031337", owner: pet.owner.toLowerCase() }));
  for (const change of [{ chainId: 1 }, { tokenId: 1000002n }, { owner: `0x${"ee".repeat(20)}` }, { contractAddress: `0x${"ff".repeat(20)}` }]) {
    assert.notEqual(base, makeGardenKey({ ...pet, ...change }));
  }
  assert.equal(makeGardenKey({ ...pet, owner: null }), makeGardenKey());
  assert.equal(makeGardenKey({ ...pet, tokenId: Number.MAX_SAFE_INTEGER + 1 }), makeGardenKey());
});

test("the persistence store writes only after an action, never for clock refreshes", async () => {
  const storage = storageFixture(withSeeds(createGame(START)));
  let now = START;
  const store = createGardenStore("garden", { getStorage: () => storage, getLocks: () => undefined, clock: () => now });
  for (let second = 1; second <= 30; second++) {
    now = START + second * 1000;
    advanceGame(store.getSnapshot().state, now);
  }
  assert.equal(storage.writes, 0);
  assert.deepEqual(await store.dispatch(plant()), { ok: true });
  assert.equal(storage.writes, 1);
  assert.equal(store.getSnapshot().storageStatus, "saved");
  assert.equal(store.getSnapshot().storageError, "");
  const result = await store.dispatch(harvest());
  assert.equal(result.ok, false);
  assert.match(result.reason, /still growing/);
  assert.equal(storage.writes, 1);
});

test("two tabs re-read the current snapshot under one Web Lock and harvest only once", async () => {
  const seeded = reduceGame(reduceGame(createGame(START), buy(), START), plant(), START);
  const storage = storageFixture(seeded);
  const locks = exclusiveLocks();
  const options = { getStorage: () => storage, getLocks: () => locks, clock: () => START + CROPS[0].growMs };
  const tabA = createGardenStore("garden", options);
  const tabB = createGardenStore("garden", options);
  const results = await Promise.all([tabA.dispatch(harvest()), tabB.dispatch(harvest())]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(locks.calls, 2);
  const saved = JSON.parse(storage.getItem("garden"));
  assert.equal(saved.harvests, 1);
  assert.equal(saved.xp, CROPS[0].xp);
  assert.equal(saved.food, 1 + CROPS[0].food);
  assert.equal(saved.revision, seeded.revision + 1);
  assert.equal(storage.writes, 1);
  tabA.syncFromStorage();
  tabB.syncFromStorage();
  assert.deepEqual(tabA.getSnapshot().state, tabB.getSnapshot().state);
});

test("same-tab pending actions are serialized and cannot spend one plot twice", async () => {
  const start = withSeeds(createGame(START), { [CROPS[1].id]: 2 });
  const storage = storageFixture(start);
  const store = createGardenStore("garden", { getStorage: () => storage, getLocks: () => undefined, clock: () => START });
  const results = await Promise.all([store.dispatch(plant(CROPS[1].id)), store.dispatch(plant(CROPS[1].id))]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(store.getSnapshot().state.coins, 20);
  assert.equal(store.getSnapshot().state.seeds[CROPS[1].id], 1);
  assert.equal(storage.writes, 1);
});

test("damaged saved data resets visibly and the next valid action saves the recovery", async () => {
  const storage = storageFixture();
  storage.values.set("garden", "{broken");
  const store = createGardenStore("garden", { getStorage: () => storage, getLocks: () => undefined, clock: () => START });
  assert.deepEqual(store.getSnapshot().state, createGame(START));
  assert.match(store.getSnapshot().storageError, /damaged/);
  await store.dispatch(buy());
  assert.equal(store.getSnapshot().storageError, "");
  assert.ok(isGardenState(JSON.parse(storage.getItem("garden"))));
});

test("blocked storage keeps actions playable in explicit memory mode", async () => {
  const store = createGardenStore("garden", {
    getStorage: () => { throw new Error("Access denied"); },
    getLocks: () => undefined,
    clock: () => START,
  });
  assert.equal(store.getSnapshot().storageStatus, "memory");
  assert.match(store.getSnapshot().storageError, /lost/);
  assert.equal((await store.dispatch({ type: "feed" })).ok, true);
  assert.equal((await store.dispatch({ type: "play" })).ok, true);
  assert.equal(store.getSnapshot().state.xp, 25);
  assert.equal(store.getSnapshot().state.revision, 2);
});

test("a failed save never replays a harvest or later overwrites another tab's saved progress", async () => {
  const seeded = reduceGame(reduceGame(createGame(START), buy(), START), plant(), START);
  const storage = storageFixture(seeded);
  const options = { getStorage: () => storage, getLocks: () => undefined, clock: () => START + CROPS[0].growMs };
  const store = createGardenStore("garden", options);
  storage.failWrite = true;
  assert.equal((await store.dispatch(harvest())).ok, true);
  assert.equal(store.getSnapshot().storageStatus, "memory");
  assert.equal((await store.dispatch(harvest())).ok, false);
  const memory = clone(store.getSnapshot().state);
  storage.failWrite = false;
  const otherTab = reduceGame(createGame(START), { type: "play" }, START);
  storage.setItem("garden", JSON.stringify(otherTab));
  store.syncFromStorage();
  assert.deepEqual(store.getSnapshot().state, memory);
  await store.dispatch({ type: "play" });
  assert.deepEqual(JSON.parse(storage.getItem("garden")), otherTab);
  assert.equal(store.getSnapshot().state.harvests, 1);
});

test("storage synchronization reads the latest value without writing and reports read failure", () => {
  const storage = storageFixture();
  const store = createGardenStore("garden", { getStorage: () => storage, getLocks: () => undefined, clock: () => START });
  let notifications = 0;
  const unsubscribe = store.subscribe(() => notifications++);
  const remote = reduceGame(createGame(START), { type: "play" }, START);
  storage.values.set("garden", JSON.stringify(remote));
  store.syncFromStorage();
  assert.deepEqual(store.getSnapshot().state, remote);
  assert.equal(storage.writes, 0);
  assert.equal(notifications, 1);
  storage.failRead = true;
  store.syncFromStorage();
  assert.equal(store.getSnapshot().storageStatus, "memory");
  assert.deepEqual(store.getSnapshot().state, remote);
  unsubscribe();
});

test("denied or broken Web Locks fall back without ever applying an action twice", async () => {
  for (const request of [
    async () => { throw new Error("Permission denied"); },
    async (_name, _options, callback) => { callback(); throw new Error("Lock failed after callback"); },
  ]) {
    const storage = storageFixture();
    const store = createGardenStore("garden", { getStorage: () => storage, getLocks: () => ({ request }), clock: () => START });
    assert.equal((await store.dispatch({ type: "play" })).ok, true);
    assert.equal(store.getSnapshot().state.xp, 5);
    assert.equal(storage.writes, 1);
  }
});
