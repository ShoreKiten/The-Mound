/**
 * Expedition: voyage distance checks, milestones, and combat encounter boundary integration.
 */

import { pullRandomEventText } from "../../ui/components/log.js";
import { tryTriggerCombatEncounter } from "./CombatManager.js";

export function getExpeditionDistance(state) {
  if (!state) {
    return 0;
  }
  const exp = state.systems && state.systems.expedition ? state.systems.expedition : null;
  if (exp && exp.distanceKm != null && exp.distanceKm !== "") {
    const n = Number(exp.distanceKm);
    return Math.max(0, Number.isFinite(n) ? n : 0);
  }
  return 0;
}

export function resolveMaxThrustLimit(state) {
  const s = state || {};
  const fromLimit = typeof s.maxThrustLimit === "number" ? s.maxThrustLimit : null;
  const fromLegacy = typeof s.maxThrustMultiplier === "number" ? s.maxThrustMultiplier : null;
  return Math.max(1, Math.floor(fromLimit || fromLegacy || 10));
}

export function runExpeditionDistanceChecks(state, setState, addLog) {
  if (!state || typeof setState !== "function" || typeof addLog !== "function") {
    return;
  }
  const exp = state.systems && state.systems.expedition ? state.systems.expedition : {};
  const distance = getExpeditionDistance(state);
  const maxThrust = resolveMaxThrustLimit(state);
  const throttle = Math.max(0, Math.min(maxThrust, Number(exp.throttle || 0)));
  const isVoyaging = throttle > 0 && !!exp.active;
  const milestones = [
    { key: "m5000", km: 5000, text: "5000km 里程碑已达成，补给坐标信道已稳定。" },
    { key: "m10000", km: 10000, text: "10000km 航程确认，深空科研协议进入常态。" },
    { key: "m25000", km: 25000, text: "25000km 航程确认，远征风险等级上调。" }
  ];
  const reachedMap = Object.prototype.toString.call(exp.milestonesReached) === "[object Object]" ? exp.milestonesReached : {};
  const newlyReached = milestones.filter((item) => distance >= item.km && !reachedMap[item.key]);
  const nextRandomKm = Number(exp.nextRandomEventKm || 0);
  const lastBroadcastKm = Math.max(0, Number(exp.lastBroadcastKm || 0));
  const distanceStepKm = Math.floor(distance / 1000) * 1000;
  const shouldTriggerRandom = isVoyaging && distance >= (nextRandomKm > 0 ? nextRandomKm : 0);
  const shouldBroadcast = isVoyaging && Math.floor(distance / 1000) > Math.floor(lastBroadcastKm / 1000);
  let randomEventType = "";
  let randomFlavorText = "";

  if (!newlyReached.length && !shouldTriggerRandom && !shouldBroadcast && nextRandomKm > 0) {
    return;
  }

  setState((draft) => {
    draft.systems = draft.systems || {};
    draft.systems.expedition = draft.systems.expedition || {};
    if (Object.prototype.toString.call(draft.systems.expedition.milestonesReached) !== "[object Object]") {
      draft.systems.expedition.milestonesReached = {};
    }
    newlyReached.forEach((item) => {
      draft.systems.expedition.milestonesReached[item.key] = true;
    });
    if (Number(draft.systems.expedition.nextRandomEventKm || 0) <= 0) {
      draft.systems.expedition.nextRandomEventKm = distance + 1000;
    }
    const dueKm = Number(draft.systems.expedition.nextRandomEventKm || 0);
    if (isVoyaging && distance >= dueKm) {
      draft.resources = draft.resources || {};
      const roll = Math.random();
      if (roll < 0.34) {
        const loss = Math.max(120, Number(draft.resources.power || 0) * 0.08);
        draft.resources.power = Math.max(0, Number(draft.resources.power || 0) - loss);
        randomEventType = "solar";
      } else if (roll < 0.67) {
        const sealLoss = Math.max(20, Number(draft.resources.sealant || 0) * 0.05);
        draft.resources.sealant = Math.max(0, Number(draft.resources.sealant || 0) - sealLoss);
        randomEventType = "micro";
      } else {
        draft.resources.scrapMetal = Number(draft.resources.scrapMetal || 0) + 240;
        draft.resources.alloy = Number(draft.resources.alloy || 0) + 20;
        randomEventType = "cargo";
      }
      randomFlavorText = pullRandomEventText("minor-voyage") || "";
      draft.systems.expedition.nextRandomEventKm = distance + 1000;
    }
    if (shouldBroadcast) {
      draft.systems.expedition.lastBroadcastKm = distanceStepKm;
      if (!randomFlavorText) {
        randomFlavorText = pullRandomEventText("minor-voyage") || "";
      }
    }
  });

  newlyReached.forEach((item) => addLog(item.text));
  if (randomEventType === "solar") {
    addLog("太阳耀斑掠过航道，主电网出现明显压降。");
  } else if (randomEventType === "micro") {
    addLog("微陨石群擦伤外层装甲，舱体修复储备下降。");
  } else if (randomEventType === "cargo") {
    addLog("发现废弃货舱，成功回收可用资源。");
  }
  if (randomFlavorText) {
    addLog(String(randomFlavorText).replace(/^\s*\[[^\]]+\]\s*/, ""));
  }
}

const ENCOUNTER_MIN_KM = 100000;
const ENCOUNTER_STEP_KM = 3000;

/**
 * First encounter boundary (km) strictly after `prevKm` and at or before `nextKm`.
 * @param {number} prevKm
 * @param {number} nextKm
 * @returns {number | null}
 */
export function findEncounterBoundaryKm(prevKm, nextKm) {
  const prev = Number(prevKm) || 0;
  const next = Number(nextKm) || 0;
  const bucketCrossed =
    next >= ENCOUNTER_MIN_KM && Math.floor(prev / ENCOUNTER_STEP_KM) < Math.floor(next / ENCOUNTER_STEP_KM);
  if (!bucketCrossed) {
    return null;
  }
  const lo = Math.min(prev, next);
  const hi = Math.max(prev, next);
  const firstBoundary = Math.ceil(ENCOUNTER_MIN_KM / ENCOUNTER_STEP_KM) * ENCOUNTER_STEP_KM;
  for (let m = firstBoundary; m <= hi + 1e-9; m += ENCOUNTER_STEP_KM) {
    if (lo < m && hi >= m) {
      return Math.floor(m);
    }
  }
  return null;
}

/**
 * Run once per expedition integration step after distance has advanced.
 *
 * @param {object} state
 * @param {function} setState
 * @param {function} addLog
 * @param {number} prevKm
 * @param {number} nextKm
 * @param {number} dtSec
 */
export function runExpeditionEncounterStep(state, setState, addLog, prevKm, nextKm, dtSec) {
  if (!state || typeof setState !== "function") {
    return;
  }
  void dtSec;

  // Boss trigger: detect crossing 200,000 km exactly
  // MUST run before any regular encounter boundary check to guarantee priority.
  const bossCrossed = Number(prevKm || 0) < 200000 && Number(nextKm || 0) >= 200000;
  if (bossCrossed) {
    const omegaDefeated = !!(state.flags && state.flags.omegaDefeated);
    const debugOverride = typeof window !== "undefined" && window.debugMode;
    if (!omegaDefeated || debugOverride) {
      // Force-reset any stale encounter state that may have been set by the
      // combat watchdog on the same tick.  This guarantees the boss always wins.
      const encNow = state.systems && state.systems.combatEncounter;
      if (encNow && encNow.phase && encNow.phase !== "IDLE") {
        setState((draft) => {
          const enc = draft.systems && draft.systems.combatEncounter;
          if (enc) {
            enc.phase = "IDLE";
            enc.enemy = null;
            enc.lastTriggerKm = null;
            enc.lastResolution = null;
          }
          if (typeof draft.combatState === "string") {
            draft.combatState = "IDLE";
          }
        });
      }
      const opened = tryTriggerCombatEncounter(state, setState, addLog, 200000, {
        immediateEngage: false,
        focusTacticalDeck: true
      });
      if (opened) return;
    }
  }

  const boundaryKm = findEncounterBoundaryKm(prevKm, nextKm);
  if (boundaryKm === null) {
    return;
  }
  const opened = tryTriggerCombatEncounter(state, setState, addLog, boundaryKm, {
    immediateEngage: false,
    focusTacticalDeck: true
  });
  if (!opened) {
    return;
  }
}

if (typeof window !== "undefined") {
  window.MoundExpeditionSystem = {
    getExpeditionDistance,
    resolveMaxThrustLimit,
    runExpeditionDistanceChecks,
    findEncounterBoundaryKm,
    runExpeditionEncounterStep
  };
}
