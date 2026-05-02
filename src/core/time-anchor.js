import { moundState } from "./state.js";
import { getEngineApi, getUiApi } from "./runtime-hooks.js";

const ANCHOR_KEY = "omega_boss_checkpoint";

// ── Safeguard 1: Deep Clone ──

function isPlainObject(value) {
  return Object.prototype.toString.call(value) === "[object Object]";
}

function cloneSerializable(value, depth = 0) {
  if (depth > 64) return null; // circular reference guard
  if (typeof value === "function") return undefined;
  if (value === undefined) return null;
  if (value === null) return null;
  if (Array.isArray(value)) {
    return value.map((v) => cloneSerializable(v, depth + 1));
  }
  if (isPlainObject(value)) {
    const out = {};
    Object.keys(value).forEach((key) => {
      if (key.includes("timer") || key.includes("handle") || key.includes("Timer") || key.includes("Handle")) {
        return;
      }
      const cloned = cloneSerializable(value[key], depth + 1);
      if (cloned !== undefined) {
        out[key] = cloned;
      }
    });
    return out;
  }
  // Primitives: string, number, boolean
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  return null; // Drop symbols, bigints, etc.
}

function serializeAnchorPayload(state) {
  try {
    const cloned = cloneSerializable(state);
    if (!cloned || typeof cloned !== "object") return null;
    // Verify round-trip safety
    const json = JSON.stringify(cloned);
    if (!json || json.length < 100) return null; // Suspiciously small
    const reparse = JSON.parse(json);
    if (!isPlainObject(reparse)) return null;
    return json;
  } catch (e) {
    console.error("[时间锚点] 序列化失败", e);
    return null;
  }
}

// ── Safeguard 2: Validation on Load (Anti-Brick) ──

const REQUIRED_PATHS = [
  "resources",
  "systems",
  "systems.expedition",
  "structures",
  "flags",
  "combat"
];

const REQUIRED_NUMERIC_FIELDS = [
  ["systems", "expedition", "distanceKm"],
  ["resources", "stardust"],
  ["resources", "power"],
  ["resources", "scrapMetal"],
  ["resources", "oxygen"],
  ["resources", "helium3"],
  ["resources", "alloy"],
  ["resources", "sealant"],
  ["resources", "crew"],
  ["resources", "techPoints"],
  ["resources", "singularity"],
  ["resources", "powerCapacity"]
];

function validateTimeAnchorPayload(parsed) {
  if (!isPlainObject(parsed)) {
    console.error("[时间锚点·校验] 数据格式无效：非对象。");
    return false;
  }

  // Check required object paths exist
  for (const path of REQUIRED_PATHS) {
    const segments = path.split(".");
    let cursor = parsed;
    let ok = true;
    for (const seg of segments) {
      if (!cursor || typeof cursor !== "object" || !(seg in cursor)) {
        ok = false;
        break;
      }
      cursor = cursor[seg];
    }
    if (!ok) {
      console.error(`[时间锚点·校验] 缺少必要路径: ${path}`);
      return false;
    }
  }

  // Check required numeric fields
  for (const fieldPath of REQUIRED_NUMERIC_FIELDS) {
    let cursor = parsed;
    for (let i = 0; i < fieldPath.length - 1; i++) {
      cursor = cursor[fieldPath[i]];
      if (!cursor || typeof cursor !== "object") break;
    }
    const lastKey = fieldPath[fieldPath.length - 1];
    const value = cursor ? cursor[lastKey] : undefined;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      console.error(`[时间锚点·校验] 必要数值字段无效: ${fieldPath.join(".")} = ${value}`);
      return false;
    }
  }

  // Distance sanity: must be reasonable (0-500000 km)
  const dist = parsed.systems.expedition.distanceKm;
  if (dist < 0 || dist > 500000) {
    console.error(`[时间锚点·校验] 距离异常: ${dist} km`);
    return false;
  }

  // Resources sanity: no negative or NaN
  const res = parsed.resources;
  if (res.stardust < 0 || res.power < 0 || res.oxygen < 0 || res.scrapMetal < 0 ||
      res.helium3 < 0 || res.alloy < 0 || res.sealant < 0 || res.crew < 0 || res.techPoints < 0 || res.singularity < 0) {
    console.error("[时间锚点·校验] 资源值为负数，拒绝加载。");
    return false;
  }

  return true;
}

// ── Safeguard 3: Combat State Reset on Load ──

/**
 * Paths that represent permanent player progression (never downgraded by time-anchor loads).
 * Numbers use MAX(current, saved); booleans use OR logic.
 * During time-anchor load, these keep the HIGHER of (current live state, saved anchor).
 */
const PROGRESSION_PATHS = [
  // ── Combat ship levels ──
  ["combat", "attackSystems", "kineticCannon"],
  ["combat", "attackSystems", "laserArray"],
  ["combat", "defenseSystems", "shieldGenerator"],
  ["combat", "defenseSystems", "ablativeArmor"],
  ["combat", "attackLevel"],
  ["combat", "defenseLevel"],
  ["combat", "baseDamage"],
  ["combat", "critChance"],
  ["combat", "damageReduction"],
  ["combat", "hullHp"],
  // ── Upgrades ──
  ["upgrades", "dustRefining"],
  ["upgrades", "powerEfficiency"],
  ["upgrades", "shieldLevel"],
  // ── Structures (count) ──
  ["structures", "magneticArray"],
  ["structures", "massProjector"],
  ["structures", "miningMachine"],
  ["structures", "fusionGenerator"],
  // ── Boolean progression flags (OR logic: true wins) ──
  ["hasRefiningFurnace"],
  ["massDriverBuilt"],
  ["blueprints", "maintenanceCenter"],
  ["blueprints", "quantumCommArray"],
  ["blueprints", "researchWorkstation"],
  ["flags", "combatSystemUnlocked"],
  ["flags", "isResearchStationBlueprintUnlocked"]
];

function getNested(obj, path) {
  let cursor = obj;
  for (const seg of path) {
    if (!cursor || typeof cursor !== "object") return undefined;
    cursor = cursor[seg];
  }
  return cursor;
}

function setNested(obj, path, value) {
  const last = path[path.length - 1];
  let cursor = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const seg = path[i];
    if (!cursor[seg] || typeof cursor[seg] !== "object") {
      cursor[seg] = {};
    }
    cursor = cursor[seg];
  }
  cursor[last] = value;
}

function snapshotProgression(draft) {
  const snap = {};
  for (const path of PROGRESSION_PATHS) {
    const val = getNested(draft, path);
    if (val !== undefined && val !== null) {
      snap[path.join(".")] = val;
    }
  }
  return snap;
}

function restoreProgressionMax(draft, snapshot) {
  for (const path of PROGRESSION_PATHS) {
    const pathKey = path.join(".");
    const snapVal = snapshot[pathKey];
    if (snapVal === undefined || snapVal === null) continue;
    const mergedVal = getNested(draft, path);
    if (mergedVal === undefined || mergedVal === null) {
      setNested(draft, path, snapVal);
      continue;
    }
    // Numbers: keep max. Booleans: keep true if either is true.
    if (typeof snapVal === "boolean" || typeof mergedVal === "boolean") {
      if (snapVal || mergedVal) {
        setNested(draft, path, true);
      }
    } else if (typeof snapVal === "number" && typeof mergedVal === "number") {
      if (Number.isFinite(snapVal) && (!Number.isFinite(mergedVal) || snapVal > mergedVal)) {
        setNested(draft, path, snapVal);
      }
    } else {
      // Type mismatch — prefer the snapshot (anchor truth)
      setNested(draft, path, snapVal);
    }
  }
}

function applyCombatReset(draft) {
  const currentDistance = (draft.systems && draft.systems.expedition)
    ? Number(draft.systems.expedition.distanceKm || 0)
    : 0;

  // Hard reset: fully re-init combat encounter slice
  draft.systems = draft.systems || {};
  draft.systems.combatEncounter = {
    phase: "IDLE",
    enemy: null,
    savedThrottle: null,
    lastTriggerKm: null,
    massDriverCharging: false,
    lastResolution: null,
    isBoss: false,
    bossEndingActive: false,
    bossPhase: 1,
    bossBioPulseCounter: 0,
    bossVoidNovaCounter: 0,
    bossOriginalAttack: 75,
    bossTransitionBuffer: false,
    bossCorrosionDamage: 0,
    bossAblationLayer: 1200,
    bossKineticDamageDealt: 0,
    bossP2TotalTurns: 0
  };
  draft.combatState = "IDLE";

  // Hard reset: combat stats
  draft.combatStats = {
    hull: draft.combat && typeof draft.combat.hullHp === "number" ? draft.combat.hullHp : 100,
    hullMax: draft.combat && typeof draft.combat.hullHp === "number" ? draft.combat.hullHp : 100,
    playerShield: 0,
    playerShieldMax: 30,
    shieldCooldown: 0,
    shieldCharges: 3,
    laserCooldown: 0,
    turnCount: 0
  };

  // Hard reset: combat turn state
  draft.combat = draft.combat || {};
  draft.combat.turnCount = 0;
  draft.combat.shieldCooldown = 0;
  draft.combat.shieldCharges = 3;
  draft.combat.laserCooldown = 0;
  draft.combat.playerShield = 0;
  draft.combat.isLocked = false;

  // Clear UI combat state
  draft.systems.ui = draft.systems.ui || {};
  draft.systems.ui.showCombatModal = false;
  draft.systems.ui.activeEncounter = null;

  // Unlock navigation
  draft.systems.expedition = draft.systems.expedition || {};
  draft.systems.expedition.isNavigationLocked = false;

  // Clear all boss-related flags so the boss can re-trigger after rollback
  if (draft.flags) {
    draft.flags.omegaDefeated = false;
    draft.flags.omegaSlayer = false;
    draft.flags.omegaEndingDefeat = false;
    draft.flags.isInCombat = false;
  }
}

function removeCombatModalsFromDOM() {
  if (typeof document === "undefined") return;
  // Remove full-screen combat modal
  const modalContainer = document.getElementById("combat-modal-container");
  if (modalContainer && modalContainer.parentNode) {
    modalContainer.parentNode.removeChild(modalContainer);
  }
  // Remove combat-active class from body
  if (document.body) {
    document.body.classList.remove("combat-active");
  }
}

// ── Safeguard 4: UI Feedback & Protection ──

export function isCombatActive() {
  try {
    const state = moundState && moundState.state;
    if (!state) return false;
    if (state.combatState && state.combatState !== "IDLE") return true;
    const enc = state.systems && state.systems.combatEncounter;
    if (enc && enc.phase && enc.phase !== "IDLE") return true;
    return false;
  } catch (e) {
    return false;
  }
}

function logToEngine(msg) {
  const engineHook = getEngineApi();
  if (engineHook && typeof engineHook.addLog === "function") {
    engineHook.addLog(msg);
  }
}

// ── Public API ──

export function saveTimeAnchor() {
  try {
    // Safeguard 4: Disable save during combat
    if (isCombatActive()) {
      logToEngine("[时间锚点] 无法保存：战斗进行中，请先完成或脱离战斗。");
      return false;
    }

    const state = moundState && moundState.state;
    if (!state || typeof state !== "object") {
      logToEngine("[时间锚点] 保存失败：状态无效。");
      return false;
    }

    const json = serializeAnchorPayload(state);
    if (!json) {
      logToEngine("[时间锚点] 保存失败：序列化异常。");
      return false;
    }

    localStorage.setItem(ANCHOR_KEY, json);

    // Record the checkpoint distance so the restart flow can preserve it
    const currentDistance = state.systems && state.systems.expedition
      ? Math.floor(Number(state.systems.expedition.distanceKm || 0))
      : 0;
    if (currentDistance > 0) {
      moundState.setState((draft) => {
        draft.checkpoints = draft.checkpoints || [];
        if (!draft.checkpoints.includes(currentDistance)) {
          draft.checkpoints.push(currentDistance);
        }
      });
    }

    logToEngine("[时间锚点] 当前状态已保存至时间锚点。");
    return true;
  } catch (e) {
    console.error("[时间锚点] 保存失败", e);
    logToEngine("[时间锚点] 保存时发生异常。");
    return false;
  }
}

export function loadTimeAnchor(options = {}) {
  const { skipConfirm = false } = options;

  try {
    // Safeguard 4: Confirmation dialog
    if (!skipConfirm && typeof window !== "undefined" && typeof window.confirm === "function") {
      const confirmed = window.confirm("确定要回溯时间线吗？当前进度将丢失。");
      if (!confirmed) {
        logToEngine("[时间锚点] 回溯已取消。");
        return false;
      }
    }

    const raw = localStorage.getItem(ANCHOR_KEY);
    if (!raw) {
      logToEngine("[时间锚点] 未找到已保存的时间锚点。");
      return false;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (parseErr) {
      console.error("[时间锚点] JSON 解析失败", parseErr);
      logToEngine("[时间锚点] 锚点数据损坏，无法解析。");
      return false;
    }

    // Safeguard 2: Validate before touching state
    if (!validateTimeAnchorPayload(parsed)) {
      logToEngine("[时间锚点] 锚点数据校验失败，拒绝加载以防止存档损坏。");
      console.error("[时间锚点·拒绝] 校验未通过，锚点未加载。");
      return false;
    }

    // Merge into state — selective overlay (never wipes current progress)
    function deepMerge(target, source) {
      Object.keys(source || {}).forEach((key) => {
        const next = source[key];
        if (isPlainObject(next) && isPlainObject(target[key])) {
          deepMerge(target[key], next);
          return;
        }
        target[key] = next;
      });
    }

    function mergeSavedIntoDraft(draft, saved) {
      Object.keys(saved || {}).forEach((key) => {
        const next = saved[key];
        if (next === undefined || next === null) return; // never overwrite with null/undefined
        if (isPlainObject(next) && isPlainObject(draft[key])) {
          deepMerge(draft[key], next);
          return;
        }
        draft[key] = next;
      });
    }

    moundState.setState((draft) => {
      // Snapshot current progression before merge (prevents rollback from erasing upgrades)
      const progSnap = snapshotProgression(draft);

      // Selective merge: overlay saved state onto draft without destructive wipe
      mergeSavedIntoDraft(draft, parsed);

      // Restore progression to max(current live, saved anchor)
      restoreProgressionMax(draft, progSnap);

      // Safeguard 3: Force-reset combat turn state only (not ship progression)
      applyCombatReset(draft);
    });

    // Safeguard 3: Remove combat UI from DOM
    removeCombatModalsFromDOM();

    // Trigger full re-render
    const ui = getUiApi();
    if (ui && typeof ui.renderAll === "function") {
      ui.renderAll(true);
    }

    logToEngine("[时间锚点] 时间线回溯至锚点时刻。");
    return true;
  } catch (e) {
    console.error("[时间锚点] 回溯失败", e);
    logToEngine("[时间锚点] 回溯时发生严重异常。");
    return false;
  }
}

export function hasTimeAnchor() {
  try {
    return !!localStorage.getItem(ANCHOR_KEY);
  } catch (e) {
    return false;
  }
}

export { ANCHOR_KEY };

// Expose to global scope so HTML onclick / console can reach them
if (typeof window !== "undefined") {
  window.saveTimeAnchor = saveTimeAnchor;
  window.loadTimeAnchor = loadTimeAnchor;

  /**
   * Emergency one-shot: restore combat ship levels from known-good values.
   * Run in console: `restoreCombatLevels()`
   * Override with custom values: `restoreCombatLevels({ kinetic: 30, laser: 30, shield: 25, armor: 32, baseDamage: 301, hullHp: 1380 })`
   */
  window.restoreCombatLevels = function (overrides = {}) {
    const state = moundState && moundState.state;
    if (!state) {
      console.error("[restoreCombatLevels] State not found.");
      return false;
    }
    const cfg = {
      kinetic: Number(overrides.kinetic ?? 30),
      laser: Number(overrides.laser ?? 30),
      shield: Number(overrides.shield ?? 25),
      armor: Number(overrides.armor ?? 32),
      baseDamage: Number(overrides.baseDamage ?? 301),
      hullHp: Number(overrides.hullHp ?? 1380)
    };
    moundState.setState((draft) => {
      draft.combat = draft.combat || {};
      draft.combat.attackSystems = draft.combat.attackSystems || {};
      draft.combat.defenseSystems = draft.combat.defenseSystems || {};
      draft.combat.attackSystems.kineticCannon = cfg.kinetic;
      draft.combat.attackSystems.laserArray = cfg.laser;
      draft.combat.defenseSystems.shieldGenerator = cfg.shield;
      draft.combat.defenseSystems.ablativeArmor = cfg.armor;
      draft.combat.attackLevel = cfg.kinetic + cfg.laser;
      draft.combat.defenseLevel = cfg.shield + cfg.armor;
      draft.combat.baseDamage = cfg.baseDamage;
      draft.combat.hullHp = cfg.hullHp;
      // Sync combatStats hull
      if (draft.combatStats) {
        draft.combatStats.hullMax = cfg.hullHp;
        draft.combatStats.hull = cfg.hullHp;
      }
    });
    const ui = getUiApi();
    if (ui && typeof ui.renderAll === "function") {
      ui.renderAll(true);
    }
    console.log("[restoreCombatLevels] Levels restored:", {
      kinetic: cfg.kinetic,
      laser: cfg.laser,
      shield: cfg.shield,
      armor: cfg.armor,
      attackLevel: cfg.kinetic + cfg.laser,
      defenseLevel: cfg.shield + cfg.armor,
      baseDamage: cfg.baseDamage,
      hullHp: cfg.hullHp
    });
    return true;
  };
}
