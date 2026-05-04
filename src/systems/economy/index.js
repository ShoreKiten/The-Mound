/** @file Economy system entry — resource production/consumption tick applied per game cycle. */

import { gameState as rootGameState } from "../../core/state.js";
import { getEngineApi } from "../../core/runtime-hooks.js";
import { syncColonyCapacityInDraft } from "../colony-cap.js";
import { EconomyManager, canAfford, deduct } from "./manager.js";

(() => {
  const RESOURCE_KEYS = ["power", "oxygen", "scrapMetal", "stardust", "alloy", "sealant", "helium3", "techPoints"];

  function safeNum(value) {
    return Number.isFinite(value) ? value : 0;
  }

  function createRateBucket() {
    return {
      netRates: {
        power: 0,
        oxygen: 0,
        scrapMetal: 0,
        stardust: 0,
        alloy: 0,
        sealant: 0,
        helium3: 0,
        techPoints: 0
      },
      valueSources: {
        power: {},
        oxygen: {},
        scrapMetal: {},
        stardust: {},
        alloy: {},
        sealant: {},
        helium3: {},
        techPoints: {}
      },
      meta: {
        powerPriorityScale: {
          oxygen: 1,
          production: 1,
          collection: 1
        }
      }
    };
  }

  function addSource(bucket, resource, name, value) {
    const n = safeNum(value);
    if (!bucket || !bucket.netRates || !bucket.valueSources) {
      return;
    }
    if (!bucket.valueSources[resource]) {
      bucket.valueSources[resource] = {};
    }
    bucket.valueSources[resource][name] = (bucket.valueSources[resource][name] || 0) + n;
    bucket.netRates[resource] = (bucket.netRates[resource] || 0) + n;
  }

  function calculateTotalProduction(powerParts) {
    const parts = powerParts || {};
    return safeNum(parts.crew) + safeNum(parts.fusion);
  }

  function calculateTotalConsumption(powerParts) {
    const parts = powerParts || {};
    return (
      safeNum(parts.oxygen) +
      safeNum(parts.industrial) +
      safeNum(parts.collection) +
      safeNum(parts.expedition)
    );
  }

  function scaleSource(bucket, resource, name, factor) {
    if (!bucket || !bucket.valueSources || !bucket.netRates) {
      return;
    }
    const table = bucket.valueSources[resource] || {};
    const current = safeNum(table[name]);
    const scaled = current * factor;
    table[name] = scaled;
    bucket.valueSources[resource] = table;
    bucket.netRates[resource] = safeNum(bucket.netRates[resource]) - (current - scaled);
  }

  function calculateAllRates(gameState, options) {
    const state = gameState || rootGameState || {};
    const now = options && options.now ? options.now : Date.now();
    const out = createRateBucket();
    const resources = state.resources || {};
    const systems = state.systems || {};
    const expedition = systems.expedition || {};
    const upgrades = state.upgrades || {};
    const tech = systems.tech || {};

    const population = safeNum(state.population);
    const structures = state.structures || {};
    const arrays = safeNum(state.arrays || structures.magneticArray || resources.magneticArray);
    const ionCatchers = safeNum(state.ionCatchers);
    const autoSmelters = safeNum(state.autoSmelters);
    const autoSynthesizers = safeNum(state.autoSynthesizers);
    const miningDrones = safeNum(state.miningDrones);
    const fusionGenerators = safeNum(state.fusionGenerators || structures.fusionGenerator);

    const dustRefining = safeNum(upgrades.dustRefining) > 0 ? safeNum(upgrades.dustRefining) : 1;
    const cycleFactor = Math.max(0.2, 1 - safeNum(tech.cycleLevel) * 0.15);
    const miningFactor = 1 + safeNum(tech.miningLevel) * 0.2;
    const productionBonus = (1 + safeNum(systems.productionSpeedBonusPct)) * (safeNum(state.globalProdMod) > 0 ? safeNum(state.globalProdMod) : 1);
    const workforceBonus = population > 5 ? 1 + (population - 5) * 0.2 : 1;
    const highCrewLoad = population > 5 ? 2 : 1;

    const automationFault = (systems.automationFaultUntil || 0) > now;
    const fusionDebuffed = (systems.fusionDebuffUntil || 0) > now;
    const expeditionActive = !!expedition.active;
    const maxThrust = Math.max(1, safeNum(state.maxThrustLimit || state.maxThrustMultiplier || 10));
    const expeditionThrottle = Math.max(0, Math.min(maxThrust, safeNum(expedition.throttle)));
    const stormFactor = (expedition.magneticStormUntil || 0) > now ? 2 : 1;
    const expeditionEff = safeNum(upgrades.powerEfficiency) > 0 ? safeNum(upgrades.powerEfficiency) : 1;
    const powerUsageMod = safeNum(state.powerUsageMod) > 0 ? safeNum(state.powerUsageMod) : 1;
    const he3UsageMod = safeNum(state.he3UsageMod) > 0 ? safeNum(state.he3UsageMod) : 1;

    const arrayScrapRate = arrays * 0.36 * productionBonus;
    const stardustIonRate = ionCatchers * 1.125 * dustRefining * productionBonus;
    const droneBaseHe3 =
      state.massDriverBuilt && safeNum(resources.power) > 0
        ? miningDrones * 0.25 * miningFactor * productionBonus
        : 0;
    addSource(out, "scrapMetal", "磁力阵列", arrayScrapRate);
    addSource(out, "stardust", "离子捕获器", stardustIonRate);
    addSource(out, "helium3", "轨道采矿机", droneBaseHe3);

    const crewPowerGain = 0;
    const fusionFuelNeed = fusionGenerators > 0 ? fusionGenerators * 0.3 : 0;
    const canBurnFusionFuel = resources.helium3 > 0 && fusionFuelNeed > 0;
    const fusionRate = canBurnFusionFuel ? fusionGenerators * 50 * (fusionDebuffed ? 0.2 : 1) * productionBonus : 0;
    addSource(out, "power", "载员发电", crewPowerGain);
    addSource(out, "power", "氦-3聚变发电机", fusionRate);
    addSource(out, "helium3", "聚变燃料消耗", canBurnFusionFuel ? -(fusionFuelNeed * he3UsageMod) : 0);

    const deepDrain = safeNum(resources.power) <= 0;
    const oxygenOnline = state.isVaultRepaired && !deepDrain;
    const oxygenPowerNeed = oxygenOnline ? 0.5 : 0;
    const smelterPowerNeed = autoSmelters > 0 ? autoSmelters * 15 * highCrewLoad * cycleFactor : 0;
    const synthPowerNeed = autoSynthesizers > 0 ? (((population >= 5 ? 2 : 8) * autoSynthesizers) / 5) * highCrewLoad * cycleFactor : 0;
    const maintenancePowerNeed = state.maintenanceCenterBuilt ? 5 * highCrewLoad * cycleFactor : 0;
    const collectionPowerNeed = state.massDriverBuilt && !deepDrain ? miningDrones * 0.4 : 0;
    const propulsionBaseCost = 50;
    const propulsionTechMultiplier = Math.max(0.1, stormFactor * expeditionEff * powerUsageMod);
    const expeditionPowerNeed =
      expeditionActive && expeditionThrottle > 0
        ? propulsionBaseCost * (expeditionThrottle ** 1.5) * propulsionTechMultiplier
        : 0;
    const productionNeed = smelterPowerNeed + synthPowerNeed + maintenancePowerNeed;

    const oxygenScale = oxygenOnline ? 1 : 0;
    const productionScale = deepDrain ? 0 : 1;
    const collectionScale = deepDrain ? 0 : 1;
    const expeditionScale = 1;
    const powerParts = {
      crew: crewPowerGain,
      fusion: fusionRate,
      oxygen: oxygenPowerNeed * oxygenScale,
      industrial: productionNeed * productionScale,
      collection: collectionPowerNeed * collectionScale,
      expedition: expeditionPowerNeed * expeditionScale
    };
    const rawNetPower = calculateTotalProduction(powerParts) - calculateTotalConsumption(powerParts);

    out.meta.powerPriorityScale.oxygen = oxygenScale;
    out.meta.powerPriorityScale.production = productionScale;
    out.meta.powerPriorityScale.collection = collectionScale;

    if (collectionScale < 1) {
      scaleSource(out, "scrapMetal", "磁力阵列", collectionScale);
      scaleSource(out, "stardust", "离子捕获器", collectionScale);
      scaleSource(out, "helium3", "轨道采矿机", collectionScale);
    }

    addSource(out, "power", "制氧系统负荷", -oxygenPowerNeed * oxygenScale);
    addSource(out, "power", "工业系统负荷", -productionNeed * productionScale);
    addSource(out, "power", "采集系统负荷", -collectionPowerNeed * collectionScale);
    addSource(out, "power", "远征推进负荷", -expeditionPowerNeed * expeditionScale);
    out.netRates.power = rawNetPower;

    const smelterRate = automationFault ? 0 : autoSmelters * 0.1 * productionScale;
    const synthRate = automationFault ? 0 : autoSynthesizers * 0.2 * productionScale;
    const stardustForSmelter = autoSmelters * 1 * productionScale;
    const scrapForSmelter = autoSmelters * 1.2 * productionScale;
    const stardustForSynth = autoSynthesizers * 1.0 * productionScale;

    const hasStardustInput = resources.stardust > 0 || out.netRates.stardust > 0;
    const hasScrapInput = resources.scrapMetal > 0 || out.netRates.scrapMetal > 0;
    const smelterInputScale = hasStardustInput && hasScrapInput ? 1 : 0;
    const synthInputScale = hasStardustInput ? 1 : 0;

    addSource(out, "stardust", "合金模组消耗", -stardustForSmelter * smelterInputScale);
    addSource(out, "scrapMetal", "合金模组消耗", -scrapForSmelter * smelterInputScale);
    addSource(out, "alloy", "合金模组产出", smelterRate * workforceBonus * productionBonus * smelterInputScale);

    addSource(out, "stardust", "自动合成仪消耗", -stardustForSynth * synthInputScale);
    addSource(out, "sealant", "自动合成仪产出", synthRate * workforceBonus * productionBonus * synthInputScale);

    const oxygenGain = oxygenOnline ? 0.20 * productionBonus : 0;
    const oxygenUse = state.isVaultRepaired ? population * 0.02 : 0;
    const oxygenLeak = state.isVaultRepaired && safeNum(resources.power) <= 0 ? 1.0 : 0;
    addSource(out, "oxygen", "内部循环系统", oxygenGain);
    addSource(out, "oxygen", `载员生命维持 (${Math.floor(population)}人)`, -oxygenUse);
    addSource(out, "oxygen", "低电泄漏", -oxygenLeak);

    const expeditionHe3Use = expeditionActive && expeditionThrottle > 5 ? expeditionThrottle * 0.1 * expeditionScale * he3UsageMod : 0;
    addSource(out, "helium3", "远征推进消耗", -expeditionHe3Use);

    const blueprintUnlocked = !!(
      (state.flags && state.flags.isResearchStationBlueprintUnlocked) ||
      (state.blueprints && state.blueprints.researchWorkstation)
    );
    const techSystem = window.MoundSystems && window.MoundSystems.tech;
    const calcTechRate = techSystem && typeof techSystem.calculateTechOutput === "function"
      ? Number(techSystem.calculateTechOutput(state) || 0)
      : 0;
    const techRate = blueprintUnlocked && !deepDrain ? Math.max(0, calcTechRate) : 0;
    addSource(out, "techPoints", "科研产出", techRate);

    return out;
  }

  function applyTechOutputStep(gameState, setState, dtSec) {
    const state = gameState || rootGameState || {};
    if (typeof setState !== "function") {
      return 0;
    }
    const step = Math.max(0, Number(dtSec || 0));
    if (step <= 0) {
      return 0;
    }
    const techSystem = window.MoundSystems && window.MoundSystems.tech;
    const calc = techSystem && typeof techSystem.calculateTechOutput === "function"
      ? techSystem.calculateTechOutput
      : null;
    if (!calc) {
      return 0;
    }
    const blueprintUnlocked = !!(
      (state.flags && state.flags.isResearchStationBlueprintUnlocked) ||
      (state.blueprints && state.blueprints.researchWorkstation)
    );
    if (!blueprintUnlocked) {
      setState((draft) => {
        syncColonyCapacityInDraft(draft);
        draft.resources = draft.resources || {};
        draft.resources.techPoints = 0;
      });
      return 0;
    }
    const ratePerSec = Math.max(0, Number(calc(state) || 0));
    if (ratePerSec <= 0) {
      return 0;
    }
    setState((draft) => {
      syncColonyCapacityInDraft(draft);
      draft.resources = draft.resources || {};
      const currentTech = Number(draft.resources.techPoints || 0);
      const nextTech = Math.max(0, currentTech + (ratePerSec * step));
      draft.resources.techPoints = nextTech;
      draft.systems = draft.systems || {};
      draft.systems.rates = draft.systems.rates || {};
      draft.systems.rates.techPoints = ratePerSec;
    });
    return ratePerSec;
  }

  window.MoundSystemsIndustry = window.MoundSystemsIndustry || {
    getDroneDestructionChance(baseChance, maintenanceActive) {
      if (maintenanceActive) {
        return baseChance * 0.2;
      }
      return baseChance;
    },
    calculateAllRates,
    applyTechOutputStep
  };

  function makeDeferred(method) {
    const deferred = function (...args) {
      const engine = getEngineApi();
      const target = engine && engine[method];
      if (typeof target === "function" && target !== deferred) {
        return target.apply(engine, args);
      }
      return false;
    };
    return deferred;
  }

  window.MoundActions = window.MoundActions || {};
  const actionNames = [
    "gainStardust",
    "gainScrapMetal",
    "forgeSealant",
    "activateReactorCore",
    "repairVault",
    "manualOxygen",
    "manualCharge",
    "manualCrank",
    "deployMagneticArray",
    "meltIceOre",
    "buildIonCatcher",
    "buildRefiningFurnace",
    "refineAlloy",
    "buildAutoSmelter",
    "buildAutoSynthesizer",
    "upgradeCoreEfficiency",
    "upgradeShieldTech",
    "upgradeCycleTech",
    "upgradeMiningTech",
    "activateStardustBeacon",
    "buildMassDriver",
    "buildMaintenanceCenter",
    "launchMiningDrone",
    "buildFusionGenerator",
    "scanNearbySector",
    "lockExpeditionTarget",
    "toggleExpeditionOverdrive",
    "setExpeditionThrottle",
    "setAutomationLoggingEnabled",
    "startEngine"
  ];

  actionNames.forEach((name) => {
    if (!window.MoundActions[name]) {
      window.MoundActions[name] = makeDeferred(name);
    }
  });
})();

export function calculateAllRates(gameState, options) {
  if (
    window.MoundSystemsIndustry &&
    typeof window.MoundSystemsIndustry.calculateAllRates === "function"
  ) {
    return window.MoundSystemsIndustry.calculateAllRates(gameState, options);
  }
  return null;
}

export function applyResourceTickStep(gameState, setState, dtSec) {
  const state = gameState || rootGameState || {};
  if (typeof setState !== "function") {
    return;
  }
  const step = Math.max(0, Number(dtSec || 0));
  if (step <= 0) {
    return;
  }
  const rates = state.netRates || {};
  const powerParts = state.systems && state.systems.rates && state.systems.rates.powerParts
    ? state.systems.rates.powerParts
    : null;
  setState((draft) => {
    draft.resources = draft.resources || {};
    const keys = ["power", "oxygen", "helium3", "scrapMetal", "stardust", "alloy", "sealant", "techPoints"];
    keys.forEach((key) => {
      if (key === "power") {
        const currentPower = Number(draft.resources.power || 0);
        const powerCap = Math.max(5000000, Number(draft.resources.powerCapacity || 5000000));
        draft.resources.powerCapacity = powerCap;
        const prod = Number(powerParts && powerParts.totalProduction);
        const cons = Number(powerParts && powerParts.totalConsumption);
        if (Number.isFinite(prod) && Number.isFinite(cons)) {
          const afterConsumption = currentPower - (cons * step);
          const afterProduction = afterConsumption + (prod * step);
          draft.resources.power = Math.max(0, Math.min(powerCap, afterProduction));
          if (!applyResourceTickStep._lastPowerDebug || Date.now() - applyResourceTickStep._lastPowerDebug > 5000) {
            applyResourceTickStep._lastPowerDebug = Date.now();
            console.log(`[POWER_DEBUG] Current: ${draft.resources.power.toFixed(0)}, Max: ${powerCap}, Prod: ${prod.toFixed(2)}, Cons: ${cons.toFixed(2)}`);
          }
          return;
        }
      }
      const rate = Number(rates[key] || 0);
      if (!Number.isFinite(rate) || rate === 0) {
        return;
      }
      const current = Number(draft.resources[key] || 0);
      const next = Math.max(0, current + (rate * step));
      draft.resources[key] = next;
      if (key === "oxygen") {
        const cap = Number(draft.oxygenMax || 100);
        draft.resources.oxygen = Math.max(0, Math.min(cap, next));
        draft.oxygen = draft.resources.oxygen;
      } else if (key === "helium3") {
        draft.helium3 = next;
      }
    });
    if (typeof draft.oxygen === "number") {
      const cap = Number(draft.oxygenMax || 100);
      draft.oxygen = Math.max(0, Math.min(cap, draft.oxygen));
      draft.resources.oxygen = draft.oxygen;
    }
  });
}

export function applyTechOutputStep(gameState, setState, dtSec) {
  if (
    window.MoundSystemsIndustry &&
    typeof window.MoundSystemsIndustry.applyTechOutputStep === "function"
  ) {
    return window.MoundSystemsIndustry.applyTechOutputStep(gameState, setState, dtSec);
  }
  return 0;
}

export { EconomyManager, canAfford, deduct };
