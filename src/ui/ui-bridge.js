/**
 * Binds modular store emissions (moundState / gameState) to DOM nodes.
 * Uses [data-state-path] on elements — not window.Mound.
 * Enable verbose Proxy logs: window.__MOUND_DEBUG_STATE_PROXY__ = true (see state.js).
 */
import { moundState, gameState } from "../core/state.js";
import { getEngineApi } from "../core/runtime-hooks.js";
import { computePopulationCap } from "../systems/colony-cap.js";

let warnedEngineNotReady = false;

function formatInt(value) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return String(value);
  }
  return String(Math.floor(value));
}

function getState() {
  return moundState && moundState.state ? moundState.state : gameState;
}

/**
 * Writes display text without touching innerHTML; skips write if unchanged to limit reflow.
 */
export function updateElementContent(el, value) {
  if (!el) {
    return;
  }
  const next = value === undefined || value === null ? "" : String(value);
  if (el.textContent !== next) {
    el.textContent = next;
  }
}

function resolvePath(root, path) {
  if (!root || !path) {
    return undefined;
  }
  return path.split(".").reduce((acc, key) => (acc != null ? acc[key] : undefined), root);
}

function pathChangeTouchesBinding(changedPath, bindPath) {
  if (!bindPath) {
    return false;
  }
  if (!changedPath) {
    return true;
  }
  const watch = bindingWatchList(bindPath);
  return watch.some(
    (prefix) => changedPath === prefix || changedPath.startsWith(`${prefix}.`)
  );
}

function bindingWatchList(bindPath) {
  if (bindPath === "oxygen") {
    return ["oxygen", "systems.oxygenSupplyLow", "resources.power", "resources"];
  }
  if (bindPath === "autoSmelters") {
    return ["autoSmelters", "resources.power", "resources"];
  }
  if (bindPath === "singularity" || bindPath === "resources.singularity") {
    return ["resources.singularity", "singularity", "distance", "systems.expedition.distanceKm", "systems.expedition"];
  }
  if (bindPath === "population") {
    return ["population", "populationCap"];
  }
  if (bindPath === "resources.power") {
    return [bindPath, "resources", "netRates.power", "netRates"];
  }
  if (bindPath.startsWith("resources.")) {
    return [bindPath, "resources"];
  }
  return [bindPath];
}

function formatTopBarLine(bindPath, state) {
  const s = state || getState();
  if (!s) {
    return "";
  }
  switch (bindPath) {
    case "resources.radiation":
      return `辐射值: ${formatInt(s.resources.radiation)}`;
    case "resources.stardust":
      return `星尘: ${formatInt(s.resources.stardust)}`;
    case "resources.scrapMetal":
      return `废金属: ${formatInt(s.resources.scrapMetal)}`;
    case "resources.sealant":
      return `密封剂: ${formatInt(s.resources.sealant)}`;
    case "resources.alloy":
      return `合金: ${formatInt(s.resources.alloy)}`;
    case "resources.helium3":
      return `氦-3: ${formatInt(s.resources.helium3)}`;
    case "autoSmelters":
      return `合金模组: ${s.autoSmelters > 0 && s.resources.power <= 60 ? `${s.autoSmelters}(停机)` : s.autoSmelters}`;
    case "resources.power":
      return `电力: ${Math.round(s.resources.power)}`;
    case "oxygen": {
      const low = s.systems && s.systems.oxygenSupplyLow;
      return low
        ? `氧气: ${formatInt(s.oxygen)}% (供能不足)`
        : `氧气: ${formatInt(s.oxygen)}%`;
    }
    case "population":
      return `载员: ${formatInt(s.population)}/${formatInt(computePopulationCap(s))}`;
    case "arrays":
      return `磁力阵列: ${s.arrays}`;
    case "ionCatchers":
      return `离子捕获器: ${s.ionCatchers}`;
    case "autoSynthesizers":
      return `合成仪: ${s.autoSynthesizers}`;
    case "miningDrones":
      return `采矿机: ${s.miningDrones || 0}`;
    case "singularity": {
      const v = Number(s.singularity || 0);
      return `奇点: ${formatInt(v)}`;
    }
    default: {
      const v = resolvePath(s, bindPath);
      if (v !== null && typeof v === "object") {
        return "";
      }
      return v === undefined || v === null ? "" : String(v);
    }
  }
}

function refreshPowerCriticalClass(el, state) {
  if (!el || el.dataset.statePath !== "resources.power") {
    return;
  }
  const neg = ((state.netRates && state.netRates.power) || 0) < 0;
  el.classList.toggle("power-critical", !!neg);
}

function refreshOxygenAlertClass(el, state) {
  if (!el || el.dataset.statePath !== "oxygen") {
    return;
  }
  el.className = state.oxygen < 30 ? "oxygen-alert" : "";
}

function refreshSingularityVisibility(el, state) {
  if (!el || (el.dataset.statePath !== "singularity" && el.dataset.statePath !== "resources.singularity")) {
    return;
  }
  const singularityValue = Number((state.resources && state.resources.singularity) || state.singularity || 0);
  const dist = Number(
    (state.systems && state.systems.expedition) ? (state.systems.expedition.distanceKm || 0) : 0
  );
  const unlocked = singularityValue > 0 || dist >= 100000;
  el.style.display = unlocked ? "inline-block" : "none";
}

function syncDomFromState(changedPath) {
  if (!getEngineApi()) {
    if (!warnedEngineNotReady) {
      warnedEngineNotReady = true;
      console.warn("UI Init: Engine not ready — state DOM bridge skipping updates.");
    }
    return;
  }
  warnedEngineNotReady = false;
  const state = getState();
  const nodes = typeof document !== "undefined" ? document.querySelectorAll("[data-state-path]") : [];
  nodes.forEach((el) => {
    const bindPath = el.getAttribute("data-state-path");
    if (!bindPath || !pathChangeTouchesBinding(changedPath, bindPath)) {
      return;
    }
    if (
      bindPath === "resources.radiation" ||
      bindPath === "resources.stardust" ||
      bindPath === "resources.scrapMetal" ||
      bindPath === "resources.sealant" ||
      bindPath === "resources.alloy" ||
      bindPath === "resources.helium3" ||
      bindPath === "autoSmelters" ||
      bindPath === "resources.power" ||
      bindPath === "oxygen" ||
      bindPath === "population" ||
      bindPath === "arrays" ||
      bindPath === "ionCatchers" ||
      bindPath === "autoSynthesizers" ||
      bindPath === "miningDrones" ||
      bindPath === "singularity"
    ) {
      return;
    }
    const line = formatTopBarLine(bindPath, state);
    updateElementContent(el, line);
    refreshPowerCriticalClass(el, state);
    refreshOxygenAlertClass(el, state);
    refreshSingularityVisibility(el, state);
  });
}

let bridgeStarted = false;
let domSyncRaf = 0;

export function startStateDomBridge() {
  if (bridgeStarted || !moundState || typeof moundState.subscribeImmediate !== "function") {
    return;
  }
  bridgeStarted = true;
  moundState.subscribeImmediate((event) => {
    if (!event || typeof event.path !== "string") {
      return;
    }
    if (domSyncRaf) {
      return;
    }
    domSyncRaf = requestAnimationFrame(() => {
      domSyncRaf = 0;
      syncDomFromState("");
    });
  });
}

startStateDomBridge();

function syncAllStateBoundDom() {
  syncDomFromState("");
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", syncAllStateBoundDom, { once: true });
  } else {
    queueMicrotask(syncAllStateBoundDom);
  }
}
