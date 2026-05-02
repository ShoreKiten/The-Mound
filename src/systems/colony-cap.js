/**
 * Crew / population capacity derived from colony progression (not a fixed 5/8).
 * - Before vault repair: 1 nominal berth (surface / emergency).
 * - After vault: 5 pressurized berths.
 * - After 10k km milestone (cryo pod): 8.
 */
export function computePopulationCap(state) {
  if (!state || typeof state !== "object") {
    return 1;
  }
  const exp = state.systems && state.systems.expedition ? state.systems.expedition : {};
  if (exp.milestone10000Reached) {
    return 8;
  }
  if (state.isVaultRepaired) {
    return 5;
  }
  return 1;
}

/**
 * Mutates draft: populationCap, maxPopulation, clamps population, syncs crew.
 */
export function syncColonyCapacityInDraft(draft) {
  if (!draft || typeof draft !== "object") {
    return;
  }
  const cap = computePopulationCap(draft);
  draft.populationCap = cap;
  const prevMax = Number(draft.maxPopulation);
  draft.maxPopulation = Math.max(Number.isFinite(prevMax) ? prevMax : cap, cap);
  const pop = Math.max(0, Number(draft.population || 0));
  if (pop > cap) {
    draft.population = cap;
  }
  draft.crew = draft.population || 0;
  draft.resources = draft.resources || {};
  draft.resources.crew = draft.crew;
  draft.resources.crewCapacity = cap;
}
