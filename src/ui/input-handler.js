import { MoundEngine } from "../core/engine-runtime.js";
import { gameState, moundState } from "../core/state.js";
import { getUiApi } from "../core/runtime-hooks.js";

let combatEscapeHatchInstalled = false;

function installCombatEscapeHatch() {
  if (typeof window === "undefined" || combatEscapeHatchInstalled) {
    return;
  }
  combatEscapeHatchInstalled = true;
  window.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") {
      return;
    }
    const st = (typeof window !== "undefined" && window.gameState) ? window.gameState : (gameState || {});
    const cs = typeof st.combatState === "string" ? st.combatState : "IDLE";
    const ph = st.systems && st.systems.combatEncounter && st.systems.combatEncounter.phase;
    if (cs === "IDLE" && (!ph || ph === "IDLE")) {
      return;
    }
    event.preventDefault();
    if (!moundState || typeof moundState.setState !== "function") {
      return;
    }
    moundState.setState((draft) => {
      draft.combatState = "IDLE";
      draft.systems = draft.systems || {};
      draft.systems.expedition = draft.systems.expedition || {};
      draft.systems.expedition.isNavigationLocked = false;
      draft.systems.combatEncounter = draft.systems.combatEncounter && typeof draft.systems.combatEncounter === "object"
        ? draft.systems.combatEncounter
        : {};
      const enc = draft.systems.combatEncounter;
      enc.phase = "IDLE";
      enc.enemy = null;
      enc.massDriverCharging = false;
      const restore = enc.savedThrottle;
      if (typeof restore === "number" && restore > 0) {
        const maxThrust = Math.max(1, Number(draft.maxThrustLimit || draft.maxThrustMultiplier || 10));
        draft.systems.expedition.throttle = Math.min(maxThrust, restore);
      }
      enc.savedThrottle = null;
    });
    if (MoundEngine && typeof MoundEngine.addLog === "function") {
      MoundEngine.addLog("[调试] ESC — 已强制清空战斗状态（测试用）。");
    }
    console.log("ESC: Forcing Combat Idle");
    if (typeof window !== "undefined" && window.gameState) {
      window.gameState.combatState = "IDLE";
      window.gameState.systems = window.gameState.systems || {};
      window.gameState.systems.expedition = window.gameState.systems.expedition || {};
      window.gameState.systems.expedition.isNavigationLocked = false;
      window.gameState.systems.combatEncounter = window.gameState.systems.combatEncounter || {};
      window.gameState.systems.combatEncounter.phase = "IDLE";
    }
    const ui = (typeof window.getUiApi === "function" ? window.getUiApi() : null) || getUiApi();
    if (ui && typeof ui.renderAll === "function") {
      ui.renderAll(true);
      return;
    }
    console.warn("[Input] Escape cleared combat state, but UI API renderAll is unavailable.");
  }, true);
}

const DOM_DEEP_SPACE = "deep-space-actions-host";
const SPACE_ACTION_MAP = {
  buildMassDriver: "buildMassDriver",
  launchMiningDrone: "launchMiningDrone",
  buildFusionGenerator: "buildFusionGenerator",
  buildMaintenanceCenter: "buildMaintenanceCenter"
};

const boundRoots = new WeakSet();

function isSpaceActionInteractive(target) {
  if (!target || !target.closest) {
    return false;
  }
  const withinDeepSpace = !!target.closest(`#${DOM_DEEP_SPACE}`);
  if (!withinDeepSpace) {
    return false;
  }
  const st = gameState || {};
  const ui = st.systems && st.systems.ui ? st.systems.ui : {};
  const activeDeck = ui.activeDeck || "industry";
  const rawSub = ui.spaceSubDeck || "expedition";
  const subDeck = rawSub === "logistics" ? "expedition" : rawSub;
  const deepSpaceUnlocked = !!(
    st.systems &&
    st.systems.deepSpace &&
    st.systems.deepSpace.unlocked
  );
  return activeDeck === "space" && subDeck === "expedition" && deepSpaceUnlocked;
}

function handleSpaceAction(event) {
  const target = event.target && event.target.closest
    ? event.target.closest("button[data-space-action]")
    : null;
  if (!target || target.disabled || !isSpaceActionInteractive(target)) {
    return;
  }
  const actionKey = target.dataset.spaceAction || "";
  const engineMethod = SPACE_ACTION_MAP[actionKey];
  if (!engineMethod || !MoundEngine || typeof MoundEngine[engineMethod] !== "function") {
    return;
  }
  const ok = MoundEngine[engineMethod]();
  if (ok === false) {
    return;
  }
  const ui = getUiApi();
  if (ui && typeof ui.renderAll === "function") {
    ui.renderAll(true);
  }
  if (ui && typeof ui.syncResourceBarVisuals === "function") {
    if (typeof window !== "undefined") {
      window.lastManualUpdate = Date.now();
    }
    ui.syncResourceBarVisuals(true);
  }
}

export function initDeepSpaceInputDelegation(root) {
  installCombatEscapeHatch();
  const node = root && typeof root.addEventListener === "function" ? root : document;
  if (!node || boundRoots.has(node)) {
    return;
  }
  node.addEventListener("click", handleSpaceAction);
  boundRoots.add(node);
}
