import { gameState, moundState } from "../core/state.js";
import { MoundEngine } from "../core/engine-runtime.js";
import { MAX_LOG_LINES, renderStream as renderLogStream } from "./components/log.js";
import {
  scheduleUiRender,
  setUiApi,
  registerApplyDeckInDraft,
  getStorageNeedsRender,
  setStorageNeedsRender,
  getEngineApi
} from "../core/runtime-hooks.js";
import "./ui-bridge.js";
import {
  createAtomicDomWriter,
  getActiveHazardWindow,
  createResearchCenterPanel,
  createDeepSpaceProductionSection,
  showOutpostMenu as showOutpostMenuPanel,
  renderOutpostExchangeBody,
  subscribeStatePaths
} from "./components.js";
import { createTacticalCenterPanel } from "./TacticalCenter.js";
import { showCombatModal as showCombatModalFn } from "./CombatModal.js";
import { renderEndingScreen, renderDefeatScreen, renderEvacScreen } from "./EndingOverlay.js";
import { renderExpeditionConsole, applySpaceTheme, refreshThrustUI as refreshThrustUiBridge } from "./bridge.js";
import { initDeepSpaceInputDelegation } from "./input-handler.js";
import { initBackgroundEffect } from "./background-effect.js";
import { computePopulationCap } from "../systems/colony-cap.js";
import { buildResourceRateTipHtml, formatRate, rateClass } from "./components/resource-bar.js";

const GAME_CONTAINER_ID = "game-container";
const LEGACY_APP_ID = "app";
const DOM_PANEL_LOGISTICS = "panel-logistics";
const DOM_PANEL_DEEP_SPACE = "panel-deep-space";
const DOM_LOGISTICS = "base-logistics-deck";
const DOM_DEEP_SPACE = "deep-space-actions-host";
const DOM_TECH = "space-tech-host";
let gameShellAttachLogged = false;

/**
 * Prefer #game-container, then legacy #app; if both missing, inject #game-container on document.body.
 */
function resolveGameShell() {
  if (typeof document === "undefined") {
    return null;
  }
  let el = document.getElementById(GAME_CONTAINER_ID);
  let usedId = GAME_CONTAINER_ID;
  if (!el) {
    el = document.getElementById(LEGACY_APP_ID);
    if (el) {
      usedId = LEGACY_APP_ID;
    }
  }
  if (!el && document.body) {
    console.error(
      `[UIRoot] Critical: #${GAME_CONTAINER_ID} and #${LEGACY_APP_ID} are missing — injecting #${GAME_CONTAINER_ID} on document.body.`
    );
    el = document.createElement("div");
    el.id = GAME_CONTAINER_ID;
    document.body.appendChild(el);
    usedId = GAME_CONTAINER_ID;
  }
  if (!el) {
    console.error("[UIRoot] Critical: cannot resolve game shell (no document.body).");
    return null;
  }
  if (!gameShellAttachLogged) {
    gameShellAttachLogged = true;
  }
  return el;
}

let uiApi = {
  initUI: () => {},
  renderAll: () => {},
  showOutpostMenu: () => {},
  syncResourceBarVisuals: () => {}
};

(() => {
const gameShell = resolveGameShell();
if (!gameShell) {
  console.error("[UIRoot] 主挂载节点 #game-container 不可用（且无法注入），跳过初始化。");
  return;
}
if (!MoundEngine || !moundState) {
  console.error("[UIRoot] 依赖未就绪（MoundEngine/moundState）。");
  return;
}
const {
  CooldownManager,
  activateReactorCore,
  activateStardustBeacon,
  buildIonCatcher,
  buildAutoSmelter,
  buildAutoSynthesizer,
  buildRefiningFurnace,
  deployMagneticArray,
  forgeSealant,
  gainScrapMetal,
  gainStardust,
  manualCharge,
  manualCrank,
  manualOxygen,
  meltIceOre,
  refineAlloy,
  repairVault,
  setAutomationLoggingEnabled,
  upgradeCoreEfficiency,
  startEngine
} = MoundEngine;
const { state, subscribe, setState: setGameState } = moundState;
const spaceUI = {
  renderExpeditionConsole,
  applySpaceTheme
};

function ensureLayoutNode(id, createNode) {
  const existing = document.getElementById(id);
  if (existing) {
    return existing;
  }
  return typeof createNode === "function" ? createNode() : null;
}

const layoutRoot = ensureLayoutNode("layout", () => {
  const main = document.createElement("main");
  main.id = "layout";
  gameShell.appendChild(main);
  return main;
});
const leftPanel = ensureLayoutNode("left-panel", () => {
  const section = document.createElement("section");
  section.id = "left-panel";
  section.setAttribute("aria-label", "event-log");
  (layoutRoot || gameShell).appendChild(section);
  return section;
});
const rightPanel = ensureLayoutNode("right-panel", () => {
  const section = document.createElement("section");
  section.id = "right-panel";
  section.setAttribute("aria-label", "actions");
  (layoutRoot || gameShell).appendChild(section);
  return section;
});
const topBar = ensureLayoutNode("top-bar", () => {
  const header = document.createElement("header");
  header.id = "top-bar";
  header.setAttribute("aria-label", "resources");
  gameShell.prepend(header);
  return header;
});
const actionList = ensureLayoutNode("action-list", () => {
  const node = document.createElement("div");
  node.id = "action-list";
  (rightPanel || gameShell).appendChild(node);
  return node;
});
const logStream = ensureLayoutNode("log-stream", () => {
  const node = document.createElement("div");
  node.id = "log-stream";
  (leftPanel || gameShell).appendChild(node);
  return node;
});
const tooltip =
  document.getElementById("game-tooltip") ||
  (() => {
    const node = document.createElement("div");
    node.id = "game-tooltip";
    document.body.appendChild(node);
    return node;
  })();
window.colors = window.colors || {};
if (!window.colors.positive) {
  window.colors.positive = "#eeeeee";
}
if (!window.colors.negative) {
  window.colors.negative = "#777777";
}
const cooldownGlyphs = ["", "", "", "", ""];
function getSealantValue() {
  if (typeof state.sealant === "number") {
    return state.sealant;
  }
  return state.resources.sealant;
}

function getCurrentCrewCount() {
  return Math.max(0, Number(state.population || state.crew || 0));
}

function getBeaconLaunchCost() {
  const crew = getCurrentCrewCount();
  return Math.max(100, Math.round(100 * (1 + (crew * 0.5))));
}

function formatInt(value) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return value;
  }
  return Math.floor(value);
}

function isInitialIdleState() {
  const exp = gameState && gameState.systems && gameState.systems.expedition;
  const distance = Number(exp ? exp.distanceKm : 0);
  return distance < 1 && !state.isVaultRepaired;
}

function safeSetText(node, value) {
  if (!node) {
    return;
  }
  const next = String(value);
  if (node.textContent !== next) {
    node.textContent = next;
  }
}

function safeUpdate(id, value) {
  const el = document.getElementById(id);
  if (!el) {
    return;
  }
  safeSetText(el, value);
}

function hasAutomationStructuresUnlocked(snapshot = state) {
  return !!(
    snapshot &&
    snapshot.systems &&
    snapshot.systems.ui &&
    snapshot.systems.ui.automationStructuresDiscovered
  );
}

function isDeepSpaceUnlocked(snapshot = state) {
  return !!(
    snapshot &&
    snapshot.systems &&
    snapshot.systems.deepSpace &&
    snapshot.systems.deepSpace.unlocked
  );
}

/** Plain action label for minimalist UI. */
function terminalCmd(label) {
  return String(label || "")
    .replace(/[\[\]•]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const buttonDefs = {
  stardust: {
    label: "扫除星尘",
    cooldownMs: 2000,
    group: "basic",
    visible: () => Number(state.ionCatchers || 0) < 1,
    action: gainStardust
  },
  scrap: {
    label: "撬动废金属",
    cooldownMs: 3000,
    group: "basic",
    visible: () => Number(state.arrays || 0) < 1 && state.resources.stardust > 0,
    action: gainScrapMetal
  },
  reactor: {
    label: "激活反应芯",
    cooldownMs: 5000,
    group: "production",
    visible: () =>
      Number(state && state.resources ? state.resources.scrapMetal || 0 : 0) >= 10 &&
      !Boolean(state && state.ReactorCoreActive),
    action: activateReactorCore
  },
  sealant: {
    label: "锻造密封剂",
    cooldownMs: 4000,
    group: "production",
    visible: () =>
      Number(state.autoSynthesizers || 0) < 1 &&
      (state.resources.scrapMetal > 0 || state.resources.stardust > 0),
    action: forgeSealant
  },
  repair: {
    label: "修补舱门",
    cooldownMs: 5000,
    group: "production",
    visible: () =>
      Number(state && state.resources ? state.resources.sealant || 0 : 0) >= 10 &&
      !Boolean(state && state.isVaultRepaired),
    action: repairVault
  },
  oxygen: {
    label: "手动制氧",
    cooldownMs: 3000,
    visible: () =>
      Boolean(state && state.isVaultRepaired) &&
      Number(state && state.resources ? state.resources.stardust || 0 : 0) >= 5 &&
      Number(state && typeof state.oxygen === "number" ? state.oxygen : 100) <= 90,
    action: manualOxygen
  },
  charge: {
    label: "手动充能",
    cooldownMs: 2000,
    group: "basic",
    visible: () =>
      !Boolean(state.ReactorCoreActive) &&
      !(state.systems && state.systems.reactorActive) &&
      state.resources.stardust >= 5,
    action: manualCharge
  },
  crank: {
    label: "手动供电",
    cooldownMs: 1200,
    group: "basic",
    visible: () => Number(state.resources.power || 0) <= 5,
    action: manualCrank
  },
  array: {
    label: "部署磁力阵列",
    cooldownMs: 3000,
    group: "production",
    visible: () => hasAutomationStructuresUnlocked(state),
    action: deployMagneticArray
  },
  melt: {
    label: "融化冰矿",
    cooldownMs: 2000,
    visible: () => state.isVaultRepaired && state.resources.iceOre > 0,
    action: meltIceOre
  },
  efficiency: {
    label: "核心隔热",
    cooldownMs: 3000,
    group: "production",
    visible: () => state.isVaultRepaired && !state.isEfficiencyUpgraded && state.resources.sealant >= 30,
    action: upgradeCoreEfficiency
  },
  ionCatcher: {
    label: "建造离子捕获器",
    cooldownMs: 5000,
    group: "production",
    visible: () => hasAutomationStructuresUnlocked(state),
    action: buildIonCatcher
  },
  refiningFurnace: {
    label: "建造精炼熔炉",
    cooldownMs: 5000,
    group: "production",
    visible: () => (
      state.resources.alloy !== undefined &&
      !state.hasRefiningFurnace &&
      (
        (state.systems && state.systems.ui && state.systems.ui.refiningFurnaceDiscovered) ||
        state.resources.sealant >= 10
      )
    ),
    action: buildRefiningFurnace
  },
  refine: {
    label: "精炼合金",
    cooldownMs: 5000,
    group: "production",
    visible: () => state.hasRefiningFurnace && Number(state.autoSmelters || 0) < 1,
    action: refineAlloy
  },
  autoSmelter: {
    label: "建造自动化冶炼模组",
    cooldownMs: 5000,
    group: "production",
    visible: () => {
      const ui = state.systems && state.systems.ui ? state.systems.ui : {};
      return state.hasRefiningFurnace && (ui.autoSmelterDiscovered || state.resources.alloy >= 3);
    },
    action: buildAutoSmelter
  },
  autoSynth: {
    label: "建造自动密封剂合成仪",
    cooldownMs: 5000,
    group: "production",
    visible: () => state.hasRefiningFurnace,
    action: buildAutoSynthesizer
  }
};
const actionButtons = {};
const cooldowns = {};
let signalTicker = null;
let topBarSyncTimer = null;
let stateUnsubscribe = null;
let thrustUiSyncAt = 0;
let lastHe3Seen = 0;
let uiRenderTimer = null;
let lastUiRenderAt = 0;
let lastLogHash = "";
let lastLogToggleState = null;
const UI_RENDER_INTERVAL_MS = 200;
const LOG_RENDER_LIMIT = MAX_LOG_LINES || 12;
const PANEL_RENDER_INTERVAL_MS = 250;
const LOG_RENDER_INTERVAL_MS = 300;
let lastPanelRenderAt = 0;
let lastLogRenderAt = 0;
let lastPanelKey = "";
let lastDeckUiLogKey = "";
let lastLogCount = -1;
let lastActionRenderSignature = "";
const actionLayoutCache = {
  ready: false,
  panels: {},
  tabs: {},
  spaceTabs: {},
  decks: {},
  sections: {},
  actionItems: {},
  beacon: null,
  monitor: null,
  sectionNote: null,
  deepSpaceHost: null,
  expeditionDeck: null,
  researchDeck: null,
  tacticalPanelRoot: null,
  persistence: {}
};
const ACTION_ORDER_KEYS = [
  "array",
  "ionCatcher",
  "refiningFurnace",
  "autoSmelter",
  "autoSynth",
  "refine",
  "sealant",
  "efficiency",
  "reactor",
  "repair",
  "stardust",
  "scrap",
  "charge",
  "crank",
  "oxygen",
  "melt"
];
const topBarNodeCache = {
  bar: null,
  radiation: null,
  stardust: null,
  scrapMetal: null,
  sealant: null,
  alloy: null,
  helium3: null,
  autoSmelters: null,
  power: null,
  oxygen: null,
  population: null,
  arrays: null,
  ionCatchers: null,
  autoSynthesizers: null,
  miningDrones: null,
  singularity: null,
  hazardAlert: null,
  hazardTitle: null,
  hazardFill: null,
  haltCell: null
};
const TOP_BAR_DISCOVERY_KEYS = [
  "stardust",
  "scrapMetal",
  "sealant",
  "power",
  "oxygen",
  "population",
  "alloy",
  "helium3",
  "autoSmelters",
  "arrays",
  "ionCatchers",
  "autoSynthesizers",
  "miningDrones",
  "singularity"
];
const TOP_BAR_ALWAYS_VISIBLE = new Set(["stardust"]);
const TOP_BAR_BATCH_UPDATE_MS = 10000;
let lastTopBarBatchUpdateAt = 0;
const topBarVisualMirror = {};
const atomicWriter = typeof createAtomicDomWriter === "function"
  ? createAtomicDomWriter()
  : {
    setText(node, value) {
      if (node) {
        node.textContent = String(value);
      }
    },
    setClass(node, className) {
      if (node) {
        node.className = String(className || "");
      }
    }
  };
const cooldownProgress = {
  stardust: 0,
  scrap: 0,
  reactor: 0,
  sealant: 0,
  repair: 0,
  oxygen: 0,
  charge: 0,
  crank: 0,
  array: 0,
  melt: 0,
  efficiency: 0,
  ionCatcher: 0,
  refiningFurnace: 0,
  refine: 0,
  autoSmelter: 0,
  autoSynth: 0
};

const actionDescriptions = {
  refine: "将 20 废金属和 10 星尘转化为 1 合金",
  beacon: "发射信标招募幸存者，费用会随当前载员规模递增。",
  massDriver: "深空投射平台，作为采矿机发射前置设施",
  miningDrone: "发射后并入轨道机队，每 30 秒返还氦-3",
  fusionGen: "持续消耗氦-3，提供高强度电力输出",
  maintenanceCenter: "自动维护轨道采矿机，降低损毁概率",
  techShield: "强化护盾：每级降低恶性事件触发概率 10%",
  techCycle: "循环优化：降低自动化电力消耗 15%",
  techMining: "高效采掘：轨道采矿机氦-3 产出提升 20%"
};

const BUTTON_COSTS = {
  stardust: () => [],
  scrap: () => [],
  reactor: () => [{ name: "废金属", need: 10, have: state.resources.scrapMetal }],
  sealant: () => [
    { name: "星尘", need: 5, have: state.resources.stardust },
    { name: "废金属", need: 2, have: state.resources.scrapMetal }
  ],
  repair: () => [{ name: "密封剂", need: 10, have: state.resources.sealant }],
  oxygen: () => [{ name: "星尘", need: 5, have: state.resources.stardust }],
  charge: () => [{ name: "星尘", need: 5, have: state.resources.stardust }],
  crank: () => [],
  array: () => [
    { name: "废金属", need: 10, have: state.resources.scrapMetal },
    { name: "密封剂", need: 5, have: state.resources.sealant }
  ],
  melt: () => [{ name: "冰矿石", need: 1, have: state.resources.iceOre }],
  efficiency: () => [{ name: "密封剂", need: 30, have: state.resources.sealant }],
  ionCatcher: () => [
    { name: "废金属", need: 40, have: state.resources.scrapMetal },
    { name: "密封剂", need: 5, have: state.resources.sealant }
  ],
  refiningFurnace: () => [
    { name: "废金属", need: 50, have: state.resources.scrapMetal },
    { name: "密封剂", need: 20, have: state.resources.sealant }
  ],
  refine: () => [
    { name: "废金属", need: 20, have: state.resources.scrapMetal },
    { name: "星尘", need: 10, have: state.resources.stardust }
  ],
  autoSmelter: () => [
    { name: "合金", need: 5, have: state.resources.alloy },
    { name: "废金属", need: 100, have: state.resources.scrapMetal },
    { name: "电力", need: 50, have: state.resources.power }
  ],
  autoSynth: () => [
    { name: "合金", need: 5, have: state.resources.alloy },
    { name: "废金属", need: 120, have: state.resources.scrapMetal },
    { name: "电力", need: 60, have: state.resources.power }
  ],
  beacon: () => [{ name: "星尘", need: getBeaconLaunchCost(), have: state.resources.stardust }],
  massDriver: () => [
    { name: "合金", need: 300, have: state.resources.alloy },
    { name: "密封剂", need: 200, have: state.resources.sealant }
  ],
  miningDrone: () => [{ name: "合金", need: 50, have: state.resources.alloy }]
  ,
  fusionGen: () => [
    { name: "合金", need: 100, have: state.resources.alloy },
    { name: "密封剂", need: 50, have: state.resources.sealant }
  ],
  maintenanceCenter: () => [
    { name: "合金", need: 300, have: state.resources.alloy },
    { name: "密封剂", need: 100, have: state.resources.sealant },
    { name: "电力", need: 500, have: state.resources.power }
  ],
  techShield: () => [{ name: "科技点", need: ((window.MoundSystems && window.MoundSystems.tech && window.MoundSystems.tech.nextTechCost)
    ? window.MoundSystems.tech.nextTechCost(state.systems.tech.shieldLevel || 0) : 50), have: (state.resources && state.resources.techPoints) ?? 0 }],
  techCycle: () => [{ name: "科技点", need: ((window.MoundSystems && window.MoundSystems.tech && window.MoundSystems.tech.nextTechCost)
    ? window.MoundSystems.tech.nextTechCost(state.systems.tech.cycleLevel || 0) : 50), have: (state.resources && state.resources.techPoints) ?? 0 }],
  techMining: () => [{ name: "科技点", need: ((window.MoundSystems && window.MoundSystems.tech && window.MoundSystems.tech.nextTechCost)
    ? window.MoundSystems.tech.nextTechCost(state.systems.tech.miningLevel || 0) : 50), have: (state.resources && state.resources.techPoints) ?? 0 }]
};

function isActionAffordable(key) {
  const resolver = BUTTON_COSTS[key];
  if (typeof resolver !== "function") {
    return true;
  }
  const costs = resolver() || [];
  return costs.every((item) => Number(item.have || 0) >= Number(item.need || 0));
}

function applyGameDeckInDraft(draft, activeDeck, spaceSubDeck) {
  draft.systems = draft.systems || {};
  draft.systems.ui = draft.systems.ui || {};
  draft.systems.ui.activeDeck = activeDeck;
  draft.systems.ui.spaceSubDeck = spaceSubDeck;
  draft.activeDeck = activeDeck;
  draft.spaceSubDeck = spaceSubDeck;
}

/**
 * Effective deck for rendering: combat always wins over tab state.
 * @param {object} st
 * @returns {{ activeDeck: string, spaceSubDeck: string }}
 */
function resolveDisplayedDecks(st) {
  const ui = st.systems && st.systems.ui ? st.systems.ui : {};
  return {
    activeDeck: ui.activeDeck || "industry",
    spaceSubDeck: ui.spaceSubDeck || "expedition"
  };
}

function getActionRenderSignature() {
  const decks = resolveDisplayedDecks(state);
  const ui = state.systems && state.systems.ui ? state.systems.ui : {};
  const exp = state.systems && state.systems.expedition ? state.systems.expedition : {};
  const tech = state.systems && state.systems.tech ? state.systems.tech : {};
  const bp = state.blueprints || {};
  const r = state.resources || {};
  const parts = [
    decks.activeDeck,
    decks.spaceSubDeck,
    hasAutomationStructuresUnlocked(state) ? 1 : 0,
    isDeepSpaceUnlocked(state) ? 1 : 0,
    state.isVaultRepaired ? 1 : 0,
    state.population || 0,
    state.populationCap || 0,
    state.autoSmelters || 0,
    state.autoSynthesizers || 0,
    state.arrays || 0,
    state.ionCatchers || 0,
    state.miningDrones || 0,
    state.fusionGenerators || 0,
    state.massDriverBuilt ? 1 : 0,
    Number((state.structures && state.structures.massProjector) || 0),
    Number((state.structures && state.structures.miningMachine) || 0),
    Number((state.structures && state.structures.fusionGenerator) || 0),
    state.maintenanceCenterBuilt ? 1 : 0,
    state.hasRefiningFurnace ? 1 : 0,
    state.isTechEra ? 1 : 0,
    bp.researchWorkstation ? 1 : 0,
    bp.maintenanceCenter ? 1 : 0,
    Number((state.resources && state.resources.techPoints) || 0),
    tech.shieldLevel || 0,
    tech.cycleLevel || 0,
    tech.miningLevel || 0,
    Number(r.stardust || 0),
    Number(r.scrapMetal || 0),
    Number(r.sealant || 0),
    Number(r.alloy || 0),
    Number(r.power || 0),
    Number(r.helium3 || 0),
    Number(r.iceOre || 0),
    ui.refiningFurnaceDiscovered ? 1 : 0,
    Number(state.pendingCrewArrivals || 0),
    Number(state.pendingCrewArrivalAt || 0),
    Number(exp.distanceKm || 0),
    Number(exp.throttle || 0),
    state.combatState || (state.systems && state.systems.combatEncounter && state.systems.combatEncounter.phase) || "IDLE",
    state.systems && state.systems.combatEncounter && state.systems.combatEncounter.enemy
      ? Number(state.systems.combatEncounter.enemy.currentHp || 0)
      : -1,
    state.systems && state.systems.combatEncounter && state.systems.combatEncounter.massDriverCharging ? 1 : 0,
    Number((state.combatStats && state.combatStats.hull) || 0),
    ui.hideManualOxygen ? 1 : 0,
    ui.hideManualCharge ? 1 : 0,
    ui.hideReactorAction ? 1 : 0,
    ui.collapseBasicGather ? 1 : 0,
    ui.outpostMenuLocked ? 1 : 0
  ];
  return parts.join("|");
}

function ensureActionLayout() {
  if (!actionList) {
    return false;
  }
  if (actionLayoutCache.ready && actionLayoutCache.decks.industry && actionLayoutCache.decks.industry.isConnected) {
    return true;
  }
  actionList.innerHTML = "";
  actionLayoutCache.tacticalPanelRoot = null;
  const tabs = document.createElement("div");
  tabs.className = "deck-tabs top-nav-tabs";
  const baseTab = document.createElement("button");
  baseTab.type = "button";
  baseTab.textContent = "基地后勤";
  baseTab.addEventListener("click", () => {
    setGameState((draft) => {
      applyGameDeckInDraft(draft, "industry", "expedition");
    });
  });
  const spaceTab = document.createElement("button");
  spaceTab.type = "button";
  spaceTab.textContent = "深空指挥部";
  spaceTab.addEventListener("click", () => {
    setGameState((draft) => {
      const cur = draft.systems && draft.systems.ui && draft.systems.ui.spaceSubDeck;
      applyGameDeckInDraft(draft, "space", cur || "expedition");
    });
  });
  tabs.appendChild(baseTab);
  tabs.appendChild(spaceTab);
  actionList.appendChild(tabs);
  const panelLogistics = document.createElement("div");
  panelLogistics.id = DOM_PANEL_LOGISTICS;
  panelLogistics.className = "panel-fade is-active";
  const panelDeepSpace = document.createElement("div");
  panelDeepSpace.id = DOM_PANEL_DEEP_SPACE;
  panelDeepSpace.className = "panel-fade is-inactive";
  actionList.appendChild(panelLogistics);
  actionList.appendChild(panelDeepSpace);

  const industryDeck = document.createElement("div");
  industryDeck.className = "deck-panel";
  industryDeck.id = DOM_LOGISTICS;
  const productionSection = document.createElement("div");
  productionSection.id = "production-module";
  const productionTitle = document.createElement("div");
  productionTitle.className = "category-label";
  productionTitle.textContent = "生产与建设";
  productionSection.appendChild(productionTitle);
  const basicSection = document.createElement("div");
  const basicTitle = document.createElement("div");
  basicTitle.className = "category-label";
  basicTitle.textContent = "基础采集";
  basicSection.appendChild(basicTitle);
  const signalSection = document.createElement("div");
  const signalTitle = document.createElement("div");
  signalTitle.className = "category-label";
  signalTitle.textContent = "信号与交互";
  signalSection.appendChild(signalTitle);
  const sectionNote = document.createElement("div");
  sectionNote.className = "section-note";
  sectionNote.style.display = "none";
  sectionNote.textContent = "自动采集已接管基础作业";
  basicSection.appendChild(sectionNote);
  const deepSpaceHost = document.createElement("div");
  deepSpaceHost.id = DOM_DEEP_SPACE;

  const spaceDeck = document.createElement("div");
  spaceDeck.id = "space-command-deck";
  spaceDeck.className = "deck-panel";
  const spaceSubTabs = document.createElement("div");
  spaceSubTabs.className = "deck-tabs";
  const expTab = document.createElement("button");
  expTab.type = "button";
  expTab.textContent = "远征控制台";
  expTab.addEventListener("click", () => {
    setGameState((draft) => {
      applyGameDeckInDraft(draft, "space", "expedition");
    });
  });
  const researchTab = document.createElement("button");
  researchTab.type = "button";
  researchTab.textContent = "科研中心";
  researchTab.addEventListener("click", () => {
    setGameState((draft) => {
      applyGameDeckInDraft(draft, "space", "research");
    });
  });
  const tacticalTab = document.createElement("button");
  tacticalTab.type = "button";
  tacticalTab.textContent = "战术指挥部";
  tacticalTab.addEventListener("click", () => {
    setGameState((draft) => {
      applyGameDeckInDraft(draft, "space", "tactical");
    });
  });
  spaceSubTabs.appendChild(expTab);
  spaceSubTabs.appendChild(researchTab);
  spaceSubTabs.appendChild(tacticalTab);
  spaceDeck.appendChild(spaceSubTabs);
  const expeditionDeck = document.createElement("div");
  expeditionDeck.className = "deck-panel";
  const researchDeck = document.createElement("div");
  researchDeck.id = DOM_TECH;
  researchDeck.className = "deck-panel";
  const tacticalDeck = document.createElement("div");
  tacticalDeck.id = "space-tactical-host";
  tacticalDeck.className = "deck-panel";
  expeditionDeck.appendChild(deepSpaceHost);
  spaceDeck.appendChild(expeditionDeck);
  spaceDeck.appendChild(researchDeck);
  spaceDeck.appendChild(tacticalDeck);

  industryDeck.appendChild(productionSection);
  industryDeck.appendChild(basicSection);
  industryDeck.appendChild(signalSection);

  panelLogistics.appendChild(industryDeck);
  panelDeepSpace.appendChild(spaceDeck);

  const beaconItem = document.createElement("div");
  beaconItem.className = "action-item";
  const beaconButton = document.createElement("button");
  beaconButton.type = "button";
  beaconButton.className = "action-btn";
  beaconItem.appendChild(beaconButton);
  signalSection.appendChild(beaconItem);

  const actionItems = {};
  ACTION_ORDER_KEYS.forEach((key) => {
    const item = document.createElement("div");
    item.className = "action-item";
    item.style.display = "none";
    const button = actionButtons[key];
    if (button) {
      item.appendChild(button);
      bindTip(button, () => requirementHtml(key));
    }
    const category = buttonDefs[key] && buttonDefs[key].category === "deep-space"
      ? "deep-space"
      : "logistics";
    if (category === "deep-space") {
      panelDeepSpace.appendChild(item);
    } else {
      const targetSection = buttonDefs[key] && buttonDefs[key].group === "basic" ? basicSection : productionSection;
      targetSection.appendChild(item);
    }
    actionItems[key] = item;
  });

  actionLayoutCache.ready = true;
  actionLayoutCache.panels = { logistics: panelLogistics, deepSpace: panelDeepSpace };
  actionLayoutCache.tabs = { root: tabs, baseTab, spaceTab };
  actionLayoutCache.spaceTabs = { root: spaceSubTabs, expTab, researchTab, tacticalTab };
  actionLayoutCache.decks = { industry: industryDeck, space: spaceDeck };
  actionLayoutCache.sections = { productionSection, basicSection, signalSection };
  actionLayoutCache.actionItems = actionItems;
  actionLayoutCache.beacon = { item: beaconItem, button: beaconButton };
  actionLayoutCache.monitor = null;
  actionLayoutCache.sectionNote = sectionNote;
  actionLayoutCache.deepSpaceHost = deepSpaceHost;
  actionLayoutCache.expeditionDeck = expeditionDeck;
  actionLayoutCache.researchDeck = researchDeck;
  actionLayoutCache.tacticalDeck = tacticalDeck;
  actionLayoutCache.tacticalPanelRoot = null;
  actionLayoutCache.persistence = {};
  return true;
}

function showTip(html, x, y) {
  tooltip.style.display = "none";
  tooltip.innerHTML = html;
  tooltip.style.display = "block";
  tooltip.style.left = `${x + 15}px`;
  tooltip.style.top = `${y + 15}px`;
}

function hideTip() {
  tooltip.style.display = "none";
}

function bindTip(node, getHtml) {
  if (node.dataset.tipBound === "1") {
    return;
  }
  node.addEventListener("mouseenter", (event) => {
    showTip(getHtml(), event.clientX || 0, event.clientY || 0);
  });
  node.addEventListener("mousemove", (event) => {
    showTip(getHtml(), event.clientX, event.clientY);
  });
  node.addEventListener("mouseleave", hideTip);
  node.dataset.tipBound = "1";
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function resourceRateTip(key) {
  return buildResourceRateTipHtml(state, key);
}

function requirementsForAction(key) {
  const getter = BUTTON_COSTS[key];
  if (!getter) {
    return [];
  }
  return getter();
}

function requirementHtml(key) {
  const parts = requirementsForAction(key);
  let desc = actionDescriptions[key] ? `<div>${actionDescriptions[key]}</div>` : "";
  if (key === "beacon") {
    const pendingCount = Math.max(0, Number(state.pendingCrewArrivals || 0));
    const nextArrivalMs = Math.max(0, Number(state.pendingCrewArrivalAt || state.beaconResponseDeadline || 0) - Date.now());
    const nextArrivalSec = Math.ceil(nextArrivalMs / 1000);
    desc = `<div>发射招募信标，当前基地人口负荷：${formatInt(state.population)}/${formatInt(computePopulationCap(state))}</div>`;
    if (pendingCount > 0) {
      desc += `<div>在途响应: ${pendingCount}，下一次预计抵达 ${nextArrivalSec}s</div>`;
    }
  }
  if (parts.length === 0) {
    return `${desc}<div>基础操作，无资源消耗</div>`;
  }
  const rows = parts
    .map((item) => {
      const cls = item.have >= item.need ? "req-ok" : "req-miss";
      return `<div class="${cls}">需求: ${item.name} ${Math.floor(item.have)}/${item.need}</div>`;
    })
    .join("");
  return `${desc}${rows}`;
}

function createActionButton(label, handler) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "action-btn";
  button.textContent = label;
  button.addEventListener("click", handler);
  return button;
}

function progressGlyph(progress) {
  const idx = Math.min(
    cooldownGlyphs.length - 1,
    Math.floor(progress * (cooldownGlyphs.length - 1))
  );
  return cooldownGlyphs[idx];
}

function applyButtonText(key, progress = 0) {
  const button = actionButtons[key];
  if (!button) {
    return;
  }
  const glyph = progressGlyph(progress);
  const label = terminalCmd(buttonDefs[key].label);
  button.innerHTML = glyph ? `${label} <span class="cooldown-dot">${glyph}</span>` : label;
}

function setButtonLocked(key, locked) {
  const button = actionButtons[key];
  if (!button) {
    return;
  }
  if (locked) {
    button.classList.add("btn-disabled");
    button.disabled = true;
    return;
  }
  button.classList.remove("btn-disabled");
  button.disabled = false;
}

function bindCooldownButton(key) {
  const def = buttonDefs[key];
  cooldowns[key] = new CooldownManager(def.cooldownMs);
  const button = createActionButton(terminalCmd(def.label), () => {
    const ok = def.action();
    if (ok === false) {
      return;
    }
    if (typeof window !== "undefined") {
      window.lastManualUpdate = Date.now();
    }
    syncResourceBarVisuals(true);
    const started = cooldowns[key].start(
      (progress) => {
        cooldownProgress[key] = progress;
        applyButtonText(key, progress);
      },
      () => {
        cooldownProgress[key] = 1;
        applyButtonText(key, 1);
        setButtonLocked(key, false);
      }
    );
    if (started) {
      setButtonLocked(key, true);
    }
  });
  if (key === "repair") {
    button.id = "btn-repair-vault";
  }
  actionButtons[key] = button;
}

function getTopBarDiscoveryValue(key) {
  switch (key) {
    case "stardust":
      return Number(state.resources.stardust || 0);
    case "scrapMetal":
      return Number(state.resources.scrapMetal || 0);
    case "sealant":
      return Number(state.resources.sealant || 0);
    case "power":
      return Number(state.resources.power || 0);
    case "oxygen":
      return state.isVaultRepaired ? Number(state.oxygen || 0) : 0;
    case "population":
      return Number(state.population || 0);
    case "alloy":
      return Number(state.resources.alloy || 0);
    case "helium3":
      return Number(state.resources.helium3 || 0);
    case "autoSmelters":
      return Number(state.autoSmelters || 0);
    case "arrays":
      return Number(state.arrays || 0);
    case "ionCatchers":
      return Number(state.ionCatchers || 0);
    case "autoSynthesizers":
      return Number(state.autoSynthesizers || 0);
    case "miningDrones":
      return Number(state.miningDrones || 0);
    case "singularity":
      return Number((state.resources && state.resources.singularity) || state.singularity || 0);
    default:
      return 0;
  }
}

function isTopBarEntryVisible(key) {
  if (TOP_BAR_ALWAYS_VISIBLE.has(key)) {
    return true;
  }
  const ui = state.systems && state.systems.ui ? state.systems.ui : {};
  const discovered = ui.discoveredTopBar || {};
  return !!discovered[key];
}

function revealTopBarEntry(node, key) {
  if (!node) {
    return;
  }
  if (!isTopBarEntryVisible(key)) {
    node.style.display = "none";
    return;
  }
  if (node.dataset.revealedTopBar !== "1") {
    node.dataset.revealedTopBar = "1";
    node.classList.add("topbar-reveal");
    node.addEventListener("animationend", () => {
      node.classList.remove("topbar-reveal");
    }, { once: true });
  }
  node.style.display = "inline-block";
}

function syncTopBarDiscoveredState() {
  const ui = state.systems && state.systems.ui ? state.systems.ui : {};
  const discovered = ui.discoveredTopBar || {};
  const toReveal = TOP_BAR_DISCOVERY_KEYS.filter((key) => {
    if (TOP_BAR_ALWAYS_VISIBLE.has(key) || discovered[key]) {
      return false;
    }
    return getTopBarDiscoveryValue(key) > 0;
  });
  if (!toReveal.length) {
    return;
  }
  setGameState((draft) => {
    draft.systems = draft.systems || {};
    draft.systems.ui = draft.systems.ui || {};
    draft.systems.ui.discoveredTopBar = draft.systems.ui.discoveredTopBar || {};
    toReveal.forEach((key) => {
      draft.systems.ui.discoveredTopBar[key] = true;
    });
  });
}

function triggerTopBarBatchFlash(node) {
  if (!node || node.style.display === "none") {
    return;
  }
  node.classList.remove("topbar-batch-refresh");
  requestAnimationFrame(() => {
    node.classList.add("topbar-batch-refresh");
  });
}

function getTopBarVisualSnapshot() {
  const singularityValue = Number((state.resources && state.resources.singularity) || state.singularity || 0);
  const singularityUnlocked =
    singularityValue > 0 ||
    !!(state.flags && state.flags.combatSystemUnlocked) ||
    Number((state.systems && state.systems.expedition) ? (state.systems.expedition.distanceKm || 0) : 0) >= 100000;
  return {
    radiation: `辐射值: ${formatInt(state.resources.radiation)}`,
    stardust: `星尘: ${formatInt(state.resources.stardust)}`,
    scrapMetal: `废金属: ${formatInt(state.resources.scrapMetal)}`,
    sealant: `密封剂: ${formatInt(state.resources.sealant)}`,
    alloy: `合金: ${formatInt(state.resources.alloy)}`,
    helium3: `氦-3: ${formatInt(state.resources.helium3)}`,
    autoSmelters: `合金模组: ${state.autoSmelters > 0 && state.resources.power <= 60 ? `${state.autoSmelters} 停机` : state.autoSmelters}`,
    power: `电力: ${Math.round(state.resources.power)}`,
    oxygen:
      (state.systems && state.systems.oxygenSupplyLow)
        ? `氧气: ${formatInt(state.oxygen)}% (供能不足)`
        : `氧气: ${formatInt(state.oxygen)}%`,
    population: `载员: ${formatInt(state.population)}/${formatInt(computePopulationCap(state))}`,
    arrays: `磁力阵列: ${state.arrays}`,
    ionCatchers: `离子捕获器: ${state.ionCatchers}`,
    autoSynthesizers: `合成仪: ${state.autoSynthesizers}`,
    miningDrones: `采矿机: ${state.miningDrones || 0}`,
    singularity: `奇点: ${formatInt(singularityValue)}`,
    singularityUnlocked
  };
}

function syncResourceBarVisuals(force = false) {
  if (!ensureTopBarNodes()) {
    return;
  }
  const now = Date.now();
  const shouldUpdate = force || !lastTopBarBatchUpdateAt || (now - lastTopBarBatchUpdateAt) >= TOP_BAR_BATCH_UPDATE_MS;
  if (!shouldUpdate) {
    return;
  }
  const snapshot = getTopBarVisualSnapshot();
  topBarVisualMirror.radiation = snapshot.radiation;
  topBarVisualMirror.stardust = snapshot.stardust;
  topBarVisualMirror.scrapMetal = snapshot.scrapMetal;
  topBarVisualMirror.sealant = snapshot.sealant;
  topBarVisualMirror.alloy = snapshot.alloy;
  topBarVisualMirror.helium3 = snapshot.helium3;
  topBarVisualMirror.autoSmelters = snapshot.autoSmelters;
  topBarVisualMirror.power = snapshot.power;
  topBarVisualMirror.oxygen = snapshot.oxygen;
  topBarVisualMirror.population = snapshot.population;
  topBarVisualMirror.arrays = snapshot.arrays;
  topBarVisualMirror.ionCatchers = snapshot.ionCatchers;
  topBarVisualMirror.autoSynthesizers = snapshot.autoSynthesizers;
  topBarVisualMirror.miningDrones = snapshot.miningDrones;
  topBarVisualMirror.singularity = snapshot.singularity;

  atomicWriter.setText(topBarNodeCache.radiation, topBarVisualMirror.radiation);
  atomicWriter.setText(topBarNodeCache.stardust, topBarVisualMirror.stardust);
  atomicWriter.setText(topBarNodeCache.scrapMetal, topBarVisualMirror.scrapMetal);
  atomicWriter.setText(topBarNodeCache.sealant, topBarVisualMirror.sealant);
  atomicWriter.setText(topBarNodeCache.alloy, topBarVisualMirror.alloy);
  atomicWriter.setText(topBarNodeCache.helium3, topBarVisualMirror.helium3);
  atomicWriter.setText(topBarNodeCache.autoSmelters, topBarVisualMirror.autoSmelters);
  atomicWriter.setText(topBarNodeCache.power, topBarVisualMirror.power);
  atomicWriter.setText(topBarNodeCache.oxygen, topBarVisualMirror.oxygen);
  safeUpdate("res-population", topBarVisualMirror.population);
  atomicWriter.setText(topBarNodeCache.arrays, topBarVisualMirror.arrays);
  atomicWriter.setText(topBarNodeCache.ionCatchers, topBarVisualMirror.ionCatchers);
  atomicWriter.setText(topBarNodeCache.autoSynthesizers, topBarVisualMirror.autoSynthesizers);
  atomicWriter.setText(topBarNodeCache.miningDrones, topBarVisualMirror.miningDrones);
  if (topBarNodeCache.singularity) {
    atomicWriter.setText(topBarNodeCache.singularity, topBarVisualMirror.singularity);
    topBarNodeCache.singularity.style.display = snapshot.singularityUnlocked ? "inline-block" : "none";
  }

  lastTopBarBatchUpdateAt = now;
  triggerTopBarBatchFlash(topBarNodeCache.stardust);
  triggerTopBarBatchFlash(topBarNodeCache.scrapMetal);
  triggerTopBarBatchFlash(topBarNodeCache.sealant);
  triggerTopBarBatchFlash(topBarNodeCache.alloy);
  triggerTopBarBatchFlash(topBarNodeCache.helium3);
  triggerTopBarBatchFlash(topBarNodeCache.autoSmelters);
  triggerTopBarBatchFlash(topBarNodeCache.power);
  triggerTopBarBatchFlash(topBarNodeCache.oxygen);
  triggerTopBarBatchFlash(topBarNodeCache.population);
  triggerTopBarBatchFlash(topBarNodeCache.arrays);
  triggerTopBarBatchFlash(topBarNodeCache.ionCatchers);
  triggerTopBarBatchFlash(topBarNodeCache.autoSynthesizers);
  triggerTopBarBatchFlash(topBarNodeCache.miningDrones);
  triggerTopBarBatchFlash(topBarNodeCache.singularity);
}

function ensureTopBarNodes() {
  if (!topBar) {
    return false;
  }
  if (topBarNodeCache.bar && topBarNodeCache.bar.isConnected) {
    return true;
  }
  topBar.innerHTML = "";
  const bar = document.createElement("div");
  bar.id = "resource-bar";
  topBarNodeCache.bar = bar;
  const createCell = (key, rateKey, statePath) => {
    const cell = document.createElement("span");
    cell.style.display = "none";
    topBarNodeCache[key] = cell;
    if (rateKey) {
      bindTip(cell, () => resourceRateTip(rateKey));
    }
    bar.appendChild(cell);
  };
  createCell("stardust", "stardust", "resources.stardust");
  createCell("scrapMetal", "scrapMetal", "resources.scrapMetal");
  createCell("sealant", "sealant", "resources.sealant");
  createCell("power", "power", "resources.power");
  const oxygenCell = document.createElement("span");
  oxygenCell.style.display = "none";
  topBarNodeCache.oxygen = oxygenCell;
  bindTip(oxygenCell, () => resourceRateTip("oxygen"));
  bar.appendChild(oxygenCell);
  const popCell = document.createElement("span");
  popCell.id = "res-population";
  popCell.style.display = "none";
  topBarNodeCache.population = popCell;
  bar.appendChild(popCell);
  createCell("alloy", "alloy", "resources.alloy");
  createCell("helium3", "helium3", "resources.helium3");
  createCell("autoSmelters", undefined, "autoSmelters");
  createCell("arrays", undefined, "arrays");
  createCell("ionCatchers", undefined, "ionCatchers");
  createCell("autoSynthesizers", undefined, "autoSynthesizers");
  createCell("miningDrones", undefined, "miningDrones");
  createCell("singularity", undefined, "resources.singularity");
  createCell("radiation", undefined, "resources.radiation");
  if (topBarNodeCache.singularity) {
    topBarNodeCache.singularity.style.display = "none";
  }
  topBar.appendChild(bar);
  const hazardAlert = document.createElement("div");
  hazardAlert.className = "hazard-alert";
  hazardAlert.style.display = "none";
  const hazardTitle = document.createElement("div");
  hazardTitle.className = "hazard-alert-title";
  const track = document.createElement("div");
  track.className = "hazard-alert-track";
  const fill = document.createElement("div");
  fill.className = "hazard-alert-fill";
  track.appendChild(fill);
  hazardAlert.appendChild(hazardTitle);
  hazardAlert.appendChild(track);
  topBar.appendChild(hazardAlert);
  topBarNodeCache.hazardAlert = hazardAlert;
  topBarNodeCache.hazardTitle = hazardTitle;
  topBarNodeCache.hazardFill = fill;
  const haltCell = document.createElement("span");
  haltCell.className = "system-halt";
  haltCell.textContent = "生命维持系统停机";
  haltCell.style.display = "none";
  topBar.appendChild(haltCell);
  topBarNodeCache.haltCell = haltCell;
  return true;
}

function renderTopBar() {
  if (!ensureTopBarNodes()) {
    return;
  }
  syncTopBarDiscoveredState();
  topBar.classList.toggle("vault-active", state.isVaultRepaired);
  const oxygenCell = topBarNodeCache.oxygen;
  topBarNodeCache.power.classList.toggle("power-critical", ((state.netRates && state.netRates.power) || 0) < 0);
  topBarNodeCache.helium3.classList.toggle("he3-pulse", state.resources.helium3 > lastHe3Seen);
  lastHe3Seen = state.resources.helium3;
  atomicWriter.setClass(oxygenCell, state.oxygen < 30 ? "oxygen-alert" : "");
  revealTopBarEntry(topBarNodeCache.stardust, "stardust");
  revealTopBarEntry(topBarNodeCache.scrapMetal, "scrapMetal");
  revealTopBarEntry(topBarNodeCache.sealant, "sealant");
  revealTopBarEntry(topBarNodeCache.power, "power");
  revealTopBarEntry(topBarNodeCache.oxygen, "oxygen");
  revealTopBarEntry(topBarNodeCache.population, "population");
  revealTopBarEntry(topBarNodeCache.alloy, "alloy");
  revealTopBarEntry(topBarNodeCache.helium3, "helium3");
  revealTopBarEntry(topBarNodeCache.autoSmelters, "autoSmelters");
  revealTopBarEntry(topBarNodeCache.arrays, "arrays");
  revealTopBarEntry(topBarNodeCache.ionCatchers, "ionCatchers");
  revealTopBarEntry(topBarNodeCache.autoSynthesizers, "autoSynthesizers");
  revealTopBarEntry(topBarNodeCache.miningDrones, "miningDrones");
  revealTopBarEntry(topBarNodeCache.singularity, "singularity");
  if (topBarNodeCache.radiation) {
    topBarNodeCache.radiation.style.display = "none";
  }
  const now = Date.now();
  const activeTimer = typeof getActiveHazardWindow === "function"
    ? getActiveHazardWindow(state, now)
    : null;
  if (activeTimer) {
    const remain = Math.max(0, activeTimer.until - now);
    const pct = Math.max(0, Math.min(100, (remain / activeTimer.duration) * 100));
    if (topBarNodeCache.hazardAlert) {
      topBarNodeCache.hazardAlert.style.display = "block";
    }
    if (topBarNodeCache.hazardTitle) {
      safeSetText(topBarNodeCache.hazardTitle, `${activeTimer.label} 剩余 ${Math.ceil(remain / 1000)}s`);
    }
    if (topBarNodeCache.hazardFill) {
      topBarNodeCache.hazardFill.style.width = `${pct}%`;
    }
  } else if (topBarNodeCache.hazardAlert) {
    topBarNodeCache.hazardAlert.style.display = "none";
  }
  if (topBarNodeCache.haltCell) {
    topBarNodeCache.haltCell.style.display = state.resources.power === 0 ? "inline" : "none";
  }
}

function renderActions() {
  if (!ensureActionLayout()) {
    return;
  }
  const signature = getActionRenderSignature();
  if (signature === lastActionRenderSignature) {
    return;
  }
  lastActionRenderSignature = signature;
  const uiState = state.systems.ui || {};
  const decks = resolveDisplayedDecks(state);
  const activeDeck = decks.activeDeck;
  const rawSpaceSub = decks.spaceSubDeck;
  const combatUnlocked = !!(state.flags && state.flags.combatSystemUnlocked);
  const normalizedSpaceSub = rawSpaceSub === "logistics" ? "expedition" : rawSpaceSub;
  const spaceSubDeck = !combatUnlocked && normalizedSpaceSub === "tactical"
    ? "expedition"
    : normalizedSpaceSub;
  const baseTab = actionLayoutCache.tabs.baseTab;
  const spaceTab = actionLayoutCache.tabs.spaceTab;
  const industryDeck = actionLayoutCache.decks.industry;
  const spaceDeck = actionLayoutCache.decks.space;
  const productionSection = actionLayoutCache.sections.productionSection;
  const basicSection = actionLayoutCache.sections.basicSection;
  const signalSection = actionLayoutCache.sections.signalSection;
  const panelLogistics = actionLayoutCache.panels.logistics;
  const panelDeepSpace = actionLayoutCache.panels.deepSpace;

  baseTab.className = activeDeck === "industry" ? "deck-tab active" : "deck-tab";
  spaceTab.className = activeDeck === "space" ? "deck-tab active" : "deck-tab";

  const focusIndustrial =
    uiState.hideManualOxygen ||
    uiState.hideReactorAction;
  document.body.classList.toggle("industrial-focus", !!focusIndustrial);
  ACTION_ORDER_KEYS.forEach((key) => {
    const button = actionButtons[key];
    const actionItem = actionLayoutCache.actionItems[key];
    if (!actionItem) {
      return;
    }
    if (!button) {
      actionItem.style.display = "none";
      return;
    }
    const shouldShow = key === "repair" && state.isVaultRepaired ? false : buttonDefs[key].visible();
    if (shouldShow) {
      actionItem.style.display = "";
      actionItem.className = "action-item";
      const softHidden =
        (key === "oxygen" && uiState.hideManualOxygen) ||
        (key === "reactor" && uiState.hideReactorAction);
      if (softHidden) {
        actionItem.classList.add("ui-soft-hidden");
      }
      applyButtonText(key, cooldownProgress[key]);
      const running = cooldowns[key].running;
      const affordable = isActionAffordable(key);
      setButtonLocked(key, running || !affordable);
      if (
        (key === "autoSmelter" && state.autoSmelters > 0 && state.resources.power <= 60) ||
        (key === "autoSynth" && state.autoSynthesizers > 0 && state.resources.power < 20)
      ) {
        button.classList.add("btn-disabled");
        button.disabled = true;
        button.textContent = terminalCmd(`${buttonDefs[key].label} 停机`);
      }
      if (button.parentNode !== actionItem) {
        actionItem.appendChild(button);
      }
    } else {
      actionItem.style.display = "none";
    }
  });
  basicSection.classList.remove("section-collapsed");
  actionLayoutCache.sectionNote.style.display = "none";
  const beaconButton = actionLayoutCache.beacon.button;
  actionLayoutCache.beacon.item.style.display = state.isVaultRepaired ? "" : "none";
  if (state.isVaultRepaired) {
    const now = Date.now();
    const responseAt = Number(state.pendingCrewArrivalAt || state.beaconResponseDeadline || 0);
    const responseLeft = Math.max(0, Math.ceil((responseAt - now) / 1000));
    const pendingCount = Math.max(0, Number(state.pendingCrewArrivals || 0));
    const berthCap = computePopulationCap(state);
    const launchCost = getBeaconLaunchCost();
    const canLaunch =
      state.population < berthCap &&
      state.resources.stardust >= launchCost;
    beaconButton.disabled = !canLaunch;
    if (beaconButton.disabled) {
      beaconButton.classList.add("btn-disabled");
    } else {
      beaconButton.classList.remove("btn-disabled");
    }
    if (state.population >= berthCap) {
      beaconButton.classList.add("btn-disabled");
      safeSetText(beaconButton, terminalCmd("舱内空间不足"));
    } else {
      const queueSuffix = pendingCount > 0 ? ` (在途 ${pendingCount}${responseLeft > 0 ? `, ${responseLeft}s` : ""})` : "";
      safeSetText(beaconButton, terminalCmd(`发射星尘信标 -${launchCost}星尘${queueSuffix}`));
    }
    beaconButton.onclick = () => {
      const ok = activateStardustBeacon();
      if (ok !== false) {
        if (typeof window !== "undefined") {
          window.lastManualUpdate = Date.now();
        }
        syncResourceBarVisuals(true);
        renderActions();
      }
    };
    bindTip(beaconButton, () => requirementHtml("beacon"));
  }
  const expTab = actionLayoutCache.spaceTabs.expTab;
  const researchTab = actionLayoutCache.spaceTabs.researchTab;
  const tacticalTab = actionLayoutCache.spaceTabs.tacticalTab;
  expTab.className = spaceSubDeck === "expedition" ? "deck-tab active" : "deck-tab";
  researchTab.className = spaceSubDeck === "research" ? "deck-tab active" : "deck-tab";
  tacticalTab.className = spaceSubDeck === "tactical" ? "deck-tab active" : "deck-tab";
  tacticalTab.style.display = combatUnlocked ? "" : "none";
  tacticalTab.classList.toggle("tactical-alert-tab", combatUnlocked);
  const expeditionDeck = actionLayoutCache.expeditionDeck;
  const researchDeck = actionLayoutCache.researchDeck;
  const tacticalDeck = actionLayoutCache.tacticalDeck;
  const deepSpaceHost =
    document.getElementById(DOM_DEEP_SPACE) || actionLayoutCache.deepSpaceHost;
  const deepSpaceUnlocked = isDeepSpaceUnlocked(state);

  if (spaceUI && typeof spaceUI.renderExpeditionConsole === "function") {
    spaceUI.renderExpeditionConsole(expeditionDeck, () => {
      renderActions();
    });
  }

  const refreshUi = () => {
    renderAll();
  };

  if (typeof createResearchCenterPanel === "function") {
    const panel = createResearchCenterPanel({
      state,
      requirementHtml,
      bindTip,
      formatInt,
      onRefresh: refreshUi
    });
    if (panel) {
      researchDeck.replaceChildren(panel);
    }
  }
  if (typeof createTacticalCenterPanel === "function") {
    try {
      const cachedTac = actionLayoutCache.tacticalPanelRoot;
      if (cachedTac && tacticalDeck.contains(cachedTac) && typeof cachedTac.__tacticalRefresh === "function") {
        cachedTac.__tacticalRefresh();
      } else {
        const panel = createTacticalCenterPanel({
          state,
          formatInt,
          onRefresh: refreshUi
        });
        if (panel) {
          actionLayoutCache.tacticalPanelRoot = panel;
          tacticalDeck.replaceChildren(panel);
        }
      }
    } catch (err) {
      console.error("[UI_DEBUG] TacticalCenter render failed:", err);
      const fallback = document.createElement("div");
      fallback.className = "tactical-fallback";
      fallback.style.cssText = "color:#CCC;text-align:center;padding:40px 12px;font-family:monospace;";
      fallback.textContent = "战术指挥部初始化中...";
      tacticalDeck.replaceChildren(fallback);
    }
  }

  if (spaceSubDeck === "research") {
    expeditionDeck.classList.add("hidden");
    researchDeck.classList.remove("hidden");
    tacticalDeck.classList.add("hidden");
  } else if (spaceSubDeck === "tactical") {
    expeditionDeck.classList.add("hidden");
    researchDeck.classList.add("hidden");
    tacticalDeck.classList.remove("hidden");
  } else {
    expeditionDeck.classList.remove("hidden");
    researchDeck.classList.add("hidden");
    tacticalDeck.classList.add("hidden");
  }
  if (deepSpaceHost) {
    if (deepSpaceUnlocked && typeof createDeepSpaceProductionSection === "function") {
      const deepBlock = createDeepSpaceProductionSection({
        state,
        requirementHtml,
        bindTip,
        formatInt,
        onRefresh: refreshUi
      });
      if (deepBlock) {
        deepSpaceHost.replaceChildren(deepBlock);
      } else {
        deepSpaceHost.replaceChildren();
      }
    } else {
      deepSpaceHost.replaceChildren();
    }
  }

  industryDeck.classList.toggle("hidden", activeDeck === "space");
  spaceDeck.classList.toggle("hidden", activeDeck !== "space");
  if (panelLogistics) {
    panelLogistics.classList.toggle("is-active", activeDeck !== "space");
    panelLogistics.classList.toggle("is-inactive", activeDeck === "space");
  }
  if (panelDeepSpace) {
    panelDeepSpace.classList.toggle("is-active", activeDeck === "space");
    panelDeepSpace.classList.toggle("is-inactive", activeDeck !== "space");
  }
  if (rightPanel) {
    rightPanel.classList.toggle(
      "tactical-terminal-lock",
      activeDeck === "space" && spaceSubDeck === "tactical" && combatUnlocked
    );
  }
}

function renderLogs() {
  if (!logStream) {
    return;
  }
  const uiLog = state.systems && state.systems.ui;
  const toggleEnabled = !!(uiLog && uiLog.automationLoggingEnabled);
  const logs = state.logs.slice(0, LOG_RENDER_LIMIT);
  const hash = logs.map((line) => {
    const text = typeof line === "string" ? line : (line && line.text ? line.text : "");
    const color = typeof line === "object" && line && typeof line.color === "string" ? line.color : "";
    return `${text}::${color}`;
  }).join("|");

  if (hash === lastLogHash && toggleEnabled === lastLogToggleState) {
    return;
  }
  lastLogHash = hash;
  lastLogToggleState = toggleEnabled;
  renderLogStream(
    logStream,
    logs,
    toggleEnabled,
    () => {
      const cur = state.systems && state.systems.ui && state.systems.ui.automationLoggingEnabled;
      setAutomationLoggingEnabled(!cur);
    }
  );
}

function destroyOutpostModal() {
  const modal = document.getElementById("outpost-modal");
  if (modal && modal.parentNode) {
    modal.parentNode.removeChild(modal);
  }
}

function showOutpostMenu() {
  if (!state.systems || !state.systems.ui || !state.systems.ui.outpostMenuLocked) {
    return;
  }
  if (typeof showOutpostMenuPanel === "function") {
    showOutpostMenuPanel({
      setState: setGameState,
      renderAll,
      saveGame,
      addLog: MoundEngine && MoundEngine.addLog ? MoundEngine.addLog : null
    });
    return;
  }
  destroyOutpostModal();
  const host =
    resolveGameShell() ||
    document.getElementById("main-container") ||
    document.getElementById("building-list") ||
    document.body;
  if (!host) {
    return;
  }
  const modal = document.createElement("div");
  modal.id = "outpost-modal";
  modal.className = "outpost-modal";
  setGameState((draft) => {
    draft.systems.ui = draft.systems.ui || {};
    if (typeof draft.systems.ui.outpostSavedThrust !== "number") {
      draft.systems.ui.outpostSavedThrust = typeof draft.thrustMultiplier === "number" ? draft.thrustMultiplier : 1;
    }
    draft.thrustMultiplier = 0;
  });

  const closeOutpostMenu = () => {
    destroyOutpostModal();
    setGameState((draft) => {
      draft.systems = draft.systems || {};
      draft.systems.ui = draft.systems.ui || {};
      draft.systems.expedition = draft.systems.expedition || {};
      draft.systems.ui.outpostMenuLocked = false;
      draft.thrustMultiplier = typeof draft.systems.ui.outpostSavedThrust === "number"
        ? draft.systems.ui.outpostSavedThrust
        : 1;
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

  host.appendChild(modal);
  if (typeof renderOutpostExchangeBody === "function") {
    renderOutpostExchangeBody({
      modal,
      state,
      setState: setGameState,
      renderAll,
      saveGame,
      addLog: MoundEngine && MoundEngine.addLog ? MoundEngine.addLog : null,
      onClose: closeOutpostMenu
    });
  }
}

function performRenderAll(force) {
  // === ENDING SEQUENCE — absolute top priority, blocks everything ===
  // Only hijack rendering when the overlay is PHYSICALLY in the DOM.
  // A bare endingActive flag without a DOM overlay is either a stale
  // auto-save remnant or the very first cycle after endCombat set the
  // flag — in both cases we must NOT block combat initialisation.
  const endingActive = !!(state.flags && state.flags.endingActive);
  const endingOverlayInDom = typeof document !== "undefined" && document.getElementById("ending-overlay");
  if (endingActive && endingOverlayInDom) {
    if (uiRenderTimer) {
      clearTimeout(uiRenderTimer);
      uiRenderTimer = null;
    }
    const staleModal = document.getElementById("combat-modal-container");
    if (staleModal && staleModal.parentNode) {
      staleModal.parentNode.removeChild(staleModal);
    }
    if (document.body) {
      document.body.classList.remove("combat-active");
    }
    return;
  }
  if (endingActive && !endingOverlayInDom) {
    // First render cycle after endCombat / handleFlee set the ending flag
    // but before the overlay exists.  Create it now.
    if (uiRenderTimer) {
      clearTimeout(uiRenderTimer);
      uiRenderTimer = null;
    }
    if (typeof document !== "undefined") {
      const staleModal = document.getElementById("combat-modal-container");
      if (staleModal && staleModal.parentNode) {
        staleModal.parentNode.removeChild(staleModal);
      }
      if (document.body) {
        document.body.classList.remove("combat-active");
      }
    }
    const isDefeat = !!(state.flags && state.flags.endingIsDefeat);
    const isEvac = !!(state.flags && state.flags.endingIsEvac);
    if (isEvac) {
      renderEvacScreen();
    } else if (isDefeat) {
      renderDefeatScreen();
    } else {
      renderEndingScreen();
    }
    return;
  }

  // === COMBAT MODAL — absolute top, independent of tab/deck logic ===
  const showCombatModal = !!(state.systems && state.systems.ui && state.systems.ui.showCombatModal);
  const combatUiForced = showCombatModal;
  if (typeof document !== "undefined") {
    document.body.classList.toggle("combat-active", combatUiForced);
    if (showCombatModal && typeof showCombatModalFn === "function") {
      try {
        showCombatModalFn();
      } catch (err) {
        console.error("[COMBAT_UI] showCombatModalFn threw:", err);
      }
    }
  }

  const forceRender = force === true;
  const _deckResolved = resolveDisplayedDecks(state);
  const _deckLogKey = `${state.activeDeck}|${state.spaceSubDeck}|${state.combatState}|${_deckResolved.activeDeck}|${_deckResolved.spaceSubDeck}`;
  if (_deckLogKey !== lastDeckUiLogKey) {
    lastDeckUiLogKey = _deckLogKey;
  }
  if (spaceUI && typeof spaceUI.applySpaceTheme === "function") {
    spaceUI.applySpaceTheme(state.systems.expedition);
  }
  document.body.classList.toggle("danger-flash", (state.systems.ui.dangerFlashUntil || 0) > Date.now());
  const nowMs = Date.now();
  const uiState = state.systems && state.systems.ui ? state.systems.ui : {};
  const showCombatModalKey = showCombatModal ? "1" : "0";
  const deckKey = resolveDisplayedDecks(state);
  const panelKey = `${deckKey.activeDeck}:${deckKey.spaceSubDeck}:${state.isVaultRepaired ? 1 : 0}:${state.flags && state.flags.combatSystemUnlocked ? 1 : 0}:${showCombatModalKey}`;
  document.body.classList.toggle("alert-red-mode", !!(state.flags && state.flags.combatSystemUnlocked));
  renderTopBar();
  const shouldRenderPanels =
    forceRender ||
    panelKey !== lastPanelKey ||
    (nowMs - lastPanelRenderAt) >= PANEL_RENDER_INTERVAL_MS;
  if (shouldRenderPanels) {
    lastActionRenderSignature = "";
    renderActions();
    lastPanelRenderAt = nowMs;
    lastPanelKey = panelKey;
  }
  const shouldRenderLogs = forceRender || (nowMs - lastLogRenderAt) >= LOG_RENDER_INTERVAL_MS;
  const uiLog = state.systems && state.systems.ui;
  const toggleEnabled = !!(uiLog && uiLog.automationLoggingEnabled);
  const logChanged = state.logs.length !== lastLogCount || toggleEnabled !== lastLogToggleState;
  if (shouldRenderLogs && (forceRender || logChanged)) {
    renderLogs();
    lastLogRenderAt = nowMs;
    lastLogCount = state.logs.length;
  }
  if (state.systems.ui.outpostMenuLocked && !document.getElementById("outpost-modal")) {
    showOutpostMenu();
  }
  const now = nowMs;
  if (typeof refreshThrustUiBridge === "function" && now - thrustUiSyncAt >= 300) {
    thrustUiSyncAt = now;
    refreshThrustUiBridge();
  }
}

function renderAll(force) {
  const schedule = (task) => scheduleUiRender(task);
  const shouldForce = force === true;
  const now = performance.now();
  if (shouldForce || (now - lastUiRenderAt) >= UI_RENDER_INTERVAL_MS) {
    if (uiRenderTimer) {
      clearTimeout(uiRenderTimer);
      uiRenderTimer = null;
    }
    lastUiRenderAt = now;
    schedule(() => performRenderAll(shouldForce));
    return;
  }
  if (uiRenderTimer) {
    return;
  }
  const wait = Math.max(0, UI_RENDER_INTERVAL_MS - (now - lastUiRenderAt));
  uiRenderTimer = setTimeout(() => {
    uiRenderTimer = null;
    lastUiRenderAt = performance.now();
    schedule(() => performRenderAll(false));
  }, wait);
}

function initUI() {
  initBackgroundEffect();
  if (typeof window !== "undefined") {
    window.lastManualUpdate = 0;
    window.addEventListener("FORCE_COMBAT_RENDER", () => {
      performRenderAll(true);
    });
  }
  initDeepSpaceInputDelegation(actionList || document);
  bindCooldownButton("stardust");
  bindCooldownButton("scrap");
  bindCooldownButton("reactor");
  bindCooldownButton("sealant");
  bindCooldownButton("repair");
  bindCooldownButton("oxygen");
  bindCooldownButton("charge");
  bindCooldownButton("crank");
  bindCooldownButton("array");
  bindCooldownButton("melt");
  bindCooldownButton("efficiency");
  bindCooldownButton("ionCatcher");
  bindCooldownButton("refiningFurnace");
  bindCooldownButton("autoSmelter");
  bindCooldownButton("autoSynth");
  bindCooldownButton("refine");
  if (signalTicker) {
    clearInterval(signalTicker);
    signalTicker = null;
  }
  if (topBarSyncTimer) {
    clearInterval(topBarSyncTimer);
    topBarSyncTimer = null;
  }
  if (stateUnsubscribe) {
    stateUnsubscribe();
    stateUnsubscribe = null;
  }
  if (!isInitialIdleState()) {
    startEngine();
  } else {
    console.warn("[UIRoot] 初始静态态：已跳过非必要引擎启动。");
  }
  registerApplyDeckInDraft(applyGameDeckInDraft);
  renderAll(true);
  syncResourceBarVisuals(false);
  topBarSyncTimer = setInterval(() => {
    syncResourceBarVisuals(false);
  }, TOP_BAR_BATCH_UPDATE_MS);
  if (getStorageNeedsRender()) {
    renderAll(true);
    syncResourceBarVisuals(false);
    setStorageNeedsRender(false);
  }
  const subscribePaths = typeof subscribeStatePaths === "function" ? subscribeStatePaths : null;
  if (subscribePaths) {
    stateUnsubscribe = subscribePaths(
      [
        "resources",
        "oxygen",
        "population",
        "populationCap",
        "pendingCrewArrivals",
        "pendingCrewArrivalAt",
        "arrays",
        "ionCatchers",
        "autoSynthesizers",
        "miningDrones",
        "fusionGenerators",
        "massDriverBuilt",
        "structures",
        "autoSmelters",
        "singularity",
        "distance",
        "logs",
        "combatState",
        "systems.combatEncounter",
        "combatStats",
        "combat",
        "flags.combatSystemUnlocked",
        "systems.ui",
        "activeDeck",
        "spaceSubDeck",
        "systems.deepSpace",
        "systems.expedition",
        "isVaultRepaired",
        "blueprints",
        "techEraEnabled",
        "crew",
        "maxPopulation"
      ],
      (event) => {
        const path = event && typeof event.path === "string" ? event.path : "";
        const isLogUpdate = path === "logs" || path.startsWith("logs.") || path === "systems.ui.automationLoggingEnabled";
        const isResourceUpdate =
          path === "resources" ||
          path.startsWith("resources.") ||
          path === "oxygen" ||
          path === "population" ||
          path === "populationCap" ||
          path === "pendingCrewArrivals" ||
          path === "pendingCrewArrivalAt" ||
          path === "crew" ||
          path === "maxPopulation" ||
          path === "arrays" ||
          path === "ionCatchers" ||
          path === "autoSynthesizers" ||
          path === "miningDrones" ||
          path === "autoSmelters" ||
          path === "resources.techPoints" ||
          path === "singularity" ||
          path === "distance";
        const isPanelUpdate =
          path === "systems.ui" ||
          path.startsWith("systems.ui.") ||
          path === "activeDeck" ||
          path === "spaceSubDeck" ||
          path === "systems.deepSpace" ||
          path.startsWith("systems.deepSpace.") ||
          path === "systems.expedition" ||
          path.startsWith("systems.expedition.") ||
          path === "systems.combatEncounter" ||
          path.startsWith("systems.combatEncounter.") ||
          path === "combatState" ||
          path === "combatStats" ||
          path.startsWith("combatStats.") ||
          path === "combat" ||
          path.startsWith("combat.") ||
          path === "flags.combatSystemUnlocked" ||
          path === "pendingCrewArrivals" ||
          path === "pendingCrewArrivalAt" ||
          path === "massDriverBuilt" ||
          path === "miningDrones" ||
          path === "fusionGenerators" ||
          path === "structures" ||
          path.startsWith("structures.") ||
          path === "isVaultRepaired" ||
          path === "blueprints" ||
          path.startsWith("blueprints.") ||
          path === "techEraEnabled";

        if (isResourceUpdate) {
          scheduleUiRender(() => renderTopBar());
        }
        if (isLogUpdate) {
          scheduleUiRender(() => renderLogs());
        }
        if (isPanelUpdate) {
          scheduleUiRender(() => renderActions());
        }
      }
    );
  } else {
    stateUnsubscribe = subscribe(() => {
      renderTopBar();
    });
  }
  queueMicrotask(() => renderAll(true));
  requestAnimationFrame(() => renderAll(true));
}

uiApi = {
  initUI,
  renderAll,
  showOutpostMenu,
  syncResourceBarVisuals
};
setUiApi(uiApi);
})();

export function initUI() {
  if (uiApi && typeof uiApi.initUI === "function") {
    return uiApi.initUI();
  }
  return undefined;
}

export function renderAll(force) {
  if (uiApi && typeof uiApi.renderAll === "function") {
    return uiApi.renderAll(force);
  }
  return undefined;
}

export function syncResourceBarVisuals(force = false) {
  if (uiApi && typeof uiApi.syncResourceBarVisuals === "function") {
    return uiApi.syncResourceBarVisuals(force);
  }
  return undefined;
}

/**
 * Called from `engine.js` after `engine-runtime` loads so the Engine API exists before UI mounts.
 */
export function bootstrapGameUi() {
  const shell = resolveGameShell();
  if (!shell) {
    console.error("[UIRoot] bootstrapGameUi: 无法解析 #game-container（注入失败）。");
    return;
  }
  if (!getEngineApi()) {
    console.warn("UI Init: Engine not ready — 将仍尝试挂载界面；部分逻辑可能延迟。");
  }
  if (window.__uiRootInited) {
    queueMicrotask(() => renderAll(true));
    requestAnimationFrame(() => renderAll(true));
    return;
  }
  window.__uiRootInited = true;
  initUI();
}
