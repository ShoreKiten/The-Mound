/**
 * Game session reset — clears progress while preserving time anchors.
 *
 * Used by the ending sequence to restart the voyage after the OMEGA ending
 * without losing hard-earned checkpoint data.
 */

import { moundState } from "./state.js";
import { getUiApi } from "./runtime-hooks.js";

const AUTO_SAVE_KEY = "the_mound_save";
const ANCHOR_KEY = "omega_boss_checkpoint";

const DEFAULT_RESOURCES = {
  stardust: 0,
  scrapMetal: 0,
  power: 0,
  radiation: 0,
  alloy: 0,
  sealant: 0,
  helium3: 0,
  oxygen: 100,
  iceOre: 0,
  magneticArray: 0,
  crew: 0,
  crewCapacity: 1,
  powerCapacity: 5000000,
  techPoints: 0,
  singularity: 0
};

const DEFAULT_STRUCTURES = {
  magneticArray: 0,
  massProjector: 0,
  miningMachine: 0,
  fusionGenerator: 0
};

const DEFAULT_COMBAT = {
  attackLevel: 0,
  defenseLevel: 0,
  attackSystems: { kineticCannon: 0, laserArray: 0 },
  defenseSystems: { shieldGenerator: 0, ablativeArmor: 0 },
  baseDamage: 1,
  critChance: 0,
  damageReduction: 0,
  hullHp: 100,
  isLocked: false
};

const DEFAULT_COMBAT_STATS = {
  hull: 100,
  hullMax: 100,
  playerShield: 0,
  playerShieldMax: 30,
  shieldCooldown: 0,
  shieldCharges: 3,
  laserCooldown: 0,
  turnCount: 0
};

const DEFAULT_BLUEPRINTS = {
  maintenanceCenter: false,
  quantumCommArray: false,
  researchWorkstation: false
};

const DEFAULT_UPGRADES = {
  dustRefining: 1,
  powerEfficiency: 1,
  shieldLevel: 0
};

const DEFAULT_WEAPONS = {
  active: false,
  type: "singularity_cannon",
  level: 0,
  energy: 0,
  damage: 100
};

const DEFAULT_FLAGS = {
  isResearchStationBlueprintUnlocked: false,
  combatReadiness: 0,
  combatSystemUnlocked: false,
  omegaDefeated: false,
  omegaSlayer: false,
  omegaEndingDefeat: false,
  isInCombat: false,
  endingActive: false
};

const DEFAULT_EXPEDITION = {
  scanned: false,
  active: false,
  drifting: false,
  status: "IDLE",
  currentRegion: "荒芜带",
  targetDistance: 5000,
  isNavigationLocked: false,
  milestonesReached: {},
  nextRandomEventKm: 0,
  lastBroadcastKm: 0,
  distanceKm: 0,
  nextMilestoneKm: 10000,
  nextHazardKm: 2000,
  lastEventDistance: 0,
  scanBlockedUntilKm: 0,
  deepSpaceLogNextAt: 0,
  orbitalScanUnlocked: false,
  midLayerLogged: false,
  milestone10000Reached: false,
  milestone30000Reached: false,
  milestone60000Reached: false,
  milestone100000Reached: false,
  throttle: 0,
  overdrive: false,
  nextSpeedBoost: 0,
  magneticStormUntil: 0,
  nextEventAt: 0,
  techFragments: 0,
  autoMaintenanceUnlocked: false,
  outpostRecovered: false
};

const DEFAULT_UI = {
  activeDeck: "industry",
  spaceSubDeck: "expedition",
  showCombatModal: false,
  activeEncounter: null,
  automationLoggingEnabled: false,
  powerSurplusSeconds: 0,
  hideManualOxygen: false,
  hideManualCharge: false,
  hideManualRefine: false,
  hideManualSealant: false,
  hideReactorAction: false,
  collapseBasicGather: false,
  he3FlashGain: 0,
  he3FlashUntil: 0,
  uiUpgradeLogged: false,
  manualPipelineLogged: false,
  manualAuthSlimLogged: false,
  expeditionInterlockLogged: false,
  dangerFlashUntil: 0,
  outpostMenuLocked: false,
  outpostSavedThrust: null,
  manualActionFlag: false,
  manualActionTriggered: false,
  discoveredTopBar: {},
  automationStructuresDiscovered: false,
  refiningFurnaceDiscovered: false,
  autoSmelterDiscovered: false
};

/**
 * Reset the game session to its initial state.
 *
 * @param {boolean} keepAnchors - If true, preserves `omega_boss_checkpoint`
 *   in localStorage and the `state.checkpoints` array.  Default true.
 */
export function resetGameSession(keepAnchors = true) {
  // 1. Preserve time-anchor data
  let savedAnchor = null;
  if (keepAnchors) {
    try {
      const raw = localStorage.getItem(ANCHOR_KEY);
      if (raw) savedAnchor = raw;
    } catch (_) { /* ignore */ }
  }

  // Snapshot checkpoints from current state before we wipe it
  let savedCheckpoints = [];
  try {
    const state = moundState && moundState.state;
    if (state && Array.isArray(state.checkpoints)) {
      savedCheckpoints = state.checkpoints.slice();
    }
  } catch (_) { /* ignore */ }

  // 2. Clear auto-save from localStorage
  try {
    localStorage.removeItem(AUTO_SAVE_KEY);
  } catch (_) { /* ignore */ }

  // 3. Remove ending overlay DOM
  if (typeof document !== "undefined") {
    const endingOverlay = document.getElementById("ending-overlay");
    if (endingOverlay && endingOverlay.parentNode) {
      endingOverlay.parentNode.removeChild(endingOverlay);
    }
    // Also clean up any lingering combat modal
    const combatModal = document.getElementById("combat-modal-container");
    if (combatModal && combatModal.parentNode) {
      combatModal.parentNode.removeChild(combatModal);
    }
    if (document.body) {
      document.body.classList.remove("combat-active");
    }
  }

  // 4. Reset in-memory state
  moundState.setState((draft) => {
    // --- Top-level scalars ---
    draft.resources = Object.assign({}, DEFAULT_RESOURCES);
    draft.structures = Object.assign({}, DEFAULT_STRUCTURES);
    draft.combat = Object.assign({}, DEFAULT_COMBAT);
    draft.combatStats = Object.assign({}, DEFAULT_COMBAT_STATS);
    draft.blueprints = Object.assign({}, DEFAULT_BLUEPRINTS);
    draft.upgrades = Object.assign({}, DEFAULT_UPGRADES);
    draft.weapons = Object.assign({}, DEFAULT_WEAPONS);
    draft.flags = Object.assign({}, DEFAULT_FLAGS);
    draft.combatState = "IDLE";
    draft.activeDeck = null;
    draft.spaceSubDeck = null;

    draft.ionCatchers = 0;
    draft.autoSmelters = 0;
    draft.autoSynthesizers = 0;
    draft.massDriverBuilt = false;
    draft.miningDrones = 0;
    draft.miners = 0;
    draft.fusionGenerators = 0;
    draft.lastMiningCycleAt = 0;
    draft.lastAutoSmelterAt = 0;
    draft.lastAutoSynthAt = 0;
    draft.hasRefiningFurnace = false;
    draft.maintenanceCenterBuilt = false;
    draft.maintenanceCenterActive = false;
    draft.population = 0;
    draft.populationCap = 1;
    draft.maxPopulation = 1;
    draft.singularity = 0;
    draft.isAutoMaintenance = false;
    draft.isTechEra = false;
    draft.isAdventureReady = false;
    draft.isEventActive = false;
    draft.hasMetOutpost = false;
    draft.completedEvents = [];
    draft.triggeredEvents = [];
    draft.logs = [];
    draft.seenEvents = {};
    draft.helium3 = 0;
    draft.oxygen = 100;
    draft.oxygenMax = 100;
    draft.ReactorCoreActive = false;
    draft.arrays = 0;
    draft.maxRadiation = 100;
    draft.crew = 0;
    draft.thrustMultiplier = 1;
    draft.thrustEfficiency = 1;
    draft.powerUsageMod = 1;
    draft.disasterDamageMod = 1;
    draft.disasterChanceMod = 1;
    draft.globalProdMod = 1;
    draft.he3UsageMod = 1;
    draft.maxThrustLimit = 10;
    draft.maxThrustMultiplier = 10;
    draft.lastEventMilestone = 0;
    draft.baseTechRate = 0.1;
    draft.techEraEnabled = false;
    draft.beaconCooldownUntil = 0;
    draft.beaconResponseDeadline = 0;
    draft.pendingCrewArrivals = 0;
    draft.pendingCrewArrivalAt = 0;
    draft.isEfficiencyUpgraded = false;
    draft.isVaultRepaired = false;

    draft.netRates = {
      power: 0, oxygen: 0, scrapMetal: 0, stardust: 0,
      alloy: 0, sealant: 0, helium3: 0
    };
    draft.valueSources = {
      power: {}, oxygen: {}, scrapMetal: {}, stardust: {},
      alloy: {}, sealant: {}, helium3: {}
    };

    // --- systems subtree ---
    draft.systems = draft.systems || {};
    draft.systems.reactorActive = false;
    draft.systems.automationHalted = false;
    draft.systems.oxygenSupplyLow = false;
    draft.systems.lowPowerForcedShutdownLogged = false;
    draft.systems.overclockAdjustedLogged = false;
    draft.systems.orbitalPaused = false;
    draft.systems.orbitalPauseLogged = false;
    draft.systems.maintenanceActive = false;
    draft.systems.miningProgressMs = 0;
    draft.systems.miningProgressPct = 0;
    draft.systems.productionSpeedBonusPct = 0;
    draft.systems.drifterArrived = false;
    draft.systems.suffocationLogged = false;
    draft.systems.reactorShutdownLogged = false;
    draft.systems.vaultRepairLogWritten = false;
    draft.systems.systemCalibratedLogged = false;
    draft.systems.fusionDebuffUntil = 0;
    draft.systems.automationFaultUntil = 0;
    draft.systems.decompressionRepairUntil = 0;
    draft.systems.pendingCrewLoss = 0;
    draft.systems.oxygenCriticalLogged = false;

    // systems.expedition — full reset
    draft.systems.expedition = Object.assign({}, DEFAULT_EXPEDITION);

    // systems.combatEncounter — fresh slice
    draft.systems.combatEncounter = {
      phase: "IDLE",
      enemy: null,
      savedThrottle: null,
      lastTriggerKm: null,
      massDriverCharging: false,
      lastResolution: null,
      isBoss: false,
      bossEndingActive: false,
      bossPhase: 1,
      bossBioPulseCounter: 0,
      bossVoidNovaCounter: 0,
      bossOriginalAttack: 75,
      bossTransitionBuffer: false,
      bossCorrosionDamage: 0,
      bossAblationLayer: 1200,
      bossKineticDamageDealt: 0,
      bossP2TotalTurns: 0
    };

    // systems.deepSpace
    draft.systems.deepSpace = { unlocked: false };

    // systems.rates
    draft.systems.rates = {
      power: 0, oxygen: 0, scrapMetal: 0, stardust: 0,
      alloy: 0, sealant: 0, helium3: 0
    };

    // systems.tech
    draft.systems.tech = {
      shieldLevel: 0,
      cycleLevel: 0,
      miningLevel: 0,
      singularityUnlocked: false
    };

    // systems.ui
    draft.systems.ui = Object.assign({}, DEFAULT_UI);

    // --- Preserve checkpoints ---
    draft.checkpoints = savedCheckpoints;
  });

  // 5. Restore time anchor in localStorage
  if (keepAnchors && savedAnchor) {
    try {
      localStorage.setItem(ANCHOR_KEY, savedAnchor);
    } catch (_) { /* ignore */ }
  }

  // 6. Force an immediate save of the clean state so the next page load
  //    (if any) picks up the reset instead of the old auto-save.
  try {
    const state = moundState && moundState.state;
    if (state) {
      const snapshot = JSON.parse(JSON.stringify(state));
      if (snapshot && typeof snapshot === "object") {
        localStorage.setItem(AUTO_SAVE_KEY, JSON.stringify(snapshot));
      }
    }
  } catch (_) { /* ignore */ }

  // 7. Trigger full re-render
  const ui = getUiApi();
  if (ui && typeof ui.renderAll === "function") {
    ui.renderAll(true);
  }
}

if (typeof window !== "undefined") {
  window.resetGameSession = resetGameSession;
}
