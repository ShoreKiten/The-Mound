import { gameState, moundState } from "./state.js";
import {
  pullEventTextById,
  appendLiveLogEntry,
  MAX_LOG_LINES as UI_MAX_LOG_LINES
} from "../ui/components/log.js";
import { saveGame } from "./storage.js";
import { showMajorDecision } from "../ui/bridge.js";
import { applyResourceTickStep } from "../systems/economy/index.js";
import { canAfford as economyCanAfford, deduct as economyDeduct } from "../systems/economy/manager.js";
import { getBuildingCost } from "../data/building-data.js";
/** Expedition + encounter pipeline (canonical; do not import removed `expedition/runtime.js`). */
import {
  getExpeditionDistance as resolveExpeditionDistance,
  resolveMaxThrustLimit as resolveExpeditionMaxThrust,
  runExpeditionDistanceChecks,
  runExpeditionEncounterStep
} from "../systems/expedition/ExpeditionSystem.js";
import {
  isCombatLockActive,
  tryTriggerCombatEncounter,
  engageCombat,
  fleeCombat
} from "../systems/expedition/CombatManager.js";
import {
  getWorkerBridge,
  getWorkerMode,
  setWorkerMode,
  getLogicTickMs,
  getUiApi,
  scheduleUiRender,
  getUiSpaceApi,

  setEngineApi
} from "./runtime-hooks.js";
import { syncColonyCapacityInDraft } from "../systems/colony-cap.js";

let moundEngineApi = null;

(() => {
const { setState } = moundState;
const state = gameState;
const storage = {
  saveGame
};

let tickHandle = null;
let drifterTimer = null;
let tickCount = 0;
let lastFeedLogTick = -60;
let lastExpeditionTickAt = 0;
let lastDistanceEventCheckAt = 0;
let lastPowerBalanceDebugAt = 0;
let lastPowerSampleForDebug = null;
let isAutomationLoggingEnabled = false;
let usingWorkerHeart = false;
let workerFallbackTriggered = false;
let lastAutoSaveAt = 0;
let uiTickSyncQueued = false;
const MAX_LOG_LINES = UI_MAX_LOG_LINES || 12;
const AUTO_SAVE_INTERVAL_MS = 60000;
const logThrottleMs = 2500;
const logThrottleAt = {
  miningCrash: 0,
  miningShield: 0
};

/** Last `Math.floor(expeditionKm / 3000)` seen by the combat watchdog (fail-safe encounter lane). */
let expeditionWatchdogBoundaryIndex = null;

/** Set to true after the first combat trigger attempt at >=100k to avoid repeated ghosting. */
let expedition100kCombatPrimed = false;

/** Previous expedition km on worker-heart ticks (for `runExpeditionEncounterStep` prev/next). */
let lastWorkerSyncedExpeditionKm = null;

function syncGlobalStateBridge() {
  if (typeof window !== "undefined") {
    window.gameState = state;
  }
}

function queueUiTickSync() {
  if (uiTickSyncQueued) {
    return;
  }
  uiTickSyncQueued = true;
  scheduleUiRender(() => {
    uiTickSyncQueued = false;
    syncGlobalStateBridge();
    const uiApi = getUiApi();
    if (uiApi && typeof uiApi.renderAll === "function") {
      uiApi.renderAll();
    }
  });
}

function isDevAuditMode() {
  if (typeof window === "undefined") {
    return false;
  }
  if (window.__MOUND_DEV_AUDIT__ === true || window.__MOUND_DEV_MODE__ === true) {
    return true;
  }
  const host = window.location && typeof window.location.hostname === "string"
    ? window.location.hostname
    : "";
  return host === "localhost" || host === "127.0.0.1";
}

function getLogText(entry) {
  if (typeof entry === "string") {
    return entry;
  }
  if (entry && typeof entry === "object" && typeof entry.text === "string") {
    return entry.text;
  }
  return "";
}

function isCriticalLog(entry) {
  const text = getLogText(entry);
  return text.startsWith("[紧急]") || text.startsWith("[关键]");
}

function trimLogsQueue(logs) {
  if (!Array.isArray(logs) || logs.length <= MAX_LOG_LINES) {
    return;
  }
  while (logs.length > MAX_LOG_LINES) {
    let removeIndex = logs.length - 1;
    while (removeIndex >= 0 && isCriticalLog(logs[removeIndex])) {
      removeIndex -= 1;
    }
    if (removeIndex < 0) {
      logs.pop();
    } else {
      logs.splice(removeIndex, 1);
    }
  }
}

class CooldownManager {
  constructor(durationMs) {
    this.durationMs = durationMs;
    this.running = false;
    this.rafId = 0;
    this.startAt = 0;
    this.onTick = () => {};
    this.onDone = () => {};
  }

  start(onTick, onDone) {
    if (this.running) {
      return false;
    }
    this.running = true;
    this.startAt = performance.now();
    this.onTick = onTick || (() => {});
    this.onDone = onDone || (() => {});
    const step = (now) => {
      if (!this.running) {
        return;
      }
      const elapsed = now - this.startAt;
      const progress = Math.min(1, elapsed / this.durationMs);
      this.onTick(progress);
      if (progress >= 1) {
        this.running = false;
        this.onDone();
        return;
      }
      this.rafId = requestAnimationFrame(step);
    };
    this.rafId = requestAnimationFrame(step);
    return true;
  }

  reset() {
    this.running = false;
    cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    this.onTick(0);
  }
}

function addLog(payload, color) {
  const text = typeof payload === "string" ? payload : payload.text;
  const tint = typeof payload === "object" && typeof payload.color === "string"
    ? payload.color
    : (typeof color === "string" ? color : "");
  if (!text) {
    return;
  }
  const distance = getExpeditionDistance(state);
  if (distance < 2000 && (text.startsWith("[警告]") || text.startsWith("[紧急]"))) {
    return;
  }
  if (text.startsWith("[工厂]") && !isAutomationLoggingEnabled) {
    return;
  }
  if (state.systems.expedition.active) {
    const allowedPrefixes = [
      "[航向]",
      "[雷达]",
      "[警告]",
      "[发现]",
      "[环境]",
      "[生命探测]",
      "[系统]",
      "[广播]",
      "[突发事件]",
      "[监测]",
      "[异常]",
      "[补给]",
      "[决策]",
      "[提示]",
      "[控制台]"
    ];
    const allowed = allowedPrefixes.some((prefix) => text.startsWith(prefix));
    if (!allowed) {
      return;
    }
  }
  if (typeof payload === "object" && payload.once && payload.id) {
    const triggered = Array.isArray(state.triggeredEvents) ? state.triggeredEvents : [];
    if (triggered.includes(payload.id)) {
      return;
    }
    setState((draft) => {
      if (!Array.isArray(draft.triggeredEvents)) {
        draft.triggeredEvents = [];
      }
      draft.triggeredEvents.push(payload.id);
    });
  }
  const now = Date.now();
  if (text.includes("轨道采集器 #") && text.includes("结构已解体")) {
    if (now - logThrottleAt.miningCrash < logThrottleMs) {
      return;
    }
    logThrottleAt.miningCrash = now;
  } else if (text.includes("强化护盾拦截了一次微流星冲击")) {
    if (now - logThrottleAt.miningShield < logThrottleMs) {
      return;
    }
    logThrottleAt.miningShield = now;
  }
  setState((draft) => {
    draft.logs.unshift(tint ? { text, color: tint } : text);
    trimLogsQueue(draft.logs);
  });
  appendLiveLogEntry(
    {
      id: typeof payload === "object" && payload && typeof payload.id === "string" ? payload.id : "",
      text,
      color: tint
    },
    50
  );
}

function markManualResourceUiSync(draft) {
  draft.systems = draft.systems || {};
  draft.systems.ui = draft.systems.ui || {};
  draft.systems.ui.manualActionFlag = true;
  draft.systems.ui.manualActionTriggered = true;
}

function tryAutoSave(now = Date.now()) {
  if (!lastAutoSaveAt || (now - lastAutoSaveAt) >= AUTO_SAVE_INTERVAL_MS) {
    storage.saveGame();
    lastAutoSaveAt = now;
  }
}

function setAutomationLoggingEnabled(enabled) {
  isAutomationLoggingEnabled = !!enabled;
  setState((draft) => {
    draft.systems.ui.automationLoggingEnabled = isAutomationLoggingEnabled;
  });
}

function techSystem() {
  return window.MoundSystems && window.MoundSystems.tech ? window.MoundSystems.tech : null;
}

function resolveMaxThrustLimit(snapshot) {
  return resolveExpeditionMaxThrust(snapshot || state || {});
}

function getCyclePowerFactor() {
  const tech = techSystem();
  if (!tech || typeof tech.getCyclePowerFactor !== "function") {
    return 1;
  }
  return tech.getCyclePowerFactor(state);
}

function getMiningOutputFactor() {
  const tech = techSystem();
  if (!tech || typeof tech.getMiningOutputFactor !== "function") {
    return 1;
  }
  return tech.getMiningOutputFactor(state);
}

function getHazardRollChance(baseChance = 0.6) {
  const tech = techSystem();
  const reduction = tech && typeof tech.getShieldReduction === "function" ? tech.getShieldReduction(state) : 0;
  const mod = typeof state.disasterChanceMod === "number" ? state.disasterChanceMod : 1;
  return Math.max(0.05, baseChance * (1 - reduction) * mod);
}

function isAutomationFaultActive(now) {
  return (state.systems.automationFaultUntil || 0) > now;
}

function expeditionSpeedPerSec() {
  const exp = state.systems.expedition;
  const baseUnit = 4;
  const maxThrust = resolveMaxThrustLimit(state);
  const throttle = Math.max(0, Math.min(maxThrust, exp.throttle || 0));
  const baseSpeed = baseUnit * throttle;
  const anomalyBoost = exp.nextSpeedBoost > 0 ? 1.15 : 1;
  const eff = typeof state.thrustEfficiency === "number" ? state.thrustEfficiency : 1;
  const fusionCount = Math.max(0, Number(state.fusionGenerators || (state.structures && state.structures.fusionGenerator) || 0));
  const hasFusionFuel = Number(state.resources && state.resources.helium3 ? state.resources.helium3 : 0) > 0;
  const techMultiplier = hasFusionFuel && fusionCount >= 1 ? 2 : 1;
  const eventMultiplier = exp.overdrive ? 1.25 : anomalyBoost;
  let speed = baseSpeed * eff * techMultiplier * eventMultiplier;
  // Safety: guard against NaN/Infinity
  if (typeof speed !== "number" || !Number.isFinite(speed)) { speed = 0; }
  // When throttle > 0, ensure at least a small positive speed to prevent deadlock
  if (throttle > 0 && speed <= 0) { speed = baseUnit * 0.1; }
  return Math.max(0, speed);
}

function expeditionPowerLoadPerSec(now) {
  if (!state.systems.expedition.active) {
    return 0;
  }
  const maxThrust = resolveMaxThrustLimit(state);
  const throttle = Math.max(0, Math.min(maxThrust, state.systems.expedition.throttle || 0));
  if (throttle <= 0) {
    return 0;
  }
  const stormOn = state.systems.expedition.magneticStormUntil > now;
  const stormFactor = stormOn ? 2 : 1;
  const propulsionBaseCost = 50;
  const eff = state.upgrades && typeof state.upgrades.powerEfficiency === "number" ? state.upgrades.powerEfficiency : 1;
  const usage = typeof state.powerUsageMod === "number" ? state.powerUsageMod : 1;
  return propulsionBaseCost * (throttle ** 1.5) * stormFactor * eff * usage;
}

function expeditionHe3LoadPerSec() {
  if (!state.systems.expedition.active) {
    return 0;
  }
  const maxThrust = resolveMaxThrustLimit(state);
  const throttle = Math.max(0, Math.min(maxThrust, state.systems.expedition.throttle || 0));
  if (throttle <= 5) {
    return 0;
  }
  const usage = typeof state.he3UsageMod === "number" ? state.he3UsageMod : 1;
  return throttle * 0.1 * usage;
}

function getExpeditionDistance(sourceState = state) {
  return resolveExpeditionDistance(sourceState || state);
}

function checkDistanceEvents() {
  runExpeditionDistanceChecks(state, setState, addLog);
}

function isCombatSystemUnlocked(sourceState = state) {
  const flags = sourceState && sourceState.flags ? sourceState.flags : {};
  return !!flags.combatSystemUnlocked;
}

function triggerRedAlert100k() {
  if (isCombatSystemUnlocked(state)) {
    return false;
  }
  setState((draft) => {
    draft.flags = draft.flags || {};
    draft.flags.combatSystemUnlocked = true;
    if (typeof draft.flags.combatReadiness !== "number") {
      draft.flags.combatReadiness = 0;
    }
    draft.systems = draft.systems || {};
    draft.systems.tech = draft.systems.tech || {};
    draft.systems.tech.singularityUnlocked = true;
    draft.systems.ui = draft.systems.ui || {};
    draft.systems.ui.pendingDecision = true;
    draft.systems.ui.pendingDecisionMilestone = 100000;
    draft.systems.expedition = draft.systems.expedition || {};
    draft.systems.expedition.active = false;
    draft.systems.expedition.overdrive = false;
    draft.systems.expedition.throttle = 0;
    draft.isEventActive = true;
    draft.thrustMultiplier = 1;
  });
  if (typeof document !== "undefined" && document.body) {
    document.body.classList.add("alert-red-mode");
  }
  showMajorDecision(100000);
  addLog("[决策] 不明生物反应确认：战术系统已强制激活。");
  return true;
}

function scanNearbySector() {
  const exp = state.systems.expedition || {};
  if ((exp.distanceKm || 0) < (exp.scanBlockedUntilKm || 0)) {
    addLog("[异常] 扫描链路仍受干扰，暂时无法执行扫描。");
    return false;
  }
  const emergencyMode = state.resources.power < 500 && (exp.drifting || (exp.throttle || 0) <= 1);
  if (state.resources.power < 500 && !emergencyMode) {
    return false;
  }
  if (emergencyMode && Math.random() < 0.5) {
    setState((draft) => {
      draft.resources.power += 1000;
      draft.systems.expedition.drifting = false;
    });
    addLog("[发现] 扫描到废弃电池组，主电网回充 +1000。");
    return true;
  }
  const roll = Math.random();
  setState((draft) => {
    draft.resources.power = Math.max(0, draft.resources.power - 500);
    draft.systems.expedition.scanned = true;
  });
  if (roll < 0.3) {
    const resourceRoll = Math.random();
    if (resourceRoll < 0.34) {
      setState((draft) => {
        draft.resources.scrapMetal += 100;
      });
      addLog("[发现] 发现漂浮货箱。废金属 +100。");
    } else if (resourceRoll < 0.67) {
      setState((draft) => {
        draft.resources.sealant += 50;
      });
      addLog("[发现] 发现漂浮货箱。密封剂 +50。");
    } else {
      setState((draft) => {
        draft.resources.alloy += 20;
      });
      addLog("[发现] 发现漂浮货箱。合金 +20。");
    }
  } else if (roll < 0.5) {
    setState((draft) => {
      draft.systems.productionSpeedBonusPct += 0.01;
    });
    addLog("[发现] 发现破损芯片组。全局生产速度 +1%。");
  } else if (roll < 0.65) {
    addLog({ id: "scan-anomaly-whisper", text: pullEventTextById("scan-anomaly-whisper") || "[异常] 它在看着我们...在恒星的阴影里。" });
  } else if (roll < 0.75) {
    const he3Gain = 20 + Math.floor(Math.random() * 31);
    setState((draft) => {
      draft.resources.helium3 += he3Gain;
    });
    addLog({ id: "scan-he3-cloud", text: pullEventTextById("scan-he3-cloud") || "[雷达] 捕获到游离态高能气团，聚变堆反应强度瞬间飙升。" });
    addLog(`[发现] 氦-3回收量 +${he3Gain}。`);
  } else {
    addLog({ id: "scan-broadcast-fragment", text: pullEventTextById("scan-broadcast-fragment") || "[雷达] 扫描到旧时代广播碎片。" });
  }
  return true;
}

function continueVoyageFromSupply() {
  if (!(state.systems && state.systems.ui && state.systems.ui.outpostMenuLocked)) {
    return false;
  }
  setState((draft) => {
    draft.systems = draft.systems || {};
    draft.systems.ui = draft.systems.ui || {};
    draft.systems.expedition = draft.systems.expedition || {};
    const saved = typeof draft.systems.ui.outpostSavedThrust === "number" ? draft.systems.ui.outpostSavedThrust : 1;
    draft.systems.ui.outpostMenuLocked = false;
    draft.systems.ui.outpostSavedThrust = null;
    draft.thrustMultiplier = saved > 0 ? saved : 1;
    draft.systems.expedition.throttle = 0;
    draft.systems.expedition.active = false;
    draft.systems.expedition.overdrive = false;
    draft.systems.expedition.isNavigationLocked = false;
    draft.systems.expedition.status = "IDLE";
    draft.systems.expedition.currentRegion = "补给星区";
    draft.systems.expedition.targetDistance = Math.max(15000, Number(draft.systems.expedition.targetDistance || 0));
  });
  addLog("[航向] 补给坐标已完成交接，航路重开。");
  return true;
}

function scanSupplyAreaAndContinue() {
  const unlocked = continueVoyageFromSupply();
  const scanned = scanNearbySector();
  return unlocked || scanned;
}

function lockExpeditionTarget(target) {
  void target;
  return true;
}

function toggleExpeditionOverdrive() {
  if (!state.systems.expedition.active) {
    return false;
  }
  setState((draft) => {
    draft.systems.expedition.overdrive = !draft.systems.expedition.overdrive;
  });
  addLog(state.systems.expedition.overdrive ? "[航向] 过载推进已开启。" : "[航向] 过载推进已关闭。");
  return true;
}

function setExpeditionThrottle(value) {
  const structures = state.structures || {};
  const preflightReady =
    Number(structures.massProjector || (state.massDriverBuilt ? 1 : 0)) >= 1 &&
    Number(structures.miningMachine || state.miningDrones || 0) >= 1 &&
    Number(structures.fusionGenerator || state.fusionGenerators || 0) >= 1;
  if (!preflightReady) {
    return false;
  }
  if (state.systems.ui.outpostMenuLocked || state.isEventActive || (state.systems.expedition && state.systems.expedition.isNavigationLocked)) {
    return false;
  }
  const maxThrust = resolveMaxThrustLimit(state);
  const next = Math.max(0, Math.min(maxThrust, Math.floor(Number(value) || 0)));
  const workerBridge = getWorkerBridge();
  if (usingWorkerHeart && workerBridge && typeof workerBridge.command === "function") {
    workerBridge.command("SET_THROTTLE", { value: next });
    const uiSpace = getUiSpaceApi();
    if (uiSpace && typeof uiSpace.refreshThrustUI === "function") {
      try {
        uiSpace.refreshThrustUI(next);
      } catch (error) {
        console.warn("[推力UI] 即时刷新失败。", error);
      }
    }
    return true;
  }
  setState((draft) => {
    draft.systems.expedition.throttle = next;
    draft.systems.expedition.overdrive = next > 5;
    draft.systems.expedition.active = next > 0;
    draft.systems.expedition.drifting = false;
    draft.systems.expedition.status = next > 0 ? "VOYAGING" : "IDLE";
    draft.systems.expedition.isNavigationLocked = false;
    if (next > 0 && draft.systems.expedition.nextEventAt <= 0) {
      draft.systems.expedition.nextEventAt = Date.now() + 60000;
    }
  });
  updateRates();
  const uiApi = getUiApi();
  if (uiApi && uiApi.renderAll) {
    uiApi.renderAll();
  }
  const uiSpace = getUiSpaceApi();
  if (uiSpace && typeof uiSpace.refreshThrustUI === "function") {
    try {
      uiSpace.refreshThrustUI(next);
    } catch (error) {
      console.warn("[推力UI] 即时刷新失败。", error);
    }
  }
  return true;
}

function buildMaintenanceCenter() {
  if (!state.blueprints.maintenanceCenter || state.maintenanceCenterBuilt) {
    return false;
  }
  const ok = tryBuildStructure("maintenanceCenter", getBuildingCost("maintenanceCenter"), (draft) => {
    draft.structures = draft.structures || {};
    draft.maintenanceCenterBuilt = true;
    draft.structures.maintenanceCenter = 1;
  });
  if (!ok) {
    return false;
  }
  addLog("[发现] 自动维护中心已并入基地后勤体系。");
  return true;
}

function gainStardust() {
  setState((draft) => {
    const mult = draft.upgrades && typeof draft.upgrades.dustRefining === "number" ? draft.upgrades.dustRefining : 1;
    draft.resources.stardust += 1 * mult;
    draft.resources.radiation = Math.min(draft.maxRadiation, draft.resources.radiation + 2);
    markManualResourceUiSync(draft);
  });
  addLog("你拂去舱壁上的尘屑。");
}

function gainScrapMetal() {
  setState((draft) => {
    draft.resources.scrapMetal += 1;
    draft.resources.radiation = Math.min(draft.maxRadiation, draft.resources.radiation + 1);
    markManualResourceUiSync(draft);
  });
  addLog("你从废墟里撬出可用金属。");
}

function forgeSealant() {
  if (state.resources.stardust < 5 || state.resources.scrapMetal < 2) {
    return false;
  }
  setState((draft) => {
    draft.resources.stardust -= 5;
    draft.resources.scrapMetal -= 2;
    draft.resources.sealant += 1;
    markManualResourceUiSync(draft);
  });
  addLog("材料被加热。");
  return true;
}

function activateReactorCore() {
  if (state.resources.scrapMetal < 10) {
    return false;
  }
  setState((draft) => {
    draft.resources.reactorCore = 1;
    draft.resources.scrapMetal -= 10;
    draft.resources.power += 10;
    draft.ReactorCoreActive = true;
    draft.systems.reactorActive = true;
    draft.systems.automationHalted = false;
    draft.systems.reactorShutdownLogged = false;
    markManualResourceUiSync(draft);
  });
  addLog("核心在嗡鸣。");
  return true;
}

function repairVault() {
  if (state.resources.sealant < 10 || state.isVaultRepaired) {
    return false;
  }
  setState((draft) => {
    draft.resources.sealant -= 10;
    draft.isVaultRepaired = true;
    if (!draft.systems.vaultRepairLogWritten) {
      draft.logs.unshift("气密门已关闭。呼吸声变重了。");
      trimLogsQueue(draft.logs);
      draft.systems.vaultRepairLogWritten = true;
    }
    draft.systems.deepSpace = draft.systems.deepSpace || {};
    draft.systems.deepSpace.unlocked = true;
    syncColonyCapacityInDraft(draft);
    markManualResourceUiSync(draft);
  });
  scheduleDrifterArrival();
  storage.saveGame();
  const moduleText = pullEventTextById("electrolyzer-on");
  if (moduleText) {
    addLog(moduleText);
  }
  const uiApi = getUiApi();
  if (uiApi && uiApi.renderAll) {
    uiApi.renderAll();
  }
  checkSystems();
  return true;
}

function manualOxygen() {
  if (!state.isVaultRepaired || state.resources.stardust < 5) {
    return false;
  }
  setState((draft) => {
    draft.resources.stardust -= 5;
    draft.oxygen = Math.min(100, draft.oxygen + 10);
    markManualResourceUiSync(draft);
  });
  const freshText = pullEventTextById("air-fresh");
  if (freshText) {
    addLog(freshText);
  }
  return true;
}

function manualCharge() {
  if (state.resources.stardust < 5) {
    return false;
  }
  setState((draft) => {
    draft.resources.stardust -= 5;
    draft.resources.power += 10;
    if (draft.resources.power > 0) {
      draft.ReactorCoreActive = true;
      draft.systems.reactorActive = true;
      draft.systems.reactorShutdownLogged = false;
    }
    markManualResourceUiSync(draft);
  });
  const uiApi = getUiApi();
  if (uiApi && typeof uiApi.syncResourceBarVisuals === "function") {
    uiApi.syncResourceBarVisuals(true);
  }
  return true;
}

function manualCrank() {
  if (state.resources.power > 5) {
    return false;
  }
  setState((draft) => {
    draft.resources.power += 10;
    if (draft.resources.power > 0) {
      draft.systems.reactorActive = true;
      draft.systems.reactorShutdownLogged = false;
    }
    markManualResourceUiSync(draft);
  });
  addLog("你用力摇动应急发电机手柄，微弱的电流开始在电网中流动。");
  const uiApi = getUiApi();
  if (uiApi && typeof uiApi.syncResourceBarVisuals === "function") {
    uiApi.syncResourceBarVisuals(true);
  }
  return true;
}

function deductResources(draft, cost, structureId = "") {
  draft.resources = draft.resources || {};
  return economyDeduct(draft.resources, cost, structureId);
}

function tryBuildStructure(structureId, cost, applyBuilt) {
  const costMap = cost && typeof cost === "object" ? cost : {};
  const resources = (state && state.resources) || {};
  const canAfford = economyCanAfford(resources, costMap);
  if (!canAfford) {
    economyDeduct(resources, costMap, structureId);
    return false;
  }
  let built = false;
  setState((draft) => {
    const deducted = deductResources(draft, costMap, structureId);
    if (!deducted) {
      return;
    }
    if (typeof applyBuilt === "function") {
      applyBuilt(draft);
    }
    markManualResourceUiSync(draft);
    built = true;
  });
  if (!built) {
    return false;
  }
  const uiApi = getUiApi();
  if (uiApi && typeof uiApi.syncResourceBarVisuals === "function") {
    uiApi.syncResourceBarVisuals(true);
  }
  return true;
}

function deployMagneticArray() {
  const ok = tryBuildStructure("magneticArray", getBuildingCost("magneticArray"), (draft) => {
    draft.structures = draft.structures || {};
    draft.resources.magneticArray += 1;
    draft.arrays += 1;
    draft.structures.magneticArray = draft.arrays;
  });
  if (!ok) {
    return false;
  }
  updateRates();
  return true;
}

function meltIceOre() {
  if (state.resources.iceOre < 1 || !state.isVaultRepaired) {
    return false;
  }
  setState((draft) => {
    draft.resources.iceOre -= 1;
    draft.oxygen = Math.min(100, draft.oxygen + 50);
    markManualResourceUiSync(draft);
  });
  const iceText = pullEventTextById("ice-melt");
  if (iceText) {
    addLog(iceText);
  }
  return true;
}

function runMagneticArray() {
  if (state.arrays <= 0) {
    return;
  }
  setState((draft) => {
    draft.resources.scrapMetal += draft.arrays * 7.2;
  });
}

function autoFeedFurnace() {
  if (state.population <= 0 || state.resources.scrapMetal < 0.2) {
    return;
  }
  if (state.resources.power > 90) {
    return;
  }
  const scrapNeedPerSec = 1 / 5;
  const bonus = state.population >= 5 ? 1.2 : 1.0;
  const powerGainPerSec = state.population * 10 * bonus;
  const scale = Math.min(1, state.resources.scrapMetal / scrapNeedPerSec);
  const actualScrapCost = scrapNeedPerSec * scale;
  const actualPowerGain = powerGainPerSec * scale;
  setState((draft) => {
    draft.resources.scrapMetal = Math.max(0, draft.resources.scrapMetal - actualScrapCost);
    draft.resources.power += actualPowerGain;
    draft.ReactorCoreActive = true;
    draft.systems.reactorActive = true;
    draft.systems.reactorShutdownLogged = false;
  });
  if (tickCount - lastFeedLogTick >= 60) {
    addLog("载员将废料投入熔炉。");
    lastFeedLogTick = tickCount;
  }
}

function upgradeCoreEfficiency() {
  if (state.isEfficiencyUpgraded || state.resources.sealant < 30) {
    return false;
  }
  setState((draft) => {
    draft.resources.sealant -= 30;
    draft.isEfficiencyUpgraded = true;
  });
  return true;
}

function buildIonCatcher() {
  if (state.arrays < 3 || state.resources.sealant < 5) {
    return false;
  }
  const ok = tryBuildStructure("ionCatcher", getBuildingCost("ionCatcher"), (draft) => {
    draft.structures = draft.structures || {};
    draft.ionCatchers += 1;
    draft.structures.ionCatcher = Math.max(Number(draft.structures.ionCatcher || 0), Number(draft.ionCatchers || 0));
  });
  if (!ok) {
    return false;
  }
  return true;
}

function buildRefiningFurnace() {
  if (state.hasRefiningFurnace) {
    return false;
  }
  const ok = tryBuildStructure("refiningFurnace", getBuildingCost("refiningFurnace"), (draft) => {
    draft.structures = draft.structures || {};
    draft.hasRefiningFurnace = true;
    draft.structures.refiningFurnace = 1;
  });
  if (!ok) {
    return false;
  }
  return true;
}

function refineAlloy() {
  if (!state.hasRefiningFurnace) {
    return false;
  }
  if (state.resources.scrapMetal < 20 || state.resources.stardust < 10) {
    return false;
  }
  setState((draft) => {
    draft.resources.scrapMetal -= 20;
    draft.resources.stardust -= 10;
    draft.resources.alloy += 1;
    markManualResourceUiSync(draft);
  });
  return true;
}

function buildAutoSmelter() {
  if (!state.hasRefiningFurnace || state.resources.alloy < 5) {
    return false;
  }
  const ok = tryBuildStructure("autoSmelter", getBuildingCost("autoSmelter"), (draft) => {
    draft.structures = draft.structures || {};
    draft.autoSmelters += 1;
    draft.structures.autoSmelter = Math.max(Number(draft.structures.autoSmelter || 0), Number(draft.autoSmelters || 0));
    if (!draft.lastAutoSmelterAt) {
      draft.lastAutoSmelterAt = Date.now();
    }
  });
  if (!ok) {
    return false;
  }
  updateRates();
  return true;
}

function buildAutoSynthesizer() {
  if (!state.hasRefiningFurnace) {
    return false;
  }
  const ok = tryBuildStructure("autoSynthesizer", getBuildingCost("autoSynthesizer"), (draft) => {
    draft.structures = draft.structures || {};
    draft.autoSynthesizers += 1;
    draft.structures.autoSynthesizer = Math.max(Number(draft.structures.autoSynthesizer || 0), Number(draft.autoSynthesizers || 0));
    if (!draft.lastAutoSynthAt) {
      draft.lastAutoSynthAt = Date.now();
    }
  });
  if (!ok) {
    return false;
  }
  updateRates();
  return true;
}

function buildMassDriver() {
  if (state.massDriverBuilt) {
    return false;
  }
  const ok = tryBuildStructure("massDriver", getBuildingCost("massDriver"), (draft) => {
    draft.structures = draft.structures || {};
    draft.massDriverBuilt = true;
    draft.structures.massProjector = Math.max(Number(draft.structures.massProjector || 0), 1);
    if (!draft.lastMiningCycleAt) {
      draft.lastMiningCycleAt = Date.now();
    }
  });
  if (!ok) {
    return false;
  }
  updateRates();
  return true;
}

function launchMiningDrone() {
  if (!state.massDriverBuilt) {
    return false;
  }
  const ok = tryBuildStructure("miningDrone", getBuildingCost("miningDrone"), (draft) => {
    draft.structures = draft.structures || {};
    draft.miningDrones += 1;
    draft.miners = draft.miningDrones;
    draft.structures.miningMachine = Math.max(Number(draft.structures.miningMachine || 0), Number(draft.miningDrones || 0));
    if (!draft.lastMiningCycleAt) {
      draft.lastMiningCycleAt = Date.now();
    }
  });
  if (!ok) {
    return false;
  }
  updateRates();
  return true;
}

function buildFusionGenerator() {
  if (!state.massDriverBuilt) {
    return false;
  }
  const ok = tryBuildStructure("fusionGenerator", getBuildingCost("fusionGenerator"), (draft) => {
    draft.structures = draft.structures || {};
    draft.fusionGenerators += 1;
    draft.structures.fusionGenerator = Math.max(Number(draft.structures.fusionGenerator || 0), Number(draft.fusionGenerators || 0));
  });
  if (!ok) {
    return false;
  }
  updateRates();
  return true;
}

function runAutoSmelters() {
  if (isAutomationFaultActive(Date.now())) {
    return;
  }
  const cyclePowerFactor = getCyclePowerFactor();
  const smelterPowerCost = 150 * cyclePowerFactor;
  if (state.autoSmelters <= 0) {
    return;
  }
  if (state.resources.power <= 60) {
    return;
  }
  if (state.resources.scrapMetal < 12 || state.resources.stardust < 10 || state.resources.power < smelterPowerCost) {
    return;
  }
  setState((draft) => {
    const workforceBonus = draft.population > 5 ? 1 + (draft.population - 5) * 0.2 : 1;
    const globalBonus = 1 + (draft.systems.productionSpeedBonusPct || 0);
    let runs = draft.autoSmelters;
    let produced = 0;
    while (
      runs > 0 &&
      draft.resources.scrapMetal >= 12 &&
      draft.resources.stardust >= 10 &&
      draft.resources.power >= smelterPowerCost &&
      draft.resources.power > 60
    ) {
      draft.resources.scrapMetal -= 12;
      draft.resources.stardust -= 10;
      draft.resources.power -= smelterPowerCost;
      produced += 1;
      runs -= 1;
    }
    if (produced > 0) {
      draft.resources.alloy += produced * workforceBonus * globalBonus;
    }
  });
  addLog("[工厂] 合金模组完成了一次自动熔炼。");
}

function runAutoSynthesizers() {
  if (isAutomationFaultActive(Date.now())) {
    return;
  }
  if (state.autoSynthesizers <= 0) {
    return;
  }
  if (state.resources.power < 20) {
    return;
  }
  const powerCost = (state.population >= 5 ? 2 : 8) * getCyclePowerFactor();
  setState((draft) => {
    const workforceBonus = draft.population > 5 ? 1 + (draft.population - 5) * 0.2 : 1;
    const globalBonus = 1 + (draft.systems.productionSpeedBonusPct || 0);
    let runs = draft.autoSynthesizers;
    let produced = 0;
    while (
      runs > 0 &&
      draft.resources.stardust >= 5 &&
      draft.resources.power >= powerCost
    ) {
      draft.resources.stardust -= 5;
      draft.resources.power -= powerCost;
      produced += 1;
      runs -= 1;
    }
    if (produced > 0) {
      draft.resources.sealant += produced * workforceBonus * globalBonus;
    }
  });
}

function processAutoSystems(now) {
  const smelterInterval = 10000;
  const synthInterval = 5000;

  if (state.autoSmelters > 0) {
    if (!state.lastAutoSmelterAt) {
      setState((draft) => {
        draft.lastAutoSmelterAt = now;
      });
    } else {
      while (now - state.lastAutoSmelterAt >= smelterInterval) {
        runAutoSmelters();
        setState((draft) => {
          draft.lastAutoSmelterAt += smelterInterval;
        });
      }
    }
  }

  if (state.autoSynthesizers > 0) {
    if (!state.lastAutoSynthAt) {
      setState((draft) => {
        draft.lastAutoSynthAt = now;
      });
    } else {
      while (now - state.lastAutoSynthAt >= synthInterval) {
        runAutoSynthesizers();
        setState((draft) => {
          draft.lastAutoSynthAt += synthInterval;
        });
      }
    }
  }
}

function processMiningDrones(now) {
  if (!state.massDriverBuilt || state.miningDrones <= 0) {
    setState((draft) => {
      draft.systems.miningProgressMs = 0;
      draft.systems.miningProgressPct = 0;
    });
    return;
  }
  const interval = 30000;
  if (!state.lastMiningCycleAt) {
    setState((draft) => {
      draft.lastMiningCycleAt = now;
      draft.systems.miningProgressMs = 0;
      draft.systems.miningProgressPct = 0;
    });
    return;
  }
  const deltaMs = Math.max(0, now - state.lastMiningCycleAt);
  const efficiency = state.resources.power > 0 ? 1 : 0.1;
  setState((draft) => {
    draft.lastMiningCycleAt = now;
    draft.systems.miningProgressMs += deltaMs * efficiency;
    draft.systems.miningProgressPct = Math.min(100, (draft.systems.miningProgressMs / interval) * 100);
  });

  if (state.systems.miningProgressMs >= interval) {
    let losses = 0;
    let shieldIntercepted = false;
    setState((draft) => {
      const runtime = window.MoundEventRuntime || {};
      const result =
        typeof runtime.rollMiningDroneDamage === "function"
          ? runtime.rollMiningDroneDamage(draft, draft.systems.maintenanceActive)
          : { destroyed: 0, blocked: false };
      losses = Math.max(0, Math.min(1, result.destroyed || 0));
      shieldIntercepted = !!result.blocked;
      if (losses > 0) {
        const currentMiners =
          typeof gameState.miners === "number"
            ? gameState.miners
            : draft.miningDrones;
        if (currentMiners > 0) {
          draft.miningDrones = Math.max(0, draft.miningDrones - 1);
          draft.miners = draft.miningDrones;
        } else {
          losses = 0;
        }
      }
      draft.miners = draft.miningDrones;
      draft.systems.miningProgressMs = Math.max(0, draft.systems.miningProgressMs - interval);
      draft.systems.miningProgressPct = Math.min(100, (draft.systems.miningProgressMs / interval) * 100);
    });
    if (losses > 0) {
      const idx = state.miningDrones + 1;
      addLog(`[警告] 轨道采集器 #${idx} 遭遇高能星际物质撞击，结构已解体。`);
      console.error("[警告] 轨道采集器失去信号。");
      updateRates();
      return;
    }
    if (shieldIntercepted) {
      const spaceSystem = window.MoundSystems && window.MoundSystems.space;
      const silenceShieldLog =
        !!(spaceSystem && typeof spaceSystem.shouldSilenceShieldInterceptLog === "function" &&
        spaceSystem.shouldSilenceShieldInterceptLog(state));
      if (!silenceShieldLog) {
        addLog("[提示] 强化护盾拦截了一次微流星冲击，采矿作业继续。");
      }
      return;
    }
    const cycleGain = Math.max(
      0,
      Math.round(((state.netRates && state.netRates.helium3) || 0) * (interval / 1000))
    );
    if (cycleGain > 0) {
      setState((draft) => {
        draft.systems.ui.he3FlashGain = cycleGain;
        draft.systems.ui.he3FlashUntil = now + 1200;
      });
    }
  }
}

/**
 * Same-tick fail-safe after `distanceKm` is advanced on the main thread (draft-safe).
 * Uses `draft.systems.expedition._lastBoundary` to mirror the user's boundary latch.
 */
function applyForcedDistanceCombatHook(draft) {
  draft.systems = draft.systems || {};
  draft.systems.expedition = draft.systems.expedition || {};
  const dkm = Math.floor(Number(draft.systems.expedition.distanceKm) || 0);
  if (dkm < 100000) {
    return;
  }
  draft.flags = draft.flags || {};
  if (!draft.flags.combatSystemUnlocked) {
    return;
  }
  const boundary = Math.floor(dkm / 3000);
  const prevRaw = draft.systems.expedition._lastBoundary;
  const prev = typeof prevRaw === "number" && !Number.isNaN(prevRaw) ? prevRaw : -1;
  if (boundary <= prev) {
    return;
  }
  draft.systems.expedition._lastBoundary = boundary;
}

let combatWatchdogFiredThisTick = false;

function runExpeditionCombatWatchdog() {
  const rawKm = getExpeditionDistance(state);
  const dist = Math.floor(Number(rawKm) || 0);
  const currentBoundary = Math.floor(dist / 3000);
  const showCombatModal = !!(state.systems && state.systems.ui && state.systems.ui.showCombatModal);
  const combatLocked = isCombatLockActive(state);
  const combatUnlocked = isCombatSystemUnlocked(state);
  const isAtEncounterBoundary =
    dist >= 100000 &&
    combatUnlocked &&
    currentBoundary > (expeditionWatchdogBoundaryIndex || 0) &&
    !expedition100kCombatPrimed === false; // first crossing of 100k

  // Strict guard: only ONE encounter per 3000km boundary, never when modal is active
  if (showCombatModal || combatLocked || combatWatchdogFiredThisTick) {
    expeditionWatchdogBoundaryIndex = Math.max(expeditionWatchdogBoundaryIndex || 0, currentBoundary);
    if (dist >= 100000) expedition100kCombatPrimed = true;
    return;
  }

  if (!combatUnlocked || dist < 100000) {
    expeditionWatchdogBoundaryIndex = currentBoundary;
    expedition100kCombatPrimed = false;
    return;
  }

  // Initialize boundary tracking on first qualifying tick
  if (expeditionWatchdogBoundaryIndex === null || expeditionWatchdogBoundaryIndex === undefined) {
    expeditionWatchdogBoundaryIndex = currentBoundary;
    expedition100kCombatPrimed = true;
    return;
  }

  // Ghosting fix: force trigger on first tick crossing 100k
  if (!expedition100kCombatPrimed) {
    expedition100kCombatPrimed = true;
    expeditionWatchdogBoundaryIndex = currentBoundary;
  } else if (currentBoundary <= expeditionWatchdogBoundaryIndex) {
    return;
  }

  // === Only trigger if we crossed a new 3000km boundary ===
  combatWatchdogFiredThisTick = true;
  expeditionWatchdogBoundaryIndex = currentBoundary;
  const boundaryKm = currentBoundary * 3000;

  const opened = tryTriggerCombatEncounter(state, setState, addLog, boundaryKm, {
    immediateEngage: false,
    focusTacticalDeck: true
  });


  if (typeof window !== "undefined") {
  }}

function processExpedition(now, dtSec) {
  combatWatchdogFiredThisTick = false;
  runExpeditionCombatWatchdog();
  const exp = state.systems.expedition;
  const pendingDecisionMilestone = state.systems && state.systems.ui
    ? Number(state.systems.ui.pendingDecisionMilestone || 0)
    : 0;
  if (state.isEventActive && pendingDecisionMilestone > 0) {
    showMajorDecision(pendingDecisionMilestone);
    return;
  }
  // ========== pauseUntil 处理（保存档位，恢复档位）==========
  if ((exp.pauseUntil || 0) > now) {
    // 暂停中：保存用户设定的档位，然后临时强制停推
    setState((draft) => {
      const currentThrottle = Number(draft.systems.expedition.throttle || 0);
      // 只在第一次暂停时保存原始档位（避免每次 tick 覆盖）
      if (!draft.systems.expedition._savedThrottle) {
        draft.systems.expedition._savedThrottle = currentThrottle;
      }
      draft.systems.expedition.throttle = 0;
      draft.systems.expedition.active = false;
    });
    return;
  }
  // 暂停已到期：恢复用户保存的档位
  if ((exp.pauseUntil || 0) > 0 && (exp.pauseUntil || 0) <= now && !state.isEventActive) {
    setState((draft) => {
      const saved = Number(draft.systems.expedition._savedThrottle || 0);
      draft.systems.expedition.pauseUntil = 0;
      draft.systems.expedition._savedThrottle = 0;
      if (saved > 0) {
        draft.systems.expedition.throttle = saved;
        draft.systems.expedition.active = true;
      } else {
        // 没有保存值，至少不强制保持 0
        draft.systems.expedition.active = (draft.systems.expedition.throttle || 0) > 0;
      }
    });
  }
  const failSafeDistance = getExpeditionDistance(state);
  if (failSafeDistance >= 100000 && !isCombatSystemUnlocked(state)) {
    triggerRedAlert100k();
    return;
  }
  if (!exp.active) {
    return;
  }
  if (isCombatLockActive(state)) {
    // 战斗锁定期间：保存用户档位（仅第一次），临时停推，绝不永久丢失用户设定
    setState((draft) => {
      draft.systems.expedition = draft.systems.expedition || {};
      const t = Number(draft.systems.expedition.throttle || 0);
      if (!draft.systems.expedition._savedThrottle && t > 0) {
        draft.systems.expedition._savedThrottle = t;
      }
      draft.systems.expedition.throttle = 0;
    });
    return;
  }
  // 战斗锁定结束后，如果有保存的档位则恢复（且不在 pauseUntil 暂停期间）
  if (state.systems.expedition._savedThrottle && !isCombatLockActive(state) && !((exp.pauseUntil || 0) > now)) {
    setState((draft) => {
      const saved = Number(draft.systems.expedition._savedThrottle || 0);
      if (saved > 0) {
        draft.systems.expedition.throttle = saved;
        draft.systems.expedition.active = true;
      }
      draft.systems.expedition._savedThrottle = 0;
    });
  }

  const maxThrust = resolveMaxThrustLimit(state);
  const throttle = Math.max(0, Math.min(maxThrust, exp.throttle || 0));
  if (throttle <= 0) {
    return;
  }
  const he3Need = expeditionHe3LoadPerSec();
  if (state.resources.power <= 0) {
    // 电力耗尽时标记漂移状态，但绝不篡改用户设定的档位（throttle）
    // 保持原有的 throttle/overdrive 不变，让漂移速度仍由用户设定的档位决定
    setState((draft) => {
      draft.systems.expedition.active = true;
      draft.systems.expedition.drifting = true;
    });
  }
  if (he3Need > 0 && state.resources.helium3 < he3Need) {
    setState((draft) => {
      draft.systems.expedition.throttle = 5;
      draft.systems.expedition.overdrive = false;
    });
    addLog("[警告] 过载推进燃料耗尽，已回退到常规推进。");
  }

  // 日志监控：档位、计算速度、电力消耗、每帧增量
  const speed = expeditionSpeedPerSec();
  const prevExpeditionKm = getExpeditionDistance(state);
  setState((draft) => {
    draft.systems.expedition.distanceKm += speed * dtSec;
    draft.isAdventureReady = draft.systems.expedition.distanceKm >= 2000;
    if (draft.systems.expedition.nextSpeedBoost > 0) {
      draft.systems.expedition.nextSpeedBoost = 0;
    }
    const wobble = (Math.random() - 0.5) * 0.8;
    draft.resources.radiation = Math.max(0, Math.min(draft.maxRadiation, draft.resources.radiation + wobble));
    applyForcedDistanceCombatHook(draft);
  });

  // 强制同步 UI 渲染
  const uiApi = getUiApi();
  if (uiApi && typeof uiApi.renderAll === "function") {
    uiApi.renderAll(true);
  }

  const currentDistance = getExpeditionDistance(state);
  if (currentDistance <= 0) {
    return;
  }

  // Sanity check: if the player is before the boss threshold, omegaDefeated must be
  // eligible for reset.  This guards against a stale flag surviving a time-anchor rollback.
  if (currentDistance < 200000 && state.flags && state.flags.omegaDefeated) {
    setState((draft) => {
      draft.flags.omegaDefeated = false;
      draft.flags.omegaSlayer = false;
    });
  }

  runExpeditionEncounterStep(state, setState, addLog, prevExpeditionKm, currentDistance, dtSec);

  const nextRandomTargetKm = Number(exp.nextRandomEventKm || 0);
  const isDistanceEventDue = nextRandomTargetKm > 0 && currentDistance >= nextRandomTargetKm;
  if (isDistanceEventDue || (now - lastDistanceEventCheckAt) >= 1000) {
    checkDistanceEvents();
    lastDistanceEventCheckAt = now;
  }

  const majorRuntime = window.MoundEventRuntime || {};
  const majorTriggered =
    typeof majorRuntime.tryActivateMajorDecision === "function"
      ? majorRuntime.tryActivateMajorDecision(state, setState, (milestone) => {
        showMajorDecision(milestone);
      })
      : false;
  if (majorTriggered) {
    addLog("[决策] 深空里程碑事件已触发，等待指挥授权。");
    return;
  }

  const runtime = window.MoundEventRuntime || {};
  const outpostTriggered =
    typeof runtime.applyOutpostEncounter === "function"
      ? runtime.applyOutpostEncounter(state, setState, () => {
        const uiApi = getUiApi();
        if (uiApi && typeof uiApi.showOutpostMenu === "function") {
          uiApi.showOutpostMenu();
        }
      })
      : false;
  if (outpostTriggered) {
    addLog("[航向] 已抵达补给坐标。主推进已切断。");
    addLog("[补给] 回收到哨站库存，合金 +1000。");
    storage.saveGame();
    const uiApi = getUiApi();
    if (uiApi && uiApi.renderAll) {
      uiApi.renderAll();
    }
  }

  if (currentDistance >= exp.nextMilestoneKm) {
    setState((draft) => {
      draft.systems.expedition.nextMilestoneKm += 10000;
    });
    addLog("[环境] 船舷窗外，巨大的星际尘埃云正在缓慢划过。");
  }

  const spaceSystem = window.MoundSystems && window.MoundSystems.space ? window.MoundSystems.space : null;
  const hitTenK = spaceSystem && typeof spaceSystem.shouldTriggerTenKMilestone === "function"
    ? spaceSystem.shouldTriggerTenKMilestone(Object.assign({}, exp, { distanceKm: currentDistance }))
    : (currentDistance >= 10000 && !exp.milestone10000Reached);
  if (hitTenK) {
    if (spaceSystem && typeof spaceSystem.applyTenKMilestone === "function") {
      spaceSystem.applyTenKMilestone();
    }
    addLog({ id: "milestone-10000", text: pullEventTextById("milestone-10000") || "[关键] 成功回收星火号先遣冷冻荚。载员上限已扩展至 8 人。" });
  }

  if (currentDistance >= 30000 && !exp.milestone30000Reached) {
    setState((draft) => {
      draft.systems.expedition.milestone30000Reached = true;
      draft.systems.productionSpeedBonusPct += 0.1;
    });
    addLog({ id: "milestone-30000", text: pullEventTextById("milestone-30000") || "[环境] 信号背景变得异常纯净，地表的杂音彻底消失了。" });
  }

  if (currentDistance >= 60000 && !exp.milestone60000Reached) {
    setState((draft) => {
      draft.systems.expedition.milestone60000Reached = true;
      draft.systems.expedition.orbitalScanUnlocked = true;
      syncColonyCapacityInDraft(draft);
    });
    addLog({ id: "milestone-60000", text: pullEventTextById("milestone-60000") || "[航向] 雷达捕捉到大型金属构件，这里曾是旧时代的轨道哨所。" });
  }

  if (currentDistance >= 100000 && !exp.milestone100000Reached) {
    const applied100k = spaceSystem && typeof spaceSystem.applyHundredKMilestone === "function"
      ? spaceSystem.applyHundredKMilestone()
      : false;
    if (!applied100k) {
      setState((draft) => {
        draft.systems.expedition.milestone100000Reached = true;
        draft.blueprints.quantumCommArray = true;
      });
    }
    addLog({ id: "milestone-100000", text: pullEventTextById("milestone-100000") || "[发现] 截获一段循环播放的加密坐标，指向更遥远的虚空。" });
  }

  while (true) {
    const gate = window.MoundEventRuntime && typeof window.MoundEventRuntime.shouldRunDisasterCheck === "function"
      ? window.MoundEventRuntime.shouldRunDisasterCheck(state)
      : { shouldRun: currentDistance >= ((state.lastEventMilestone || 0) + 1) * 2000 };
    if (!state.isAdventureReady || !gate.shouldRun) {
      break;
    }
    let shouldTrigger = false;
    setState((draft) => {
      draft.lastEventMilestone += 1;
      draft.systems.expedition.lastEventDistance = (draft.systems.expedition.lastEventDistance || 0) + 2000;
      draft.systems.expedition.nextHazardKm = draft.systems.expedition.lastEventDistance + 2000;
      shouldTrigger = Math.random() < getHazardRollChance(0.6);
    });
    if (!shouldTrigger) {
      continue;
    }
    const roll = Math.random();
    if (roll < 0.05) {
      setState((draft) => {
        draft.systems.decompressionRepairUntil = now + 30000;
        draft.systems.pendingCrewLoss = 1;
        draft.systems.ui.dangerFlashUntil = now + 800;
      });
      addLog({ id: "hazard-crew-loss", text: pullEventTextById("hazard-crew-loss") || "[紧急] 2号隔离舱外壳开裂！请确保有充足合金进行自动加固！" });
    } else if (roll < 0.2) {
      setState((draft) => {
        draft.systems.fusionDebuffUntil = now + 60000;
        draft.systems.ui.dangerFlashUntil = now + 800;
      });
      addLog({ id: "hazard-reactor-overload", text: pullEventTextById("hazard-reactor-overload") || "[警告] 冷却回路发生气锁，发电机组进入低功率保护模式！" });
    } else if (roll < 0.4) {
      setState((draft) => {
        draft.systems.automationFaultUntil = now + 120000;
        draft.systems.ui.dangerFlashUntil = now + 800;
      });
      addLog({ id: "hazard-auto-fault", text: pullEventTextById("hazard-auto-fault") || "[警告] 逻辑总线受到带电粒子冲击，自动化流水线陷入混乱。" });
    } else if (roll < 0.6) {
      setState((draft) => {
        draft.systems.expedition.scanned = false;
        draft.systems.expedition.scanBlockedUntilKm = (draft.systems.expedition.distanceKm || 0) + 5000;
      });
      addLog({ id: "hazard-signal-jam", text: pullEventTextById("hazard-signal-jam") || "[异常] 捕获到强力杂讯干扰，雷达系统完全瘫痪。" });
    } else if (roll < 0.8) {
      setState((draft) => {
        draft.oxygen = Math.min(20, draft.oxygen);
        const dmg = typeof draft.disasterDamageMod === "number" ? draft.disasterDamageMod : 1;
        draft.resources.sealant = Math.max(0, draft.resources.sealant - (50 * dmg));
      });
      addLog({ id: "hazard-pressure-drop", text: pullEventTextById("hazard-pressure-drop") || "[紧急] 3号隔离舱发生泄漏，正在强制注压修复。" });
    }
    // 已触发当前灾害事件，跳出循环以避免单 tick 内连爆多次
    break;
  }

  if (exp.nextEventAt > 0 && now >= exp.nextEventAt) {
    if (!state.isAdventureReady) {
      return;
    }
    const roll = Math.random();
    if (currentDistance >= 150000 && roll < 0.2) {
      addLog("[发现] 外星信号阵列在远端闪烁，频率非人类协议。");
    } else if (currentDistance >= 150000 && roll < 0.35) {
      addLog("[警告] 反物质云团擦过航道，磁护罩进入极限波动。");
    } else if (roll < 0.2) {
      setState((draft) => {
        draft.resources.scrapMetal += 120;
      });
      addLog("[雷达] 打捞到高密度太空残骸。");
    } else if (roll < 0.3) {
      setState((draft) => {
        draft.systems.expedition.magneticStormUntil = now + 10000;
      });
      addLog("[雷达] 磁暴命中航道，推进负荷翻倍。");
    } else if (roll < 0.35) {
      setState((draft) => {
        draft.systems.expedition.techFragments += 1;
        draft.systems.expedition.autoMaintenanceUnlocked = true;
      });
      addLog("[航向] 回收技术碎片，自动维护中心蓝图已解锁。");
    } else if (roll < 0.55) {
      setState((draft) => {
        draft.resources.sealant += 50;
      });
      addLog({ id: "event-cryo-cache", text: pullEventTextById("event-cryo-cache") || "[发现] 发现漂浮冷冻库，回收密封剂。" });
    } else if (roll < 0.7) {
      setState((draft) => {
        const dmg = typeof draft.disasterDamageMod === "number" ? draft.disasterDamageMod : 1;
        draft.resources.alloy = Math.max(0, draft.resources.alloy - (20 * dmg));
      });
      addLog({ id: "event-radiation-nebula", text: pullEventTextById("event-radiation-nebula") || "[警告] 穿过辐射星云，船体受损。" });
    } else {
      addLog("[雷达] 前方 200km 处探测到高能信号响应。");
    }
    setState((draft) => {
      draft.systems.expedition.nextEventAt = now + 60000;
    });
  }
}

function processDeepSpaceLogEvent(now) {
  const exp = state.systems && state.systems.expedition ? state.systems.expedition : null;
  if (!exp) {
    return;
  }
  const distance = Number(exp.distanceKm || 0);
  if (distance < 60000 || distance >= 90000 || state.isEventActive) {
    return;
  }
  const nextAt = Number(exp.deepSpaceLogNextAt || 0);
  if (nextAt > now) {
    return;
  }
  const pool = Array.isArray(window.deepSpaceLogEvents) ? window.deepSpaceLogEvents : [];
  if (pool.length <= 0) {
    return;
  }
  const throttle = Math.max(0, Number(exp.throttle || 0));
  const chance = Math.min(0.42, 0.18 + throttle * 0.02);
  const hit = Math.random() < chance;
  setState((draft) => {
    draft.structures = draft.structures || {};
    draft.resources = draft.resources || {};
    draft.systems = draft.systems || {};
    draft.systems.expedition = draft.systems.expedition || {};
    draft.systems.expedition.deepSpaceLogNextAt = now + 6000 + Math.floor(Math.random() * 7000);
  });
  if (!hit) {
    return;
  }
  const entry = pool[Math.floor(Math.random() * pool.length)];
  if (!entry) {
    return;
  }
  if (typeof entry.effect === "function") {
    entry.effect(state, setState, addLog);
  } else if (entry.text) {
    addLog(entry.text, "#888");
  }
}

function updateRates() {
  const industry = window.MoundSystemsIndustry;
  const calc = industry && typeof industry.calculateAllRates === "function"
    ? industry.calculateAllRates(state, { now: Date.now() })
    : null;
  if (!calc) {
    return;
  }
  const src = calc.valueSources || {};
  const powerSrc = src.power || {};
  const oxygenSrc = src.oxygen || {};
  const oxygenProduce = Number(oxygenSrc["内部循环系统"] || oxygenSrc["制氧模块"] || 0);
  const oxygenBreathe = Object.keys(oxygenSrc).reduce((sum, key) => {
    if (key.indexOf("载员生命维持") === 0 || key === "载员呼吸") {
      return sum + Math.abs(Number(oxygenSrc[key] || 0));
    }
    return sum;
  }, 0);
  const oxygenLeak = Math.abs(Number(oxygenSrc["低电泄漏"] || 0));
  const powerEntries = Object.values(powerSrc).map((value) => Number(value || 0));
  const powerProd = powerEntries.reduce((sum, value) => (value > 0 ? sum + value : sum), 0);
  const powerCons = powerEntries.reduce((sum, value) => (value < 0 ? sum + Math.abs(value) : sum), 0);
  const powerNet = powerProd - powerCons;
  setState((draft) => {
    draft.netRates = calc.netRates || draft.netRates;
    draft.valueSources = calc.valueSources || draft.valueSources;
    draft.productionSource = draft.valueSources;
    draft.systems.rates.power = draft.netRates.power || 0;
    draft.systems.rates.oxygen = draft.netRates.oxygen || 0;
    draft.systems.rates.scrapMetal = draft.netRates.scrapMetal || 0;
    draft.systems.rates.stardust = draft.netRates.stardust || 0;
    draft.systems.rates.alloy = draft.netRates.alloy || 0;
    draft.systems.rates.sealant = draft.netRates.sealant || 0;
    draft.systems.rates.helium3 = draft.netRates.helium3 || 0;
    draft.systems.rates.techPoints = draft.netRates.techPoints || 0;
    draft.systems.rates.powerParts = {
      fusionGain: powerSrc["氦-3聚变发电机"] || 0,
      crewFeed: powerSrc["载员发电"] || 0,
      totalProduction: powerProd,
      totalConsumption: powerCons,
      netPower: powerNet,
      oxygenLoad: Math.abs(powerSrc["制氧系统负荷"] || 0),
      autoSmelterLoad: 0,
      autoSynthLoad: 0,
      maintenanceLoad: 0,
      industrialLoad: Math.abs(powerSrc["工业系统负荷"] || 0),
      orbitalLoad: Math.abs(powerSrc["采集系统负荷"] || 0),
      expeditionLoad: Math.abs(powerSrc["远征推进负荷"] || 0)
    };
    const scrapSrc = src.scrapMetal || {};
    const stardustSrc = src.stardust || {};
    const alloySrc = src.alloy || {};
    const sealantSrc = src.sealant || {};
    const he3Src = src.helium3 || {};
    draft.systems.rates.oxygenParts = {
      produce: oxygenProduce,
      breathe: oxygenBreathe,
      leak: oxygenLeak
    };
    draft.systems.rates.scrapParts = {
      arrayGain: scrapSrc["磁力阵列"] || 0,
      crewBurn: 0,
      smelterCost: Math.abs(scrapSrc["合金模组消耗"] || 0)
    };
    draft.systems.rates.stardustParts = {
      ionGain: stardustSrc["离子捕获器"] || 0,
      synthCost: Math.abs(stardustSrc["自动合成仪消耗"] || 0),
      smelterCost: Math.abs(stardustSrc["合金模组消耗"] || 0)
    };
    draft.systems.rates.alloyParts = {
      smelterGain: alloySrc["合金模组产出"] || 0
    };
    draft.systems.rates.sealantParts = {
      synthGain: sealantSrc["自动合成仪产出"] || 0
    };
    draft.systems.rates.helium3Parts = {
      orbitalGain: he3Src["轨道采矿机"] || 0,
      orbitalCost: Math.abs((he3Src["聚变燃料消耗"] || 0) + (he3Src["远征推进消耗"] || 0))
    };
    draft.systems.rates.fusionParts = {
      generatorGain: powerSrc["氦-3聚变发电机"] || 0,
      fuelCost: Math.abs(he3Src["聚变燃料消耗"] || 0)
    };
  });
  const now = Date.now();
  if (isDevAuditMode() && (now - lastPowerBalanceDebugAt) >= 5000) {
    lastPowerBalanceDebugAt = now;
    const techCurrent = Number((state.resources && state.resources.techPoints) || 0);
    console.log(
      `Economy Audit: Power [Prod: ${powerProd.toFixed(2)}, Cons: ${powerCons.toFixed(2)}, Net: ${powerNet.toFixed(2)}] | TechPoints: [Current: ${techCurrent.toFixed(2)}]`
    );
  }
}

function debugPowerTickTrace() {
  const parts = state.systems && state.systems.rates && state.systems.rates.powerParts
    ? state.systems.rates.powerParts
    : null;
  const netPower = Number(parts && parts.netPower);
  const currentPower = Number((state.resources && state.resources.power) || 0);
  const safeNet = Number.isFinite(netPower) ? netPower : Number((state.netRates && state.netRates.power) || 0);
  if (
    Number.isFinite(lastPowerSampleForDebug) &&
    safeNet < -0.0001 &&
    Math.abs(currentPower - lastPowerSampleForDebug) <= 0.0001
  ) {
    console.warn("[POWER] Negative net but unchanged storage; check patch merge/reset path.");
  }
  lastPowerSampleForDebug = currentPower;
}

function updateUiAutomationState() {
  const rates = state.systems.rates || {};
  const powerParts = rates.powerParts || {};
  const stardustParts = rates.stardustParts || {};
  const scrapParts = rates.scrapParts || {};
  const hasAutoOxygenFacility = state.isVaultRepaired || state.isEfficiencyUpgraded;
  const refineAutoReady = state.autoSmelters >= 3 && state.resources.alloy >= 50;
  const sealantAutoReady = state.autoSynthesizers >= 1 && state.resources.sealant >= 30;
  const currentDemand =
    (powerParts.oxygenLoad || 0) +
    (powerParts.autoSmelterLoad || 0) +
    (powerParts.autoSynthLoad || 0) +
    (powerParts.maintenanceLoad || 0) +
    (powerParts.orbitalLoad || 0) +
    (powerParts.expeditionLoad || 0);
  const currentOutput = powerParts.crewFeed || 0;
  const surplusNow = state.resources.power > 0 && currentOutput > currentDemand;
  const canHideGather =
    state.resources.power > 0 &&
    (stardustParts.ionGain || 0) > 0.5 &&
    (scrapParts.arrayGain || 0) > 0.5;

  let shouldLogUpgrade = false;
  let shouldLogPipeline = false;
  let shouldLogAuthSlim = false;
  let shouldLogExpeditionInterlock = false;
  let shouldLogResearchBlueprintUnlock = false;
  setState((draft) => {
    const ui = draft.systems.ui;
    if (surplusNow) {
      ui.powerSurplusSeconds += 1;
    } else {
      ui.powerSurplusSeconds = 0;
    }

    ui.hideManualOxygen =
      hasAutoOxygenFacility &&
      draft.oxygen >= 95 &&
      draft.resources.power > 0 &&
      !draft.systems.oxygenSupplyLow;
    ui.hideManualCharge =
      ui.powerSurplusSeconds >= 30 &&
      draft.resources.power > 0 &&
      !draft.systems.lowPowerForcedShutdownLogged;
    ui.hideManualRefine = refineAutoReady;
    ui.hideManualSealant = sealantAutoReady;
    ui.hideReactorAction = draft.systems.reactorActive && draft.resources.power > 0;
    ui.collapseBasicGather = canHideGather;
    if (!ui.automationStructuresDiscovered && Number(draft.resources.sealant || 0) >= 5) {
      ui.automationStructuresDiscovered = true;
    }
    if (!ui.refiningFurnaceDiscovered && Number(draft.resources.sealant || 0) >= 10) {
      ui.refiningFurnaceDiscovered = true;
    }
    draft.structures = draft.structures || {};
    draft.structures.massProjector = Math.max(Number(draft.structures.massProjector || 0), draft.massDriverBuilt ? 1 : 0);
    draft.structures.miningMachine = Math.max(Number(draft.structures.miningMachine || 0), Number(draft.miningDrones || 0));
    draft.structures.fusionGenerator = Math.max(Number(draft.structures.fusionGenerator || 0), Number(draft.fusionGenerators || 0));
    const expeditionInterlockReady =
      draft.structures.massProjector >= 1 &&
      draft.structures.miningMachine >= 1 &&
      draft.structures.fusionGenerator >= 1;
    if (!ui.autoSmelterDiscovered && draft.hasRefiningFurnace && Number(draft.resources.alloy || 0) >= 3) {
      ui.autoSmelterDiscovered = true;
    }
    draft.flags = draft.flags || {};
    const blueprintUnlocked = !!(draft.blueprints && draft.blueprints.researchWorkstation);
    if (blueprintUnlocked && !draft.flags.isResearchStationBlueprintUnlocked) {
      draft.flags.isResearchStationBlueprintUnlocked = true;
      shouldLogResearchBlueprintUnlock = true;
    } else if (!blueprintUnlocked && typeof draft.flags.isResearchStationBlueprintUnlocked !== "boolean") {
      draft.flags.isResearchStationBlueprintUnlocked = false;
    }
    if (!draft.flags.isResearchStationBlueprintUnlocked) {
      draft.resources = draft.resources || {};
      draft.resources.techPoints = 0;
      draft.systems = draft.systems || {};
      draft.systems.rates = draft.systems.rates || {};
      draft.systems.rates.techPoints = 0;
    }

    if (!ui.uiUpgradeLogged && (ui.hideManualOxygen || ui.hideManualCharge || ui.collapseBasicGather)) {
      ui.uiUpgradeLogged = true;
      shouldLogUpgrade = true;
    }
    if (!ui.manualPipelineLogged && (ui.hideManualRefine || ui.hideManualSealant)) {
      ui.manualPipelineLogged = true;
      shouldLogPipeline = true;
    }
    if (!ui.manualAuthSlimLogged && ui.hideManualRefine && ui.hideManualSealant) {
      ui.manualAuthSlimLogged = true;
      shouldLogAuthSlim = true;
    }
    if (expeditionInterlockReady && !ui.expeditionInterlockLogged) {
      ui.expeditionInterlockLogged = true;
      shouldLogExpeditionInterlock = true;
    }
  });
  if (shouldLogUpgrade) {
    addLog({
      id: "ui-industrial-upgrade",
      once: true,
      text: "UI 协议已升级：冗余手动指令已清理，界面焦点已转移至工业自动化。"
    });
  }
  if (shouldLogPipeline) {
    addLog({
      id: "manual-pipeline-suspended",
      once: true,
      text: "[控制台] 检测到稳定的工业流水线，手动熔炼协议已挂起。"
    });
  }
  if (shouldLogAuthSlim) {
    addLog({
      id: "manual-auth-slim",
      once: true,
      text: "操作授权已精简：手动精炼与锻造指令已交由自动化系统接管。"
    });
  }
  if (shouldLogExpeditionInterlock) {
    addLog("推进系统联锁完成，氦-3 反应堆并网成功。航行许可已发放。");
  }
  if (shouldLogResearchBlueprintUnlock) {
    addLog("科研工作站蓝图已解析，科技点获取协议已激活。");
  }
}

function activateStardustBeacon() {
  const now = Date.now();
  if (!state.isVaultRepaired) {
    return false;
  }
  const cap = Math.max(1, Number(state.populationCap || 5));
  const crewNow = Math.max(0, Number(state.population || state.crew || 0));
  if (crewNow >= cap) {
    addLog("舱内空间不足，无法接纳更多成员。");
    return false;
  }
  const launchCost = Math.max(100, Math.round(100 * (1 + (crewNow * 0.5))));
  if (state.resources.stardust < launchCost) {
    return false;
  }
  setState((draft) => {
    draft.resources.stardust -= launchCost;
    draft.pendingCrewArrivals = Math.max(0, Number(draft.pendingCrewArrivals || 0)) + 1;
    if (!Number(draft.pendingCrewArrivalAt || 0)) {
      draft.pendingCrewArrivalAt = now + 20000;
    }
    draft.beaconCooldownUntil = 0;
    draft.beaconResponseDeadline = draft.pendingCrewArrivalAt;
    markManualResourceUiSync(draft);
  });
  storage.saveGame();
  addLog("信标已划破黑暗，我们在等待回应。");
  return true;
}

function upgradeShieldTech() {
  const tech = techSystem();
  if (!state.techEraEnabled || !state.blueprints.researchWorkstation || !tech || typeof tech.nextTechCost !== "function") {
    return false;
  }
  const level = state.systems.tech.shieldLevel || 0;
  const maxLevel = Number(window.MAX_TECH_LEVEL || 10);
  if (level >= maxLevel) {
    return false;
  }
  const cost = tech.nextTechCost(level);
  const pool = Number(state.resources && state.resources.techPoints ? state.resources.techPoints : 0);
  if (pool < cost) {
    return false;
  }
  setState((draft) => {
    draft.resources = draft.resources || {};
    const available = Number(draft.resources.techPoints || 0);
    if (available < cost) {
      return;
    }
    const nextTech = available - cost;
    draft.resources.techPoints = nextTech;
    draft.systems.tech.shieldLevel += 1;
    draft.upgrades = draft.upgrades || { dustRefining: 1, powerEfficiency: 1, shieldLevel: 0 };
    draft.upgrades.shieldLevel = draft.systems.tech.shieldLevel;
  });
  return true;
}

function upgradeCycleTech() {
  const tech = techSystem();
  if (!state.techEraEnabled || !state.blueprints.researchWorkstation || !tech || typeof tech.nextTechCost !== "function") {
    return false;
  }
  const level = state.systems.tech.cycleLevel || 0;
  const maxLevel = Number(window.MAX_TECH_LEVEL || 10);
  if (level >= maxLevel) {
    return false;
  }
  const cost = tech.nextTechCost(level);
  const pool = Number(state.resources && state.resources.techPoints ? state.resources.techPoints : 0);
  if (pool < cost) {
    return false;
  }
  setState((draft) => {
    draft.resources = draft.resources || {};
    const available = Number(draft.resources.techPoints || 0);
    if (available < cost) {
      return;
    }
    const nextTech = available - cost;
    draft.resources.techPoints = nextTech;
    draft.systems.tech.cycleLevel += 1;
  });
  return true;
}

function upgradeMiningTech() {
  const tech = techSystem();
  if (!state.techEraEnabled || !state.blueprints.researchWorkstation || !tech || typeof tech.nextTechCost !== "function") {
    return false;
  }
  const level = state.systems.tech.miningLevel || 0;
  const maxLevel = Number(window.MAX_TECH_LEVEL || 10);
  if (level >= maxLevel) {
    return false;
  }
  const cost = tech.nextTechCost(level);
  const pool = Number(state.resources && state.resources.techPoints ? state.resources.techPoints : 0);
  if (pool < cost) {
    return false;
  }
  setState((draft) => {
    draft.resources = draft.resources || {};
    const available = Number(draft.resources.techPoints || 0);
    if (available < cost) {
      return;
    }
    const nextTech = available - cost;
    draft.resources.techPoints = nextTech;
    draft.systems.tech.miningLevel += 1;
  });
  return true;
}

function scheduleDrifterArrival() {
  if (drifterTimer || state.systems.drifterArrived) {
    return;
  }
  drifterTimer = setTimeout(() => {
    setState((draft) => {
      if (draft.population < draft.populationCap) {
        draft.population += 1;
        draft.oxygen = 100;
      }
      draft.systems.drifterArrived = true;
    });
    const arriveText = pullEventTextById("drifter-arrive");
    const stayText = pullEventTextById("drifter-stay");
    if (arriveText) {
      addLog(arriveText);
    }
    if (stayText) {
      addLog(stayText);
    }
    drifterTimer = null;
  }, 30000);
}

function trySurvivorReturn() {
  if (!state.isVaultRepaired || state.population > 0) {
    return;
  }
  if (Math.random() < 0.2) {
    setState((draft) => {
      if (!draft.isVaultRepaired || draft.population > 0) {
        return;
      }
      if (draft.population < draft.populationCap) {
        draft.population = 1;
        draft.oxygen = 100;
      }
    });
    const text = pullEventTextById("survivor-return");
    if (text) {
      addLog(text);
    }
  }
}

function startEngine() {
  if (window.mainLoop) {
    clearInterval(window.mainLoop);
    window.mainLoop = null;
  }
  if (tickHandle) {
    clearInterval(tickHandle);
    tickHandle = null;
  }
  const workerBridge = getWorkerBridge();
  const workerModeEnabled = getWorkerMode() === "full";
  if (
    workerModeEnabled &&
    workerBridge &&
    typeof workerBridge.start === "function" &&
    typeof workerBridge.supported === "boolean" &&
    workerBridge.supported
  ) {
    if (typeof workerBridge.onFatal === "function") {
      workerBridge.onFatal((error) => {
        if (workerFallbackTriggered) {
          return;
        }
        workerFallbackTriggered = true;
        console.error("[Worker] 已降级到主线程逻辑。", error);
        try {
          workerBridge.stop();
        } catch (stopError) {
          console.error("[Worker] stop failed during fallback:", stopError);
        }
        usingWorkerHeart = false;
        setWorkerMode("off");
        addLog("[系统] Worker 逻辑心脏异常，已回退到主线程模式。");
        setTimeout(() => {
          workerFallbackTriggered = false;
          startEngine();
        }, 0);
      });
    }
    const applyDelta = (draft, delta) => {
      if (!delta || typeof delta !== "object") {
        return;
      }
      Object.keys(delta).forEach((path) => {
        const segments = path.split(".");
        let cursor = draft;
        for (let i = 0; i < segments.length - 1; i += 1) {
          const key = segments[i];
          if (!cursor[key] || typeof cursor[key] !== "object") {
            cursor[key] = {};
          }
          cursor = cursor[key];
        }
        const lastKey = segments[segments.length - 1];
        const incoming = delta[path];
        const existing = cursor[lastKey];
        if (incoming && typeof incoming === "object" && !Array.isArray(incoming) && existing && typeof existing === "object" && !Array.isArray(existing)) {
          Object.assign(existing, incoming);
        } else {
          cursor[lastKey] = incoming;
        }
      });
    };
    usingWorkerHeart = workerBridge.start(
      state,
      getLogicTickMs() || 100,
      (workerData) => {
        const now = Date.now();
        const data = workerData || {};
        const delta = data.delta || {};
        const dtSec = Math.max(0.05, Number(data.dtSec || (getLogicTickMs() || 100) / 1000));
        if (delta && typeof delta === "object" && Object.keys(delta).length > 0) {
          const receivedDist = delta["systems.expedition.distanceKm"];
          setState((draft) => {
            applyDelta(draft, delta);
            if (Object.prototype.hasOwnProperty.call(delta, "resources.helium3")) {
              draft.helium3 = delta["resources.helium3"];
            }
            syncColonyCapacityInDraft(draft);
            applyForcedDistanceCombatHook(draft);
          });
          queueUiTickSync();
        }
        const curKmWorker = getExpeditionDistance(state);
        runExpeditionCombatWatchdog();
        if (isCombatLockActive(state)) {
          const bridge = getWorkerBridge();
          if (bridge && typeof bridge.sync === "function") {
            bridge.sync(state);
          }
        }
        if (lastWorkerSyncedExpeditionKm !== null) {
          runExpeditionEncounterStep(state, setState, addLog, lastWorkerSyncedExpeditionKm, curKmWorker, dtSec);
        }
        lastWorkerSyncedExpeditionKm = curKmWorker;
        if (Array.isArray(data.events) && data.events.length) {
          data.events.forEach((entry) => {
            if (!entry) {
              return;
            }
            if (typeof entry === "string") {
              addLog(entry);
              return;
            }
            const text = typeof entry.text === "string" ? entry.text : "";
            if (!text) {
              return;
            }
            addLog(
              {
                id: entry.id,
                once: !!entry.once,
                text,
                color: entry.color
              }
            );
          });
        }
        if (data.control) {
          const uiApi = getUiApi();
          if (data.control.showOutpostMenu && uiApi && typeof uiApi.showOutpostMenu === "function") {
            uiApi.showOutpostMenu();
          }
          if (
            typeof data.control.showMajorDecision === "number" &&
            typeof showMajorDecision === "function"
          ) {
            showMajorDecision(data.control.showMajorDecision);
          }
        }
        // Keep automation/resource simulation active in worker-heart mode
        // while preventing callback errors from crashing UI rendering.
        try {
          if (typeof updateRates === "function") {
            updateRates();
          }
          applyResourceTickStep(state, setState, dtSec);
          let beaconArrivalSuccessNow = false;
          let beaconArrivalFailedNow = false;
          setState((draft) => {
            if (Number(draft.pendingCrewArrivals || 0) > 0 && Number(draft.pendingCrewArrivalAt || 0) <= 0) {
              draft.pendingCrewArrivalAt = now + 20000;
            }
            if (draft.pendingCrewArrivals > 0 && draft.pendingCrewArrivalAt > 0 && now >= draft.pendingCrewArrivalAt) {
              const crewNow = Math.max(0, Number(draft.population || draft.crew || 0));
              const crewCap = Math.max(1, Number(draft.populationCap || draft.maxPopulation || 1));
              if (crewNow < crewCap) {
                draft.population += 1;
                draft.oxygen = 100;
                beaconArrivalSuccessNow = true;
              } else {
                beaconArrivalFailedNow = true;
              }
              draft.pendingCrewArrivals = Math.max(0, Number(draft.pendingCrewArrivals || 0) - 1);
              draft.pendingCrewArrivalAt = draft.pendingCrewArrivals > 0 ? now + 20000 : 0;
              draft.beaconResponseDeadline = draft.pendingCrewArrivalAt;
              syncColonyCapacityInDraft(draft);
            }
          });
          if (beaconArrivalSuccessNow) {
            addLog("一名流浪者收到了信号，已进入修补后的舱室。");
            const uiApi = getUiApi();
            if (uiApi && typeof uiApi.syncResourceBarVisuals === "function") {
              uiApi.syncResourceBarVisuals(true);
            }
          } else if (beaconArrivalFailedNow) {
            addLog("警告：由于舱位不足，响应信号的幸存者被迫离开了。");
          }
          if (typeof updateRates === "function") {
            updateRates();
          }
          debugPowerTickTrace();
          if (typeof updateUiAutomationState === "function") {
            updateUiAutomationState();
          }
        } catch (automationError) {
          console.warn("[Worker] automation callback step failed:", automationError);
        }
        tryAutoSave(now);
      }
    );
    if (usingWorkerHeart) {
      window.mainLoop = null;
      return;
    }
  }
  usingWorkerHeart = false;
  workerFallbackTriggered = false;
  tickHandle = setInterval(() => {
    tickCount += 1;
    const now = Date.now();
    if (!lastExpeditionTickAt) {
      lastExpeditionTickAt = now;
    }
    const dtSecRaw = (now - lastExpeditionTickAt) / 1000;
    const dtSec = Number.isFinite(dtSecRaw) && dtSecRaw > 0 ? dtSecRaw : (getLogicTickMs() / 1000);
    lastExpeditionTickAt = now;
    processMiningDrones(now);
    let oxygenStableNow = false;
    let populationDiedNow = false;
    let decompressionLossNow = false;
    let beaconArrivalSuccessNow = false;
    let beaconArrivalFailedNow = false;
    setState((draft) => {
      const highCrewLoadFactor = draft.population > 5 ? 2 : 1;
      const cyclePowerFactor = getCyclePowerFactor();
      if (draft.beaconCooldownUntil > 0 && now >= draft.beaconCooldownUntil) {
        draft.beaconCooldownUntil = 0;
      }
      if (Number(draft.pendingCrewArrivals || 0) > 0 && Number(draft.pendingCrewArrivalAt || 0) <= 0) {
        draft.pendingCrewArrivalAt = now + 20000;
      }
      if (draft.pendingCrewArrivals > 0 && draft.pendingCrewArrivalAt > 0 && now >= draft.pendingCrewArrivalAt) {
        const crewNow = Math.max(0, Number(draft.population || draft.crew || 0));
        const crewCap = Math.max(1, Number(draft.populationCap || draft.maxPopulation || 1));
        if (crewNow < crewCap) {
          draft.population += 1;
          draft.oxygen = 100;
          beaconArrivalSuccessNow = true;
        } else {
          beaconArrivalFailedNow = true;
        }
        draft.pendingCrewArrivals = Math.max(0, Number(draft.pendingCrewArrivals || 0) - 1);
        draft.pendingCrewArrivalAt = draft.pendingCrewArrivals > 0 ? now + 20000 : 0;
        draft.beaconResponseDeadline = draft.pendingCrewArrivalAt;
        draft.beaconCooldownUntil = 0;
      }
      if (draft.systems.pendingCrewLoss > 0 && draft.systems.decompressionRepairUntil > 0 && now >= draft.systems.decompressionRepairUntil) {
        if (draft.resources.alloy > 500) {
          draft.resources.alloy -= 500;
          addLog("[系统] 自动加固完成。舱体已重新闭合。");
        } else {
          draft.population = Math.max(0, draft.population - draft.systems.pendingCrewLoss);
          decompressionLossNow = true;
        }
        draft.systems.pendingCrewLoss = 0;
        draft.systems.decompressionRepairUntil = 0;
      }
      if (draft.resources.power > 0 && draft.systems.expedition.throttle > 0) {
        draft.systems.expedition.active = true;
      }
      const electrolyzerEnabled = draft.isVaultRepaired && draft.resources.power > 0;
      draft.systems.oxygenSupplyLow = draft.isVaultRepaired && !electrolyzerEnabled;
      if (draft.isVaultRepaired && electrolyzerEnabled) {
        oxygenStableNow = true;
      }
      if (draft.maintenanceCenterBuilt && draft.resources.power > 0) {
        draft.systems.maintenanceActive = true;
        draft.maintenanceCenterActive = true;
      } else {
        draft.systems.maintenanceActive = false;
        draft.maintenanceCenterActive = false;
      }
      draft.systems.expedition = draft.systems.expedition || {};
      if (draft.techEraEnabled && draft.systems.expedition.milestone10000Reached) {
        draft.blueprints = draft.blueprints || {};
        draft.blueprints.researchWorkstation = true;
        draft.blueprints.maintenanceCenter = true;
        draft.flags = draft.flags || {};
        draft.flags.isResearchStationBlueprintUnlocked = true;
      }
      if (draft.oxygen <= 0 && draft.population > 0) {
        draft.population = 0;
        populationDiedNow = true;
      }
      if (draft.resources.power <= 0) {
        draft.resources.power = 0;
        draft.ReactorCoreActive = false;
        draft.systems.reactorActive = false;
        draft.systems.automationHalted = true;
      } else {
        draft.systems.reactorActive = true;
        draft.systems.automationHalted = false;
      }
      if (draft.resources.power < 20) {
        if (!draft.systems.lowPowerForcedShutdownLogged) {
          draft.systems.lowPowerForcedShutdownLogged = true;
        }
      } else {
        draft.systems.lowPowerForcedShutdownLogged = false;
      }

      const crewGenPerSec = draft.population > 0
        ? draft.population * 10 * (draft.population >= 5 ? 1.2 : 1.0)
        : 0;
      const fusionGenPerSec =
        draft.fusionGenerators > 0 && draft.resources.helium3 > 0
          ? draft.fusionGenerators * 50 * (draft.systems.fusionDebuffUntil > now ? 0.2 : 1)
          : 0;
      const oxygenNeed = draft.isVaultRepaired && draft.resources.power > 0 ? 0.5 : 0;
      const industrialNeed =
        (draft.autoSmelters > 0 && draft.resources.power > 60 ? draft.autoSmelters * 15 * highCrewLoadFactor * cyclePowerFactor : 0) +
        (draft.autoSynthesizers > 0 ? (((draft.population >= 5 ? 2 : 8) * draft.autoSynthesizers) / 5) * highCrewLoadFactor * cyclePowerFactor : 0) +
        (draft.maintenanceCenterBuilt ? 5 * highCrewLoadFactor * cyclePowerFactor : 0) +
        (draft.systems.automationFaultUntil > now
          ? ((draft.autoSmelters > 0 ? draft.autoSmelters * 15 * highCrewLoadFactor * cyclePowerFactor : 0) +
            (draft.autoSynthesizers > 0 ? (((draft.population >= 5 ? 2 : 8) * draft.autoSynthesizers) / 5) * highCrewLoadFactor * cyclePowerFactor : 0))
          : 0);
      const orbitalNeed = draft.massDriverBuilt && draft.miningDrones > 0 ? draft.miningDrones * 0.4 : 0;
      const totalNeed = oxygenNeed + industrialNeed + orbitalNeed;
      if (totalNeed > crewGenPerSec + fusionGenPerSec + 0.0001 && orbitalNeed > 0) {
        draft.systems.orbitalPaused = true;
      } else {
        draft.systems.orbitalPaused = false;
      }
      syncColonyCapacityInDraft(draft);
    });
    queueUiTickSync();
    if (oxygenStableNow) {
      addLog({ id: "oxygen-stable", once: true, text: "氧气循环稳定。" });
    }
    if (populationDiedNow) {
      addLog("空气抽干了。他没能挺过去。");
    }
    if (beaconArrivalSuccessNow) {
      addLog("一名流浪者收到了信号，已进入修补后的舱室。");
      const uiApi = getUiApi();
      if (uiApi && typeof uiApi.syncResourceBarVisuals === "function") {
        uiApi.syncResourceBarVisuals(true);
      }
    } else if (beaconArrivalFailedNow) {
      addLog("警告：由于舱位不足，响应信号的幸存者被迫离开了。");
    }
    if (decompressionLossNow) {
      addLog("[警告] 抢修超时。2号隔离舱伤亡已确认。");
    }
    if (state.systems.lowPowerForcedShutdownLogged) {
      addLog({ id: "low-power-force-stop", once: true, text: "[警告] 能源水位极低，非必要系统已强制关停。" });
    }
    if (state.systems.orbitalPaused && !state.systems.orbitalPauseLogged) {
      setState((draft) => {
        draft.systems.orbitalPauseLogged = true;
      });
      addLog("由于能源匮乏，轨道采集作业已暂停。");
    }
    if (!state.systems.orbitalPaused && state.systems.orbitalPauseLogged) {
      setState((draft) => {
        draft.systems.orbitalPauseLogged = false;
      });
    }
    if (!state.systems.reactorActive && state.resources.power === 0 && !state.systems.reactorShutdownLogged) {
      setState((draft) => {
        draft.systems.reactorShutdownLogged = true;
      });
      addLog("核心停止输出。");
    }
    if (tickCount % 45 === 0) {
      trySurvivorReturn();
    }
    tryAutoSave(now);
    try {
      processExpedition(now, dtSec);
    } catch (error) {
      addLog("[警告] 远征控制回路异常，已自动切换安全模式。");
    }
    processDeepSpaceLogEvent(now);
    updateRates();
    applyResourceTickStep(state, setState, dtSec);
    updateRates();
    debugPowerTickTrace();
    updateUiAutomationState();
    if (state.isVaultRepaired && state.oxygen < 20 && !state.systems.oxygenCriticalLogged) {
      setState((draft) => {
        draft.systems.oxygenCriticalLogged = true;
      });
      addLog("[警告] 氧气储备跌至临界值，请检查电力供应。");
    } else if (state.systems.oxygenCriticalLogged && state.oxygen >= 25) {
      setState((draft) => {
        draft.systems.oxygenCriticalLogged = false;
      });
    }
  }, Math.max(50, Number(getLogicTickMs() || 100)));
  window.mainLoop = tickHandle;
}

function stopEngine() {
  const workerBridge = getWorkerBridge();
  if (usingWorkerHeart && workerBridge && typeof workerBridge.stop === "function") {
    workerBridge.stop();
    usingWorkerHeart = false;
  }
  if (window.mainLoop) {
    clearInterval(window.mainLoop);
    window.mainLoop = null;
  }
  if (tickHandle) {
    clearInterval(tickHandle);
    tickHandle = null;
  }
  lastExpeditionTickAt = 0;
  lastDistanceEventCheckAt = 0;
}

function checkSystems() {
  setState((draft) => {
    draft.systems = draft.systems || {};
    draft.systems.deepSpace = draft.systems.deepSpace || {};
    draft.systems.deepSpace.unlocked = !!draft.isVaultRepaired;
    if (draft.isVaultRepaired) {
      draft.systems.reactorActive = draft.resources.power > 0 || draft.ReactorCoreActive;
      if (!draft.systems.systemCalibratedLogged) {
        draft.systems.systemCalibratedLogged = true;
      }
    }
  });
  if (state.isVaultRepaired && !tickHandle) {
    startEngine();
  }
  const uiApi = getUiApi();
  if (uiApi && uiApi.renderAll) {
    uiApi.renderAll();
  }
  if (state.isVaultRepaired && state.systems.systemCalibratedLogged) {
    addLog({ id: "system-calibrated", once: true, text: "系统状态已校准。" });
  }
}

function initEngine() {
  stopEngine();
  lastAutoSaveAt = Date.now();
  setState((draft) => {
    draft.systems = draft.systems || {};
    draft.systems.expedition = draft.systems.expedition || {};
    draft.systems.deepSpace = draft.systems.deepSpace || {};
    if (typeof draft.systems.deepSpace.unlocked !== "boolean") {
      draft.systems.deepSpace.unlocked = !!draft.isVaultRepaired;
    }
    const dist = draft.systems.expedition.distanceKm || 0;
    draft.lastEventMilestone = Math.max(0, Math.floor(dist / 2000));
    draft.systems.expedition.lastEventDistance = draft.lastEventMilestone * 2000;
    draft.systems.expedition.nextHazardKm = draft.systems.expedition.lastEventDistance + 2000;
    draft.isAdventureReady = dist >= 2000;
    draft.isTechEra = dist >= 10000;
    draft.techEraEnabled = draft.isTechEra;
    draft.isAutoMaintenance = draft.isTechEra;
    draft.crew = draft.population || 0;
    if (typeof draft.ReactorCoreActive !== "boolean") {
      draft.ReactorCoreActive = false;
    }
    if (typeof draft.isVaultRepaired !== "boolean") {
      draft.isVaultRepaired = false;
    }
    draft.blueprints = draft.blueprints || {};
    draft.flags = draft.flags || {};
    if (typeof draft.flags.isResearchStationBlueprintUnlocked !== "boolean") {
      draft.flags.isResearchStationBlueprintUnlocked = !!draft.blueprints.researchWorkstation;
    }
    if (!draft.flags.isResearchStationBlueprintUnlocked) {
      draft.resources = draft.resources || {};
      draft.resources.techPoints = 0;
    }
    if (typeof draft.flags.combatSystemUnlocked !== "boolean") {
      draft.flags.combatSystemUnlocked = Number(dist || 0) >= 100000;
    }
    if (typeof draft.flags.omegaDefeated !== "boolean") {
      draft.flags.omegaDefeated = false;
    }
    if (typeof draft.flags.omegaSlayer !== "boolean") {
      draft.flags.omegaSlayer = false;
    }
    if (typeof draft.flags.omegaEndingDefeat !== "boolean") {
      draft.flags.omegaEndingDefeat = false;
    }
    if (typeof draft.flags.combatMilestoneCompApplied !== "boolean") {
      draft.flags.combatMilestoneCompApplied = false;
    }
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
    if (
      !draft.systems.ui.discoveredTopBar ||
      Object.prototype.toString.call(draft.systems.ui.discoveredTopBar) !== "[object Object]"
    ) {
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
    if (typeof draft.pendingCrewArrivals !== "number") {
      draft.pendingCrewArrivals = 0;
    }
    if (typeof draft.pendingCrewArrivalAt !== "number") {
      draft.pendingCrewArrivalAt = 0;
    }
    draft.resources = draft.resources || {};
    if (typeof draft.resources.crew !== "number") {
      draft.resources.crew = Number(draft.population || draft.crew || 0);
    }
    if (typeof draft.resources.crewCapacity !== "number") {
      draft.resources.crewCapacity = Number(draft.populationCap || draft.maxPopulation || 1);
    }
    if (typeof draft.resources.powerCapacity !== "number" || draft.resources.powerCapacity < 5000000) {
      draft.resources.powerCapacity = 5000000;
    }
    draft.resources.power = Math.min(Number(draft.resources.power || 0), draft.resources.powerCapacity);
    if (typeof draft.resources.techPoints !== "number") {
      draft.resources.techPoints = 0;
    } else if (!draft.flags.isResearchStationBlueprintUnlocked) {
      draft.resources.techPoints = 0;
    }
    if (typeof draft.resources.singularity !== "number") {
      draft.resources.singularity = Number(draft.singularity || 0);
    }
    draft.singularity = Math.max(0, Number(draft.singularity || draft.resources.singularity || 0));
    draft.resources.singularity = Math.max(0, Number(draft.resources.singularity || draft.singularity || 0));
    draft.singularity = draft.resources.singularity;
    draft.structures = draft.structures || {};
    if (typeof draft.structures.massProjector !== "number") {
      draft.structures.massProjector = draft.massDriverBuilt ? 1 : 0;
    }
    if (typeof draft.structures.miningMachine !== "number") {
      draft.structures.miningMachine = Number(draft.miningDrones || 0);
    }
    if (typeof draft.structures.fusionGenerator !== "number") {
      draft.structures.fusionGenerator = Number(draft.fusionGenerators || 0);
    }
    draft.fusionGenerators = Math.max(Number(draft.fusionGenerators || 0), Number(draft.structures.fusionGenerator || 0));
    if (typeof draft.systems.ui.autoSmelterDiscovered !== "boolean") {
      draft.systems.ui.autoSmelterDiscovered =
        !!draft.hasRefiningFurnace && (Number(draft.resources.alloy || 0) >= 3 || Number(draft.autoSmelters || 0) > 0);
    }
    draft.systems.ui.outpostMenuLocked = false;
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
    if (typeof draft.systems.expedition.deepSpaceLogNextAt !== "number") {
      draft.systems.expedition.deepSpaceLogNextAt = 0;
    }
    if (typeof draft.systems.expedition.status !== "string") {
      draft.systems.expedition.status = "IDLE";
    }
    if (typeof draft.systems.expedition.currentRegion !== "string" || !draft.systems.expedition.currentRegion) {
      draft.systems.expedition.currentRegion = dist >= 50000 ? "哨所遗迹区" : (dist >= 5000 ? "补给星区" : "荒芜带");
    }
    if (typeof draft.systems.expedition.targetDistance !== "number") {
      draft.systems.expedition.targetDistance = dist >= 5000 ? 15000 : 5000;
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
    if (dist >= 100000) {
      const missedMilestones = [60000, 70000, 80000, 90000];
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
      draft.systems.tech = draft.systems.tech || {};
      draft.systems.tech.singularityUnlocked = true;
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
    } else if (draft.systems && draft.systems.tech && typeof draft.systems.tech.shieldLevel === "number") {
      draft.upgrades.shieldLevel = draft.systems.tech.shieldLevel;
    }
    draft.helium3 = draft.resources && typeof draft.resources.helium3 === "number" ? draft.resources.helium3 : 0;
    if (typeof draft.resources.magneticArray !== "number") {
      draft.resources.magneticArray = Number(draft.arrays || 0);
    }
    if (typeof draft.structures.magneticArray !== "number") {
      draft.structures.magneticArray = Number(draft.arrays || draft.resources.magneticArray || 0);
    }
    draft.arrays = Number(draft.arrays || draft.structures.magneticArray || draft.resources.magneticArray || 0);
    draft.structures.magneticArray = draft.arrays;
    draft.resources.magneticArray = draft.arrays;
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
    draft.combat = draft.combat || {};
    draft.combat.attackSystems = draft.combat.attackSystems || {};
    draft.combat.defenseSystems = draft.combat.defenseSystems || {};
    draft.flags = draft.flags || {};
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
    syncColonyCapacityInDraft(draft);
  });
  if (
    state.systems &&
    state.systems.expedition &&
    state.systems.expedition.outpostRecovered &&
    !state.blueprints.maintenanceCenter
  ) {
    setState((draft) => {
      draft.blueprints.maintenanceCenter = true;
    });
  }
  isAutomationLoggingEnabled = !!(state.systems && state.systems.ui && state.systems.ui.automationLoggingEnabled);
  if (state.arrays < state.resources.magneticArray) {
    setState((draft) => {
      draft.arrays = draft.resources.magneticArray;
    });
  }
  if (state.ReactorCoreActive && !state.systems.reactorActive) {
    setState((draft) => {
      draft.systems.reactorActive = true;
    });
  }
  if (state.isVaultRepaired) {
    startEngine();
  }
  if (state.population === 0 && state.isVaultRepaired && state.oxygen <= 0) {
    setState((draft) => {
      draft.oxygen = 100;
    });
  }
  updateRates();
  updateUiAutomationState();
  checkSystems();
  const uiSpace = getUiSpaceApi();
  if (uiSpace && typeof uiSpace.refreshThrustUI === "function") {
    try {
      uiSpace.refreshThrustUI();
    } catch (error) {
      console.warn("[推力UI] 初始化刷新失败。", error);
    }
  }
  setState((draft) => {
    if (!draft.systems.overclockAdjustedLogged) {
      draft.systems.overclockAdjustedLogged = true;
    }
  });
  if (state.isTechEra) {
    addLog({ id: "overclock-adjusted", once: true, text: "能源核心已完成超频调整。" });
    addLog({ id: "industrial-overclock-sync", once: true, text: "工业系统已完成超频升级，所有看板信息已同步。" });
    addLog({ id: "industrial-balance-updated", once: true, text: "工业平衡协议已更新：磁力阵列效能提升，熔炼成本已优化。" });
    addLog({ id: "deep-space-protocol", once: true, text: "深空探索协议已启动：质量投射器就绪，轨道资源链已建立。" });
    addLog({ id: "power-fusion-rebuild", once: true, text: "电力传输协议已重构：聚变能源已接入，能源供应进入稳定态。" });
    addLog({
      id: "deep-space-threshold-relaxed",
      once: true,
      text: "深空准入标准已放宽：投射平台成本降低，资源看板精度已优化（取整）。"
    });
    addLog({
      id: "expedition-protocol-ignite",
      once: true,
      text: "远征协议已激活：主引擎已点火，人类的脚步已跨越地表限制。"
    });
    addLog({
      id: "deep-space-ui-chain-rebuild",
      once: true,
      text: "深空指挥链路已重构：生产日志已过滤，轨道视图已独立。"
    });
    addLog({
      id: "command-chain-refactor-done",
      once: true,
      text: "指挥链路重构完成：地表后勤已归档至二级系统，深空视图现已完全独立。"
    });
    addLog({
      id: "overdrive-params-rebuilt",
      once: true,
      text: "推进系统参数已重构：过载模式上限提升，低级信号过滤已生效。"
    });
    addLog({
      id: "resource-protocol-rewrite",
      once: true,
      text: "资源获取协议已重写：磁力/离子能级大幅提升，聚变堆反应强度已上调。"
    });
    addLog({
      id: "ui-visual-rollback-throttle-online",
      once: true,
      text: "UI 视觉协议已回滚：深空推进器手动调节模块已上线，资源流速已重新校准。"
    });
    addLog({
      id: "deep-space-mapping-updated",
      once: true,
      text: "深空测绘协议已更新：星火号哨所坐标已锁定，第一阶段远征目标明确。"
    });
    addLog({
      id: "free-roam-maintenance-online",
      once: true,
      text: "导航协议已重构为‘自由漫游’模式；自动维护中心模块已录入生产序列。"
    });
    addLog({
      id: "nav-computer-emergency-reboot",
      once: true,
      text: "导航计算机已重启：紧急动力协议已激活，自动维护蓝图已载入生产终端。"
    });
    addLog({
      id: "helium-chain-hard-reset",
      once: true,
      text: "核心采集协议已硬重置：氦-3 链路恢复，UI 渲染引擎同步完成。"
    });
    addLog({
      id: "deep-space-risk-density-updated",
      once: true,
      text: "安全协议已重写：灾难应对机制已加入缓冲冗余，10,000km 载员扩容协议就绪。"
    });
    addLog({
      id: "arch-refactor-module-era",
      once: true,
      text: "底层架构已重塑：阶段闸门协议已生效，深空协议将随航程逐步解锁。"
    });
  }
}

moundEngineApi = {
  combat: {
    engage: () => engageCombat(state, setState, addLog),
    flee: () => fleeCombat(state, setState, addLog)
  },
  CooldownManager,
  addLog,
  gainStardust,
  gainScrapMetal,
  forgeSealant,
  activateReactorCore,
  repairVault,
  manualOxygen,
  manualCharge,
  manualCrank,
  buildIonCatcher,
  buildRefiningFurnace,
  buildAutoSmelter,
  buildAutoSynthesizer,
  buildMassDriver,
  buildMaintenanceCenter,
  launchMiningDrone,
  buildFusionGenerator,
  scanNearbySector,
  continueVoyageFromSupply,
  scanSupplyAreaAndContinue,
  lockExpeditionTarget,
  toggleExpeditionOverdrive,
  setExpeditionThrottle,
  setAutomationLoggingEnabled,
  refineAlloy,
  activateStardustBeacon,
  deployMagneticArray,
  meltIceOre,
  upgradeCoreEfficiency,
  upgradeShieldTech,
  upgradeCycleTech,
  upgradeMiningTech,
  checkSystems,
  initEngine,
  startEngine,
  stopEngine
};
setEngineApi(moundEngineApi);
if (typeof window !== "undefined") {
  window.MoundEngine = moundEngineApi;
  window.dumpCombatState = () => {
    const s = gameState;
    const ui = s.systems && s.systems.ui;
    const enc = s.systems && s.systems.combatEncounter;
    const exp = s.systems && s.systems.expedition;
    console.table({
      "distanceKm": exp && exp.distanceKm,
      "combatSystemUnlocked": !!(s.flags && s.flags.combatSystemUnlocked),
      "combatState": s.combatState,
      "encounterPhase": enc && enc.phase,
      "showCombatModal": !!(ui && ui.showCombatModal),
      "activeEncounter": ui && ui.activeEncounter ? ui.activeEncounter.name : "null",
      "isNavigationLocked": !!(exp && exp.isNavigationLocked),
      "throttle": exp && exp.throttle,
      "expeditionActive": !!(exp && exp.active),
      "isEventActive": !!s.isEventActive,
      "modalRootInDom": !!(document.querySelector(".combat-modal-root"))
    });
    return "State dumped to console. Check the table above.";
  };
  window.forceMove = (speed = 500) => {
    window.gameState.expedition = window.gameState.expedition || {};
    window.gameState.expedition.velocity = speed;
    window.gameState.expedition.distance = window.gameState.expedition.distance || 0;
    window.gameState.expedition.distance += speed;
    if (window.getUiApi && typeof window.getUiApi() === "object" && typeof window.getUiApi().renderAll === "function") {
      window.getUiApi().renderAll(true);
    }
    console.log("Current Distance:", window.gameState.expedition.distance);
  };
}
initEngine();
})();

export const MoundEngine = moundEngineApi;
