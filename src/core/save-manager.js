import { moundState } from "./state.js";
import { getEngineApi, getUiApi, setStorageNeedsRender } from "./runtime-hooks.js";
import { syncColonyCapacityInDraft } from "../systems/colony-cap.js";

export const SAVE_KEY = "the_mound_save";

function isPlainObject(value) {
  return Object.prototype.toString.call(value) === "[object Object]";
}

function cloneSerializable(value) {
  if (Array.isArray(value)) {
    return value.map(cloneSerializable);
  }
  if (isPlainObject(value)) {
    const out = {};
    Object.keys(value).forEach((key) => {
      if (key.includes("timer") || key.includes("handle")) {
        return;
      }
      out[key] = cloneSerializable(value[key]);
    });
    return out;
  }
  return value;
}

function mergeIntoState(target, source) {
  Object.keys(source || {}).forEach((key) => {
    const next = source[key];
    if (isPlainObject(next) && isPlainObject(target[key])) {
      mergeIntoState(target[key], next);
      return;
    }
    target[key] = next;
  });
}

function normalizeLoadedDraft(draft) {
  if (!Array.isArray(draft.logs)) {
    draft.logs = [];
  }
  if (typeof draft.systems.expedition.distanceKm === "string") {
    draft.systems.expedition.distanceKm = Number(draft.systems.expedition.distanceKm) || 0;
  }
  draft.systems = draft.systems || {};
  draft.systems.expedition = draft.systems.expedition || {};
  if (typeof draft.systems.expedition.distanceKm === "string") {
    draft.systems.expedition.distanceKm = Number(draft.systems.expedition.distanceKm) || 0;
  }
  draft.structures = draft.structures || {};
  draft.resources = draft.resources || {};
  if (typeof draft.resources.helium3 !== "number") {
    draft.resources.helium3 = 0;
  }
  if (typeof draft.resources.magneticArray !== "number") {
    draft.resources.magneticArray = 0;
  }
  if (typeof draft.resources.crew !== "number") {
    draft.resources.crew = Number(draft.population || draft.crew || 0);
  }
  if (typeof draft.resources.crewCapacity !== "number") {
    draft.resources.crewCapacity = Number(draft.populationCap || draft.maxPopulation || 1);
  }
  if (typeof draft.resources.techPoints !== "number") {
    draft.resources.techPoints = 0;
  }
  if (typeof draft.resources.singularity !== "number") {
    draft.resources.singularity = Number(draft.singularity || 0);
  }
    if (typeof draft.resources.powerCapacity !== "number") {
      draft.resources.powerCapacity = 5000000;
    }
    draft.resources.powerCapacity = Math.max(5000000, Number(draft.resources.powerCapacity || 5000000));
  if (typeof draft.resources.power === "number") {
    draft.resources.power = Math.max(0, Math.min(Number(draft.resources.power || 0), draft.resources.powerCapacity));
  }
  if (Object.prototype.hasOwnProperty.call(draft, "techPoints")) {
    delete draft.techPoints;
  }
  if (Object.prototype.hasOwnProperty.call(draft, "sciencePoint")) {
    delete draft.sciencePoint;
  }
  if (typeof draft.structures.magneticArray !== "number") {
    draft.structures.magneticArray = Number(draft.arrays || draft.resources.magneticArray || 0);
  }
  if (typeof draft.structures.massProjector !== "number") {
    draft.structures.massProjector = draft.massDriverBuilt ? 1 : 0;
  }
  if (typeof draft.structures.miningMachine !== "number") {
    draft.structures.miningMachine = Number(draft.miningDrones || 0);
  }
  if (typeof draft.structures.fusionGenerator !== "number") {
    draft.structures.fusionGenerator = Number(draft.fusionGenerators || 0);
  }
  const normalizedArrays = Number(draft.arrays || draft.structures.magneticArray || draft.resources.magneticArray || 0);
  draft.arrays = normalizedArrays;
  draft.structures.magneticArray = normalizedArrays;
  draft.resources.magneticArray = normalizedArrays;
  if (typeof draft.ReactorCoreActive !== "boolean") {
    draft.ReactorCoreActive = false;
  }
  if (typeof draft.isVaultRepaired !== "boolean") {
    draft.isVaultRepaired = false;
  }
  if (typeof draft.helium3 !== "number") {
    draft.helium3 = draft.resources.helium3;
  }
  if (typeof draft.massDriverBuilt !== "boolean") {
    draft.massDriverBuilt = false;
  }
  if (typeof draft.miningDrones !== "number") {
    draft.miningDrones = 0;
  }
  if (typeof draft.fusionGenerators !== "number") {
    draft.fusionGenerators = 0;
  }
  draft.fusionGenerators = Math.max(Number(draft.fusionGenerators || 0), Number(draft.structures.fusionGenerator || 0));
  draft.structures.massProjector = Math.max(Number(draft.structures.massProjector || 0), draft.massDriverBuilt ? 1 : 0);
  draft.structures.miningMachine = Math.max(Number(draft.structures.miningMachine || 0), Number(draft.miningDrones || 0));
  draft.structures.fusionGenerator = Math.max(Number(draft.structures.fusionGenerator || 0), Number(draft.fusionGenerators || 0));
  if (typeof draft.lastMiningCycleAt !== "number") {
    draft.lastMiningCycleAt = 0;
  }
  draft.blueprints = draft.blueprints || {};
  if (typeof draft.blueprints.researchWorkstation !== "boolean") {
    draft.blueprints.researchWorkstation = false;
  }
  if (typeof draft.blueprints.maintenanceCenter !== "boolean") {
    draft.blueprints.maintenanceCenter = false;
  }
  if (typeof draft.baseTechRate !== "number") {
    draft.baseTechRate = 0.1;
  }
  if (typeof draft.crew !== "number") {
    draft.crew = draft.population || 0;
  }
  if (typeof draft.pendingCrewArrivals !== "number") {
    draft.pendingCrewArrivals = 0;
  }
  if (typeof draft.pendingCrewArrivalAt !== "number") {
    draft.pendingCrewArrivalAt = 0;
  }
  if (!Array.isArray(draft.completedEvents)) {
    draft.completedEvents = [];
  }
  if (!Array.isArray(draft.triggeredEvents)) {
    draft.triggeredEvents = [];
  }
  if (typeof draft.isEventActive !== "boolean") {
    draft.isEventActive = false;
  }
  if (typeof draft.thrustEfficiency !== "number") {
    draft.thrustEfficiency = 1;
  }
  if (typeof draft.thrustMultiplier !== "number" || draft.thrustMultiplier < 1) {
    draft.thrustMultiplier = 1;
  }
  if (typeof draft.powerUsageMod !== "number") {
    draft.powerUsageMod = 1;
  }
  if (typeof draft.disasterDamageMod !== "number") {
    draft.disasterDamageMod = 1;
  }
  if (typeof draft.disasterChanceMod !== "number") {
    draft.disasterChanceMod = 1;
  }
  if (typeof draft.globalProdMod !== "number") {
    draft.globalProdMod = 1;
  }
  if (typeof draft.he3UsageMod !== "number") {
    draft.he3UsageMod = 1;
  }
  if (typeof draft.maxThrustLimit !== "number") {
    draft.maxThrustLimit = typeof draft.maxThrustMultiplier === "number" ? draft.maxThrustMultiplier : 10;
  }
  if (typeof draft.maxThrustMultiplier !== "number") {
    draft.maxThrustMultiplier = draft.maxThrustLimit;
  }
  if (typeof draft.lastEventMilestone !== "number") {
    const km = (draft.systems && draft.systems.expedition) ? (draft.systems.expedition.distanceKm || 0) : 0;
    draft.lastEventMilestone = Math.max(0, Math.floor(km / 2000));
  }
  if (typeof draft.isTechEra !== "boolean") {
    const km = (draft.systems && draft.systems.expedition) ? (draft.systems.expedition.distanceKm || 0) : 0;
    draft.isTechEra = km >= 10000;
  }
  if (typeof draft.isAdventureReady !== "boolean") {
    const km = (draft.systems && draft.systems.expedition) ? (draft.systems.expedition.distanceKm || 0) : 0;
    draft.isAdventureReady = km >= 2000;
  }
  if (typeof draft.isAutoMaintenance !== "boolean") {
    draft.isAutoMaintenance = draft.isTechEra;
  }
  if (typeof draft.hasMetOutpost !== "boolean") {
    draft.hasMetOutpost = false;
  }
  draft.upgrades = draft.upgrades || { dustRefining: 1, powerEfficiency: 1, shieldLevel: 0 };
  if (typeof draft.upgrades.dustRefining !== "number") {
    draft.upgrades.dustRefining = 1;
  }
  if (typeof draft.upgrades.powerEfficiency !== "number") {
    draft.upgrades.powerEfficiency = 1;
  }
  if (typeof draft.upgrades.shieldLevel !== "number") {
    draft.upgrades.shieldLevel = draft.systems && draft.systems.tech ? draft.systems.tech.shieldLevel || 0 : 0;
  }
  draft.resources.techPoints = Number(draft.resources.techPoints || 0);
  draft.flags = draft.flags || {};
  if (typeof draft.flags.isResearchStationBlueprintUnlocked !== "boolean") {
    draft.flags.isResearchStationBlueprintUnlocked = !!(draft.blueprints && draft.blueprints.researchWorkstation);
  }
  if (!draft.flags.isResearchStationBlueprintUnlocked) {
    draft.resources.techPoints = 0;
  }
  if (typeof draft.flags.combatReadiness !== "number") {
    draft.flags.combatReadiness = 0;
  }
  if (typeof draft.flags.combatSystemUnlocked !== "boolean") {
    const km = (draft.systems && draft.systems.expedition) ? (draft.systems.expedition.distanceKm || 0) : 0;
    draft.flags.combatSystemUnlocked = km >= 100000;
  }
  if (typeof draft.flags.combatMilestoneCompApplied !== "boolean") {
    draft.flags.combatMilestoneCompApplied = false;
  }
  if (typeof draft.singularity !== "number") {
    draft.singularity = 0;
  }
  draft.singularity = Math.max(0, Number(draft.singularity || draft.resources.singularity || 0));
  draft.resources.singularity = Math.max(0, Number(draft.resources.singularity || draft.singularity || 0));
  draft.singularity = draft.resources.singularity;
  draft.weapons = Object.assign(
    {
      active: false,
      type: "singularity_cannon",
      level: 0,
      energy: 0,
      damage: 100
    },
    draft.weapons || {}
  );
  draft.combat = draft.combat || {};
  draft.combat.attackSystems = draft.combat.attackSystems || {};
  draft.combat.defenseSystems = draft.combat.defenseSystems || {};
  draft.flags = draft.flags || {};
  if (!draft.flags.tacticalResetV1) {
    draft.combat.attackSystems.kineticCannon = 0;
    draft.combat.attackSystems.laserArray = 0;
    draft.combat.defenseSystems.shieldGenerator = 0;
    draft.combat.defenseSystems.ablativeArmor = 0;
    draft.flags.tacticalResetV1 = true;
  }
  draft.combat.attackSystems.kineticCannon = Math.max(0, Number(draft.combat.attackSystems.kineticCannon || 0));
  draft.combat.attackSystems.laserArray = Math.max(0, Number(draft.combat.attackSystems.laserArray || 0));
  draft.combat.defenseSystems.shieldGenerator = Math.max(0, Number(draft.combat.defenseSystems.shieldGenerator || 0));
  draft.combat.defenseSystems.ablativeArmor = Math.max(0, Number(draft.combat.defenseSystems.ablativeArmor || 0));
  draft.combat.attackLevel =
    draft.combat.attackSystems.kineticCannon + draft.combat.attackSystems.laserArray;
  draft.combat.defenseLevel =
    draft.combat.defenseSystems.shieldGenerator + draft.combat.defenseSystems.ablativeArmor;
  draft.combat.baseDamage = Math.max(1, Number(draft.combat.baseDamage || (1 + draft.combat.attackSystems.kineticCannon * 10)));
  draft.combat.critChance = Math.max(0, Math.min(0.75, Number(draft.combat.critChance || (draft.combat.attackSystems.laserArray * 0.05))));
  draft.combat.damageReduction = Math.max(0, Math.min(0.8, Number(draft.combat.damageReduction || (draft.combat.defenseSystems.shieldGenerator * 0.04))));
  draft.combat.hullHp = Math.max(100, Number(draft.combat.hullHp || (100 + draft.combat.defenseSystems.ablativeArmor * 40)));
  draft.combatStats = draft.combatStats && typeof draft.combatStats === "object" ? draft.combatStats : {};
  const hullCap = Math.max(100, Number(draft.combat.hullHp || 100));
  draft.combatStats.hullMax = typeof draft.combatStats.hullMax === "number" ? draft.combatStats.hullMax : hullCap;
  draft.combatStats.hull =
    typeof draft.combatStats.hull === "number" ? Math.min(hullCap, Math.max(0, draft.combatStats.hull)) : hullCap;
  draft.combatStats.shield =
    typeof draft.combatStats.shield === "number"
      ? draft.combatStats.shield
      : Math.max(0, Math.min(0.9, Number(draft.combat.damageReduction || 0)));
  if (typeof draft.combatState !== "string") {
    draft.combatState = "IDLE";
  }
  if (draft.activeDeck != null && typeof draft.activeDeck !== "string") {
    draft.activeDeck = null;
  }
  if (draft.spaceSubDeck != null && typeof draft.spaceSubDeck !== "string") {
    draft.spaceSubDeck = null;
  }
  draft.systems.combatEncounter =
    draft.systems.combatEncounter && typeof draft.systems.combatEncounter === "object"
      ? draft.systems.combatEncounter
      : {};
  const ce = draft.systems.combatEncounter;
  if (typeof ce.phase !== "string") {
    ce.phase = "IDLE";
  }
  if (ce.enemy !== null && typeof ce.enemy !== "object") {
    ce.enemy = null;
  }
  if (ce.savedThrottle !== null && typeof ce.savedThrottle !== "number") {
    ce.savedThrottle = null;
  }
  if (typeof ce.lastTriggerKm !== "number") {
    ce.lastTriggerKm = null;
  }
  if (typeof ce.massDriverCharging !== "boolean") {
    ce.massDriverCharging = false;
  }
  if (ce.lastResolution !== null && typeof ce.lastResolution !== "object") {
    ce.lastResolution = null;
  }
  if (typeof ce.phase === "string" && ce.phase !== "IDLE") {
    draft.combatState = ce.phase;
  }
  draft.netRates = draft.netRates || {
    power: 0,
    oxygen: 0,
    scrapMetal: 0,
    stardust: 0,
    alloy: 0,
    sealant: 0,
    helium3: 0
  };
  draft.valueSources = draft.valueSources || {
    power: {},
    oxygen: {},
    scrapMetal: {},
    stardust: {},
    alloy: {},
    sealant: {},
    helium3: {}
  };
  if (typeof draft.techEraEnabled !== "boolean") {
    draft.techEraEnabled = false;
  }
  draft.systems = draft.systems || {};
  draft.systems.ui = draft.systems.ui || {};
  if (typeof draft.systems.ui.showCombatModal !== "boolean") {
    draft.systems.ui.showCombatModal = false;
  }
  if (draft.systems.ui.activeEncounter === undefined) {
    draft.systems.ui.activeEncounter = null;
  }
  if (!draft.systems.ui.showCombatModal && !draft.systems.ui.outpostMenuLocked) {
    draft.systems.expedition = draft.systems.expedition || {};
    draft.systems.expedition.isNavigationLocked = false;
  }
  if (typeof draft.systems.ui.manualActionFlag !== "boolean") {
    draft.systems.ui.manualActionFlag = false;
  }
  if (typeof draft.systems.ui.manualActionTriggered !== "boolean") {
    draft.systems.ui.manualActionTriggered = false;
  }
  if (!isPlainObject(draft.systems.ui.discoveredTopBar)) {
    draft.systems.ui.discoveredTopBar = {};
  }
  if (typeof draft.systems.ui.automationStructuresDiscovered !== "boolean") {
    draft.systems.ui.automationStructuresDiscovered = Number(draft.resources.sealant || 0) >= 5;
  }
  if (typeof draft.systems.ui.refiningFurnaceDiscovered !== "boolean") {
    draft.systems.ui.refiningFurnaceDiscovered = Number(draft.resources.sealant || 0) >= 10;
  }
  if (typeof draft.systems.ui.expeditionInterlockLogged !== "boolean") {
    draft.systems.ui.expeditionInterlockLogged = false;
  }
  if (typeof draft.systems.ui.autoSmelterDiscovered !== "boolean") {
    draft.systems.ui.autoSmelterDiscovered =
      !!draft.hasRefiningFurnace && (Number(draft.resources.alloy || 0) >= 3 || Number(draft.autoSmelters || 0) > 0);
  }
  draft.systems.expedition = draft.systems.expedition || {};
  draft.systems.deepSpace = draft.systems.deepSpace || {};
  if (typeof draft.systems.deepSpace.unlocked !== "boolean") {
    draft.systems.deepSpace.unlocked = !!draft.isVaultRepaired;
  }
  if (typeof draft.systems.expedition.nextHazardKm !== "number") {
    draft.systems.expedition.nextHazardKm = 2000;
  }
  if (typeof draft.systems.expedition.lastEventDistance !== "number") {
    draft.systems.expedition.lastEventDistance = 0;
  }
  if (typeof draft.systems.expedition.scanBlockedUntilKm !== "number") {
    draft.systems.expedition.scanBlockedUntilKm = 0;
  }
  if (typeof draft.systems.expedition.status !== "string") {
    draft.systems.expedition.status = "IDLE";
  }
  if (typeof draft.systems.expedition.currentRegion !== "string" || !draft.systems.expedition.currentRegion) {
    const distance = Number(draft.systems.expedition.distanceKm || 0);
    draft.systems.expedition.currentRegion =
      distance >= 50000 ? "哨所遗迹区" : (distance >= 5000 ? "补给星区" : "荒芜带");
  }
  if (typeof draft.systems.expedition.targetDistance !== "number") {
    const distance = Number(draft.systems.expedition.distanceKm || 0);
    draft.systems.expedition.targetDistance = distance >= 5000 ? 15000 : 5000;
  }
  if (typeof draft.systems.expedition.isNavigationLocked !== "boolean") {
    draft.systems.expedition.isNavigationLocked = !!(draft.systems.ui && draft.systems.ui.outpostMenuLocked);
  }
  if (
    !draft.systems.expedition.milestonesReached ||
    Object.prototype.toString.call(draft.systems.expedition.milestonesReached) !== "[object Object]"
  ) {
    draft.systems.expedition.milestonesReached = {};
  }
  if (typeof draft.systems.expedition.nextRandomEventKm !== "number") {
    draft.systems.expedition.nextRandomEventKm = 0;
  }
  if (typeof draft.systems.expedition.lastBroadcastKm !== "number") {
    draft.systems.expedition.lastBroadcastKm = 0;
  }
  if (typeof draft.systems.fusionDebuffUntil !== "number") {
    draft.systems.fusionDebuffUntil = 0;
  }
  if (typeof draft.systems.automationFaultUntil !== "number") {
    draft.systems.automationFaultUntil = 0;
  }
  if (typeof draft.systems.decompressionRepairUntil !== "number") {
    draft.systems.decompressionRepairUntil = 0;
  }
  if (typeof draft.systems.pendingCrewLoss !== "number") {
    draft.systems.pendingCrewLoss = 0;
  }
  draft.systems.tech = draft.systems.tech || {};
  if (typeof draft.systems.tech.shieldLevel !== "number") {
    draft.systems.tech.shieldLevel = 0;
  }
  if (typeof draft.systems.tech.cycleLevel !== "number") {
    draft.systems.tech.cycleLevel = 0;
  }
  if (typeof draft.systems.tech.miningLevel !== "number") {
    draft.systems.tech.miningLevel = 0;
  }
  if (typeof draft.systems.tech.singularityUnlocked !== "boolean") {
    draft.systems.tech.singularityUnlocked = Number(draft.systems.expedition.distanceKm || 0) >= 100000;
  }
  const dist = Number((draft.systems && draft.systems.expedition) ? (draft.systems.expedition.distanceKm || 0) : 0);
  if (dist >= 100000) {
    const missedMilestones = [60000, 70000, 80000, 90000];
    draft.completedEvents = Array.isArray(draft.completedEvents) ? draft.completedEvents : [];
    missedMilestones.forEach((milestone) => {
      if (!draft.completedEvents.includes(milestone)) {
        draft.completedEvents.push(milestone);
      }
    });
    if (!draft.flags.combatMilestoneCompApplied) {
      draft.flags.combatReadiness = Math.max(0, Number(draft.flags.combatReadiness || 0)) + 5;
      draft.flags.combatMilestoneCompApplied = true;
    }
    draft.flags.combatSystemUnlocked = true;
    draft.systems.tech.singularityUnlocked = true;
  }
  syncColonyCapacityInDraft(draft);
}

function notifyLoaded() {
  const engineHook = getEngineApi();
  if (engineHook && typeof engineHook.checkSystems === "function") {
    engineHook.checkSystems();
  }
  const uiApi = getUiApi();
  if (uiApi && typeof uiApi.renderAll === "function") {
    uiApi.renderAll();
  } else {
    setStorageNeedsRender(true);
  }
  if (typeof window.updateUI === "function") {
    window.updateUI();
  }
}

export function saveGame(state = moundState.state) {
  try {
    if (!state || typeof state !== "object") {
      return false;
    }
    const payload = cloneSerializable(state);
    localStorage.setItem(SAVE_KEY, JSON.stringify(payload));
    return true;
  } catch (error) {
    console.error("[SaveManager] 保存失败", error);
    return false;
  }
}

export function loadGame() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) {
      return false;
    }
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed)) {
      localStorage.removeItem(SAVE_KEY);
      return false;
    }
    moundState.setState((draft) => {
      mergeIntoState(draft, parsed);
      normalizeLoadedDraft(draft);
    });
    notifyLoaded();
    return true;
  } catch (error) {
    console.warn("[SaveManager] 存档损坏，已回退初始状态。", error);
    try {
      localStorage.removeItem(SAVE_KEY);
    } catch (removeError) {
      console.warn("[SaveManager] 无法清理损坏存档。", removeError);
    }
    return false;
  }
}

export function clearSave() {
  try {
    localStorage.removeItem(SAVE_KEY);
    return true;
  } catch (error) {
    return false;
  }
}
