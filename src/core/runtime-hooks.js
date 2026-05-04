/** @file Bridge hooks — UI API, Worker bridge, and render scheduling shared across core, systems, and UI layers. */

const runtimeState = {
  workerBridge: null,
  workerMode: "full",
  logicTickMs: 100,
  applyingWorkerPatch: false,
  engineApi: null,
  uiApi: null,
  uiMainApi: null,
  uiSpaceApi: null,
  storageNeedsRender: false
};

let pendingFrame = 0;
const uiRenderQueue = [];
let batchQueued = false;
const writeQueue = [];

export function getWorkerBridge() {
  return runtimeState.workerBridge;
}

export function setWorkerBridge(bridge) {
  runtimeState.workerBridge = bridge || null;
}

export function getWorkerMode() {
  return runtimeState.workerMode;
}

export function setWorkerMode(mode) {
  runtimeState.workerMode = mode || "off";
}

export function getLogicTickMs() {
  return runtimeState.logicTickMs;
}

export function setLogicTickMs(value) {
  const next = Math.max(50, Number(value || 100));
  runtimeState.logicTickMs = Number.isFinite(next) ? next : 100;
}

export function getApplyingWorkerPatch() {
  return !!runtimeState.applyingWorkerPatch;
}

export function setApplyingWorkerPatch(flag) {
  runtimeState.applyingWorkerPatch = !!flag;
}

export function batchUiWrite(task) {
  if (typeof task !== "function") {
    return;
  }
  writeQueue.push(task);
  if (batchQueued) {
    return;
  }
  batchQueued = true;
  queueMicrotask(() => {
    batchQueued = false;
    const batch = writeQueue.splice(0, writeQueue.length);
    batch.forEach((fn) => {
      try {
        fn();
      } catch (error) {
        console.error("[UI] Batched write failed.", error);
      }
    });
  });
}

export function scheduleUiRender(task) {
  if (typeof task !== "function") {
    return;
  }
  uiRenderQueue.push(task);
  if (pendingFrame) {
    return;
  }
  pendingFrame = requestAnimationFrame(() => {
    pendingFrame = 0;
    const batch = uiRenderQueue.splice(0, uiRenderQueue.length);
    batch.forEach((fn) => {
      try {
        fn();
      } catch (error) {
        console.error("[UI] Batched render failed.", error);
      }
    });
  });
}

let engineApiEverRegistered = false;

export function setEngineApi(api) {
  runtimeState.engineApi = api || null;
  if (api) {
    engineApiEverRegistered = true;
  }
}

let warnedPrematureEngineApiAccess = false;

export function getEngineApi() {
  if (!runtimeState.engineApi && !engineApiEverRegistered && !warnedPrematureEngineApiAccess) {
    warnedPrematureEngineApiAccess = true;
    console.warn(
      "[RuntimeHooks] getEngineApi() was called before setEngineApi() ran with a live Engine. " +
        "UI or storage may be bootstrapping too early."
    );
  }
  return runtimeState.engineApi;
}

export function setUiApi(api) {
  runtimeState.uiApi = api || null;
  if (typeof window !== "undefined") {
    window.getUiApi = getUiApi;
  }
}

export function getUiApi() {
  return runtimeState.uiApi;
}

let applyDeckInDraftImpl = null;

/**
 * Registered from `root.js` so systems can sync `systems.ui` and root deck mirrors in one place.
 * @param {function|null} fn (draft, activeDeck, spaceSubDeck) => void
 */
export function registerApplyDeckInDraft(fn) {
  applyDeckInDraftImpl = typeof fn === "function" ? fn : null;
}

/** @returns {function|null} */
export function getApplyDeckInDraft() {
  return applyDeckInDraftImpl;
}

export function setUiMainApi(api) {
  runtimeState.uiMainApi = api || null;
}

export function getUiMainApi() {
  return runtimeState.uiMainApi;
}

export function setUiSpaceApi(api) {
  runtimeState.uiSpaceApi = api || null;
}

export function getUiSpaceApi() {
  return runtimeState.uiSpaceApi;
}

export function setStorageNeedsRender(flag) {
  runtimeState.storageNeedsRender = !!flag;
}

export function getStorageNeedsRender() {
  return !!runtimeState.storageNeedsRender;
}
