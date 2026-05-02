import { gameState as rootGameState, moundState } from "../../core/state.js";
import { getWorkerMode, getWorkerBridge, getEngineApi } from "../../core/runtime-hooks.js";

(() => {
  const resolveMaxTechLevel = () => {
    const byConst = Number(window.MoundConstants && window.MoundConstants.MAX_TECH_LEVEL);
    const byWindow = Number(window.MAX_TECH_LEVEL);
    const value = Number.isFinite(byConst) && byConst > 0 ? byConst : byWindow;
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 10;
  };

  const resolveConversionRate = () => {
    const byConst = Number(window.MoundConstants && window.MoundConstants.CONVERSION_RATE);
    const byWindow = Number(window.CONVERSION_RATE);
    const value = Number.isFinite(byConst) && byConst > 0 ? byConst : byWindow;
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 100;
  };

  function getTechLevels(state) {
    const s = state || rootGameState || {};
    const t = s && s.systems && s.systems.tech ? s.systems.tech : {};
    return {
      shield: Number(t.shieldLevel || 0),
      cycle: Number(t.cycleLevel || 0),
      mining: Number(t.miningLevel || 0)
    };
  }

  function isAtMaxLevel(upgradeId, gameState) {
    const levels = getTechLevels(gameState);
    const current = Number(levels[upgradeId] || 0);
    return current >= resolveMaxTechLevel();
  }

  function getShieldReduction(state) {
    if (!state || !state.techEraEnabled) {
      return 0;
    }
    const level = state && state.systems && state.systems.tech ? state.systems.tech.shieldLevel || 0 : 0;
    return Math.max(0, Math.min(0.8, level * 0.1));
  }

  function getCyclePowerFactor(state) {
    if (!state || !state.techEraEnabled) {
      return 1;
    }
    const level = state && state.systems && state.systems.tech ? state.systems.tech.cycleLevel || 0 : 0;
    return Math.max(0.2, 1 - level * 0.15);
  }

  function getMiningOutputFactor(state) {
    if (!state || !state.techEraEnabled) {
      return 1;
    }
    const level = state && state.systems && state.systems.tech ? state.systems.tech.miningLevel || 0 : 0;
    return 1 + level * 0.2;
  }

  function nextTechCost(level) {
    return 50 * (Math.max(0, level || 0) + 1);
  }

  function calculateTechOutput(gameState) {
    const s = gameState || rootGameState || {};
    if (!((s.flags && s.flags.isResearchStationBlueprintUnlocked) || (s.blueprints && s.blueprints.researchWorkstation))) {
      return 0;
    }
    const populationRaw = Number(s.population || 0);
    const maxPopulationRaw = Number(s.maxPopulation || s.populationCap || 8);
    const baseTechRateRaw = Number(s.baseTechRate || 0.1);
    const population = Math.max(0, Math.min(populationRaw, Math.max(1, maxPopulationRaw)));
    const baseTechRate = Math.max(0, baseTechRateRaw);
    const cooperationBonus = population >= Math.max(8, maxPopulationRaw) ? 1.2 : 1;
    const extraBonus = Number(s.globalProdMod || 1);
    const totalOutput = population * baseTechRate * cooperationBonus * (Number.isFinite(extraBonus) ? extraBonus : 1);
    return Math.max(0, Number(totalOutput || 0));
  }

  function getTechPoints(gameState) {
    const s = gameState || rootGameState || {};
    return s.resources && typeof s.resources.techPoints === "number"
      ? s.resources.techPoints
      : 0;
  }

  function listTechUpgrades(gameState) {
    const st = gameState || rootGameState;
    if (!st || !st.systems) {
      return [];
    }
    if (!st.techEraEnabled || !(st.blueprints && st.blueprints.researchWorkstation)) {
      return [];
    }
    const t = st.systems.tech || {};
    const maxLevel = resolveMaxTechLevel();
    return [
      { id: "shield", name: "强化护盾", level: Number(t.shieldLevel || 0), maxLevel, atMax: Number(t.shieldLevel || 0) >= maxLevel },
      { id: "cycle", name: "循环优化", level: Number(t.cycleLevel || 0), maxLevel, atMax: Number(t.cycleLevel || 0) >= maxLevel },
      { id: "mining", name: "高效采掘", level: Number(t.miningLevel || 0), maxLevel, atMax: Number(t.miningLevel || 0) >= maxLevel }
    ];
  }

  function isSingularityUnlocked(gameState) {
    const s = gameState || rootGameState || {};
    const distance = Number((s.systems && s.systems.expedition) ? s.systems.expedition.distanceKm : 0);
    const flagged = !!(s.systems && s.systems.tech && s.systems.tech.singularityUnlocked);
    return flagged || distance >= 100000;
  }

  function convertToSingularity() {
    const st = rootGameState || {};
    const conversionRate = resolveConversionRate();
    if (
      !st.techEraEnabled ||
      !(st.blueprints && st.blueprints.researchWorkstation) ||
      !isSingularityUnlocked(st) ||
      !moundState ||
      typeof moundState.setState !== "function"
    ) {
      return false;
    }
    const currentTech = Number((st.resources && st.resources.techPoints) || 0);
    if (currentTech < conversionRate) {
      return false;
    }
    const workerMode = getWorkerMode() === "full";
    const workerBridge = getWorkerBridge();
    if (workerMode && workerBridge && typeof workerBridge.command === "function") {
      workerBridge.command("CONVERT_SINGULARITY", { conversionRate });
      const engineHook = getEngineApi();
      if (engineHook && typeof engineHook.addLog === "function") {
        engineHook.addLog("[奇点凝聚中...] 物理常数已达极限，奇点 +1。");
      }
      return true;
    }
    moundState.setState((draft) => {
      draft.resources = draft.resources || {};
      const before = Number(draft.resources.techPoints || 0);
      if (before < conversionRate) {
        return;
      }
      draft.resources.techPoints = before - conversionRate;
      draft.resources.singularity = Number(draft.resources.singularity || draft.singularity || 0) + 1;
      draft.singularity = draft.resources.singularity;
      console.log(`[Singularity Exchange] -${conversionRate} Tech, +1 Singularity. New Total: ${draft.resources.singularity}`);
      draft.systems = draft.systems || {};
      draft.systems.tech = draft.systems.tech || {};
      draft.systems.tech.singularityUnlocked = true;
    });
    const engineHook = getEngineApi();
    if (engineHook && typeof engineHook.addLog === "function") {
      engineHook.addLog("[奇点凝聚中...] 物理常数已达极限，奇点 +1。");
    }
    calculateWeaponEffect(rootGameState);
    return true;
  }

  function calculateWeaponEffect(gameState) {
    const s = gameState || rootGameState || {};
    const singularityCount = Math.max(0, Number((s.resources && s.resources.singularity) || s.singularity || 0));
    const weapons = s.weapons || {};
    const level = Math.max(0, Number(weapons.level || 0));
    const baseDamage = Math.max(1, Number(weapons.damage || 100));
    const damage = Math.floor(baseDamage * (1 + singularityCount * 0.35 + level * 0.5));
    const energy = Math.max(0, Math.min(100, singularityCount * 12 + level * 8));
    if (moundState && typeof moundState.setState === "function") {
      moundState.setState((draft) => {
        draft.weapons = draft.weapons || {
          active: false,
          type: "singularity_cannon",
          level: 0,
          energy: 0,
          damage: 100
        };
        draft.weapons.damage = damage;
        draft.weapons.energy = energy;
        draft.weapons.active = singularityCount > 0 || level > 0;
      });
    }
    return { damage, energy, level, singularity: singularityCount };
  }

  function upgradeWeaponLevel() {
    const st = rootGameState || {};
    if (
      !st.techEraEnabled ||
      !(st.blueprints && st.blueprints.researchWorkstation) ||
      !moundState ||
      typeof moundState.setState !== "function"
    ) {
      return false;
    }
    const singularity = Number((st.resources && st.resources.singularity) || st.singularity || 0);
    const tech = Number((st.resources && st.resources.techPoints) || 0);
    if (singularity < 1 || tech < 1000) {
      return false;
    }
    const workerMode = getWorkerMode() === "full";
    const workerBridge = getWorkerBridge();
    if (workerMode && workerBridge && typeof workerBridge.command === "function") {
      workerBridge.command("UPGRADE_WEAPON", { techCost: 1000, singularityCost: 1 });
      const engineHook = getEngineApi();
      if (engineHook && typeof engineHook.addLog === "function") {
        engineHook.addLog("[火控] 奇点炮完成迭代升级，火力曲线已重算。");
      }
      return true;
    }
    moundState.setState((draft) => {
      draft.weapons = draft.weapons || {
        active: false,
        type: "singularity_cannon",
        level: 0,
        energy: 0,
        damage: 100
      };
      draft.resources = draft.resources || {};
      const singularityCount = Number(draft.resources.singularity || draft.singularity || 0);
      if (singularityCount < 1 || Number(draft.resources.techPoints || 0) < 1000) {
        return;
      }
      draft.resources.singularity = singularityCount - 1;
      draft.singularity = draft.resources.singularity;
      const nextTech = Number(draft.resources.techPoints || 0) - 1000;
      draft.resources.techPoints = nextTech;
      draft.weapons.level = Number(draft.weapons.level || 0) + 1;
      draft.weapons.active = true;
    });
    calculateWeaponEffect(rootGameState);
    const engineHook = getEngineApi();
    if (engineHook && typeof engineHook.addLog === "function") {
      engineHook.addLog("[火控] 奇点炮完成迭代升级，火力曲线已重算。");
    }
    return true;
  }

  function convertSingularity() {
    return convertToSingularity();
  }

  function tryPurchaseUpgrade(upgradeId) {
    const engine = getEngineApi();
    if (!engine) {
      return false;
    }
    const st = rootGameState || {};
    if (!st.techEraEnabled || !(st.blueprints && st.blueprints.researchWorkstation)) {
      return false;
    }
    if (isAtMaxLevel(upgradeId, rootGameState)) {
      return false;
    }
    if (upgradeId === "shield") {
      return engine.upgradeShieldTech();
    }
    if (upgradeId === "cycle") {
      return engine.upgradeCycleTech();
    }
    if (upgradeId === "mining") {
      return engine.upgradeMiningTech();
    }
    return false;
  }

  window.MoundSystems = window.MoundSystems || {};
  window.MoundSystems.tech = {
    name: "tech",
    ready: true,
    getShieldReduction,
    getCyclePowerFactor,
    getMiningOutputFactor,
    nextTechCost,
    calculateTechOutput,
    isAtMaxLevel,
    getTechPoints,
    listTechUpgrades,
    tryPurchaseUpgrade,
    isSingularityUnlocked,
    convertToSingularity,
    convertSingularity,
    calculateWeaponEffect,
    upgradeWeaponLevel
  };
})();

export function convertToSingularity() {
  const tech = window.MoundSystems && window.MoundSystems.tech;
  if (tech && typeof tech.convertToSingularity === "function") {
    return tech.convertToSingularity();
  }
  return false;
}

export function calculateWeaponEffect(state) {
  const tech = window.MoundSystems && window.MoundSystems.tech;
  if (tech && typeof tech.calculateWeaponEffect === "function") {
    return tech.calculateWeaponEffect(state);
  }
  return { damage: 0, energy: 0, level: 0, singularity: 0 };
}

export function upgradeWeaponLevel() {
  const tech = window.MoundSystems && window.MoundSystems.tech;
  if (tech && typeof tech.upgradeWeaponLevel === "function") {
    return tech.upgradeWeaponLevel();
  }
  return false;
}
