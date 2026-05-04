/** @file Turn-based combat modal — renders the tactical encounter UI, player actions, and flee/evac logic. */

import { gameState, moundState } from "../core/state.js";
import { calculateEscapePenalty } from "../systems/expedition/EnemySystem.js";
import {
  COMBAT_PHASE,
  CombatWeapons,
  engageCombat,
  endCombat,
  fleeCombat,
  playerCombatAction
} from "../systems/expedition/CombatManager.js";
import { getWorkerBridge, getUiApi } from "../core/runtime-hooks.js";
import { renderEvacScreen } from "./EndingOverlay.js";

// Module-scope constants — shared by showCombatModal() and refreshModalDisplay()
const C_BORDER = "#333";
const C_TEXT = "#FFF";
const C_DIM = "#CCC";
const C_BG = "#000";
const C_FRAME_BG = "#111";

function getLiveState() {
  return (moundState && moundState.state) || gameState || {};
}

function safeNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

let modalRoot = null;
let combatLogLines = [];

function pushCombatLog(msg) {
  combatLogLines.push(String(msg || "").trim());
  while (combatLogLines.length > 10) {
    combatLogLines.shift();
  }
  flushCombatLog();
}

function flushCombatLog() {
  if (!modalRoot) return;
  const lines = modalRoot.querySelectorAll(".combat-side-log-line");
  const start = Math.max(0, combatLogLines.length - lines.length);
  lines.forEach((el, i) => {
    el.textContent = combatLogLines[start + i] || "";
  });
  // Auto-scroll to bottom
  const logContainer = modalRoot.querySelector(".combat-side-log");
  if (logContainer) {
    logContainer.scrollTop = logContainer.scrollHeight;
  }
}

function clearCombatLog() {
  combatLogLines.length = 0;
  flushCombatLog();
}

function asciiBar(current, max, width = 12) {
  const mx = Math.max(0.0001, Number(max) || 1);
  const cur = Math.max(0, Number(current) || 0);
  const pct = Math.round((cur / mx) * 100);
  const filled = Math.min(width, Math.max(0, Math.round((cur / mx) * width)));
  return { bar: "|".repeat(filled) + ".".repeat(width - filled), pct };
}

function syncStateToWorker() {
  const bridge = getWorkerBridge();
  if (bridge && typeof bridge.sync === "function") {
    bridge.sync(getLiveState());
  }
}

function closeModal() {
  if (!modalRoot || !modalRoot.parentNode) return;
  if (typeof document !== "undefined" && document.body && !document.body.contains(modalRoot)) {
    modalRoot = null;
    return;
  }
  modalRoot.parentNode.removeChild(modalRoot);
  modalRoot = null;
  clearCombatLog();

  moundState.setState((draft) => {
    draft.systems = draft.systems || {};
    draft.systems.ui = draft.systems.ui || {};
    draft.systems.ui.showCombatModal = false;
    draft.systems.ui.activeEncounter = null;
    draft.systems.expedition = draft.systems.expedition || {};
    draft.systems.expedition.isNavigationLocked = false;
    draft.combatState = "IDLE";
    const enc = draft.systems.combatEncounter || {};
    enc.phase = "IDLE";
    enc.enemy = null;
    enc.massDriverCharging = false;
    const restore = enc.savedThrottle;
    if (typeof restore === "number" && restore > 0) {
      const maxThrust = Math.max(1, Number(draft.maxThrustLimit || 10));
      draft.systems.expedition.throttle = Math.min(maxThrust, restore);
    }
    enc.savedThrottle = null;
    draft.systems.combatEncounter = enc;
  });

  // Force-sync to worker so it knows isNavigationLocked is cleared
  syncStateToWorker();

  // Remove combat-active class from body to re-enable UI
  if (typeof document !== "undefined" && document.body) {
    document.body.classList.remove("combat-active");
  }

  const eng = typeof window !== "undefined" && window.MoundEngine;
  if (eng && typeof eng.addLog === "function") {
    eng.addLog("[UNLOCK] 生物信号消失。推进系统恢复。航行锁定已解除。");
  }
}

async function handleWeaponAction(weapon) {
  const state = getLiveState();
  const enc = state.systems && state.systems.combatEncounter;
  const phase = (enc && enc.phase) || state.combatState || COMBAT_PHASE.IDLE;
  if (phase !== COMBAT_PHASE.COMBAT_PHASE) return;
  if (state.combat && state.combat.isLocked) return;

  playerCombatAction(
    getLiveState(),
    moundState.setState,
    (msg) => pushCombatLog(msg),
    weapon
  );

  const after = getLiveState();
  const encAfter = after.systems && after.systems.combatEncounter;
  const enemyAfter = encAfter && encAfter.enemy;
  const res = encAfter && encAfter.lastResolution;

  if (enemyAfter && after.systems && after.systems.ui && after.systems.ui.activeEncounter) {
    moundState.setState((draft) => {
      if (draft.systems.ui.activeEncounter) {
        draft.systems.ui.activeEncounter.currentHp = enemyAfter.currentHp;
      }
    });
  }

  syncStateToWorker();

  if (res) {
    if (res.kind === "victory") {
      await endCombat("victory", (msg) => pushCombatLog(msg));
      return;
    }
    if (res.kind === "defeat") {
      await endCombat("defeat", (msg) => pushCombatLog(msg));
      return;
    }
  }

  refreshModalDisplay();
}

async function handleBattle() {
  const state = getLiveState();
  const enc = state.systems && state.systems.combatEncounter;
  const enemy = state.systems && state.systems.ui && state.systems.ui.activeEncounter;
  if (!enemy && !(enc && enc.enemy)) return;
  if (state.combat && state.combat.isLocked) return;

  const phase = (enc && enc.phase) || state.combatState || COMBAT_PHASE.IDLE;
  if (phase !== COMBAT_PHASE.COMBAT_PHASE) {
    engageCombat(state, moundState.setState, (msg) => pushCombatLog(msg));
    pushCombatLog("交战：武器系统启动。");
    syncStateToWorker();
    refreshModalDisplay();
    return;
  }

  playerCombatAction(
    getLiveState(),
    moundState.setState,
    (msg) => pushCombatLog(msg),
    CombatWeapons.KINETIC
  );

  const after = getLiveState();
  const encAfter = after.systems && after.systems.combatEncounter;
  const enemyAfter = encAfter && encAfter.enemy;
  const res = encAfter && encAfter.lastResolution;

  if (enemyAfter && after.systems && after.systems.ui && after.systems.ui.activeEncounter) {
    moundState.setState((draft) => {
      if (draft.systems.ui.activeEncounter) {
        draft.systems.ui.activeEncounter.currentHp = enemyAfter.currentHp;
      }
    });
  }

  syncStateToWorker();

  if (res) {
    if (res.kind === "victory") {
      await endCombat("victory", (msg) => pushCombatLog(msg));
      return;
    }
    if (res.kind === "defeat") {
      await endCombat("defeat", (msg) => pushCombatLog(msg));
      return;
    }
  }

  refreshModalDisplay();
}

function handleFlee() {
  const state = getLiveState();
  const enc = state.systems && state.systems.combatEncounter;
  const isBossFlee = !!(enc && enc.isBoss);

  if (isBossFlee) {
    // OMEGA boss evacuation — trigger the evac ending sequence
    fleeCombat(state, moundState.setState, (msg) => pushCombatLog(msg));
    pushCombatLog("[ 紧急撤离 ] 远征号全推力脱离战斗区域。");

    syncStateToWorker();

    renderEvacScreen();
    return;
  }

  // Standard flee for non-boss encounters
  const penalty = calculateEscapePenalty(state);

  fleeCombat(state, moundState.setState, (msg) => pushCombatLog(msg));

  pushCombatLog(`撤离：损失合金 ${penalty.alloyLoss}，氦-3 ${penalty.fuelLoss}。`);

  moundState.setState((draft) => {
    draft.systems = draft.systems || {};
    draft.systems.ui = draft.systems.ui || {};
    draft.systems.ui.showCombatModal = false;
    draft.systems.ui.activeEncounter = null;
  });

  syncStateToWorker();
  const modalAtTimeout = modalRoot;
  setTimeout(() => {
    if (modalRoot === modalAtTimeout) closeModal();
  }, 1200);
}

function refreshModalDisplay() {
  if (!modalRoot) return;
  const state = getLiveState();
  const enemy = state.systems && state.systems.ui && state.systems.ui.activeEncounter;
  if (!enemy) return;

  const enc = state.systems && state.systems.combatEncounter;
  const phase = (enc && enc.phase) || state.combatState || COMBAT_PHASE.IDLE;
  const inCombat = phase === COMBAT_PHASE.COMBAT_PHASE;
  const isLocked = !!(state.combat && state.combat.isLocked);
  const combatStats = state.combatStats || {};
  const turn = Math.max(1, (state.combat && state.combat.turnCount) || combatStats.turnCount || 1);
  const laserCooldown = Math.max(0, (state.combat && state.combat.laserCooldown) || combatStats.laserCooldown || 0);
  const shieldCooldown = Math.max(0, (state.combat && state.combat.shieldCooldown) || combatStats.shieldCooldown || 0);
  const shieldCharges = (state.combat && typeof state.combat.shieldCharges === "number") ? state.combat.shieldCharges : (typeof combatStats.shieldCharges === "number" ? combatStats.shieldCharges : 3);

  const headerEl = modalRoot.querySelector(".combat-modal-header");
  const enemyNameEl = modalRoot.querySelector(".combat-modal-enemy-name");
  const enemyTierEl = modalRoot.querySelector(".combat-modal-enemy-tier");
  const enemyBarEl = modalRoot.querySelector(".combat-modal-hull-bar");
  const enemyAtkEl = modalRoot.querySelector(".combat-modal-enemy-atk");
  const playerBarEl = modalRoot.querySelector(".combat-modal-player-bar");
  const playerShieldBarEl = modalRoot.querySelector(".combat-modal-shield-bar");
  const playerAtkEl = modalRoot.querySelector(".combat-modal-player-atk");

  // Header with turn counter
  if (headerEl) {
    headerEl.textContent = inCombat ? `—— 第 ${turn} 回合 ——` : "—— 深空生物质接触 ——";
  }

  if (enemyNameEl) enemyNameEl.textContent = String(enemy.name || "未知生物体").toUpperCase();
  if (enemyTierEl) enemyTierEl.textContent = `威胁等级：${enemy.tier || "?"}`;

  // Boss phase indicator and name styling
  const bossPhaseEl = modalRoot.querySelector(".combat-modal-boss-phase");
  const isBoss = !!(enc && enc.isBoss && enemy && enemy.id === "omega_boss");
  if (bossPhaseEl) {
    if (isBoss) {
      const phaseNames = { 1: "噬能外壳", 2: "不稳定突变", 3: "塌缩临界" };
      const phaseNum = Number(enc.bossPhase || 1);
      let phaseText = `—— 阶段 ${phaseNum}：${phaseNames[phaseNum] || ""} ——`;
      if (phaseNum === 1 && (enc.bossAblationLayer || 0) > 0) {
        phaseText += ` | 消融隔热层: ${enc.bossAblationLayer}`;
      }
      if (phaseNum === 3 && Number(enc.bossVoidNovaCounter || 0) > 0) {
        phaseText += ` | 虚空新星 ${enc.bossVoidNovaCounter}/4`;
        bossPhaseEl.style.color = "#FF4444";
      } else {
        bossPhaseEl.style.color = "#FFD700";
      }
      bossPhaseEl.style.display = "block";
      bossPhaseEl.textContent = phaseText;
    } else {
      bossPhaseEl.style.display = "none";
      bossPhaseEl.textContent = "";
    }
  }
  if (enemyNameEl) {
    if (isBoss) {
      enemyNameEl.style.color = "#FFD700";
      enemyNameEl.style.textShadow = "0 0 8px rgba(255, 80, 30, 0.7)";
    } else {
      enemyNameEl.style.color = C_TEXT;
      enemyNameEl.style.textShadow = "none";
    }
  }

  const eHp = safeNum(enemy.currentHp, enemy.hp);
  const eMax = Math.max(0.0001, safeNum(enemy.hp, 1));
  if (enemyBarEl) {
    const eb = asciiBar(eHp, eMax);
    enemyBarEl.textContent = `敌方舰体：[${eb.bar}] ${eb.pct}%`;
  }
  if (enemyAtkEl) enemyAtkEl.textContent = `攻击力：${safeNum(enemy.attack, 0)} | 命中率：${Math.round(safeNum(enemy.accuracy, 0) * 100)}%`;

  const pHp = safeNum(combatStats.hull || (state.combat && state.combat.hullHp) || 100, 100);
  const pMax = Math.max(0.0001, safeNum(combatStats.hullMax || (state.combat && state.combat.hullHp) || 100, 100));
  if (playerBarEl) {
    const pb = asciiBar(pHp, pMax);
    playerBarEl.textContent = `我方舰体：[${pb.bar}] ${pb.pct}%`;
  }

  // Shield bar
  const pShield = safeNum((state.combat && state.combat.playerShield) || combatStats.playerShield, 0);
  const pShieldMax = Math.max(1, safeNum((state.combat && state.combat.playerShieldMax) || combatStats.playerShieldMax, 30));
  if (playerShieldBarEl) {
    if (inCombat) {
      const sb = asciiBar(pShield, pShieldMax, 8);
      playerShieldBarEl.textContent = `当前护盾：[${sb.bar}] ${pShield}/${pShieldMax}`;
      playerShieldBarEl.style.display = "";
    } else {
      playerShieldBarEl.style.display = "none";
    }
  }

  if (playerAtkEl) {
    const baseDmg = safeNum((state.combat && state.combat.baseDamage) || 1, 1);
    playerAtkEl.textContent = `基础伤害：${baseDmg}`;
  }

  // Toggle buttons: engage row for PENDING, combat grid for COMBAT_PHASE
  // Locked state overrides everything — hide all action buttons, show countdown
  const engageBtn = modalRoot.querySelector(".combat-modal-btn-engage");
  const fleeBtn = modalRoot.querySelector(".combat-modal-btn-flee");
  const combatGrid = modalRoot.querySelector(".combat-modal-action-grid");
  const laserBtn = modalRoot.querySelector(".combat-modal-btn-laser");
  const lockedOverlayEl = modalRoot.querySelector(".combat-modal-locked-overlay");

  if (isLocked) {
    if (engageBtn) engageBtn.style.display = "none";
    if (fleeBtn) fleeBtn.style.display = "none";
    if (combatGrid) combatGrid.style.display = "none";
    if (lockedOverlayEl) lockedOverlayEl.style.display = "";
    if (modalRoot) modalRoot.classList.add("is-stabilizing");
  } else {
    if (engageBtn) engageBtn.style.display = inCombat ? "none" : "";
    if (fleeBtn) fleeBtn.style.display = inCombat ? "none" : "";
    if (combatGrid) combatGrid.style.display = inCombat ? "grid" : "none";
    if (lockedOverlayEl) lockedOverlayEl.style.display = "none";
    if (modalRoot) modalRoot.classList.remove("is-stabilizing");
  }

  // Laser cooldown indicator
  if (laserBtn) {
    if (laserCooldown > 0) {
      laserBtn.textContent = "[ 激光矩阵 ]\n充能中… " + laserCooldown + "回合";
      laserBtn.style.opacity = "0.5";
      laserBtn.disabled = true;
    } else {
      laserBtn.textContent = "[ 激光矩阵 ]\n高额伤害 · 2回冷却";
      laserBtn.style.opacity = "1";
      laserBtn.disabled = false;
    }
  }

  // Shield status indicator
  const shieldBtn = modalRoot.querySelector(".combat-modal-btn-shield");
  if (shieldBtn) {
    const shieldLevel = Math.max(0, Number((state.combat && state.combat.defenseSystems && state.combat.defenseSystems.shieldGenerator) || 0));
    const shieldCapacity = 80 + shieldLevel * 8;
    if (shieldCharges <= 0) {
      shieldBtn.textContent = "[ 等离子护盾 ]\n能源耗尽";
      shieldBtn.style.opacity = "0.4";
      shieldBtn.disabled = true;
    } else if (shieldCooldown > 0) {
      shieldBtn.textContent = "[ 等离子护盾 ]\n充能中… " + shieldCooldown + "回合 (余: " + shieldCharges + ") [能量: " + shieldCapacity + "]";
      shieldBtn.style.opacity = "0.5";
      shieldBtn.disabled = true;
    } else {
      shieldBtn.textContent = "[ 等离子护盾 ]\n(余: " + shieldCharges + ") [能量: " + shieldCapacity + "]";
      shieldBtn.style.opacity = "1";
      shieldBtn.disabled = false;
    }
  }

  const dead = eHp <= 0;
  if (fleeBtn) fleeBtn.disabled = dead;
  if (engageBtn) engageBtn.disabled = dead;
}

export function showCombatModal() {
  if (typeof document === "undefined") return;

  const state = getLiveState();
  const showCombat = !!(state.systems && state.systems.ui && state.systems.ui.showCombatModal);
  const enemy = state.systems && state.systems.ui && state.systems.ui.activeEncounter;
  const enc = state.systems && state.systems.combatEncounter;
  const inDom = !!document.getElementById("combat-modal-container");

  // Pre-flight kill-switch: if state says no combat, destroy any lingering modal
  if (!showCombat || !enemy || (enc && enc.phase === "IDLE")) {
    if (inDom) {
      const stale = document.getElementById("combat-modal-container");
      if (stale && stale.parentNode) stale.parentNode.removeChild(stale);
    }
    modalRoot = null;
    clearCombatLog();
    if (typeof document !== "undefined" && document.body) {
      document.body.classList.remove("combat-active");
    }
    return;
  }

  // If modal already mounted in DOM, just refresh
  if (inDom && modalRoot && modalRoot.parentNode) {
    refreshModalDisplay();
    return;
  }

  // Clean up any stale DOM node before creating
  if (inDom) {
    const old = document.getElementById("combat-modal-container");
    if (old && old.parentNode) old.parentNode.removeChild(old);
  }
  modalRoot = null;
  clearCombatLog();

  const safeEnemy = enemy;

  modalRoot = document.createElement("div");
  modalRoot.id = "combat-modal-container";
  modalRoot.className = "combat-modal-root";
  modalRoot.setAttribute("aria-modal", "true");
  modalRoot.setAttribute("role", "dialog");
  modalRoot.style.cssText =
    "position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;background:#000;pointer-events:auto;";

  const frame = document.createElement("div");
  frame.className = "combat-modal-frame";
  frame.style.cssText =
    "display:flex;flex-direction:row;gap:0;width:720px;max-width:96vw;max-height:90vh;background:" + C_FRAME_BG + ";border:1px solid " + C_BORDER + ";color:" + C_TEXT + ";font-family:monospace;overflow:hidden;";

  // ── Main Panel (left/center): combat info + actions ──
  const mainPanel = document.createElement("div");
  mainPanel.className = "combat-modal-main";
  mainPanel.style.cssText =
    "flex:1 1 auto;padding:24px 20px;overflow-y:auto;min-width:0;";

  const header = document.createElement("div");
  header.className = "combat-modal-header";
  header.style.cssText =
    "border-bottom:1px solid " + C_BORDER + ";padding-bottom:12px;margin-bottom:18px;text-align:center;";
  header.textContent = "—— 深空生物质接触 ——";
  header.setAttribute("data-turn", "1");
  mainPanel.appendChild(header);

  const enemyName = document.createElement("div");
  enemyName.className = "combat-modal-enemy-name";
  enemyName.style.cssText =
    "font-size:1.35em;font-weight:700;letter-spacing:0.08em;text-align:center;margin-bottom:6px;color:" + C_TEXT + ";";
  enemyName.textContent = String(safeEnemy.name || "未知生物体").toUpperCase();
  mainPanel.appendChild(enemyName);

  const enemyTier = document.createElement("div");
  enemyTier.className = "combat-modal-enemy-tier";
  enemyTier.style.cssText =
    "text-align:center;color:" + C_DIM + ";margin-bottom:14px;font-size:0.95em;";
  enemyTier.textContent = `威胁等级：${safeEnemy.tier || "?"}`;
  mainPanel.appendChild(enemyTier);

  const bossPhaseEl = document.createElement("div");
  bossPhaseEl.className = "combat-modal-boss-phase";
  bossPhaseEl.style.cssText =
    "text-align:center;color:#FFD700;margin-bottom:8px;font-size:0.95em;letter-spacing:0.06em;display:none;";
  mainPanel.appendChild(bossPhaseEl);

  const enemyBar = document.createElement("pre");
  enemyBar.className = "combat-modal-hull-bar";
  enemyBar.style.cssText =
    "text-align:center;margin:0 0 8px 0;white-space:pre;font:inherit;font-size:1.05em;color:" + C_TEXT + ";";
  mainPanel.appendChild(enemyBar);

  const enemyAtk = document.createElement("div");
  enemyAtk.className = "combat-modal-enemy-atk";
  enemyAtk.style.cssText =
    "text-align:center;color:" + C_DIM + ";margin-bottom:20px;font-size:0.9em;";
  mainPanel.appendChild(enemyAtk);

  const spacer = document.createElement("div");
  spacer.style.cssText = "border-top:1px solid #222;margin:14px 0;";
  mainPanel.appendChild(spacer);

  const playerBar = document.createElement("pre");
  playerBar.className = "combat-modal-player-bar";
  playerBar.style.cssText =
    "text-align:center;margin:0 0 4px 0;white-space:pre;font:inherit;font-size:1.05em;color:" + C_TEXT + ";";
  mainPanel.appendChild(playerBar);

  const playerShieldBar = document.createElement("pre");
  playerShieldBar.className = "combat-modal-shield-bar";
  playerShieldBar.style.cssText =
    "text-align:center;margin:0 0 8px 0;white-space:pre;font:inherit;color:" + C_DIM + ";font-size:0.9em;";
  mainPanel.appendChild(playerShieldBar);

  const playerAtk = document.createElement("div");
  playerAtk.className = "combat-modal-player-atk";
  playerAtk.style.cssText =
    "text-align:center;color:" + C_DIM + ";margin-bottom:20px;";
  mainPanel.appendChild(playerAtk);

  // ── Action area: engage/flee row + 2×2 grid ──
  const btnRow = document.createElement("div");
  btnRow.className = "combat-modal-btn-row";
  btnRow.style.cssText = "display:flex;gap:14px;justify-content:center;margin-top:8px;flex-direction:column;align-items:center;";

  // Locked countdown overlay (hidden by default, shown during post-combat buffer)
  const lockedOverlay = document.createElement("div");
  lockedOverlay.className = "combat-modal-locked-overlay";
  lockedOverlay.style.cssText = "display:none;text-align:center;padding:16px 0;";
  const lockedCountdown = document.createElement("div");
  lockedCountdown.className = "combat-modal-locked-countdown";
  lockedCountdown.style.cssText = "color:#FFD700;font-size:1.1em;font-weight:700;letter-spacing:0.08em;margin-bottom:6px;";
  lockedCountdown.textContent = "系统稳定中… 5 秒";
  const lockedHint = document.createElement("div");
  lockedHint.style.cssText = "color:#888;font-size:0.8em;";
  lockedHint.textContent = "战斗结束后系统需要冷却，请等待…";
  lockedOverlay.appendChild(lockedCountdown);
  lockedOverlay.appendChild(lockedHint);
  btnRow.appendChild(lockedOverlay);

  const engageBtn = document.createElement("button");
  engageBtn.type = "button";
  engageBtn.className = "combat-modal-btn-engage";
  engageBtn.textContent = "[ 发起攻击 ]";
  engageBtn.style.cssText =
    "padding:12px 32px;font:inherit;font-weight:700;font-size:1em;background:#111;color:" + C_TEXT + ";border:1px solid " + C_BORDER + ";cursor:pointer;letter-spacing:0.08em;";
  engageBtn.addEventListener("click", handleBattle);

  const fleeBtn = document.createElement("button");
  fleeBtn.type = "button";
  fleeBtn.className = "combat-modal-btn-flee";
  fleeBtn.textContent = "[ 紧急撤离 ]";
  fleeBtn.style.cssText =
    "padding:12px 32px;font:inherit;font-weight:700;font-size:1em;background:#111;color:" + C_TEXT + ";border:1px solid " + C_BORDER + ";cursor:pointer;letter-spacing:0.08em;";
  fleeBtn.addEventListener("click", handleFlee);

  const combatGrid = document.createElement("div");
  combatGrid.className = "combat-modal-action-grid";
  combatGrid.style.cssText = "display:none;grid-template-columns:1fr 1fr;gap:10px;margin-top:12px;";

  const btnStyle =
    "padding:14px 18px;font:inherit;font-weight:700;background:#111;color:" + C_TEXT + ";border:1px solid " + C_BORDER + ";cursor:pointer;letter-spacing:0.06em;font-size:0.9em;";

  const kineticBtn = document.createElement("button");
  kineticBtn.type = "button";
  kineticBtn.className = "combat-modal-btn-kinetic";
  kineticBtn.textContent = "[ 动能炮 ]\n常规输出";
  kineticBtn.style.cssText = btnStyle + "white-space:pre-line;min-height:56px;";
  kineticBtn.addEventListener("click", () => handleWeaponAction(CombatWeapons.KINETIC));

  const laserBtn = document.createElement("button");
  laserBtn.type = "button";
  laserBtn.className = "combat-modal-btn-laser";
  laserBtn.textContent = "[ 激光矩阵 ]\n高额伤害 · 2回冷却";
  laserBtn.style.cssText = btnStyle + "white-space:pre-line;min-height:56px;";
  laserBtn.addEventListener("click", () => handleWeaponAction(CombatWeapons.LASER));

  const shieldBtn = document.createElement("button");
  shieldBtn.type = "button";
  shieldBtn.className = "combat-modal-btn-shield";
  const shieldInitLevel = Math.max(0, Number((state.combat && state.combat.defenseSystems && state.combat.defenseSystems.shieldGenerator) || 0));
  const shieldInitCapacity = 80 + shieldInitLevel * 8;
  shieldBtn.textContent = "[ 等离子护盾 ]\n(余: 3) [能量: " + shieldInitCapacity + "]";
  shieldBtn.style.cssText = btnStyle + "white-space:pre-line;min-height:56px;";
  shieldBtn.addEventListener("click", () => handleWeaponAction(CombatWeapons.SHIELD));

  const combatFleeBtn = document.createElement("button");
  combatFleeBtn.type = "button";
  combatFleeBtn.className = "combat-modal-btn-flee-grid";
  combatFleeBtn.textContent = "[ 紧急撤离 ]\n脱离战斗";
  combatFleeBtn.style.cssText = btnStyle + "white-space:pre-line;min-height:56px;";
  combatFleeBtn.addEventListener("click", handleFlee);

  combatGrid.appendChild(kineticBtn);
  combatGrid.appendChild(laserBtn);
  combatGrid.appendChild(shieldBtn);
  combatGrid.appendChild(combatFleeBtn);

  btnRow.appendChild(engageBtn);
  btnRow.appendChild(fleeBtn);
  btnRow.appendChild(combatGrid);
  mainPanel.appendChild(btnRow);

  // ── Side Panel (right): combat log stream ──
  const sidePanel = document.createElement("div");
  sidePanel.className = "combat-modal-side";
  sidePanel.style.cssText =
    "flex:0 0 220px;border-left:1px solid " + C_BORDER + ";display:flex;flex-direction:column;overflow:hidden;";

  const sideLog = document.createElement("div");
  sideLog.className = "combat-side-log";
  sideLog.style.cssText =
    "flex:1;padding:10px;overflow-y:auto;font-size:0.72em;color:" + C_DIM + ";background:rgba(255,255,255,0.03);line-height:1.5;";
  for (let i = 0; i < 10; i++) {
    const line = document.createElement("div");
    line.className = "combat-side-log-line";
    line.style.cssText = "padding:1px 0;border-bottom:1px solid rgba(255,255,255,0.04);white-space:pre-wrap;word-break:break-all;";
    sideLog.appendChild(line);
  }
  sidePanel.appendChild(sideLog);

  frame.appendChild(mainPanel);
  frame.appendChild(sidePanel);

  modalRoot.appendChild(frame);
  document.body.appendChild(modalRoot);

  refreshModalDisplay();

  const eng = typeof window !== "undefined" && window.MoundEngine;
  if (eng && typeof eng.addLog === "function") {
    eng.addLog(`警告：检测到不明生物反应。`);
  }
}

// Global exposure for console debugging and rollback integration
if (typeof window !== "undefined") {
  window.renderCombatModal = showCombatModal;
}
