import {
  getApplyingWorkerPatch,
  getWorkerMode,
  getWorkerBridge
} from "./runtime-hooks.js";

const AUTO_SAVE_KEY = "the_mound_save";
const AUTO_SAVE_DEBOUNCE_MS = 1000;
let autoSaveTimer = null;
let autoSavePending = false;

function canUseLocalStorage() {
  return typeof localStorage !== "undefined";
}

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
      out[key] = cloneSerializable(value[key]);
    });
    return out;
  }
  return value;
}

function mergeSavedState(target, source) {
  if (!isPlainObject(source) || !target) {
    return;
  }
  Object.keys(source).forEach((key) => {
    const next = source[key];
    if (isPlainObject(next) && isPlainObject(target[key])) {
      mergeSavedState(target[key], next);
      return;
    }
    target[key] = next;
  });
}

function readPersistedStateSnapshot() {
  if (!canUseLocalStorage()) {
    return null;
  }
  try {
    const raw = localStorage.getItem(AUTO_SAVE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed)) {
      localStorage.removeItem(AUTO_SAVE_KEY);
      return null;
    }
    return parsed;
  } catch (error) {
    try {
      localStorage.removeItem(AUTO_SAVE_KEY);
    } catch (_error) {
      void _error;
    }
    return null;
  }
}

function schedulePersistedStateWrite(getSnapshot) {
  if (!canUseLocalStorage()) {
    return;
  }
  autoSavePending = true;
  if (autoSaveTimer) {
    return;
  }
  autoSaveTimer = setTimeout(() => {
    autoSaveTimer = null;
    if (!autoSavePending) {
      return;
    }
    autoSavePending = false;
    try {
      const snapshot = typeof getSnapshot === "function" ? getSnapshot() : null;
      if (!snapshot || typeof snapshot !== "object") {
        return;
      }
      localStorage.setItem(AUTO_SAVE_KEY, JSON.stringify(cloneSerializable(snapshot)));
    } catch (error) {
      console.warn("[StateProxy] auto-save failed", error);
    }
  }, AUTO_SAVE_DEBOUNCE_MS);
}

let exportedGameState = null;
let exportedMoundState = null;

(() => {
  const STATE_SINGLETON_KEY = "__gameStateSingleton";
  const STORE_SINGLETON_KEY = "__storeSingleton";
  const existingState = globalThis[STATE_SINGLETON_KEY];
  const existingStore = globalThis[STORE_SINGLETON_KEY];
  if (existingState && existingStore) {
    exportedGameState = existingState;
    exportedMoundState = existingStore;
    return;
  }
  const listeners = new Set();
  const proxyCache = new WeakMap();
  const proxyToTarget = new WeakMap();

  function shouldDeepProxifyAssignedValue(value) {
    if (!value || typeof value !== "object") {
      return false;
    }
    if (proxyToTarget.has(value)) {
      return false;
    }
    if (Array.isArray(value)) {
      return true;
    }
    return Object.prototype.toString.call(value) === "[object Object]";
  }

  const baseState = {
    structures: {
      magneticArray: 0,
      massProjector: 0,
      miningMachine: 0,
      fusionGenerator: 0
    },
    resources: {
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
    },
    ionCatchers: 0,
    autoSmelters: 0,
    autoSynthesizers: 0,
    massDriverBuilt: false,
    miningDrones: 0,
    miners: 0,
    fusionGenerators: 0,
    lastMiningCycleAt: 0,
    lastAutoSmelterAt: 0,
    lastAutoSynthAt: 0,
    hasRefiningFurnace: false,
    blueprints: {
      maintenanceCenter: false,
      quantumCommArray: false,
      researchWorkstation: false
    },
    maintenanceCenterBuilt: false,
    maintenanceCenterActive: false,
    population: 0,
    populationCap: 1,
    maxPopulation: 1,
    singularity: 0,
    weapons: {
      active: false,
      type: "singularity_cannon",
      level: 0,
      energy: 0,
      damage: 100
    },
    combat: {
      attackLevel: 0,
      defenseLevel: 0,
      attackSystems: {
        kineticCannon: 0,
        laserArray: 0
      },
      defenseSystems: {
        shieldGenerator: 0,
        ablativeArmor: 0
      },
      baseDamage: 1,
      critChance: 0,
      damageReduction: 0,
      hullHp: 100,
      isLocked: false
    },
    combatStats: {
      hull: 100,
      hullMax: 100,
      shield: 0
    },
    combatState: "IDLE",
    activeDeck: null,
    spaceSubDeck: null,
    baseTechRate: 0.1,
    techEraEnabled: false,
    isTechEra: false,
    isAdventureReady: false,
    isAutoMaintenance: false,
    completedEvents: [],
    isEventActive: false,
    thrustEfficiency: 1,
    powerUsageMod: 1,
    disasterDamageMod: 1,
    disasterChanceMod: 1,
    globalProdMod: 1,
    he3UsageMod: 1,
    maxThrustLimit: 10,
    maxThrustMultiplier: 10,
    lastEventMilestone: 0,
    crew: 0,
    hasMetOutpost: false,
    thrustMultiplier: 1,
    upgrades: {
      dustRefining: 1,
      powerEfficiency: 1,
      shieldLevel: 0
    },
    flags: {
      isResearchStationBlueprintUnlocked: false,
      combatReadiness: 0,
      combatSystemUnlocked: false,
      omegaDefeated: false,
      omegaSlayer: false,
      omegaEndingDefeat: false,
      isInCombat: false,
      endingActive: false
    },
    helium3: 0,
    netRates: {
      power: 0,
      oxygen: 0,
      scrapMetal: 0,
      stardust: 0,
      alloy: 0,
      sealant: 0,
      helium3: 0
    },
    valueSources: {
      power: {},
      oxygen: {},
      scrapMetal: {},
      stardust: {},
      alloy: {},
      sealant: {},
      helium3: {}
    },
    oxygen: 100,
    oxygenMax: 100,
    ReactorCoreActive: false,
    arrays: 0,
    maxRadiation: 100,
    beaconCooldownUntil: 0,
    beaconResponseDeadline: 0,
    pendingCrewArrivals: 0,
    pendingCrewArrivalAt: 0,
    isEfficiencyUpgraded: false,
    isVaultRepaired: false,
    triggeredEvents: [],
    seenEvents: {},
    logs: [],
    checkpoints: [],
    systems: {
      reactorActive: false,
      automationHalted: false,
      oxygenSupplyLow: false,
      lowPowerForcedShutdownLogged: false,
      overclockAdjustedLogged: false,
      orbitalPaused: false,
      orbitalPauseLogged: false,
      maintenanceActive: false,
      miningProgressMs: 0,
      miningProgressPct: 0,
      ui: {
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
      },
      expedition: {
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
      },
      deepSpace: {
        unlocked: false
      },
      combatEncounter: {
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
      },
      rates: {
        power: 0,
        oxygen: 0,
        scrapMetal: 0,
        stardust: 0,
        alloy: 0,
        sealant: 0,
        helium3: 0
      },
      productionSpeedBonusPct: 0,
      drifterArrived: false,
      suffocationLogged: false,
      reactorShutdownLogged: false,
      vaultRepairLogWritten: false,
      systemCalibratedLogged: false,
      fusionDebuffUntil: 0,
      automationFaultUntil: 0,
      decompressionRepairUntil: 0,
      pendingCrewLoss: 0,
      oxygenCriticalLogged: false,
      tech: {
        shieldLevel: 0,
        cycleLevel: 0,
        miningLevel: 0,
        singularityUnlocked: false
      }
    }
  };
  const persistedSnapshot = readPersistedStateSnapshot();
  if (persistedSnapshot) {
    mergeSavedState(baseState, persistedSnapshot);
  }

  function emit(path, value, prev) {
    listeners.forEach((listener) => {
      listener({
        path,
        value,
        prev,
        state: moundState.state
      });
    });
  }

  function proxify(target, path = "") {
    if (!target || typeof target !== "object") {
      return target;
    }
    if (proxyToTarget.has(target)) {
      return target;
    }
    const cached = proxyCache.get(target);
    if (cached) {
      return cached;
    }
    const proxy = new Proxy(target, {
      get(obj, key) {
        const value = obj[key];
        if (value && typeof value === "object") {
          const nextPath = path ? `${path}.${String(key)}` : String(key);
          return proxify(value, nextPath);
        }
        return value;
      },
      set(obj, key, value) {
        const prev = obj[key];
        if (Object.is(prev, value)) {
          return true;
        }
        const nextPath = path ? `${path}.${String(key)}` : String(key);
        let stored = value;
        if (shouldDeepProxifyAssignedValue(value)) {
          stored = proxify(value, nextPath);
        }
        obj[key] = stored;
        emit(nextPath, stored, prev);
        schedulePersistedStateWrite(() => moundState.state);
        return true;
      }
    });
    proxyCache.set(target, proxy);
    proxyToTarget.set(proxy, target);
    return proxy;
  }

  const state = proxify(baseState);
  const moundState = {
    state,
    setState(mutator) {
      if (typeof mutator !== "function") {
        return;
      }
      mutator(state);
    },
    subscribe(listener) {
      if (typeof listener !== "function") {
        return function noop() {};
      }
      listeners.add(listener);
      return function unsubscribe() {
        listeners.delete(listener);
      };
    }
  };
  globalThis[STATE_SINGLETON_KEY] = state;
  globalThis[STORE_SINGLETON_KEY] = moundState;
  exportedGameState = state;
  exportedMoundState = moundState;

  const immediateSubscribe = moundState.subscribe.bind(moundState);
  const pathSubscribers = new Map();
  const pendingPathNotifications = new Map();
  let pendingPathFlush = false;

  function matchesPath(subscriptionPath, changedPath) {
    if (!subscriptionPath || subscriptionPath === "*") {
      return true;
    }
    return subscriptionPath === changedPath || changedPath.startsWith(`${subscriptionPath}.`);
  }

  function flushPathSubscribers() {
    pendingPathFlush = false;
    const pending = Array.from(pendingPathNotifications.entries());
    pendingPathNotifications.clear();
    pending.forEach(([listener, payload]) => {
      listener(payload);
    });
  }

  immediateSubscribe((event) => {
    if (!event) {
      return;
    }
    const changedPath = typeof event.path === "string" ? event.path : "";
    pathSubscribers.forEach((listenersForPath, subscriptionPath) => {
      if (!matchesPath(subscriptionPath, changedPath)) {
        return;
      }
      listenersForPath.forEach((listener) => {
        pendingPathNotifications.set(listener, {
          path: changedPath,
          value: event.value,
          prev: event.prev,
          state: moundState.state
        });
      });
    });
    if (!pendingPathFlush) {
      pendingPathFlush = true;
      queueMicrotask(flushPathSubscribers);
    }
  });

  let pendingWorkerSync = false;
  immediateSubscribe(() => {
    if (getApplyingWorkerPatch()) {
      return;
    }
    if (getWorkerMode() === "full") {
      return;
    }
    if (pendingWorkerSync) {
      return;
    }
    pendingWorkerSync = true;
    queueMicrotask(() => {
      pendingWorkerSync = false;
      const workerBridge = getWorkerBridge();
      if (workerBridge && typeof workerBridge.sync === "function") {
        workerBridge.sync(moundState.state);
      }
    });
  });

  moundState.subscribeImmediate = immediateSubscribe;
  moundState.subscribe = function subscribe(listener) {
    if (typeof listener !== "function") {
      return function noop() {};
    }
    let queued = false;
    let latestEvent = null;
    const unbind = immediateSubscribe((event) => {
      latestEvent = event;
      if (queued) {
        return;
      }
      queued = true;
      queueMicrotask(() => {
        queued = false;
        listener(latestEvent);
      });
    });
    return function unsubscribe() {
      unbind();
    };
  };

  moundState.subscribePath = function subscribePath(path, listener) {
    if (typeof listener !== "function") {
      return function noop() {};
    }
    const key = typeof path === "string" && path.length ? path : "*";
    if (!pathSubscribers.has(key)) {
      pathSubscribers.set(key, new Set());
    }
    pathSubscribers.get(key).add(listener);
    return function unsubscribePath() {
      const bucket = pathSubscribers.get(key);
      if (!bucket) {
        return;
      }
      bucket.delete(listener);
      if (bucket.size === 0) {
        pathSubscribers.delete(key);
      }
    };
  };

})();

if (typeof window !== "undefined" && exportedGameState) {
  window.state = exportedGameState;
  window.gameState = exportedGameState;
}

export const gameState = exportedGameState;
export const moundState = exportedMoundState;

export function loadStateFromLocalStorage() {
  if (!exportedMoundState || typeof exportedMoundState.setState !== "function") {
    return false;
  }
  const parsed = readPersistedStateSnapshot();
  if (!parsed) {
    return false;
  }
  exportedMoundState.setState((draft) => {
    mergeSavedState(draft, parsed);
    // Transient UI state — never survive a page reload.  If auto-save
    // fired during endCombat's 5 s countdown it may have persisted
    // isLocked / endingActive, which would block combat initialisation
    // on the next load (boss fight stuck at "系统稳定中").
    if (draft.flags) {
      draft.flags.endingActive = false;
      draft.flags.endingIsDefeat = false;
      draft.flags.endingIsEvac = false;
    }
    if (draft.combat) {
      draft.combat.isLocked = false;
    }
  });
  return true;
}
