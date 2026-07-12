// Resource / good / recipe helpers over the injected economy definition.
//
// PURE: imports nothing. Everything is derived from `economy` (the deep-cloned
// data/economy.json) so there are NO hardcoded resource names or gameplay `case`
// branches here — adding a resource/good/recipe is a data edit, not a code edit.
//
// Special resources: Gold (currency) and People (population) are NOT in raw/goods
// — they are carried/held specially (island.gold / island.population, ship.cargo).
// `tradeables` = raw + goods = the things that have a stockpile and a price.

export const GOLD = 'Gold';
export const PEOPLE = 'People';

export function isRaw(economy, k) { return economy.raw.includes(k); }
export function isGood(economy, k) { return economy.goods.includes(k); }

/** The stockpile ceiling for a commodity (goods vs raw). */
export function capOf(economy, tuning, res) {
  return isGood(economy, res) ? tuning.GOODS_CAP : tuning.STOCKPILE_CAP;
}

/** All priced/stockpiled commodities (raw + goods), stable order. */
export function tradeables(economy) {
  return economy._tradeables || (economy._tradeables = [...economy.raw, ...economy.goods]);
}

/** The recipe producing `good`, or null. */
export function recipeFor(economy, good) {
  return economy.recipes.find((r) => r.out === good) || null;
}

/** A fresh stockpile map with every tradeable at 0. */
export function newStock(economy) {
  const s = {};
  for (const k of tradeables(economy)) s[k] = 0;
  return s;
}

/** The target stock level used for pricing this commodity at an island. */
export function targetFor(tuning, res) {
  const o = tuning.TARGET_OVERRIDES || {};
  return o[res] != null ? o[res] : tuning.TARGET_DEFAULT;
}

/** Base (reference) price of a commodity. */
export function basePrice(tuning, res) {
  return tuning.PRICE_BASE[res] != null ? tuning.PRICE_BASE[res] : tuning.TARGET_DEFAULT;
}

/**
 * The single conserved-move primitive: move up to `amount` from src[srcKey] to
 * dst[dstKey]. Never moves more than exists, so what leaves src exactly enters
 * dst — gold/goods/people are conserved by construction. Returns the amount moved.
 * `src`/`dst` are any objects holding a numeric field (island, island.stock,
 * ship.cargo, …), so one primitive serves every economic transfer.
 */
export function transfer(src, srcKey, dst, dstKey, amount) {
  const avail = src[srcKey] || 0;
  const move = amount < avail ? (amount > 0 ? amount : 0) : avail;
  if (move <= 0) return 0;
  src[srcKey] = avail - move;
  dst[dstKey] = (dst[dstKey] || 0) + move;
  return move;
}

/** Physical cargo occupied on a ship = every good + migrants, PLUS the weight of the coin
 *  aboard (gold is heavy): `goldPerUnit` coins take one cargo unit. Pass 0/undefined to treat
 *  coin as weightless (legacy). */
export function cargoUnits(ship, goldPerUnit = 0) {
  let n = 0;
  for (const k in ship.cargo) { if (k !== GOLD) n += ship.cargo[k] || 0; }
  if (goldPerUnit > 0) n += (ship.cargo[GOLD] || 0) / goldPerUnit;
  return n;
}

export function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

/** Divide guarding /0 and NaN. */
export function safeDiv(a, b, fallback = 0) {
  if (!b || !Number.isFinite(b)) return fallback;
  const r = a / b;
  return Number.isFinite(r) ? r : fallback;
}
