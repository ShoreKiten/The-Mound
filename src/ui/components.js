/** @file Reusable UI component factories — atomic DOM writer, research panel, outpost menu, resource bar helpers. */

import { MoundEngine } from "../core/engine-runtime.js";
import { gameState, moundState } from "../core/state.js";
import { computePopulationCap } from "../systems/colony-cap.js";
import {
  batchUiWrite,
  setUiMainApi,
  getUiApi,
  getUiSpaceApi
} from "../core/runtime-hooks.js";
import { readTechPoints } from "./components/tech-tree.js";

function applyRootThemeIfReady() {
  if (typeof document !== "undefined" && document.body) {
    document.body.style.backgroundColor = "#0d0d0d";
    document.body.style.color = "#eeeeee";
  }
}
applyRootThemeIfReady();
if (typeof document !== "undefined" && document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", applyRootThemeIfReady, { once: true });
}

export function getActiveHazardWindow(gameState, now) {
    if (!gameState || !gameState.systems) {
      return null;
    }
    const t = now || Date.now();
    const windows = [
      { label: "聚变冷却故障", until: gameState.systems.fusionDebuffUntil || 0, duration: 60000 },
      { label: "自动化链路中断", until: gameState.systems.automationFaultUntil || 0, duration: 120000 },
      { label: "隔舱紧急抢修", until: gameState.systems.decompressionRepairUntil || 0, duration: 30000 }
    ];
    return windows.find((item) => item.until > t) || null;
}

export function createAtomicDomWriter() {
    const textCache = new WeakMap();
    const classCache = new WeakMap();
    const styleCache = new WeakMap();
    const runWrite = (task) => {
      batchUiWrite(task);
    };
    return {
      setText(node, value) {
        if (!node) {
          return;
        }
        const next = String(value);
        if (textCache.get(node) === next) {
          return;
        }
        textCache.set(node, next);
        runWrite(() => {
          node.textContent = next;
        });
      },
      setClass(node, className) {
        if (!node) {
          return;
        }
        const next = String(className || "");
        if (classCache.get(node) === next) {
          return;
        }
        classCache.set(node, next);
        runWrite(() => {
          node.className = next;
        });
      },
      setStyle(node, property, value) {
        if (!node || !property) {
          return;
        }
        const key = `${property}:${String(value)}`;
        if (styleCache.get(node) === key) {
          return;
        }
        styleCache.set(node, key);
        runWrite(() => {
          node.style[property] = value;
        });
      }
    };
}

export function subscribeStatePaths(paths, listener) {
    if (!moundState || typeof listener !== "function") {
      return function noop() {};
    }
    if (!Array.isArray(paths) || paths.length === 0) {
      if (typeof moundState.subscribe === "function") {
        return moundState.subscribe(listener);
      }
      return function noop() {};
    }
    if (typeof moundState.subscribePath !== "function") {
      if (typeof moundState.subscribe === "function") {
        return moundState.subscribe(listener);
      }
      return function noop() {};
    }
    const unsubs = paths.map((path) => moundState.subscribePath(path, listener));
    return function unsubscribeAll() {
      unsubs.forEach((unbind) => {
        if (typeof unbind === "function") {
          unbind();
        }
      });
    };
}

export function createNodePool() {
    const nodes = new Map();
    return {
      get(key) {
        return nodes.get(key) || null;
      },
      ensure(key, factory) {
        if (!nodes.has(key) && typeof factory === "function") {
          nodes.set(key, factory());
        }
        return nodes.get(key) || null;
      },
      clear() {
        nodes.clear();
      }
    };
}

  function renderFactory() {
    const currentState = moundState && moundState.state ? moundState.state : gameState;
    if (currentState && currentState.blueprints && currentState.blueprints.maintenanceCenter === true) {
      const btn = document.getElementById("build-maintenance-btn");
      if (btn) {
        btn.style.display = "block";
      }
    }
  }

export function createDeepSpaceProductionSection(api) {
    if (!api || !api.state) return null;
    const state = api.state;
    const requirementHtml = api.requirementHtml;
    const bindTip = api.bindTip;

    const wrap = document.createElement("div");
    wrap.className = "deep-space-production-block";
    const divider = document.createElement("div");
    divider.className = "section-divider";
    divider.textContent = "---";
    wrap.appendChild(divider);
    const head = document.createElement("div");
    head.className = "category-label";
    head.textContent = "深空生产线";
    wrap.appendChild(head);
    const deepSpaceUnlocked = !!(
      state.systems &&
      state.systems.deepSpace &&
      state.systems.deepSpace.unlocked
    );
    if (!deepSpaceUnlocked) {
      return wrap;
    }
    if (!state.isVaultRepaired) {
      const hint = document.createElement("div");
      hint.className = "space-status-row";
      hint.textContent = "舱体未修复，深空生产线未就绪。";
      wrap.appendChild(hint);
      return wrap;
    }
    if (!MoundEngine) return wrap;
    const structures = state.structures || {};
    const massProjectorCount = Math.max(Number(structures.massProjector || 0), state.massDriverBuilt ? 1 : 0);
    const miningMachineCount = Math.max(Number(structures.miningMachine || 0), Number(state.miningDrones || 0));

    const driverItem = document.createElement("div");
    driverItem.className = "action-item";
    const driverButton = document.createElement("button");
    driverButton.type = "button";
    driverButton.className = "action-btn";
    if (massProjectorCount < 1) {
      driverButton.textContent = "建造质量投射器";
      driverButton.dataset.spaceAction = "buildMassDriver";
      driverButton.disabled = state.resources.alloy < 300 || state.resources.sealant < 200;
      if (driverButton.disabled) driverButton.classList.add("btn-disabled");
      if (typeof bindTip === "function") bindTip(driverButton, () => requirementHtml("massDriver"));
    } else {
      driverButton.textContent = "建造采矿机";
      driverButton.dataset.spaceAction = "launchMiningDrone";
      driverButton.disabled = state.resources.alloy < 50;
      if (driverButton.disabled) driverButton.classList.add("btn-disabled");
      if (typeof bindTip === "function") bindTip(driverButton, () => requirementHtml("miningDrone"));
    }
    driverItem.appendChild(driverButton);
    wrap.appendChild(driverItem);

    const fusionItem = document.createElement("div");
    fusionItem.className = "action-item";
    const fusionButton = document.createElement("button");
    fusionButton.type = "button";
    fusionButton.className = "action-btn";
    fusionButton.textContent = "建造氦-3 聚变发电机";
    fusionButton.dataset.spaceAction = "buildFusionGenerator";
    fusionButton.disabled =
      massProjectorCount < 1 ||
      miningMachineCount < 1 ||
      state.resources.alloy < 100 ||
      state.resources.sealant < 50;
    if (fusionButton.disabled) fusionButton.classList.add("btn-disabled");
    fusionItem.appendChild(fusionButton);
    if (typeof bindTip === "function") bindTip(fusionButton, () => requirementHtml("fusionGen"));
    wrap.appendChild(fusionItem);

    if (state.isTechEra && state.blueprints.maintenanceCenter && !state.maintenanceCenterBuilt) {
      const maintenanceItem = document.createElement("div");
      maintenanceItem.className = "action-item";
      const maintenanceButton = document.createElement("button");
      maintenanceButton.id = "build-maintenance-btn";
      maintenanceButton.type = "button";
      maintenanceButton.className = "action-btn";
      maintenanceButton.textContent = "建造自动维护中心";
      maintenanceButton.dataset.spaceAction = "buildMaintenanceCenter";
      maintenanceButton.disabled = state.resources.alloy < 300 || state.resources.sealant < 100 || state.resources.power < 500;
      if (maintenanceButton.disabled) maintenanceButton.classList.add("btn-disabled");
      maintenanceItem.appendChild(maintenanceButton);
      if (typeof bindTip === "function") bindTip(maintenanceButton, () => requirementHtml("maintenanceCenter"));
      wrap.appendChild(maintenanceItem);
    }
    return wrap;
}

export function createResearchCenterPanel(api) {
    if (!api || !api.state) return null;
    const state = api.state;
    const requirementHtml = api.requirementHtml;
    const bindTip = api.bindTip;
    const formatInt = typeof api.formatInt === "function" ? api.formatInt : function (v) { return String(Math.floor(Number(v) || 0)); };

    const root = document.createElement("div");
    root.className = "research-center-root";
    const title = document.createElement("div");
    title.className = "research-center-title";
    title.textContent = "核心科技树";
    root.appendChild(title);
    const techMod = window.MoundSystems && window.MoundSystems.tech;
    const pointsRow = document.createElement("div");
    pointsRow.className = "research-tech-points";
    const gs = gameState;
    const ptsRaw = readTechPoints(gs);
    const pts = ptsRaw !== null ? ptsRaw : techMod && typeof techMod.getTechPoints === "function" ? techMod.getTechPoints(gs || state) : 0;
    const techRate = techMod && typeof techMod.calculateTechOutput === "function" ? Number(techMod.calculateTechOutput(gs || state) || 0) : 0;
    const blueprintUnlocked = !!(
      (state.flags && state.flags.isResearchStationBlueprintUnlocked) ||
      (state.blueprints && state.blueprints.researchWorkstation)
    );
    pointsRow.textContent = blueprintUnlocked
      ? `科技点: ${formatInt(pts)}  (+${techRate.toFixed(2)}/s)`
      : "科技点: 0 (+0.00/s)";
    root.appendChild(pointsRow);
    const manpowerRow = document.createElement("div");
    manpowerRow.className = "research-tech-points";
    const pop = Math.max(0, Number((gs || state).population || 0));
    const maxPop = Math.max(1, Number((gs || state).maxPopulation || 0), computePopulationCap(gs || state));
    manpowerRow.textContent = `人力资源配给: 幸存者 ${formatInt(pop)} / ${formatInt(maxPop)}    科研效能 ${techRate.toFixed(2)}/s`;
    root.appendChild(manpowerRow);
    if (!state.techEraEnabled || !blueprintUnlocked) {
      const lock = document.createElement("div");
      lock.className = "space-status-row";
      lock.textContent = "[ 系统锁定 ]：缺少科研工作站蓝图，无法累积科技数据。";
      root.appendChild(lock);
      return root;
    }
    const list = document.createElement("div");
    list.className = "research-upgrade-list";
    const rows = techMod && typeof techMod.listTechUpgrades === "function" ? techMod.listTechUpgrades(gameState || state) : [];
    const costKey = { shield: "techShield", cycle: "techCycle", mining: "techMining" };
    const rowMap = new Map();
    const readSnapshot = () => {
      const current = gameState || state || {};
      const systems = current.systems || {};
      const techState = systems.tech || {};
      const points = readTechPoints(current);
      const levelById = {
        shield: Number(techState.shieldLevel || 0),
        cycle: Number(techState.cycleLevel || 0),
        mining: Number(techState.miningLevel || 0)
      };
      return { current, points, levelById };
    };
    rows.forEach((row) => {
      const line = document.createElement("div");
      line.className = "research-upgrade-row";
      line.setAttribute("role", "button");
      line.tabIndex = -1;
      const label = document.createElement("span");
      label.textContent = `${row.name} `;
      const levelValue = document.createElement("span");
      levelValue.className = "level-value";
      levelValue.textContent = `Lv.${row.level}/${row.maxLevel || 10}`;
      const costValue = document.createElement("span");
      costValue.className = "cost-value";
      line.appendChild(label);
      line.appendChild(levelValue);
      line.appendChild(costValue);
      const tipKey = costKey[row.id];
      const hasRequirement = tipKey && typeof requirementHtml === "function";
      const purchase = () => {
        const snapshot = readSnapshot();
        const liveLevel = Number(snapshot.levelById[row.id] || 0);
        const maxLevel = Number(row.maxLevel || 10);
        const costNow = techMod && typeof techMod.nextTechCost === "function"
          ? Number(techMod.nextTechCost(liveLevel))
          : 50;
        const canUpgradeNow = liveLevel < maxLevel && snapshot.points >= costNow;
        if (!canUpgradeNow) {
          return;
        }
        if (techMod && typeof techMod.tryPurchaseUpgrade === "function") {
          const ok = techMod.tryPurchaseUpgrade(row.id);
          if (ok !== false) {
            applyResearchSnapshot();
          }
        }
      };
      line.addEventListener("click", purchase);
      line.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          purchase();
        }
      });
      if (typeof bindTip === "function" && hasRequirement) {
        bindTip(line, () => {
          const snapshot = readSnapshot();
          const liveLevel = Number(snapshot.levelById[row.id] || 0);
          const isMax = liveLevel >= Number(row.maxLevel || 10);
          if (isMax) {
            return "<div>已达上限</div>";
          }
          return requirementHtml(tipKey);
        });
      }
      rowMap.set(row.id, {
        line,
        label,
        levelValue,
        costValue,
        maxLevel: Number(row.maxLevel || 10),
        name: row.name
      });
      list.appendChild(line);
    });
    root.appendChild(list);

    function applyResearchSnapshot() {
      const snapshot = readSnapshot();
      const current = snapshot.current;
      const currentTechRate = techMod && typeof techMod.calculateTechOutput === "function"
        ? Number(techMod.calculateTechOutput(current) || 0)
        : 0;
      pointsRow.textContent = `科技点: ${formatInt(snapshot.points)}  (+${currentTechRate.toFixed(2)}/s)`;
      const currentPop = Math.max(0, Number(current.population || 0));
      const currentMaxPop = Math.max(1, Number(current.maxPopulation || 0), computePopulationCap(current));
      manpowerRow.textContent = `人力资源配给: 幸存者 ${formatInt(currentPop)} / ${formatInt(currentMaxPop)}    科研效能 ${currentTechRate.toFixed(2)}/s`;
      rowMap.forEach((entry, id) => {
        const liveLevel = Number(snapshot.levelById[id] || 0);
        const costNow = techMod && typeof techMod.nextTechCost === "function"
          ? Number(techMod.nextTechCost(liveLevel))
          : 50;
        const atMax = liveLevel >= entry.maxLevel;
        const canUpgrade = !atMax && snapshot.points >= costNow;
        entry.label.textContent = `${entry.name} `;
        entry.levelValue.textContent = `Lv.${liveLevel}/${entry.maxLevel}`;
        entry.costValue.textContent = `(消耗 ${formatInt(costNow)} 科技点)`;
        entry.line.classList.toggle("is-clickable", canUpgrade);
        entry.line.classList.toggle("is-disabled", !canUpgrade);
        entry.line.setAttribute("aria-disabled", canUpgrade ? "false" : "true");
        entry.line.tabIndex = canUpgrade ? 0 : -1;
      });
    }
    applyResearchSnapshot();
    return root;
}

export { createTacticalCenterPanel } from "./TacticalCenter.js";

export function renderOutpostExchangeBody(api) {
    if (!api || !api.modal) {
      return;
    }
    const modal = api.modal;
    const state = api.state || gameState || {};
    const setState = api.setState;
    const renderAll = typeof api.renderAll === "function" ? api.renderAll : function () {};
    const closeHandler = typeof api.onClose === "function" ? api.onClose : function () {};
    if (!setState) {
      return;
    }

    while (modal.firstChild) {
      modal.removeChild(modal.firstChild);
    }
    const content = document.createElement("div");
    content.id = "outpost-content";
    content.style.display = "block";
    modal.appendChild(content);

    const title = document.createElement("div");
    title.className = "outpost-modal-title";
    title.textContent = "深空哨站中继站";
    content.appendChild(title);

    const intro = document.createElement("div");
    intro.className = "outpost-modal-intro";
    intro.textContent = "资源转换协议已停用。你可以在此短暂停靠并整理航线。";
    content.appendChild(intro);

    const balance = document.createElement("div");
    balance.className = "outpost-modal-intro";
    balance.textContent =
      `星尘 ${Math.round(state.resources.stardust || 0)} ｜ 废金属 ${Math.round(state.resources.scrapMetal || 0)} ｜ 密封剂 ${Math.round(state.resources.sealant || 0)} ｜ 氦-3 ${Math.round(state.resources.helium3 || 0)}`;
    content.appendChild(balance);

    const note = document.createElement("div");
    note.className = "outpost-modal-intro";
    note.textContent = "当前版本不再提供任何哨站资源兑换功能。";
    content.appendChild(note);

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "outpost-close-btn action-btn";
    closeBtn.textContent = "断开连接并继续航行";
    closeBtn.addEventListener("click", closeHandler);
    content.appendChild(closeBtn);
}

export function showOutpostMenu(api) {
    const setState = api && api.setState;
    if (typeof setState !== "function" || !document.body) {
      return;
    }
    const gameStateSnapshot = (moundState && moundState.state) || gameState || {};
    const renderAll = api && typeof api.renderAll === "function" ? api.renderAll : function () {};
    const saveGame = api && typeof api.saveGame === "function" ? api.saveGame : function () {};
    const addLog = api && typeof api.addLog === "function" ? api.addLog : function () {};

    const prev = document.getElementById("outpost-modal");
    if (prev && prev.parentNode) {
      prev.parentNode.removeChild(prev);
    }
    const modal = document.createElement("div");
    modal.id = "outpost-modal";
    modal.className = "outpost-modal";
    document.body.appendChild(modal);

    const closeOutpost = () => {
      const target = document.getElementById("outpost-modal");
      if (target && target.parentNode) {
        target.parentNode.removeChild(target);
      }
      setState((draft) => {
        draft.systems = draft.systems || {};
        draft.systems.ui = draft.systems.ui || {};
        draft.systems.expedition = draft.systems.expedition || {};
        draft.systems.ui.outpostMenuLocked = false;
        draft.thrustMultiplier =
          typeof draft.systems.ui.outpostSavedThrust === "number" ? draft.systems.ui.outpostSavedThrust : 1;
        draft.systems.ui.outpostSavedThrust = null;
        draft.systems.expedition.isNavigationLocked = false;
        draft.systems.expedition.status = "IDLE";
        draft.systems.expedition.targetDistance = Math.max(15000, Number(draft.systems.expedition.targetDistance || 0));
        draft.systems.expedition.currentRegion = "补给星区";
        draft.systems.expedition.throttle = 0;
        draft.systems.expedition.active = false;
        draft.systems.expedition.overdrive = false;
      });
      saveGame();
      renderAll();
    };

    renderOutpostExchangeBody({
      modal,
      state: gameStateSnapshot,
      setState,
      renderAll,
      saveGame,
      addLog: (text) => {
        addLog(text);
      },
      onClose: closeOutpost
    });
}

export function updateUI() {
    const uiHook = getUiApi();
    if (uiHook && typeof uiHook.renderAll === "function") {
      uiHook.renderAll();
    }
    const spaceHook = getUiSpaceApi();
    if (spaceHook && typeof spaceHook.refreshThrustUI === "function") {
      spaceHook.refreshThrustUI();
    }
    renderFactory();
}

setUiMainApi({
  getActiveHazardWindow,
  createAtomicDomWriter,
  subscribeStatePaths,
  createNodePool,
  createDeepSpaceProductionSection,
  createResearchCenterPanel,
  renderOutpostExchangeBody,
  showOutpostMenu,
  updateUI
});
