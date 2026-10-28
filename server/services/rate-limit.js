import { AppError } from "../lib/errors.js";

/**
 * Single-instance account limiter. The IP layer is handled by Fastify's rate
 * limit plugin; a production multi-instance deployment should move this bucket
 * to the shared database or a gateway.
 */
export function createAccountRateLimiter({
  perMinute = 10, perHour = 60, clock = Date.now, maxKeys = 20_000,
} = {}) {
  const buckets = new Map();

  function prune(now) {
    if (buckets.size < maxKeys) return;
    for (const [key, bucket] of buckets) {
      if (bucket.minuteStart + 60_000 < now && bucket.hourStart + 3_600_000 < now) {
        buckets.delete(key);
      }
    }
  }

  return {
    consume(key) {
      const now = clock();
      prune(now);
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { minuteStart: now, minuteCount: 0, hourStart: now, hourCount: 0 };
        buckets.set(key, bucket);
      }
      if (now - bucket.minuteStart >= 60_000) {
        bucket.minuteStart = now;
        bucket.minuteCount = 0;
      }
      if (now - bucket.hourStart >= 3_600_000) {
        bucket.hourStart = now;
        bucket.hourCount = 0;
      }
      if (bucket.minuteCount >= perMinute || bucket.hourCount >= perHour) {
        throw new AppError(
          "RATE_LIMITED",
          "Too many claim attempts. Wait a little before trying again.",
          429,
        );
      }
      bucket.minuteCount += 1;
      bucket.hourCount += 1;
    },
    reset() {
      buckets.clear();
    },
  };
}
