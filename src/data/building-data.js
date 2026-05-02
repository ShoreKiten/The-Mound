export const BUILDING_COSTS = Object.freeze({
  magneticArray: Object.freeze({ scrapMetal: 10, sealant: 5 }),
  ionCatcher: Object.freeze({ scrapMetal: 40, sealant: 5 }),
  refiningFurnace: Object.freeze({ scrapMetal: 50, sealant: 20 }),
  autoSmelter: Object.freeze({ alloy: 5, scrapMetal: 100, power: 50 }),
  autoSynthesizer: Object.freeze({ alloy: 5, scrapMetal: 120, power: 60 }),
  massDriver: Object.freeze({ alloy: 300, sealant: 200 }),
  miningDrone: Object.freeze({ alloy: 50 }),
  fusionGenerator: Object.freeze({ alloy: 100, sealant: 50 }),
  maintenanceCenter: Object.freeze({ alloy: 300, sealant: 100, power: 500 })
});

export function getBuildingCost(key) {
  const table = BUILDING_COSTS;
  const raw = table && Object.prototype.hasOwnProperty.call(table, key) ? table[key] : null;
  if (!raw) {
    return {};
  }
  return Object.assign({}, raw);
}
