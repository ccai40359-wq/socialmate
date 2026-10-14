// Verified-account growth-target recognition (涨粉 lane).
// Pure functions so the acceptance cases are directly assertable.
// Qualifier: BlueV AND followers <= maxFollowers. Anything missing -> false
// (never follow a target we cannot positively confirm - a missed follow is
// cheaper than a wrong one).
import { parseCountAny } from '../parse-count.mjs';

// '45.6K Followers' -> 45600, '1,234' -> 1234, '3.2万' -> 32000, missing -> 0.
export function parseFollowerCount(text) {
  if (!text || typeof text !== 'string') return 0;
  const first = String(text).trim().split(/\s+/)[0];
  return parseCountAny(first) || parseCountAny(String(text).trim());
}

// The growth-target predicate. Degrades to false on any missing field.
export function qualifiesAsGrowthTarget({ verified, followers, maxFollowers = 10000 } = {}) {
  if (verified !== true) return false;
  const n = Number(followers);
  if (!Number.isFinite(n) || n < 0) return false;
  const max = Number(maxFollowers);
  if (!Number.isFinite(max) || max < 0) return false;
  return n <= max;
}