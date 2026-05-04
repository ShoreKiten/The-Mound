/** @file Exploration system — deep space scanning, outpost discovery, and region progression. */

import { gameState, moundState } from "../../core/state.js";
import { getEngineApi } from "../../core/runtime-hooks.js";
import { syncColonyCapacityInDraft } from "../colony-cap.js";

(() => {
  function getSectorByDistance(distanceKm) {
    const dist = Math.max(0, distanceKm || 0);
    if (dist >= 150000) {
      return "[未知深空]";
    }
    if (dist >= 50000) {
      return "[哨所遗迹区]";
    }
    return "[荒芜带]";
  }

  function nextMilestone(distanceKm) {
    const dist = Math.max(0, distanceKm || 0);
    if (dist < 30000) {
      return 30000;
    }
    if (dist < 60000) {
      return 60000;
    }
    if (dist < 100000) {
      return 100000;
    }
    return 0;
  }

  function isNearMilestone(distanceKm, thresholdKm = 500) {
    const target = nextMilestone(distanceKm);
    if (!target) {
      return false;
    }
    return target - Math.max(0, distanceKm || 0) <= thresholdKm;
  }

  function isEmergencyScanEligible(state) {
    const exp = state && state.systems && state.systems.expedition ? state.systems.expedition : {};
    const power = state && state.resources ? state.resources.power : 0;
    return power < 500 && (exp.drifting || (exp.throttle || 0) <= 1);
  }

  function shouldTriggerTenKMilestone(expeditionState) {
    if (!expeditionState) {
      return false;
    }
    return (expeditionState.distanceKm || 0) >= 10000 && !expeditionState.milestone10000Reached;
  }

  function stepHazardCheckpoint(expeditionState, stepKm = 2000) {
    if (!expeditionState) {
      return false;
    }
    return (expeditionState.distanceKm || 0) >= (expeditionState.nextHazardKm || stepKm);
  }

  // Kept as no-op to keep API stable while moving DOM concerns out of logic layer.
  function injectLateStageButtons() {
    return true;
  }

  function applyTenKMilestone() {
    if (!moundState || !moundState.state || !moundState.setState) {
      return false;
    }
    const exp = moundState.state.systems && moundState.state.systems.expedition ? moundState.state.systems.expedition : null;
    if (!exp || (exp.distanceKm || 0) < 10000 || exp.milestone10000Reached) {
      return false;
    }
    moundState.setState((draft) => {
      draft.systems.expedition.milestone10000Reached = true;
      draft.techEraEnabled = true;
      draft.isTechEra = true;
      draft.isAutoMaintenance = true;
      draft.population = Math.min(8, draft.population + 3);
      draft.blueprints.researchWorkstation = true;
      draft.blueprints.maintenanceCenter = true;
      draft.flags = draft.flags || {};
      draft.flags.isResearchStationBlueprintUnlocked = true;
      syncColonyCapacityInDraft(draft);
    });
    return true;
  }

  function applyHundredKMilestone() {
    if (!moundState || !moundState.state || !moundState.setState) {
      return false;
    }
    const st = moundState.state;
    const exp = st.systems && st.systems.expedition ? st.systems.expedition : null;
    const distance = Number(exp ? exp.distanceKm : 0);
    if (distance < 100000) {
      return false;
    }
    const unlocked = !!(st.systems && st.systems.tech && st.systems.tech.singularityUnlocked);
    const reached = !!(exp && exp.milestone100000Reached);
    if (unlocked && reached) {
      return false;
    }
    let shouldLog = false;
    moundState.setState((draft) => {
      draft.systems = draft.systems || {};
      draft.systems.expedition = draft.systems.expedition || {};
      draft.systems.tech = draft.systems.tech || {};
      draft.blueprints = draft.blueprints || {};
      if (!draft.systems.expedition.milestone100000Reached) {
        draft.systems.expedition.milestone100000Reached = true;
        draft.blueprints.quantumCommArray = true;
      }
      if (!draft.systems.tech.singularityUnlocked) {
        draft.systems.tech.singularityUnlocked = true;
        shouldLog = true;
      }
      draft.resources = draft.resources || {};
      if (typeof draft.resources.singularity !== "number") {
        draft.resources.singularity = Number(draft.singularity || 0);
      }
      if (typeof draft.singularity !== "number") {
        draft.singularity = 0;
      }
      draft.singularity = Number(draft.resources.singularity || draft.singularity || 0);
    });
    const engineHook = getEngineApi();
    if (shouldLog && engineHook && typeof engineHook.addLog === "function") {
      engineHook.addLog("监测到空间物理常数坍缩，[奇点] 模块已解锁。");
    }
    return true;
  }

  function shouldSilenceShieldInterceptLog(snapshot) {
    const state = snapshot || gameState || (moundState && moundState.state) || {};
    const dist = Number(
      (state.systems && state.systems.expedition) ? state.systems.expedition.distanceKm : 0
    ) || 0;
    return dist > 50000;
  }

  window.MoundSystems = window.MoundSystems || {};
  window.MoundSystems.space = {
    name: "space",
    ready: true,
    getSectorByDistance,
    isEmergencyScanEligible,
    nextMilestone,
    isNearMilestone,
    shouldTriggerTenKMilestone,
    stepHazardCheckpoint,
    injectLateStageButtons,
    applyTenKMilestone,
    applyHundredKMilestone,
    shouldSilenceShieldInterceptLog
  };
})();

export function shouldSilenceShieldInterceptLog(snapshot) {
  const space = window.MoundSystems && window.MoundSystems.space;
  if (space && typeof space.shouldSilenceShieldInterceptLog === "function") {
    return space.shouldSilenceShieldInterceptLog(snapshot);
  }
  return false;
}

export function processExpedition(snapshot) {
  const space = window.MoundSystems && window.MoundSystems.space;
  if (!space) {
    return { silentShieldLog: false };
  }
  return {
    silentShieldLog:
      typeof space.shouldSilenceShieldInterceptLog === "function"
        ? space.shouldSilenceShieldInterceptLog(snapshot)
        : false
  };
}
