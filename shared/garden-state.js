export const PLOT_COUNT = 3;
export const FEED_FULLNESS_LIMIT = 90;
export const PLAY_COOLDOWN_MS = 30_000;
export const CROPS = Object.freeze([
  Object.freeze({ id: "carrot", name: "Sun carrot", icon: "🥕", cost: 0, growMs: 30_000, coins: 5, food: 1, xp: 10 }),
  Object.freeze({ id: "glowberry", name: "Glowberry", icon: "🫐", cost: 8, growMs: 60_000, coins: 14, food: 2, xp: 20 }),
  Object.freeze({ id: "moonbloom", name: "Moon bloom", icon: "🌸", cost: 15, growMs: 120_000, coins: 25, food: 3, xp: 35 }),
]);

export const SEED_CAP = 99;

const SEED_IDS = Object.freeze(CROPS.map((crop) => crop.id));
const MAX_COUNTER = 1_000_000_000;
const HOUR = 3_600_000;
const REQUIRED_FIELDS = [
  "version", "coins", "food", "xp", "fullness", "happiness", "plots", "seeds",
  "lastUpdated", "lastPlayAt", "harvests", "feeds", "plays", "revision",
];
const COUNTERS = ["coins", "food", "xp", "harvests", "feeds", "plays", "revision"];
const cropFor = (id) => CROPS.find((crop) => crop.id === id);
const validTime = (value) => Number.isSafeInteger(value) && value >= 0;
const timeOr = (value, fallback = 0) => validTime(value) ? value : fallback;
const cap = (value) => Math.min(MAX_COUNTER, value);
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function emptySeeds() {
  return Object.fromEntries(SEED_IDS.map((id) => [id, 0]));
}

export function createGame(now) {
  return {
    version: 2,
    coins: 20,
    food: 1,
    xp: 0,
    fullness: 80,
    happiness: 70,
    plots: Array(PLOT_COUNT).fill(null),
    seeds: emptySeeds(),
    lastUpdated: timeOr(now),
    lastPlayAt: 0,
    harvests: 0,
    feeds: 0,
    plays: 0,
    revision: 0,
  };
}

/** Validate a complete persisted snapshot, including the crop timing invariant. */
export function isGardenState(value) {
  if (!record(value) || value.version !== 2 || REQUIRED_FIELDS.some((field) => !Object.hasOwn(value, field))) return false;
  if (COUNTERS.some((field) => !Number.isSafeInteger(value[field]) || value[field] < 0 || value[field] > MAX_COUNTER)) return false;
  if (["fullness", "happiness"].some((field) => !Number.isFinite(value[field]) || value[field] < 0 || value[field] > 100)) return false;
  if (!validTime(value.lastUpdated) || !validTime(value.lastPlayAt) || value.lastPlayAt > value.lastUpdated) return false;
  if (value.plays === 0 && value.lastPlayAt !== 0) return false;
  if (!record(value.seeds)) return false;
  if (SEED_IDS.some((id) => !Number.isSafeInteger(value.seeds[id]) || value.seeds[id] < 0 || value.seeds[id] > SEED_CAP)) return false;
  if (!Array.isArray(value.plots) || value.plots.length !== PLOT_COUNT) return false;
  return Array.from(value.plots).every((plot) => {
    if (plot === null) return true;
    if (!record(plot)) return false;
    const crop = cropFor(plot.cropId);
    return Boolean(crop && validTime(plot.plantedAt) && validTime(plot.readyAt)
      && plot.plantedAt <= value.lastUpdated && plot.readyAt === plot.plantedAt + crop.growMs);
  });
}

/** Upgrade a v1 save (coins paid at planting) without losing its progress. */
export function upgradeGame(raw, now) {
  if (isGardenState(raw)) return normalizeGame(raw, now);
  if (!record(raw) || raw.version !== 1) return null;
  const migrated = { ...raw, version: 2, seeds: emptySeeds() };
  return isGardenState(migrated) ? normalizeGame(migrated, now) : null;
}

export function normalizeGame(raw, now) {
  if (!isGardenState(raw)) return createGame(now);
  const clean = Object.fromEntries(REQUIRED_FIELDS.map((field) => [field, raw[field]]));
  clean.plots = raw.plots.map((plot) => plot === null ? null : {
    cropId: plot.cropId, plantedAt: plot.plantedAt, readyAt: plot.readyAt,
  });
  clean.seeds = Object.fromEntries(SEED_IDS.map((id) => [id, raw.seeds[id]]));
  return advanceGame(clean, now);
}

/** Passive time changes never grant rewards or increment a saved revision. */
export function advanceGame(state, now) {
  if (!isGardenState(state)) return createGame(now);
  const moment = timeOr(now, state.lastUpdated);
  if (moment <= state.lastUpdated) return state;
  const hours = (moment - state.lastUpdated) / HOUR;
  return {
    ...state,
    fullness: Math.max(0, state.fullness - hours * 6),
    happiness: Math.max(0, state.happiness - hours * 4),
    lastUpdated: moment,
  };
}

export function getGardenActionError(state, action, now) {
  if (!isGardenState(state) || !record(action)) return "This garden action is not available.";
  const current = advanceGame(state, now);
  if (action.type === "buy") {
    const crop = cropFor(action.cropId);
    if (!crop) return "Choose a seed packet first.";
    if (current.coins < crop.cost) {
      return `You need ${crop.cost - current.coins} more coins for a ${crop.name} packet.`;
    }
    if (current.seeds[crop.id] >= SEED_CAP) return "The seed cupboard is full for this packet.";
    return null;
  }
  if (action.type === "plant" || action.type === "harvest") {
    if (!Number.isInteger(action.plotIndex) || action.plotIndex < 0 || action.plotIndex >= PLOT_COUNT) {
      return "Choose a valid garden plot.";
    }
    const plot = current.plots[action.plotIndex];
    if (action.type === "plant") {
      const crop = cropFor(action.cropId);
      if (!crop) return "Choose a crop first.";
      if (plot) return "Harvest this plot before planting again.";
      if (current.seeds[crop.id] < 1) return `No ${crop.name} seeds in the cupboard. Buy a packet first.`;
      if (!Number.isSafeInteger(Math.max(timeOr(now), current.lastUpdated) + crop.growMs)) return "The device clock is outside the supported range.";
    } else {
      if (!plot) return "This plot is empty.";
      if (timeOr(now, current.lastUpdated) < plot.readyAt) return "Your crop is still growing.";
    }
    return null;
  }
  if (action.type === "feed") {
    if (current.fullness >= FEED_FULLNESS_LIMIT) return "Your pet is still full. Save the food for later.";
    if (current.food < 1) return "Harvest a crop to collect food first.";
    return null;
  }
  if (action.type === "play") {
    const remaining = PLAY_COOLDOWN_MS - (timeOr(now, current.lastUpdated) - current.lastPlayAt);
    if (current.plays > 0 && remaining > 0) return `Your pet is resting. Play again in ${Math.ceil(remaining / 1000)} seconds.`;
    return null;
  }
  return "This garden action is not available.";
}

/** Invalid or repeated actions return the original object, without mutations. */
export function reduceGame(state, action, now) {
  if (getGardenActionError(state, action, now)) return state;
  const current = advanceGame(state, now);
  const moment = Math.max(timeOr(now, current.lastUpdated), current.lastUpdated);
  const next = {
    ...current,
    revision: cap(current.revision + 1),
    lastUpdated: moment,
    seeds: { ...current.seeds },
  };
  if (action.type === "buy") {
    const crop = cropFor(action.cropId);
    next.coins -= crop.cost;
    next.seeds[crop.id] += 1;
  } else if (action.type === "plant") {
    const crop = cropFor(action.cropId);
    next.seeds[crop.id] -= 1;
    next.plots = current.plots.slice();
    next.plots[action.plotIndex] = { cropId: crop.id, plantedAt: moment, readyAt: moment + crop.growMs };
  } else if (action.type === "harvest") {
    const crop = cropFor(current.plots[action.plotIndex].cropId);
    next.plots = current.plots.slice();
    next.plots[action.plotIndex] = null;
    next.coins = cap(current.coins + crop.coins);
    next.food = cap(current.food + crop.food);
    next.xp = cap(current.xp + crop.xp);
    next.harvests = cap(current.harvests + 1);
  } else if (action.type === "feed") {
    next.food -= 1;
    next.xp = cap(current.xp + 20);
    next.fullness = Math.min(100, current.fullness + 25);
    next.happiness = Math.min(100, current.happiness + 5);
    next.feeds = cap(current.feeds + 1);
  } else {
    next.xp = cap(current.xp + 5);
    next.happiness = Math.min(100, current.happiness + 12);
    next.lastPlayAt = moment;
    next.plays = cap(current.plays + 1);
  }
  return next;
}

export function getCareProgress(state) {
  const xp = Number.isSafeInteger(state?.xp) && state.xp >= 0 ? Math.min(MAX_COUNTER, state.xp) : 0;
  const milestoneTarget = xp >= 900 ? 900 : xp >= 400 ? 400 : 150;
  return {
    level: Math.floor(xp / 50) + 1,
    xpIntoLevel: xp % 50,
    xpForNextLevel: 50,
    milestoneTarget,
    milestoneReady: xp >= milestoneTarget,
  };
}

export function makeGardenKey({ chainId, contractAddress, tokenId, owner } = {}) {
  const numberId = (value) => {
    if (typeof value === "number" && !Number.isSafeInteger(value)) return null;
    const text = String(value ?? "");
    if (!/^[0-9]+$/.test(text)) return null;
    const number = BigInt(text);
    return number > 0n ? number.toString() : null;
  };
  const address = (value) => typeof value === "string" && /^0x[0-9a-f]{40}$/i.test(value)
    ? value.toLowerCase() : null;
  const chain = numberId(chainId);
  const token = numberId(tokenId);
  const contract = address(contractAddress);
  const holder = address(owner);
  if (!chain || !token || !contract || !holder) return "glowpet:garden:v1:guest";
  return `glowpet:garden:v1:${chain}:${contract}:${token}:${holder}`;
}
