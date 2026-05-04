/** @file Economy manager — resource affordability checks, deduction, and rate calculations. */

function safeNum(value) {
  return Number.isFinite(value) ? value : 0;
}

export function canAfford(resources, cost) {
  const bag = resources && typeof resources === "object" ? resources : {};
  const costMap = cost && typeof cost === "object" ? cost : {};
  return Object.keys(costMap).every((key) => safeNum(bag[key]) >= safeNum(costMap[key]));
}

export function deduct(resources, cost, contextLabel = "") {
  const bag = resources && typeof resources === "object" ? resources : null;
  if (!bag) {
    console.warn("[EconomyManager] Build blocked: resources bag missing.");
    return false;
  }
  if (!canAfford(bag, cost)) {
    const label = contextLabel ? ` (${contextLabel})` : "";
    console.warn(`[EconomyManager] Build blocked${label}: insufficient resources.`);
    return false;
  }
  const costMap = cost && typeof cost === "object" ? cost : {};
  Object.keys(costMap).forEach((key) => {
    bag[key] = Math.max(0, safeNum(bag[key]) - safeNum(costMap[key]));
  });
  return true;
}

export const EconomyManager = {
  canAfford,
  deduct
};
