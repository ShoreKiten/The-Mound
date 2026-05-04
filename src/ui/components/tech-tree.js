/** @file Tech tree utilities — tech point reads and research cost calculations. */

export function readTechPoints(state) {
  return Number((state && state.resources && state.resources.techPoints) || 0);
}

export function hasTechCost(state, cost) {
  return readTechPoints(state) >= Number(cost || 0);
}
