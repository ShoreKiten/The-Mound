/**
 * Turn-based expedition combat: encounter hook, player weapons, enemy reply, flee / win / lose.
 * Expedition is paused (throttle 0) while `ENCOUNTER_PENDING` or `COMBAT_PHASE` is active.
 */

import { generateEncounter, calculateEscapePenalty, createOmegaEncounter, computeBossHPThresholds } from "./EnemySystem.js";
import { gameState, moundState } from "../../core/state.js";
import { getUiApi, getWorkerBridge } from "../../core/runtime-hooks.js";
import { renderEndingScreen, renderDefeatScreen } from "../../ui/EndingOverlay.js";

function syncStateToWorker() {
  const bridge = getWorkerBridge();
  if (bridge && typeof bridge.sync === "function") {
    bridge.sync(gameState);
  }
}

export const COMBAT_PHASE = Object.freeze({
  IDLE: "IDLE",
  ENCOUNTER_PENDING: "ENCOUNTER_PENDING",
  COMBAT_PHASE: "COMBAT_PHASE",
  RESOLUTION: "RESOLUTION"
});

const WEAPON = Object.freeze({
  KINETIC: "kinetic",
  LASER: "laser",
  MASS_DRIVER: "mass_driver",
  SHIELD: "shield"
});

function defaultCombatEncounter() {
  return {
    phase: COMBAT_PHASE.IDLE,
    enemy: null,
    savedThrottle: null,
    lastTriggerKm: null,
    massDriverCharging: false,
    lastResolution: null
  };
}

function getEncounterSlice(draft) {
  draft.systems = draft.systems || {};
  if (!draft.systems.combatEncounter || typeof draft.systems.combatEncounter !== "object") {
    draft.systems.combatEncounter = defaultCombatEncounter();
  }
  if (typeof draft.combatState !== "string") {
    draft.combatState = draft.systems.combatEncounter.phase || COMBAT_PHASE.IDLE;
  }
  return draft.systems.combatEncounter;
}

function getCombatStatsSlice(draft) {
  draft.combat = draft.combat || {};
  if (!draft.combatStats || typeof draft.combatStats !== "object") {
    draft.combatStats = {
      hull: 100,
      hullMax: 100,
      playerShield: 0,
      playerShieldMax: 100,
      turnCount: 1,
      laserCooldown: 0,
      shieldCooldown: 0,
      shieldCharges: 3
    };
  }
  // Ensure new fields exist on existing objects (migration)
  if (typeof draft.combatStats.playerShield !== "number") draft.combatStats.playerShield = 0;
  if (typeof draft.combatStats.playerShieldMax !== "number") draft.combatStats.playerShieldMax = 100;
  if (typeof draft.combatStats.turnCount !== "number") draft.combatStats.turnCount = 1;
  if (typeof draft.combatStats.laserCooldown !== "number") draft.combatStats.laserCooldown = 0;
  if (typeof draft.combatStats.shieldCooldown !== "number") draft.combatStats.shieldCooldown = 0;
  if (typeof draft.combatStats.shieldCharges !== "number") draft.combatStats.shieldCharges = 3;
  // Mirror to state.combat for UI access
  draft.combat.turnCount = draft.combatStats.turnCount;
  draft.combat.playerShield = draft.combatStats.playerShield;
  draft.combat.playerShieldMax = draft.combatStats.playerShieldMax;
  draft.combat.laserCooldown = draft.combatStats.laserCooldown;
  draft.combat.shieldCooldown = draft.combatStats.shieldCooldown;
  draft.combat.shieldCharges = draft.combatStats.shieldCharges;
  return draft.combatStats;
}

function getBossSlice(draft) {
  const enc = getEncounterSlice(draft);
  if (typeof enc.isBoss !== "boolean") enc.isBoss = false;
  if (typeof enc.bossEndingActive !== "boolean") enc.bossEndingActive = false;
  if (typeof enc.bossPhase !== "number") enc.bossPhase = 1;
  if (typeof enc.bossBioPulseCounter !== "number") enc.bossBioPulseCounter = 0;
  if (typeof enc.bossVoidNovaCounter !== "number") enc.bossVoidNovaCounter = 0;
  if (typeof enc.bossOriginalAttack !== "number") enc.bossOriginalAttack = 75;
  if (typeof enc.bossTransitionBuffer !== "boolean") enc.bossTransitionBuffer = false;
  if (typeof enc.bossCorrosionDamage !== "number") enc.bossCorrosionDamage = 0;
  if (typeof enc.bossAblationLayer !== "number") enc.bossAblationLayer = 1200;
  if (typeof enc.bossKineticDamageDealt !== "number") enc.bossKineticDamageDealt = 0;
  if (typeof enc.bossP2TotalTurns !== "number") enc.bossP2TotalTurns = 0;
  return enc;
}

function isBossFight(draft) {
  const enc = getEncounterSlice(draft);
  return !!(enc.isBoss && enc.enemy && enc.enemy.id === "omega_boss");
}

function syncCombatStatsFromShip(draft) {
  draft.combat = draft.combat || {};
  const hullMax = Math.max(100, Number(draft.combat.hullHp || 100));
  const shieldLevel = Math.max(0, Number((draft.combat.defenseSystems && draft.combat.defenseSystems.shieldGenerator) || 0));
  const shieldCapacity = 80 + shieldLevel * 8;
  const stats = getCombatStatsSlice(draft);
  stats.hullMax = hullMax;
  stats.hull = Math.min(hullMax, Math.max(0, Number(draft.combat.hullHp ?? hullMax)));
  stats.playerShield = 0;
  stats.playerShieldMax = shieldCapacity;
  stats.turnCount = 1;
  stats.laserCooldown = 0;
  stats.shieldCooldown = 0;
  stats.shieldCharges = 3;
  draft.combat.playerShield = 0;
  draft.combat.playerShieldMax = shieldCapacity;
  draft.combat.turnCount = 1;
  draft.combat.laserCooldown = 0;
  draft.combat.shieldCooldown = 0;
  draft.combat.shieldCharges = 3;
}

function writeHullToShip(draft) {
  const stats = getCombatStatsSlice(draft);
  draft.combat = draft.combat || {};
  draft.combat.hullHp = Math.max(0, Math.min(stats.hullMax, Number(stats.hull || 0)));
}

function pauseExpedition(draft) {
  const enc = getEncounterSlice(draft);
  draft.systems.expedition = draft.systems.expedition || {};
  if (enc.savedThrottle === null || enc.savedThrottle === undefined) {
    enc.savedThrottle = Math.max(0, Number(draft.systems.expedition.throttle || 0));
  }
  draft.systems.expedition.throttle = 0;
  draft.systems.expedition.isNavigationLocked = true;
}

function resumeExpedition(draft) {
  const enc = getEncounterSlice(draft);
  draft.systems.expedition = draft.systems.expedition || {};
  draft.systems.expedition.isNavigationLocked = false;
  const restore = enc.savedThrottle;
  if (typeof restore === "number" && restore > 0) {
    const maxThrust = Math.max(1, Number(draft.maxThrustLimit || draft.maxThrustMultiplier || 10));
    draft.systems.expedition.throttle = Math.min(maxThrust, restore);
  }
  enc.savedThrottle = null;
}

function clearEncounter(draft) {
  const enc = getEncounterSlice(draft);
  enc.enemy = null;
  enc.massDriverCharging = false;
  enc.phase = COMBAT_PHASE.IDLE;
  draft.combatState = COMBAT_PHASE.IDLE;
  draft.systems.expedition = draft.systems.expedition || {};
  draft.systems.expedition.isNavigationLocked = false;
}

/**
 * True while an encounter is open or combat is in progress (expedition should not advance).
 * @param {object} state
 * @returns {boolean}
 */
export function isCombatLockActive(state) {
  const s = state || {};
  const phase = s.systems && s.systems.combatEncounter && s.systems.combatEncounter.phase;
  const cs = typeof s.combatState === "string" ? s.combatState : "";
  if (cs === COMBAT_PHASE.ENCOUNTER_PENDING || cs === COMBAT_PHASE.COMBAT_PHASE) {
    return true;
  }
  return phase === COMBAT_PHASE.ENCOUNTER_PENDING || phase === COMBAT_PHASE.COMBAT_PHASE;
}

/**
 * @param {object} draft
 * @param {{ id: string, name: string, tier: number, hp: number, attack: number, accuracy: number }} template
 */
function attachEnemy(draft, template) {
  const enc = getEncounterSlice(draft);
  enc.enemy = {
    id: template.id,
    name: template.name,
    tier: template.tier,
    maxHp: template.hp,
    currentHp: template.hp,
    attack: template.attack,
    accuracy: template.accuracy
  };
}

function rollPlayerDamage(draft, weapon) {
  const combat = draft.combat || {};
  const base = Math.max(1, Number(combat.baseDamage || 1));
  const critChance = Math.max(0, Math.min(0.75, Number(combat.critChance || 0)));
  if (weapon === WEAPON.KINETIC) {
    const jitter = 0.88 + Math.random() * 0.24;
    return Math.max(1, Math.round(base * jitter));
  }
  if (weapon === WEAPON.LASER) {
    const mult = Math.random() < critChance ? 2.2 : 1;
    return Math.max(1, Math.round(base * mult));
  }
  if (weapon === WEAPON.MASS_DRIVER) {
    return Math.max(1, Math.round(base * 3.4));
  }
  return Math.max(1, Math.round(base));
}

function applyEnemyStrike(draft, addLog) {
  const enc = getEncounterSlice(draft);
  const enemy = enc.enemy;
  if (!enemy || enemy.currentHp <= 0) {
    return;
  }
  const stats = getCombatStatsSlice(draft);
  const hit = Math.random() < Number(enemy.accuracy || 0.5);
  if (!hit) {
    if (typeof addLog === "function") {
      const turnLabel = `[第 ${(draft.combat && draft.combat.turnCount) || 1} 回合]`;
      addLog(`${turnLabel} [接敌] 成功闪避了${enemy.name}的攻击。`);
    }
    return;
  }
  let raw = Math.max(1, Number(enemy.attack || 1));
  const distKm = Number(enc.lastTriggerKm || 0);
  let isCrit = false;
  if (distKm >= 150000 && Math.random() < 0.15) {
    raw = Math.round(raw * 2.0);
    isCrit = true;
  }
  let remaining = Math.round(raw);

  // Shield absorbs damage first
  const currentShield = Math.max(0, Number(stats.playerShield || 0));
  if (currentShield > 0) {
    const absorbed = Math.min(currentShield, remaining);
    stats.playerShield = currentShield - absorbed;
    draft.combat.playerShield = stats.playerShield;
    remaining -= absorbed;
    if (typeof addLog === "function") {
      const turnLabel = `[第 ${(draft.combat && draft.combat.turnCount) || 1} 回合]`;
      addLog(`${turnLabel} [接敌] 等离子护盾吸收了 ${absorbed} 点伤害。（剩余护盾：${stats.playerShield}）${isCrit ? " [暴击！]" : ""}`);
    }
  }

  // Remaining damage hits hull
  if (remaining > 0) {
    stats.hull = Math.max(0, Number(stats.hull || 0) - remaining);
    writeHullToShip(draft);
    if (typeof addLog === "function") {
      const turnLabel2 = `[第 ${(draft.combat && draft.combat.turnCount) || 1} 回合]`;
      addLog(`${turnLabel2} [接敌] ${enemy.name}对你造成了 ${remaining} 点伤害。（船体：${stats.hull}/${stats.hullMax}）${isCrit ? " [暴击！]" : ""}`);
    }
  } else if (typeof addLog === "function") {
    const turnLabel3 = `[第 ${(draft.combat && draft.combat.turnCount) || 1} 回合]`;
    addLog(`${turnLabel3} [接敌] ${enemy.name}的攻击被护盾完全抵挡！`);
  }
}

function grantVictoryRewards(draft, enemy) {
  draft.resources = draft.resources || {};

  // Boss victory: 200 singularity + flag
  if (enemy && enemy.id === "omega_boss") {
    const singGain = 200;
    draft.resources.singularity = Number(draft.resources.singularity || 0) + singGain;
    draft.singularity = draft.resources.singularity;
    draft.flags = draft.flags || {};
    draft.flags.omegaDefeated = true;
    draft.flags.omegaSlayer = true;
    const bossSlice = getBossSlice(draft);
    bossSlice.isBoss = false;
    bossSlice.bossPhase = 1;
    bossSlice.bossVoidNovaCounter = 0;
    bossSlice.bossBioPulseCounter = 0;
    return { singGain, omegaDefeated: true };
  }

  const tier = Math.max(1, Number(enemy.tier || 1));
  const singGain = Math.floor(tier * 2.0) + 10;
  draft.resources.singularity = Number(draft.resources.singularity || 0) + singGain;
  draft.singularity = draft.resources.singularity;
  return { singGain };
}

/**
 * Apply kinetic damage to the ablation layer.  Each point of kinetic damage
 * ablates one point off the layer.  When the layer reaches zero, laser damage
 * reduction is permanently removed.
 */
function applyAblationDamage(draft, kineticDamage, addLog) {
  const enc = getBossSlice(draft);
  if (!enc.isBoss || enc.bossAblationLayer <= 0) return;

  enc.bossAblationLayer = Math.max(0, (enc.bossAblationLayer || 0) - kineticDamage);
  if (enc.bossAblationLayer <= 0 && typeof addLog === "function") {
    addLog("[消融隔热层·碎裂] 动能冲击已击穿隔热层！激光矩阵恢复 100% 输出！");
  }
}

/**
 * Phase 1 laser damage reduction — 50% while ablation layer remains.
 * Kinetic and Mass Driver weapons bypass the layer entirely.
 */
function applyPhase1DamageReduction(draft, weapon, damage) {
  if (weapon === WEAPON.KINETIC || weapon === WEAPON.MASS_DRIVER) return damage;
  const enc = getBossSlice(draft);
  if (!enc.isBoss) return damage;
  if (enc.bossPhase !== 1 || (enc.bossAblationLayer || 0) <= 0) return damage;
  return Math.round(damage * 0.50);
}

function applyBossPhase1SingularityDrain(draft, addLog) {
  draft.resources = draft.resources || {};
  const current = Math.max(0, Number(draft.resources.singularity || draft.singularity || 0));
  if (current <= 0) return;
  const drain = Math.max(1, Math.floor(current * 0.10));
  draft.resources.singularity = Math.max(0, current - drain);
  draft.singularity = draft.resources.singularity;
  if (typeof addLog === "function") {
    addLog(`[欧米伽·噬能外壳] 能量吸收：奇点 -${drain}！`);
  }
}

function checkAndApplyPhaseTransition(draft, addLog) {
  const enc = getBossSlice(draft);
  const enemy = enc.enemy;
  if (!enemy || !enc.isBoss) return;

  const thresholds = computeBossHPThresholds(enemy.maxHp || enemy.hp || 6000);
  const curHp = Number(enemy.currentHp);

  if (enc.bossPhase === 1 && curHp <= thresholds.phase1End) {
    enc.bossPhase = 2;
    enc.bossBioPulseCounter = 0;
    enc.bossP2TotalTurns = 0;
    enc.bossTransitionBuffer = true;
    if (typeof addLog === "function") {
      const armorStatus = (enc.bossAblationLayer || 0) > 0 ? " 消融隔热层仍处于激活状态。" : "";
      addLog("[ 阶段转换 ] 欧米伽外壳碎裂！进入【不稳定突变】阶段。双重打击，高频低伤，腐蚀性攻击。" + armorStatus);
      addLog("[ 排热 ] 欧米伽正在排出废热…本回合跳过攻击。");
    }
  }

  if (enc.bossPhase === 2 && curHp <= thresholds.phase2End) {
    enc.bossPhase = 3;
    enc.bossVoidNovaCounter = 4;
    enc.bossTransitionBuffer = true;
    if (typeof addLog === "function") {
      addLog("[ 阶段转换 ] 欧米伽核心暴露！进入【塌缩临界】阶段。虚空新星倒计时：4 回合！");
      addLog("[ 缓冲 ] 核心能量涌动…本回合跳过攻击。");
    }
  }
}

function applyBossDefeatEnding(draft) {
  applyDefeatRepairs(draft);
  draft.flags = draft.flags || {};
  draft.flags.omegaEndingDefeat = true;
  draft.combat = draft.combat || {};
  draft.combat.isLocked = true;
  const enc = getBossSlice(draft);
  enc.bossEndingActive = true;
  // CRITICAL: set lastResolution so the UI caller detects defeat and
  // calls endCombat("defeat"), which runs the 5 s countdown then
  // triggers the ending overlay.  Without this the combat modal stays
  // alive and the player can keep attacking — "死后还在反击" bug.
  enc.lastResolution = {
    kind: "defeat",
    enemy: enc.enemy ? Object.assign({}, enc.enemy) : null
  };
  // Keep expedition locked, keep enemy visible for the countdown transition
}

function applyBossEnemyStrike(draft, addLog) {
  const enc = getBossSlice(draft);
  const enemy = enc.enemy;
  if (!enemy || enemy.currentHp <= 0) return;

  const stats = getCombatStatsSlice(draft);
  const turnLabel = `[第 ${(draft.combat && draft.combat.turnCount) || 1} 回合]`;

  // Phase transition buffer: boss skips this attack to "recharge"
  if (enc.bossTransitionBuffer) {
    enc.bossTransitionBuffer = false;
    if (typeof addLog === "function") {
      addLog(`${turnLabel} [排热] 欧米伽正在排出废热，本回合无攻击动作。`);
    }
    return;
  }

  // Apply pending corrosion DOT from previous turn (ticks before regular strike)
  if (enc.bossCorrosionDamage > 0) {
    const corr = enc.bossCorrosionDamage;
    enc.bossCorrosionDamage = 0;
    stats.hull = Math.max(0, Number(stats.hull || 0) - corr);
    writeHullToShip(draft);
    if (typeof addLog === "function") {
      addLog(`${turnLabel} [腐蚀] 残留腐蚀造成 ${corr} 点伤害。（船体：${stats.hull}/${stats.hullMax}）`);
    }
  }

  // Enrage: +5% per turn (additive). No separate P2 bonus — double-strike replaces it.
  const turnCount = Math.max(1, (draft.combat && draft.combat.turnCount) || 1);
  const baseAttack = enc.bossOriginalAttack || 75;
  const inP2 = enc.bossPhase === 2;
  const inP3 = enc.bossPhase === 3;
  const enragePct = 0.05 * (turnCount - 1);
  const totalMultiplier = 1 + enragePct;
  enemy.attack = Math.round(baseAttack * totalMultiplier);

  // Ablation layer: passively decreases each enemy turn by a small amount
  if (isBossFight(draft) && getBossSlice(draft).bossPhase === 1) {
    applyAblationDamage(draft, 25, addLog); // passive 25/turn ablation
  }

  // P2: double-strike at 55% power. P1/P3: single strike.
  const strikesPerTurn = inP2 ? 2 : 1;

  // P2: accuracy bonus from Unstable Power
  const effectiveAccuracy = inP2
    ? Math.min(0.98, (Number(enemy.accuracy || 0.88) + 0.10))
    : Number(enemy.accuracy || 0.88);

  // Track P2 turns for Void Syringe death clock
  if (inP2) {
    enc.bossP2TotalTurns = (enc.bossP2TotalTurns || 0) + 1;
  }

  for (let s = 0; s < strikesPerTurn; s++) {
    const hit = Math.random() < effectiveAccuracy;
    if (!hit) {
      if (typeof addLog === "function") {
        addLog(`${turnLabel} [接敌·${s + 1}] 成功闪避了${enemy.name}的攻击。`);
      }
      continue;
    }

    let raw = Math.max(1, Number(enemy.attack || 75));

    // P2: per-strike at 55% power
    if (inP2) {
      raw = Math.round(raw * 0.55);
    }

    // Crit: 1.5x on second strike only (s===1) in P2 for "telegraphed danger"; 1.3x in P3
    let isBossCrit = false;
    if (inP2 && s === 1 && Math.random() < 0.15) {
      raw = Math.round(raw * 1.5);
      isBossCrit = true;
    } else if (inP3 && Math.random() < 0.15) {
      raw = Math.round(raw * 1.3);
      isBossCrit = true;
    }

    let remaining = Math.round(raw);
    const currentShield = Math.max(0, Number(stats.playerShield || 0));
    const critTag = isBossCrit ? " [暴击！]" : "";

    // Phase 2: shield efficiency -30% (absorbs 70% instead of 100%)
    const shieldEfficiency = inP2 ? 0.70 : 1.0;

    if (currentShield > 0) {
      const effectiveShield = Math.round(currentShield * shieldEfficiency);
      const absorbed = Math.min(effectiveShield, remaining);
      stats.playerShield = Math.max(0, currentShield - absorbed);
      draft.combat.playerShield = stats.playerShield;
      remaining -= absorbed;
      if (typeof addLog === "function") {
        const effTag = inP2 && currentShield > 0 ? " [护盾效率-30%]" : "";
        addLog(`${turnLabel} [接敌·${s + 1}] 等离子护盾吸收了 ${absorbed} 点伤害。（剩余护盾：${stats.playerShield}）${effTag}${critTag}`);
      }
    }

    // Void Syringe: after 6 P2 turns, each hit steals 50 hull and heals boss 50
    if (inP2 && enc.bossP2TotalTurns > 6 && remaining > 0) {
      const steal = Math.min(50, remaining);
      remaining -= steal;
      enemy.currentHp = Math.min(enemy.maxHp || enemy.hp, (enemy.currentHp || 0) + 50);
      if (typeof addLog === "function") {
        addLog(`${turnLabel} [虚空注射器] 欧米伽从船体抽取 50 点结构精华，自身恢复 50 HP！（Boss HP：${enemy.currentHp}）`);
      }
    }

    if (remaining > 0) {
      stats.hull = Math.max(0, Number(stats.hull || 0) - remaining);
      writeHullToShip(draft);
      if (typeof addLog === "function") {
        addLog(`${turnLabel} [接敌·${s + 1}] ${enemy.name}对你造成了 ${remaining} 点伤害。（船体：${stats.hull}/${stats.hullMax}）${critTag}`);
      }
    } else if (typeof addLog === "function") {
      addLog(`${turnLabel} [接敌·${s + 1}] ${enemy.name}的攻击被护盾完全抵挡！${critTag}`);
    }

    // Phase 2: Corrosive Strike — set up DOT for next turn (30% of raw hit damage)
    if (inP2 && raw > 0) {
      enc.bossCorrosionDamage = Math.max(1, Math.round(raw * 0.30));
    }

    // Phase 1: singularity drain on hit
    if (enc.bossPhase === 1) {
      applyBossPhase1SingularityDrain(draft, addLog);
    }
  }

  // Phase 2: Bio-Pulse every 4 turns with 1-turn telegraph
  if (inP2) {
    enc.bossBioPulseCounter = (enc.bossBioPulseCounter || 0) + 1;
    if (enc.bossBioPulseCounter === 3 && typeof addLog === "function") {
      addLog(`${turnLabel} [生物脉冲·蓄能] 欧米伽正在蓄能…生物脉冲即将释放！下回合部署护盾可有效抵挡。`);
    }
    if (enc.bossBioPulseCounter >= 4) {
      enc.bossBioPulseCounter = 0;
      const bioDamage = Math.round(Number(enemy.attack || 75) * 0.7);
      let remainingBP = bioDamage;
      const bpShield = Math.max(0, Number(stats.playerShield || 0));
      const effectiveShield = Math.round(bpShield * 0.70);
      const absorbedBP = Math.min(effectiveShield, remainingBP);
      stats.playerShield = Math.max(0, bpShield - absorbedBP);
      draft.combat.playerShield = stats.playerShield;
      remainingBP -= absorbedBP;
      if (remainingBP > 0) {
        stats.hull = Math.max(0, Number(stats.hull || 0) - remainingBP);
        writeHullToShip(draft);
      }
      if (typeof addLog === "function") {
        addLog(`${turnLabel} [生物脉冲] 欧米伽释放突变脉冲！护盾效率-30%！（船体：${stats.hull}/${stats.hullMax}）`);
      }
    }
  }

  // Phase 3: Void Nova countdown (4 turns with 2-turn explicit warning)
  if (inP3 && enc.bossVoidNovaCounter > 0) {
    enc.bossVoidNovaCounter -= 1;
    if (typeof addLog === "function") {
      if (enc.bossVoidNovaCounter === 2) {
        addLog(`${turnLabel} [⚠ 虚空新星·警告] 距离引爆仅剩 2 回合！立即全力输出！`);
      } else if (enc.bossVoidNovaCounter > 0) {
        addLog(`${turnLabel} [塌缩临界] 虚空新星蓄能：${enc.bossVoidNovaCounter} 回合后引爆！`);
      } else {
        addLog(`[虚空新星·引爆] 欧米伽核心释放虚空能量！999 点不可阻挡伤害！（船体：${stats.hull}/${stats.hullMax}）`);
      }
    }
    if (enc.bossVoidNovaCounter === 0) {
      stats.hull = Math.max(0, Number(stats.hull || 0) - 999);
      writeHullToShip(draft);
    }
  }
}

function applyDefeatRepairs(draft) {
  const stats = getCombatStatsSlice(draft);
  const hullMax = Math.max(1, Number(stats.hullMax || 100));
  const patched = Math.max(1, Math.floor(hullMax * 0.12));
  stats.hull = patched;
  writeHullToShip(draft);
  draft.flags = draft.flags || {};
  draft.flags.combatEmergencyRepairsPending = true;
}

/**
 * Open encounter at distance (pending): pause expedition, store enemy template.
 * @param {object} draft
 * @param {object} encounterResult from generateEncounter
 */
export function applyEncounterPending(draft, encounterResult) {
  const enc = getEncounterSlice(draft);
  enc.phase = COMBAT_PHASE.ENCOUNTER_PENDING;
  draft.combatState = COMBAT_PHASE.ENCOUNTER_PENDING;
  enc.massDriverCharging = false;
  enc.lastResolution = null;
  pauseExpedition(draft);
  attachEnemy(draft, encounterResult);
}

/**
 * Begin combat rounds (mutates draft).
 * @param {object} draft
 */
export function applyCombatPhaseStart(draft) {
  const enc = getEncounterSlice(draft);
  if (!enc.enemy) {
    return;
  }
  enc.phase = COMBAT_PHASE.COMBAT_PHASE;
  draft.combatState = COMBAT_PHASE.COMBAT_PHASE;
  draft.flags = draft.flags || {};
  draft.flags.isInCombat = true;
  syncCombatStatsFromShip(draft);
}

function bootstrapCombatEnemy(draft) {
  const enc = getEncounterSlice(draft);
  if (!enc.enemy) {
    enc.enemy = {
      id: "fallback_contact",
      name: "未识别生命体",
      tier: 1,
      maxHp: 100,
      currentHp: 100,
      attack: 6,
      accuracy: 0.5
    };
  }
  return enc;
}

function resolveSetState(setState) {
  if (typeof setState === "function") {
    return setState;
  }
  return (mutator) => {
    if (typeof mutator === "function") {
      mutator(gameState);
    }
  };
}

/**
 * @param {object} draft
 * @param {"victory"|"defeat"|"flee"} kind
 * @param {object} extra
 */
function applyResolution(draft, kind, extra) {
  const enc = getEncounterSlice(draft);
  const enemySnapshot = enc.enemy ? Object.assign({}, enc.enemy) : null;
  enc.lastResolution = Object.assign({ kind, enemy: enemySnapshot }, extra || {});
  if (kind === "victory") {
    const rewards = grantVictoryRewards(draft, enemySnapshot || {});
    enc.lastResolution.rewards = rewards;
  } else if (kind === "defeat") {
    applyDefeatRepairs(draft);
  } else if (kind === "flee") {
    const pen = calculateEscapePenalty(draft);
    draft.resources = draft.resources || {};
    draft.resources.alloy = pen.alloyAfter;
    draft.resources.scrapMetal = pen.scrapAfter;
    draft.resources.stardust = pen.dustAfter;
    draft.resources.sealant = pen.sealantAfter;
    draft.resources.helium3 = pen.fuelAfter;
    enc.lastResolution.pen = pen;
  }
  resumeExpedition(draft);
  enc.enemy = null;
  enc.massDriverCharging = false;
  enc.phase = COMBAT_PHASE.IDLE;
  draft.combatState = COMBAT_PHASE.IDLE;
}

/**
 * @param {object} state
 * @param {function} setState
 * @param {function} addLog
 * @param {number} distanceKm floored expedition km
 * @param {{ immediateEngage?: boolean, focusTacticalDeck?: boolean }} [opts] focusTacticalDeck is legacy.
 * @returns {boolean} true if a new encounter opened
 */
export function tryTriggerCombatEncounter(state, setState, addLog, distanceKm, opts) {
  if (!state || typeof setState !== "function") {
    return false;
  }
  const unlocked = !!(state.flags && state.flags.combatSystemUnlocked);
  if (!unlocked) {
    return false;
  }
  const encNow = (state.systems && state.systems.combatEncounter) || {};
  if (encNow.phase && encNow.phase !== COMBAT_PHASE.IDLE) {
    return false;
  }

  // Bail out completely if an ending overlay is physically showing —
  // the expedition may have resumed (evac ending) but we must not
  // disturb the ending sequence by clearing flags or spawning combat.
  if (typeof document !== "undefined" && document.getElementById("ending-overlay")) {
    return false;
  }

  // Physically purge stale ending DOM and clear persisted combat/ending
  // flags so boss combat can initialise cleanly.  Only runs when no
  // overlay is in the DOM (stale auto-save remnants).
  if (typeof document !== "undefined") {
    document.querySelectorAll("#ending-overlay, .ending-flash").forEach((el) => {
      if (el && el.parentNode) el.parentNode.removeChild(el);
    });
    if (document.body) {
      document.body.classList.remove("combat-active");
    }
  }
  if ((state.flags && state.flags.endingActive) || (state.combat && state.combat.isLocked)) {
    setState((draft) => {
      draft.flags = draft.flags || {};
      draft.flags.endingActive = false;
      draft.flags.endingIsDefeat = false;
      draft.flags.endingIsEvac = false;
      draft.combat = draft.combat || {};
      draft.combat.isLocked = false;
    });
  }

  const d = Math.floor(Number(distanceKm) || 0);
  const omegaDefeated = !!(state.flags && state.flags.omegaDefeated);
  const debugOverride = typeof window !== "undefined" && window.debugMode;
  const isBossRange = d >= 200000 && (!omegaDefeated || debugOverride);

  let encounter;
  if (isBossRange) {
    if (encNow.phase && encNow.phase !== COMBAT_PHASE.IDLE) {
      return false;
    }
    // Prevent re-trigger at the same km after flee or resolution
    if (Number(encNow.lastTriggerKm) === d) {
      return false;
    }
    encounter = createOmegaEncounter();
  } else {
    encounter = generateEncounter(d);
    if (!encounter) {
      return false;
    }
    if (Number(encNow.lastTriggerKm) === d) {
      return false;
    }
  }
  setState((draft) => {
    const enc = getEncounterSlice(draft);
    enc.lastTriggerKm = d;
    applyEncounterPending(draft, encounter);
    if (isBossRange) {
      const bossSlice = getBossSlice(draft);
      bossSlice.isBoss = true;
      bossSlice.bossPhase = 1;
      bossSlice.bossBioPulseCounter = 0;
      bossSlice.bossVoidNovaCounter = 0;
      bossSlice.bossOriginalAttack = encounter.attack;
    }
    draft.systems = draft.systems || {};
    draft.systems.ui = draft.systems.ui || {};
    draft.systems.ui.showCombatModal = true;
    draft.systems.ui.activeEncounter = {
      id: encounter.id,
      name: encounter.name,
      tier: encounter.tier,
      hp: encounter.hp,
      currentHp: encounter.hp,
      attack: encounter.attack,
      accuracy: encounter.accuracy
    };
  });
  const ui = getUiApi();
  if (ui && typeof ui.renderAll === "function") {
    ui.renderAll(true);
  }
  if (typeof addLog === "function") {
    if (isBossRange) {
      addLog(`警告：检测到虚空演化终点信号——欧米伽正在接近。所有系统进入战斗状态。`);
    } else if (d >= 160000) {
      addLog(`警告：检测到极高能级生物反应，装甲厚度异常。`);
    } else {
      addLog(`警告：检测到不明生物反应。`);
    }
  }
  return true;
}

/**
 * Move from ENCOUNTER_PENDING to COMBAT_PHASE (player commits to fight).
 * @param {object} state
 * @param {function} setState
 * @param {function} [addLog]
 */
export function engageCombat(state, setState, addLog) {
  const writeState = resolveSetState(setState);
  writeState((draft) => {
    const enc = getEncounterSlice(draft);
    if (!enc.enemy) {
      enc.enemy = {
        id: "fallback_contact",
        name: "未识别生命体",
        tier: 1,
        maxHp: 100,
        currentHp: 100,
        attack: 6,
        accuracy: 0.5
      };
    }
    enc.phase = COMBAT_PHASE.COMBAT_PHASE;
    draft.combatState = COMBAT_PHASE.COMBAT_PHASE;
    // Force-clear any stale ending / lock flags that would cause the
    // combat modal to render in "系统稳定中" locked state.
    draft.flags = draft.flags || {};
    draft.flags.endingActive = false;
    draft.flags.endingIsDefeat = false;
    draft.flags.endingIsEvac = false;
    draft.combat = draft.combat || {};
    draft.combat.isLocked = false;
    syncCombatStatsFromShip(draft);
  });
  if (typeof addLog === "function") {
    addLog("[战术] 生物反应确认，交战开始。");
  }
  const ui = getUiApi();
  if (ui && typeof ui.renderAll === "function") {
    ui.renderAll(true);
  }
  return true;
}

/**
 * fireKinetic — standard immediate damage, always available.
 */
function fireKinetic(draft, log) {
  const slice = getEncounterSlice(draft);
  const enemy = slice.enemy;
  let damage = rollPlayerDamage(draft, WEAPON.KINETIC);
  const turnLabel = `[第 ${(draft.combat && draft.combat.turnCount) || 1} 回合]`;

  // Ablation layer absorbs kinetic damage; overflow hits boss HP
  if (isBossFight(draft)) {
    const enc = getBossSlice(draft);
    enc.bossKineticDamageDealt = (enc.bossKineticDamageDealt || 0) + damage;
    const layerBefore = enc.bossAblationLayer || 0;
    applyAblationDamage(draft, damage, log);
    if (layerBefore > 0) {
      const absorbed = Math.min(layerBefore, damage);
      const overflow = damage - absorbed;
      if (overflow > 0) {
        log(`${turnLabel} [动能炮·消融隔热层] 隔热层吸收 ${absorbed} 点，溢出 ${overflow} 点伤害。`);
        enemy.currentHp = Math.max(0, Number(enemy.currentHp || 0) - overflow);
      } else {
        log(`${turnLabel} [动能炮] 命中，但伤害被消融隔热层完全吸收。（${absorbed} 点）`);
      }
    } else {
      log(`${turnLabel} [动能炮] 命中，你对 ${enemy.name} 造成了 ${damage} 点伤害。`);
      enemy.currentHp = Math.max(0, Number(enemy.currentHp || 0) - damage);
    }
  } else {
    log(`${turnLabel} [动能炮] 命中，你对 ${enemy.name} 造成了 ${damage} 点伤害。`);
    enemy.currentHp = Math.max(0, Number(enemy.currentHp || 0) - damage);
  }

  if (enemy.currentHp <= 0) {
    applyResolution(draft, "victory", { enemyId: enemy.id });
    return "victory";
  }
  checkAndApplyPhaseTransition(draft, log);
  return "continue";
}

/**
 * fireLaser — high damage, available every 2 turns (cooldown).
 */
function fireLaser(draft, log) {
  const stats = getCombatStatsSlice(draft);
  if (stats.laserCooldown > 0) {
    log(`[激光矩阵] 正在充能，还需 ${stats.laserCooldown} 回合。`);
    return "cooldown";
  }
  const slice = getEncounterSlice(draft);
  const enemy = slice.enemy;
  const base = Math.max(1, Number((draft.combat || {}).baseDamage || 1));
  let laserDamage = Math.max(1, Math.round(base * 2.4));
  const turnLabel = `[第 ${(draft.combat && draft.combat.turnCount) || 1} 回合]`;
  // Boss phase 1: ablation layer active — 50% laser reduction while layer > 0
  if (isBossFight(draft) && getBossSlice(draft).bossPhase === 1) {
    const reduced = applyPhase1DamageReduction(draft, WEAPON.LASER, laserDamage);
    if (reduced !== laserDamage) {
      log(`${turnLabel} [激光矩阵·消融隔热层] 外壳削弱了激光伤害！（${laserDamage} → ${reduced}）`);
    }
    laserDamage = reduced;
  }
  log(`${turnLabel} [激光矩阵] 高额能量打击！你对 ${enemy.name} 造成了 ${laserDamage} 点伤害。`);
  enemy.currentHp = Math.max(0, Number(enemy.currentHp || 0) - laserDamage);
  stats.laserCooldown = 3;
  if (enemy.currentHp <= 0) {
    applyResolution(draft, "victory", { enemyId: enemy.id });
    return "victory";
  }
  checkAndApplyPhaseTransition(draft, log);
  return "continue";
}

/**
 * deployShield — free action: deploy plasma shield (no enemy strike, no turn advance).
 * Shield capacity scales with shieldGenerator level: 100 + level * 20.
 * Limited to 5 charges per combat with 2-turn cooldown between uses.
 */
function deployShield(draft, log) {
  const stats = getCombatStatsSlice(draft);
  // Cooldown check
  if (stats.shieldCooldown > 0) {
    log(`[等离子护盾] 充能中… ${stats.shieldCooldown} 回合后可用。`);
    return "cooldown";
  }
  // Charges check
  if (stats.shieldCharges <= 0) {
    log("[等离子护盾] 能源耗尽，本场战斗无法再次部署。");
    return "cooldown";
  }
  const shieldLevel = Math.max(0, Number((draft.combat && draft.combat.defenseSystems && draft.combat.defenseSystems.shieldGenerator) || 0));
  const shieldCapacity = 80 + shieldLevel * 8;
  stats.playerShieldMax = shieldCapacity;
  stats.playerShield = shieldCapacity;
  draft.combat.playerShield = stats.playerShield;
  draft.combat.playerShieldMax = stats.playerShieldMax;
  stats.shieldCooldown = 3; // 2 full turns + current turn
  stats.shieldCharges -= 1;
  draft.combat.shieldCooldown = stats.shieldCooldown;
  draft.combat.shieldCharges = stats.shieldCharges;
  log(`[等离子护盾] 全功率部署：护盾 ${stats.playerShield}/${shieldCapacity}（剩余次数：${stats.shieldCharges}）。`);
  return "free_action";
}

/**
 * @param {object} state
 * @param {function} setState
 * @param {function} addLog
 * @param {"kinetic"|"laser"|"mass_driver"|"shield"} weapon
 * @returns {boolean}
 */
export function playerCombatAction(state, setState, addLog, weapon) {
  if (!state || typeof setState !== "function") {
    return false;
  }
  const enc = state.systems && state.systems.combatEncounter;
  if (!enc || enc.phase !== COMBAT_PHASE.COMBAT_PHASE || !enc.enemy) {
    return false;
  }
  if (weapon === WEAPON.MASS_DRIVER && !state.massDriverBuilt) {
    if (typeof addLog === "function") {
      addLog("[火控] 质量投射器未部署，无法使用该武器。");
    }
    return false;
  }
  const pendingLogs = [];
  const log = (msg) => pendingLogs.push(String(msg));

  setState((draft) => {
    const slice = getEncounterSlice(draft);
    const enemy = slice.enemy;
    if (!enemy || slice.phase !== COMBAT_PHASE.COMBAT_PHASE) {
      return;
    }

    const stats = getCombatStatsSlice(draft);

    let result = "continue";

    if (weapon === WEAPON.SHIELD) {
      result = deployShield(draft, log);
    } else if (weapon === WEAPON.LASER) {
      result = fireLaser(draft, log);
    } else if (weapon === WEAPON.KINETIC) {
      result = fireKinetic(draft, log);
    } else if (weapon === WEAPON.MASS_DRIVER) {
      // Mass driver legacy path
      if (!slice.massDriverCharging) {
        slice.massDriverCharging = true;
        const turnLabelMD = `[第 ${(draft.combat && draft.combat.turnCount) || 1} 回合]`;
        log(`${turnLabelMD} [火控] 质量投射器充能中（本回合无弹着，下回合释放）。`);
        if (isBossFight(draft)) {
          applyBossEnemyStrike(draft, log);
        } else {
          applyEnemyStrike(draft, log);
        }
        const statsAfterMD = getCombatStatsSlice(draft);
        if (statsAfterMD.hull <= 0) {
          if (isBossFight(draft)) {
            applyBossDefeatEnding(draft);
          } else {
            applyResolution(draft, "defeat", {});
          }
        }
        return;
      }
      slice.massDriverCharging = false;
      draft.resources = draft.resources || {};
      const sing = Math.max(0, Number(draft.resources.singularity || draft.singularity || 0));
      if (sing < 1) {
        log("[火控] 奇点不足，无法完成质量投射释放（需要 1 奇点）。");
        slice.massDriverCharging = true;
        return;
      }
      draft.resources.singularity = sing - 1;
      draft.singularity = draft.resources.singularity;
      let mdDamage = rollPlayerDamage(draft, WEAPON.MASS_DRIVER);
      // Boss phase 1: ablation layer bypass — kinetic/mass driver always pass through
      if (isBossFight(draft) && getBossSlice(draft).bossPhase === 1) {
        const reduced = applyPhase1DamageReduction(draft, WEAPON.MASS_DRIVER, mdDamage);
        if (reduced !== mdDamage) {
          log(`[火控·消融隔热层] 外壳削弱了投射器伤害！（${mdDamage} → ${reduced}）`);
        }
        mdDamage = reduced;
      }
      // Mass driver strips ablation layer (absorbs damage, overflow hits boss)
      if (isBossFight(draft)) {
        const encMD = getBossSlice(draft);
        const layerBeforeMD = encMD.bossAblationLayer || 0;
        applyAblationDamage(draft, mdDamage, log);
        if (layerBeforeMD > 0) {
          const absorbedMD = Math.min(layerBeforeMD, mdDamage);
          const overflowMD = mdDamage - absorbedMD;
          if (overflowMD > 0) {
            log(`[火控·消融隔热层] 隔热层吸收 ${absorbedMD} 点，溢出 ${overflowMD} 点伤害。`);
            enemy.currentHp = Math.max(0, Number(enemy.currentHp || 0) - overflowMD);
          } else {
            log(`[火控] 质量投射命中，但伤害被消融隔热层完全吸收。（${absorbedMD} 点）`);
          }
        } else {
          log(`[火控] 质量投射命中，你对 ${enemy.name} 造成了 ${mdDamage} 点伤害。`);
          enemy.currentHp = Math.max(0, Number(enemy.currentHp || 0) - mdDamage);
        }
      } else {
        log(`[火控] 质量投射命中，你对 ${enemy.name} 造成了 ${mdDamage} 点伤害。`);
        enemy.currentHp = Math.max(0, Number(enemy.currentHp || 0) - mdDamage);
      }
      if (enemy.currentHp <= 0) {
        applyResolution(draft, "victory", { enemyId: enemy.id });
        return;
      }
      checkAndApplyPhaseTransition(draft, log);
    }

    // Free action (shield): no enemy strike, no turn advance
    if (result === "free_action") {
      return;
    }

    // If player's action didn't resolve combat, enemy strikes back
    if (result === "continue" || result === "cooldown") {
      // If cooldown blocked the attack, enemy gets a free shot
      if (result === "cooldown") {
        const turnLabelCD = `[第 ${(draft.combat && draft.combat.turnCount) || 1} 回合]`;
        log(`${turnLabelCD} [激光矩阵] 充能未完成，本回合无攻击输出。`);
      }
      if (isBossFight(draft)) {
        applyBossEnemyStrike(draft, log);
      } else {
        applyEnemyStrike(draft, log);
      }
      const statsAfter = getCombatStatsSlice(draft);
      if (statsAfter.hull <= 0) {
        if (isBossFight(draft)) {
          applyBossDefeatEnding(draft);
        } else {
          applyResolution(draft, "defeat", {});
        }
      } else {
        // Advance turn counter after a full exchange
        statsAfter.turnCount = (statsAfter.turnCount || 1) + 1;
        draft.combat.turnCount = statsAfter.turnCount;
        // Decrement laser cooldown at end of turn
        if (statsAfter.laserCooldown > 0) {
          statsAfter.laserCooldown -= 1;
        }
        draft.combat.laserCooldown = statsAfter.laserCooldown;
        // Decrement shield cooldown at end of turn
        if (statsAfter.shieldCooldown > 0) {
          statsAfter.shieldCooldown -= 1;
        }
        draft.combat.shieldCooldown = statsAfter.shieldCooldown;
      }
    }
  });

  syncStateToWorker();
  if (typeof addLog === "function") {
    pendingLogs.forEach(addLog);
  }
  const res = gameState.systems && gameState.systems.combatEncounter && gameState.systems.combatEncounter.lastResolution;
  if (typeof addLog === "function" && res) {
    if (res.kind === "victory" && res.rewards) {
      if (res.rewards.omegaDefeated) {
        addLog("[ 终局：虚空黎明 ] 欧米伽的塌缩点燃了黑暗。你成为了第一艘穿过演化终点的飞船。");
      } else {
        addLog(
          `[ 战斗胜利 ] 成功回收生物能核。奇点 +${res.rewards.singGain}！`
        );
      }
    } else if (res.kind === "defeat") {
      addLog("[紧急] 船体临界击穿，紧急修复协议已强制接管结构场。");
    }
  }
  // Boss defeat ending check (separate from normal resolution)
  const endingState = gameState.flags && gameState.flags.omegaEndingDefeat;
  if (typeof addLog === "function" && endingState) {
    addLog("[ 终局：归于死寂 ] 你的物质被欧米伽同化。演化在 200,000km 处画上了句号。");
  }
  return true;
}

/**
 * @param {object} state
 * @param {function} setState
 * @param {function} addLog
 */
export function fleeCombat(state, setState, addLog) {
  const writeState = resolveSetState(setState);
  writeState((draft) => {
    const enc = getEncounterSlice(draft);
    const wasBoss = !!(enc.isBoss);
    if (enc.enemy) {
      applyResolution(draft, "flee", {});
      if (wasBoss) {
        enc.lastTriggerKm = null;
        enc.isBoss = false;
        // applyResolution resumes expedition — for boss evac the
        // ending overlay takes over the screen so navigation must
        // stay locked until the player clicks the restart button.
        draft.systems.expedition = draft.systems.expedition || {};
        draft.systems.expedition.isNavigationLocked = true;
        draft.systems.expedition.throttle = 0;
      }
    } else {
      enc.phase = COMBAT_PHASE.IDLE;
      enc.enemy = null;
      enc.massDriverCharging = false;
      draft.combatState = COMBAT_PHASE.IDLE;
      resumeExpedition(draft);
    }
  });
  if (typeof addLog === "function") {
    const snap = state.resources || {};
    const total = (snap.alloy || 0) + (snap.scrapMetal || 0) + (snap.stardust || 0) + (snap.sealant || 0) + (snap.helium3 || 0);
    const loss = Math.floor(total * 0.15);
    addLog(`[ 紧急撤离 ] 为了摆脱生物纠缠，你抛弃了大量物资。损失材料: ${loss}。`);
  }
  syncStateToWorker();
  const ui = getUiApi();
  if (ui && typeof ui.renderAll === "function") {
    ui.renderAll(true);
  }
  return true;
}

/**
 * Post-combat buffer: 5-second mandatory delay before modal dismissal.
 * Locks all combat actions, updates countdown in the UI, then cleans up.
 * @param {"victory"|"defeat"} kind
 * @param {function} [addLog]
 */
export async function endCombat(kind, addLog) {
  // Step 1: Lock all combat buttons immediately
  moundState.setState((draft) => {
    draft.combat = draft.combat || {};
    draft.combat.isLocked = true;
  });

  // Step 2: Trigger one final re-render so the player sees final HP (0) and final log
  const ui = getUiApi();
  if (ui && typeof ui.renderAll === "function") {
    ui.renderAll(true);
  }

  // Step 3: Log final message
  if (typeof addLog === "function") {
    if (kind === "victory") {
      addLog("[ 战斗胜利 ] 生物信号消失。系统正在稳定…");
    } else if (kind === "defeat") {
      addLog("[ 战败 ] 船体临界击穿。紧急修复协议接管中…");
    }
  }

  // Step 4: Add stabilization class and begin 5-second countdown
  const modalRootEl = typeof document !== "undefined"
    ? document.querySelector(".combat-modal-root")
    : null;
  if (modalRootEl) {
    modalRootEl.classList.add("is-stabilizing");
  }
  for (let i = 5; i > 0; i--) {
    const countdownEl = typeof document !== "undefined"
      ? document.querySelector(".combat-modal-locked-countdown")
      : null;
    if (countdownEl) {
      countdownEl.textContent = `>> 同步时间锚点数据中... ${i} 秒`;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (modalRootEl) {
    modalRootEl.classList.remove("is-stabilizing");
  }

  // Step 5: Clean up state — dismiss modal, release expedition lock
  moundState.setState((draft) => {
    draft.combat = draft.combat || {};
    draft.combat.isLocked = false;
    draft.systems = draft.systems || {};
    draft.systems.ui = draft.systems.ui || {};
    draft.systems.ui.showCombatModal = false;
    draft.systems.ui.activeEncounter = null;
    draft.systems.expedition = draft.systems.expedition || {};
    draft.systems.expedition.isNavigationLocked = false;
    draft.combatState = "IDLE";
    draft.flags = draft.flags || {};
    draft.flags.isInCombat = false;
    const enc = draft.systems.combatEncounter || {};
    enc.phase = "IDLE";
    enc.enemy = null;
    enc.massDriverCharging = false;
    const restore = enc.savedThrottle;
    if (typeof restore === "number" && restore > 0) {
      const maxThrust = Math.max(1, Number(draft.maxThrustLimit || 10));
      draft.systems.expedition.throttle = Math.min(maxThrust, restore);
    }
    enc.lastResolution = null;
    enc.savedThrottle = null;
    draft.systems.combatEncounter = enc;
  });

  // Check if this was an OMEGA Boss victory — trigger victory ending sequence
  const isOmegaVictory = !!(moundState.state.flags && moundState.state.flags.omegaDefeated);

  if (isOmegaVictory) {
    syncStateToWorker();
    if (typeof document !== "undefined" && document.body) {
      document.body.classList.remove("combat-active");
    }
    renderEndingScreen();
    return;
  }

  // Check if this was an OMEGA Boss defeat — trigger defeat ending sequence
  const isOmegaDefeat = !!(moundState.state.flags && moundState.state.flags.omegaEndingDefeat);

  if (isOmegaDefeat) {
    syncStateToWorker();
    if (typeof document !== "undefined" && document.body) {
      document.body.classList.remove("combat-active");
    }
    renderDefeatScreen();
    return;
  }

  syncStateToWorker();

  if (typeof document !== "undefined" && document.body) {
    document.body.classList.remove("combat-active");
  }

  // Final re-render to remove modal from DOM
  if (ui && typeof ui.renderAll === "function") {
    ui.renderAll(true);
  }

  if (typeof addLog === "function") {
    addLog("[UNLOCK] 生物信号消失。推进系统恢复。航行锁定已解除。");
  }
}

/**
 * Debug helper: reset the OMEGA boss environment so the boss can be re-triggered at 200,000 km.
 * Clears omegaDefeated, omegaSlayer, lastTriggerKm, and boss slice state.
 * For repeated testing: enable `window.debugMode = true` to bypass the omegaDefeated gate entirely.
 */
export function resetBossEnv() {
  moundState.setState((draft) => {
    draft.flags = draft.flags || {};
    draft.flags.omegaDefeated = false;
    draft.flags.omegaSlayer = false;
    const enc = getEncounterSlice(draft);
    enc.lastTriggerKm = null;
    enc.lastResolution = null;
    // Reset boss slice state
    const bossSlice = getBossSlice(draft);
    bossSlice.isBoss = false;
    bossSlice.bossPhase = 1;
    bossSlice.bossBioPulseCounter = 0;
    bossSlice.bossVoidNovaCounter = 0;
    bossSlice.bossEndingActive = false;
    bossSlice.bossP2TotalTurns = 0;
  });
  syncStateToWorker();
  const ui = getUiApi();
  if (ui && typeof ui.renderAll === "function") {
    ui.renderAll(true);
  }
  return true;
}

export const CombatWeapons = WEAPON;

if (typeof window !== "undefined") {
  window.MoundCombatManager = {
    COMBAT_PHASE,
    CombatWeapons: WEAPON,
    tryTriggerCombatEncounter,
    engageCombat,
    playerCombatAction,
    fleeCombat,
    endCombat,
    resetBossEnv,
    isCombatLockActive
  };

  // Debug helper: reset boss environment for repeated testing
  window.resetBossEnv = resetBossEnv;

  // Initialize debug mode if not already set
  if (typeof window.debugMode === "undefined") {
    window.debugMode = false;
  }

  window.MoundEngine = window.MoundEngine || {};
  window.MoundEngine.combat = {
    engage: () => engageCombat(gameState, moundState && moundState.setState, window.MoundEngine && window.MoundEngine.addLog),
    kinetic: () => playerCombatAction(gameState, moundState && moundState.setState, window.MoundEngine && window.MoundEngine.addLog, WEAPON.KINETIC),
    laser: () => playerCombatAction(gameState, moundState && moundState.setState, window.MoundEngine && window.MoundEngine.addLog, WEAPON.LASER),
    shield: () => playerCombatAction(gameState, moundState && moundState.setState, window.MoundEngine && window.MoundEngine.addLog, WEAPON.SHIELD),
    flee: () => fleeCombat(gameState, moundState && moundState.setState, window.MoundEngine && window.MoundEngine.addLog)
  };
}
