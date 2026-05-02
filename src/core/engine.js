import { gameState, moundState, loadStateFromLocalStorage } from "./state.js";
import {
  getWorkerBridge,
  setWorkerBridge,
  setWorkerMode,
  getLogicTickMs,
  setLogicTickMs,
  setApplyingWorkerPatch
} from "./runtime-hooks.js";
import "../systems/constants.js";
import "../systems/items.js";
import "../systems/events/pool.js";
import "./storage.js";
import "../systems/economy/index.js";
import "../systems/world/exploration.js";
import "../systems/world/evolution.js";
import "../systems/events/runtime.js";
import { initBackgroundEffect } from "../ui/background-effect.js";

const currentActiveStateReference = (moundState && moundState.state) || gameState;
if (typeof window !== "undefined") {
  window.gameState = currentActiveStateReference;
}

function toWorkerPayload(value) {
  try {
    return JSON.parse(JSON.stringify(value || {}));
  } catch (error) {
    console.warn("[Worker] snapshot serialization failed, using empty payload.", error);
    return {};
  }
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      initBackgroundEffect();
    }, { once: true });
  } else {
    initBackgroundEffect();
  }
}

(async () => {
  const DIAGNOSTIC_MODE = false;
  loadStateFromLocalStorage();
  setWorkerMode("full");
  setLogicTickMs(100);
  if (DIAGNOSTIC_MODE && document && document.body) {
    document.body.classList.add("diagnostic-mode");
  }
  if (!getWorkerBridge()) {
    let worker = null;
    let onPatch = null;
    let onFatal = null;
    let pendingDeltaBuffer = null;
    let pendingEventsBuffer = [];
    let pendingControlBuffer = {};
    let pendingMetaBuffer = null;
    let flushScheduled = false;
    const fallbackNoop = () => {};

    function mergeDeep(target, source) {
      if (!source || typeof source !== "object") {
        return target || {};
      }
      const output = Object.assign({}, target || {});
      Object.keys(source).forEach((key) => {
        const sv = source[key];
        const tv = output[key];
        if (sv && typeof sv === "object" && !Array.isArray(sv) && tv && typeof tv === "object" && !Array.isArray(tv)) {
          output[key] = mergeDeep(tv, sv);
        } else {
          output[key] = sv;
        }
      });
      return output;
    }

    const supportsWorker = () => typeof Worker !== "undefined";

    function flushPendingPatch() {
      const flushStart = performance.now();
      flushScheduled = false;
      if (
        !pendingDeltaBuffer &&
        pendingEventsBuffer.length === 0 &&
        Object.keys(pendingControlBuffer).length === 0
      ) {
        return;
      }
      if (typeof onPatch !== "function") {
        pendingDeltaBuffer = null;
        pendingEventsBuffer = [];
        pendingControlBuffer = {};
        pendingMetaBuffer = null;
        return;
      }
      const payload = {
        type: "STATE_PATCH",
        delta: pendingDeltaBuffer || {},
        events: pendingEventsBuffer.length ? pendingEventsBuffer.slice() : null,
        control: Object.keys(pendingControlBuffer).length ? Object.assign({}, pendingControlBuffer) : null,
        now: pendingMetaBuffer ? pendingMetaBuffer.now : Date.now(),
        dtSec: pendingMetaBuffer ? pendingMetaBuffer.dtSec : 0
      };
      pendingDeltaBuffer = null;
      pendingEventsBuffer = [];
      pendingControlBuffer = {};
      pendingMetaBuffer = null;
      const applyStart = performance.now();
      setApplyingWorkerPatch(true);
      try {
        onPatch(payload);
      } finally {
        setApplyingWorkerPatch(false);
      }
      const applyEnd = performance.now();
      const flushEnd = applyEnd;
      if (applyEnd - applyStart > 16) {
        console.warn(`[Diag] STATE_PATCH应用耗时异常: ${(applyEnd - applyStart).toFixed(2)}ms`);
      }
      if (flushEnd - flushStart > 16) {
        console.warn(`[Diag] 渲染帧耗时异常: ${(flushEnd - flushStart).toFixed(2)}ms`);
      }
    }

    function schedulePatchFlush() {
      if (flushScheduled) {
        return;
      }
      flushScheduled = true;
      requestAnimationFrame(flushPendingPatch);
    }

    function ensureWorker() {
      if (worker || !supportsWorker()) {
        return worker;
      }
      worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
      worker.onmessage = (event) => {
        const data = event && event.data ? event.data : {};
        if (data.type === "STATE_PATCH" && typeof onPatch === "function") {
          const nextDelta = data.delta && typeof data.delta === "object" ? data.delta : null;
          if (nextDelta) {
            pendingDeltaBuffer = mergeDeep(pendingDeltaBuffer, nextDelta);
          }
          if (Array.isArray(data.events) && data.events.length) {
            pendingEventsBuffer = pendingEventsBuffer.concat(data.events);
          }
          if (data.control && typeof data.control === "object") {
            pendingControlBuffer = mergeDeep(pendingControlBuffer, data.control);
          }
          pendingMetaBuffer = {
            now: data.now,
            dtSec: data.dtSec
          };
          schedulePatchFlush();
        }
      };
      worker.onerror = (error) => {
        console.error("[Worker] runtime error:", error);
        if (typeof onFatal === "function") {
          onFatal(error);
        }
      };
      worker.onmessageerror = (error) => {
        console.error("[Worker] message error:", error);
        if (typeof onFatal === "function") {
          onFatal(error);
        }
      };
      return worker;
    }

    setWorkerBridge({
      supported: supportsWorker(),
      start(snapshot, tickMs, patchListener) {
        const w = ensureWorker();
        if (!w) {
          return false;
        }
        onPatch = typeof patchListener === "function" ? patchListener : null;
        try {
          w.postMessage({
            type: "INIT",
            snapshot: toWorkerPayload(snapshot),
            tickMs: Math.max(50, Number(tickMs || getLogicTickMs() || 100))
          });
        } catch (error) {
          console.error("[Worker] INIT postMessage failed:", error);
          if (typeof onFatal === "function") {
            onFatal(error);
          }
          return false;
        }
        return true;
      },
      sync(snapshot) {
        if (!worker) {
          return;
        }
        try {
          worker.postMessage({
            type: "SYNC_STATE",
            snapshot: toWorkerPayload(snapshot)
          });
        } catch (error) {
          console.error("[Worker] SYNC postMessage failed:", error);
          if (typeof onFatal === "function") {
            onFatal(error);
          }
        }
      },
      command(command, payload) {
        if (!worker || !command) {
          return;
        }
        try {
          worker.postMessage({
            type: "COMMAND",
            command,
            payload: toWorkerPayload(payload)
          });
        } catch (error) {
          console.error("[Worker] COMMAND postMessage failed:", error);
          if (typeof onFatal === "function") {
            onFatal(error);
          }
        }
      },
      stop() {
        if (!worker) {
          return;
        }
        worker.postMessage({ type: "STOP" });
        worker.terminate();
        worker = null;
        onPatch = null;
        onFatal = null;
        pendingDeltaBuffer = null;
        pendingEventsBuffer = [];
        pendingControlBuffer = {};
        pendingMetaBuffer = null;
        flushScheduled = false;
      },
      onPatch(listener) {
        onPatch = typeof listener === "function" ? listener : fallbackNoop;
      },
      onFatal(listener) {
        onFatal = typeof listener === "function" ? listener : null;
      }
    });
  }
  // Single entry ESM module tree: engine first, then UI (must run after setEngineApi / initEngine).
  await import("./engine-runtime.js");
  const rootUi = await import("../ui/root.js");
  if (typeof rootUi.bootstrapGameUi === "function") {
    rootUi.bootstrapGameUi();
  }

  // Console debugging helpers — exposed for devtools access
  if (typeof window !== "undefined") {
    window.engine = window.MoundEngine || null;
    window.renderAll = typeof rootUi.renderAll === "function" ? rootUi.renderAll.bind(rootUi) : null;
    window.gameState = window.state || window.gameState || null;

    window.rollbackDistance = function (km) {
      const s = window.state || window.gameState;
      if (!s) return console.error("[rollback] state not found");
      const num = Number(km);
      if (!Number.isFinite(num) || num < 0) return console.error("[rollback] invalid km:", num);

      // Validate ship combat levels are intact before jumping
      const combat = s.combat || {};
      const atkSys = combat.attackSystems || {};
      const defSys = combat.defenseSystems || {};
      const kin = atkSys.kineticCannon;
      const las = atkSys.laserArray;
      const shd = defSys.shieldGenerator;
      const arm = defSys.ablativeArmor;
      const hull = combat.hullHp;
      const baseDmg = combat.baseDamage;
      if (!kin || !las || !shd || !arm || !hull || !baseDmg) {
        console.warn(
          "[rollback] WARNING: Combat levels appear zeroed!",
          { kinetic: kin, laser: las, shield: shd, armor: arm, hull: hull, baseDamage: baseDmg }
        );
        console.warn(
          "[rollback] If this was caused by a time-anchor load, run the emergency fix script or reload a valid save."
        );
      }

      s.systems.expedition.distanceKm = num;
      // Prevent instant combat re-trigger by syncing lastTriggerKm
      if (s.systems && s.systems.combatEncounter) {
        s.systems.combatEncounter.lastTriggerKm = num;
      }
      // Purge any lingering combat UI
      const modal = document.getElementById("combat-modal-container");
      if (modal && modal.parentNode) modal.parentNode.removeChild(modal);
      if (document.body) document.body.classList.remove("combat-active");
      if (typeof rootUi.renderAll === "function") rootUi.renderAll(true);
      console.log("[时间回溯] 航程已重置为: " + num + " km");
    };

    window.jumpToDistance = function (km) {
      window.rollbackDistance(km);
    };
  }
})().catch((error) => {
  console.error("[Engine] Module bootstrap failed:", error);
});
