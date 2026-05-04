/** @file Expedition console bridge — renders voyage panel, throttle UI, and deep-space status. */

import { gameState, moundState } from "../core/state.js";
import { setUiSpaceApi, getUiApi, getEngineApi } from "../core/runtime-hooks.js";

const DOM_DEEP_SPACE = "deep-space-actions-host";

let uiSpaceApi = {
  formatEta: () => "00:00:00",
  applySpaceTheme: () => {},
  bindThrottleSlider: () => {},
  renderExpeditionConsole: () => {},
  showMajorDecision: () => {},
  destroyDecisionOverlay: () => {},
  updateSliderRange: () => {},
  updateThrustText: () => {},
  refreshThrustUI: () => {}
};

(() => {
  let lastKnownMaxThrust = 10;
  let isSyncingThrustLimit = false;
  let lastMaxThrust = null;
  let lastThrottleValue = null;
  let lastThrustSliderNode = null;
  let lastThrustLabelNode = null;
  let lastDistanceSampleKm = 0;
  let lastDistanceSampleAt = 0;
  let lastDistanceSpeedKps = 0;
  let expeditionLiveRaf = 0;

  function pad2(value) {
    return String(value).padStart(2, "0");
  }

  function formatInt(value) {
    if (typeof value !== "number" || Number.isNaN(value)) {
      return String(value);
    }
    return String(Math.floor(value));
  }

  function formatEta(totalSeconds) {
    const safe = Math.max(0, Math.floor(totalSeconds || 0));
    const hours = Math.floor(safe / 3600);
    const minutes = Math.floor((safe % 3600) / 60);
    const seconds = safe % 60;
    return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`;
  }

  function updateDOM(id, value, root) {
    const scope = root && typeof root.querySelector === "function" ? root : document;
    const el = scope.getElementById ? scope.getElementById(id) : scope.querySelector(`#${id}`);
    const next = String(value);
    if (el && el.textContent !== next) {
      el.textContent = next;
    }
    return el;
  }

  function applySpaceTheme(expeditionState) {
    void expeditionState;
    document.body.style.backgroundColor = "#1a1a1a";
  }

  function bindThrottleSlider(slider, onInput) {
    if (!slider) {
      return;
    }
    slider.addEventListener("input", (event) => {
      const value = parseInt(event.target.value, 10) || 0;
      if (typeof onInput === "function") {
        onInput(value, slider);
      }
    });
  }

  function getExpeditionReadout(state) {
    const exp = state && state.systems && state.systems.expedition ? state.systems.expedition : {};
    const distanceKm = Number(exp.distanceKm || 0);
    const nowMs = Date.now();
    if (!lastDistanceSampleAt) {
      lastDistanceSampleAt = nowMs;
      lastDistanceSampleKm = distanceKm;
      lastDistanceSpeedKps = 0;
    } else if (nowMs > lastDistanceSampleAt) {
      const dt = (nowMs - lastDistanceSampleAt) / 1000;
      if (dt >= 0.05) {
        lastDistanceSpeedKps = Math.max(0, (distanceKm - lastDistanceSampleKm) / dt);
        lastDistanceSampleAt = nowMs;
        lastDistanceSampleKm = distanceKm;
      }
    }
    const sectorResolver = window.MoundSystems && window.MoundSystems.space && window.MoundSystems.space.getSectorByDistance;
    const dynamicSector = typeof sectorResolver === "function"
      ? sectorResolver(distanceKm)
      : (distanceKm >= 150000 ? "未知深空" : (distanceKm >= 50000 ? "哨所遗迹区" : "荒芜带"));
    const sector = typeof exp.currentRegion === "string" && exp.currentRegion ? exp.currentRegion : dynamicSector;
    return { sector, distanceKm, speedKps: lastDistanceSpeedKps };
  }

  function updateExpeditionDistanceDisplay(state) {
    const snapshot = state || (moundState && moundState.state) || gameState || {};
    const distanceEl = document.getElementById("distance-display");
    const speedEl = document.getElementById("speed-display");
    if (!distanceEl || !speedEl) {
      return;
    }
    const readout = getExpeditionReadout(snapshot);
    distanceEl.textContent = `${readout.distanceKm.toFixed(2)} km`;
    speedEl.textContent = `${readout.speedKps.toFixed(2)} km/s`;
  }

  function ensureExpeditionLiveTicker() {
    if (expeditionLiveRaf) {
      return;
    }
    const step = () => {
      expeditionLiveRaf = requestAnimationFrame(step);
      updateExpeditionDistanceDisplay();
    };
    expeditionLiveRaf = requestAnimationFrame(step);
  }

  function safeGetMaxThrust(state) {
    const gs = state || gameState || (moundState && moundState.state) || {};
    try {
      const limit = Number(gs.maxThrustLimit) || 10;
      const legacy = Number(gs.maxThrustMultiplier) || 10;
      let resolved = Math.max(limit, legacy, 10);
      lastKnownMaxThrust = Math.max(10, Math.floor(Number(lastKnownMaxThrust || resolved || 10)));
      const completed = Array.isArray(gs.completedEvents) ? gs.completedEvents : [];
      const reached50kMilestone = completed.includes(50000);
      if (resolved > lastKnownMaxThrust) {
        lastKnownMaxThrust = resolved;
      } else if (resolved < lastKnownMaxThrust && lastKnownMaxThrust > 10) {
        const isLegalDownshift = resolved === 8 || !reached50kMilestone;
        if (isLegalDownshift) {
          lastKnownMaxThrust = resolved;
        } else {
          resolved = lastKnownMaxThrust;
        }
      }
      resolved = Math.max(10, Math.floor(Number(resolved) || 10));
      if (!isSyncingThrustLimit && gs && (gs.maxThrustLimit !== resolved || gs.maxThrustMultiplier !== resolved)) {
        isSyncingThrustLimit = true;
        try {
          gs.maxThrustLimit = resolved;
          gs.maxThrustMultiplier = resolved;
        } finally {
          isSyncingThrustLimit = false;
        }
      }
      return resolved;
    } catch (error) {
      console.warn("[推力UI] 上限解析失败，回退默认值10。", error);
      return 10;
    }
  }

  function updateThrustText(label, currentValue, maxLimit) {
    if (!label) {
      return;
    }
    const current = Math.max(0, Math.floor(Number(currentValue) || 0));
    label.style.display = "block";
    label.style.color = "#eeeeee";
    label.textContent = `推力档位: ${current} / ${maxLimit}`;
  }

  function updateThrustTextCompat(currentValue) {
    const gs = gameState || (moundState && moundState.state) || {};
    const maxLimit = safeGetMaxThrust(gs);
    const label = document.getElementById("thrust-label");
    const resolvedCurrent =
      typeof currentValue === "number"
        ? currentValue
        : (gs.systems && gs.systems.expedition ? gs.systems.expedition.throttle : (gs.thrustMultiplier || 0));
    updateThrustText(label, resolvedCurrent, maxLimit);
  }

  function updateSliderRange(slider, limit) {
    if (!slider) {
      return;
    }
    if (slider.max !== String(limit)) {
      slider.max = String(limit);
    }
    slider.step = "1";
    if (Number(slider.value || 0) > limit) {
      slider.value = String(limit);
    }
  }

  function updateSliderRangeCompat() {
    const gs = gameState || (moundState && moundState.state);
    if (!gs) {
      return;
    }
    const slider = document.getElementById("thrust-slider");
    if (!slider) {
      return;
    }
    updateSliderRange(slider, safeGetMaxThrust(gs));
  }

  function refreshThrustUI(currentValue) {
    const gs = gameState || (moundState && moundState.state);
    if (!gs) {
      return;
    }
    const maxLimit = safeGetMaxThrust(gs);
    const resolvedCurrent =
      typeof currentValue === "number"
        ? currentValue
        : (gs.systems && gs.systems.expedition ? gs.systems.expedition.throttle : (gs.thrustMultiplier || 0));
    const current = Math.max(0, Math.floor(Number(resolvedCurrent) || 0));
    const slider = document.getElementById("thrust-slider");
    const label = document.getElementById("thrust-label");
    const domChanged = slider !== lastThrustSliderNode || label !== lastThrustLabelNode;
    const maxChanged = maxLimit !== lastMaxThrust;
    if (slider && (domChanged || maxChanged)) {
      updateSliderRange(slider, maxLimit);
    }
    if (slider && Number(slider.value || 0) !== current) {
      slider.value = String(Math.max(0, Math.min(maxLimit, current)));
    }
    const currentChanged = current !== lastThrottleValue;
    if (label && (domChanged || maxChanged || currentChanged)) {
      updateThrustText(label, current, maxLimit);
    }
    const overLamp = document.getElementById("thrust-overlamp");
    if (overLamp) {
      overLamp.className = current > 5 ? "status-lamp overdrive-on" : "status-lamp";
    }
    lastThrustSliderNode = slider;
    lastThrustLabelNode = label;
    lastMaxThrust = maxLimit;
    lastThrottleValue = current;
  }

  function destroyDecisionOverlay() {
    const prev = document.getElementById("decision-overlay");
    if (prev && prev.parentNode) {
      prev.parentNode.removeChild(prev);
    }
  }

  function showMajorDecision(distance) {
    const runtime = window.MoundEventRuntime || {};
    const state = gameState || (moundState && moundState.state);
    if (!state || !runtime || typeof runtime.getMajorDecision !== "function") {
      return;
    }
    const decision = runtime.getMajorDecision(distance);
    if (!decision || !document.body) {
      return;
    }
    destroyDecisionOverlay();
    const overlay = document.createElement("div");
    overlay.id = "decision-overlay";
    overlay.className = "decision-overlay";

    const panel = document.createElement("div");
    panel.className = "decision-panel";
    const title = document.createElement("div");
    title.className = "decision-panel-title";
    title.textContent = `深空决策事件 · ${distance}km · ${decision.title}`;
    const desc = document.createElement("div");
    desc.className = "decision-panel-desc";
    desc.textContent = decision.description;
    const warning = document.createElement("div");
    warning.className = "decision-warning";
    panel.appendChild(title);
    panel.appendChild(desc);

    const optionsFrag = document.createDocumentFragment();
    (decision.options || []).forEach((opt, idx) => {
      const row = document.createElement("div");
      row.className = "decision-option-row";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "action-btn";
      btn.textContent = `${opt.label} · ${opt.costText} · ${opt.rewardText}`;
      btn.addEventListener("click", () => {
        const latest = moundState && moundState.state ? moundState.state : state;
        const okay =
          typeof runtime.canAffordMajorDecision === "function"
            ? runtime.canAffordMajorDecision(latest, distance, opt.id)
            : true;
        if (!okay) {
          warning.textContent = "资源不足，无法执行此方案。";
          return;
        }
        const applied =
          typeof runtime.applyMajorDecisionChoice === "function"
            ? runtime.applyMajorDecisionChoice(latest, moundState.setState, distance, opt.id)
            : { ok: false };
        if (!applied.ok) {
          warning.textContent = "资源不足，无法执行此方案。";
          return;
        }
        const engine = getEngineApi();
        if (engine && typeof engine.addLog === "function") {
          engine.addLog(applied.logText || `[决策] ${opt.label} 已执行。`);
        }
        refreshThrustUI();
        if (engine && typeof engine.checkSystems === "function") {
          engine.checkSystems();
        }
        destroyDecisionOverlay();
        const uiHook = getUiApi();
        if (uiHook && typeof uiHook.renderAll === "function") {
          uiHook.renderAll();
        }
      });
      row.appendChild(btn);
      optionsFrag.appendChild(row);
      if (idx < decision.options.length - 1) {
        const sep = document.createElement("div");
        sep.className = "decision-sep";
        sep.textContent = "---";
        optionsFrag.appendChild(sep);
      }
    });
    panel.appendChild(optionsFrag);
    panel.appendChild(warning);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
  }

  function ensureExpeditionConsoleStructure(container, requestRender) {
    if (!container || container.dataset.expeditionConsoleInit === "1") {
      return;
    }
    container.dataset.expeditionConsoleInit = "1";
    const fragment = document.createDocumentFragment();
    const title = document.createElement("div");
    title.textContent = "远征控制台";
    title.className = "space-status-row";
    fragment.appendChild(title);
    const lockRow = document.createElement("div");
    lockRow.id = "expedition-lock-row";
    lockRow.className = "space-status-row";
    lockRow.textContent = "推进联锁校验中";
    const checklist = document.createElement("div");
    checklist.id = "expedition-lock-checklist";
    checklist.className = "space-status-row";
    const lockActions = document.createElement("div");
    lockActions.id = "expedition-lock-actions";
    lockActions.className = "space-status-row";
    lockActions.style.display = "none";
    const continueBtn = document.createElement("button");
    continueBtn.id = "expedition-continue-btn";
    continueBtn.className = "action-btn";
    continueBtn.type = "button";
    continueBtn.textContent = "继续航行";
    const scanBtn = document.createElement("button");
    scanBtn.id = "expedition-scan-btn";
    scanBtn.className = "action-btn";
    scanBtn.type = "button";
    scanBtn.textContent = "扫描区域";
    lockActions.appendChild(continueBtn);
    lockActions.appendChild(scanBtn);
    fragment.appendChild(lockRow);
    fragment.appendChild(checklist);
    fragment.appendChild(lockActions);
    const voyageRow = document.createElement("div");
    voyageRow.id = "expedition-voyage-row";
    voyageRow.className = "space-status-row expedition-live-row";
    const distancePrefix = document.createElement("span");
    distancePrefix.textContent = "已航行距离: ";
    const voyageDistance = document.createElement("span");
    voyageDistance.id = "distance-display";
    voyageDistance.textContent = "0.00 km";
    const speedPrefix = document.createElement("span");
    speedPrefix.textContent = "    当前航速: ";
    const voyageSpeed = document.createElement("span");
    voyageSpeed.id = "speed-display";
    voyageSpeed.textContent = "0.00 km/s";
    voyageRow.appendChild(distancePrefix);
    voyageRow.appendChild(voyageDistance);
    voyageRow.appendChild(speedPrefix);
    voyageRow.appendChild(voyageSpeed);
    fragment.appendChild(voyageRow);
    const thrustItem = document.createElement("div");
    thrustItem.className = "action-item expedition-live-row";
    const thrustLabel = document.createElement("div");
    thrustLabel.id = "thrust-label";
    thrustLabel.style.display = "block";
    thrustLabel.style.color = "#eeeeee";
    thrustLabel.textContent = "推力档位: 0 / 10";
    thrustItem.appendChild(thrustLabel);
    const thrustSlider = document.createElement("input");
    thrustSlider.id = "thrust-slider";
    thrustSlider.type = "range";
    thrustSlider.min = "0";
    thrustSlider.step = "1";
    thrustSlider.value = "0";
    bindThrottleSlider(thrustSlider, (value) => {
      const engine = getEngineApi();
      if (engine && typeof engine.setExpeditionThrottle === "function") {
        const ok = engine.setExpeditionThrottle(value);
        if (ok !== false && typeof requestRender === "function") {
          requestRender();
        }
      }
      refreshThrustUI(value);
    });
    thrustItem.appendChild(thrustSlider);
    const overLamp = document.createElement("span");
    overLamp.id = "thrust-overlamp";
    overLamp.className = "status-lamp";
    thrustItem.appendChild(overLamp);
    fragment.appendChild(thrustItem);
    container.appendChild(fragment);
  }

  function getExpeditionInterlockStatus(state) {
    const s = state || {};
    const structures = s.structures || {};
    const massProjector = Math.max(Number(structures.massProjector || 0), s.massDriverBuilt ? 1 : 0);
    const miningMachine = Math.max(Number(structures.miningMachine || 0), Number(s.miningDrones || 0));
    const fusionGenerator = Math.max(Number(structures.fusionGenerator || 0), Number(s.fusionGenerators || 0));
    return {
      massProjector,
      miningMachine,
      fusionGenerator,
      ready: massProjector >= 1 && miningMachine >= 1 && fusionGenerator >= 1
    };
  }

  function setConsoleVisibility(container, unlocked) {
    if (!container) {
      return;
    }
    const lockRow = container.querySelector("#expedition-lock-row");
    const checklist = container.querySelector("#expedition-lock-checklist");
    if (lockRow) {
      lockRow.style.display = unlocked ? "none" : "block";
    }
    if (checklist) {
      checklist.style.display = unlocked ? "none" : "block";
    }
    const liveRows = container.querySelectorAll(".expedition-live-row");
    liveRows.forEach((node) => {
      node.style.display = unlocked ? "" : "none";
    });
  }

  function renderExpeditionConsole(container, requestRender) {
    try {
      if (!container) {
        const host = document.getElementById(DOM_DEEP_SPACE);
        container = host && host.parentElement ? host.parentElement : null;
      }
      if (!container) return;
      const state = moundState && moundState.state;
      if (!state) return;
      ensureExpeditionConsoleStructure(container, requestRender);
      const interlock = getExpeditionInterlockStatus(state);
      const unlocked = !!state.isVaultRepaired && interlock.ready;
      setConsoleVisibility(container, unlocked);
      const lockRow = container.querySelector("#expedition-lock-row");
      const checklist = container.querySelector("#expedition-lock-checklist");
      const lockActions = container.querySelector("#expedition-lock-actions");
      const continueBtn = container.querySelector("#expedition-continue-btn");
      const scanBtn = container.querySelector("#expedition-scan-btn");
      const exp = state.systems && state.systems.expedition ? state.systems.expedition : {};
      const isNavigationLocked = !!((state.systems && state.systems.ui && state.systems.ui.outpostMenuLocked) || exp.isNavigationLocked);
      if (!unlocked) {
        lastDistanceSampleAt = 0;
        lastDistanceSampleKm = 0;
        lastDistanceSpeedKps = 0;
        if (lockRow) {
          lockRow.textContent = "远征控制台锁定：请先完成推进系统联锁";
        }
        if (checklist) {
          const lineMass = interlock.massProjector >= 1 ? "[x] 质量投射器: 已部署" : "[ ] 质量投射器: 待部署";
          const lineMining = interlock.miningMachine >= 1 ? "[x] 采矿协议: 已激活" : "[ ] 采矿协议: 未激活";
          const lineFusion = interlock.fusionGenerator >= 1 ? "[x] 氦-3 能源循环: 已建立" : "[ ] 氦-3 能源循环: 未建立";
          checklist.replaceChildren();
          [lineMass, lineMining, lineFusion].forEach((text) => {
            const row = document.createElement("div");
            row.textContent = text;
            checklist.appendChild(row);
          });
        }
        if (lockActions) {
          lockActions.style.display = "none";
        }
        return;
      }
      if (isNavigationLocked) {
        if (lockRow) {
          lockRow.textContent = "已抵达补给坐标：请选择下一步行动";
          lockRow.style.display = "block";
        }
        if (checklist) {
          checklist.replaceChildren();
          checklist.style.display = "none";
        }
        if (lockActions) {
          lockActions.style.display = "block";
        }
        if (continueBtn) {
          continueBtn.onclick = () => {
            const engine = getEngineApi();
            if (engine && typeof engine.continueVoyageFromSupply === "function") {
              engine.continueVoyageFromSupply();
            }
            if (typeof requestRender === "function") {
              requestRender();
            }
          };
        }
        if (scanBtn) {
          scanBtn.onclick = () => {
            const engine = getEngineApi();
            if (engine && typeof engine.scanSupplyAreaAndContinue === "function") {
              engine.scanSupplyAreaAndContinue();
            }
            if (typeof requestRender === "function") {
              requestRender();
            }
          };
        }
      } else {
        if (lockActions) {
          lockActions.style.display = "none";
        }
        if (checklist) {
          checklist.style.display = "none";
        }
      }
      updateExpeditionDistanceDisplay(state);
      const slider = document.getElementById("thrust-slider");
      if (slider) {
        slider.disabled = !unlocked || !!state.isEventActive || isNavigationLocked;
        slider.classList.toggle("btn-disabled", slider.disabled);
      }
      refreshThrustUI(exp.throttle || 0);
    } catch (error) {
      console.error("[推力UI] 远征控制台渲染失败。", error);
    }
  }

  uiSpaceApi = {
    formatEta,
    applySpaceTheme,
    bindThrottleSlider,
    renderExpeditionConsole,
    showMajorDecision,
    destroyDecisionOverlay,
    updateSliderRange: updateSliderRangeCompat,
    updateThrustText: updateThrustTextCompat,
    refreshThrustUI
  };
  setUiSpaceApi(uiSpaceApi);
  ensureExpeditionLiveTicker();
  if (document && typeof document.addEventListener === "function") {
    document.addEventListener("DOMContentLoaded", refreshThrustUI);
    window.addEventListener("load", () => {
      const uiHook = getUiApi();
      if (uiHook && typeof uiHook.renderAll === "function") {
        uiHook.renderAll();
      }
      refreshThrustUI();
    });
  }
})();

export function refreshThrustUI(currentValue) {
  return uiSpaceApi.refreshThrustUI(currentValue);
}

export function renderExpeditionConsole(container, requestRender) {
  return uiSpaceApi.renderExpeditionConsole(container, requestRender);
}

export function applySpaceTheme(expeditionState) {
  return uiSpaceApi.applySpaceTheme(expeditionState);
}

export function showMajorDecision(distance) {
  return uiSpaceApi.showMajorDecision(distance);
}
