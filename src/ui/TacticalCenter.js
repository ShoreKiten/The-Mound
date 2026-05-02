import { gameState, moundState } from "../core/state.js";
import { getUiApi } from "../core/runtime-hooks.js";
import {
  COMBAT_PHASE,
  CombatWeapons,
  engageCombat,
  fleeCombat,
  playerCombatAction
} from "../systems/expedition/CombatManager.js";

function ensureWindowCombatBridge() {
  if (typeof window === "undefined") {
    return;
  }
  window.MoundEngine = window.MoundEngine || {};
  window.MoundEngine.combat = window.MoundEngine.combat || {};
  if (typeof window.MoundEngine.combat.engage !== "function") {
    window.MoundEngine.combat.engage = () =>
      engageCombat(getLiveState(), moundState && moundState.setState, window.MoundEngine && window.MoundEngine.addLog);
  }
  if (typeof window.MoundEngine.combat.flee !== "function") {
    window.MoundEngine.combat.flee = () =>
      fleeCombat(getLiveState(), moundState && moundState.setState, window.MoundEngine && window.MoundEngine.addLog);
  }
}

function getLiveState() {
  return (moundState && moundState.state) || gameState || {};
}

function asciiHullBar(current, max, label) {
  const mx = Math.max(0.0001, Number(max) || 1);
  const cur = Math.max(0, Number(current) || 0);
  const pct = Math.round((cur / mx) * 100);
  const w = 10;
  const filled = Math.min(w, Math.max(0, Math.round((cur / mx) * w)));
  const bar = "|".repeat(filled) + ".".repeat(w - filled);
  const lbl = label || "舰体";
  return `${lbl}：[${bar}] ${pct}%`;
}

function asciiShieldBar(current, max, w) {
  const mx = Math.max(0.0001, Number(max) || 1);
  const cur = Math.max(0, Number(current) || 0);
  const width = Math.max(1, w || 8);
  const filled = Math.min(width, Math.max(0, Math.round((cur / mx) * width)));
  return { bar: "|".repeat(filled) + ".".repeat(width - filled), pct: Math.round((cur / mx) * 100) };
}

/**
 * Tactical deck: upgrades plus turn-based combat overlay (white on black, no scrollbars).
 * @param {{ state?: object, formatInt?: function, onRefresh?: function }} api
 */
export function createTacticalCenterPanel(api) {
  const formatInt = (api && api.formatInt) || ((n) => Math.floor(Number(n || 0)).toString());
  const onRefresh = api && typeof api.onRefresh === "function" ? api.onRefresh : function () {};
  const techMod = window.MoundSystems && window.MoundSystems.tech;
  const addGameLog = (msg) => {
    const eng = typeof window !== "undefined" ? window.MoundEngine : null;
    if (eng && typeof eng.addLog === "function") {
      eng.addLog(String(msg || ""));
    }
  };

  const root = document.createElement("div");
  root.className = "research-center-root tactical-center-root";

  const normalLayer = document.createElement("div");
  normalLayer.className = "tactical-normal-layer";

  const title = document.createElement("div");
  title.className = "research-center-title";
  title.textContent = "—— 战术指挥部 ——";
  normalLayer.appendChild(title);
  const hint = document.createElement("div");
  hint.className = "research-tech-points tactical-danger-title";
  hint.textContent = "深空生物质浓度持续上升";
  normalLayer.appendChild(hint);

  const scanningPlaceholder = document.createElement("div");
  scanningPlaceholder.className = "tactical-scanning-placeholder";
  scanningPlaceholder.style.cssText =
    "text-align:center;padding:28px 12px;color:#666;font-family:monospace;letter-spacing:0.08em;font-size:0.9rem;";
  scanningPlaceholder.textContent = "正在扫描生命体征信号...";
  normalLayer.appendChild(scanningPlaceholder);

  const singularityCount = document.createElement("div");
  singularityCount.className = "research-tech-points";
  normalLayer.appendChild(singularityCount);
  const convertButton = document.createElement("button");
  convertButton.type = "button";
  convertButton.className = "action-btn tactical-convert-btn";
  convertButton.textContent = "奇点重组: 100 科技点 -> 1 奇点";
  let convertLocked = false;
  convertButton.addEventListener("click", () => {
    if (convertLocked) return;
    convertLocked = true;
    moundState.setState((draft) => {
      const tech = Number(draft.resources.techPoints || 0);
      if (tech < 100) return;
      // 严格执行：100科技点换1个奇点，允许无限累加
      draft.resources.techPoints = tech - 100;
      draft.resources.singularity = Number(draft.resources.singularity || draft.singularity || 0) + 1;
      draft.singularity = draft.resources.singularity;
      console.log('[DEBUG] 奇点兑换成功: 当前总数 = ' + draft.resources.singularity);
    });
    addGameLog("[奇点凝聚中...] 物理常数已达极限，奇点 +1。");
    refresh();
    onRefresh();
    setTimeout(() => { convertLocked = false; }, 300);
  });
  normalLayer.appendChild(convertButton);

  const summaryLine1 = document.createElement("div");
  summaryLine1.className = "research-tech-points tactical-summary-line";
  normalLayer.appendChild(summaryLine1);
  const summaryLine2 = document.createElement("div");
  summaryLine2.className = "research-tech-points tactical-summary-line";
  normalLayer.appendChild(summaryLine2);

  const grid = document.createElement("div");
  grid.className = "tactical-grid";
  const attackCol = document.createElement("div");
  attackCol.className = "tactical-col";
  const defenseCol = document.createElement("div");
  defenseCol.className = "tactical-col";
  const attackTitle = document.createElement("div");
  attackTitle.className = "research-center-title tactical-col-title";
  attackTitle.textContent = "攻击系统";
  const defenseTitle = document.createElement("div");
  defenseTitle.className = "research-center-title tactical-col-title";
  defenseTitle.textContent = "防御系统";
  attackCol.appendChild(attackTitle);
  defenseCol.appendChild(defenseTitle);
  grid.appendChild(attackCol);
  grid.appendChild(defenseCol);
  normalLayer.appendChild(grid);

  const rows = {
    kinetic: createCombatUpgradeRow("动能炮", "提升基础伤害", attackCol),
    laser: createCombatUpgradeRow("激光矩阵", "每 2 回合可以发动一次高能打击，造成巨大伤害。", attackCol),
    shield: createCombatUpgradeRow("等离子护盾", "部署高能离子层，产生护盾抵扣即将到来的伤害。", defenseCol),
    armor: createCombatUpgradeRow("消融装甲", "提升船体耐久", defenseCol)
  };

  const combatOverlay = document.createElement("div");
  combatOverlay.className = "tactical-combat-overlay";
  combatOverlay.setAttribute("aria-hidden", "true");
  combatOverlay.style.zIndex = "2147483647";

  const encounterBlock = document.createElement("div");
  encounterBlock.className = "tactical-combat-encounter tactical-encounter-terminal";
  const encounterHeader = document.createElement("div");
  encounterHeader.className = "tactical-encounter-header";
  encounterHeader.textContent = "—— 侦测到生物反应 ——";
  const encounterEnemyTitle = document.createElement("div");
  encounterEnemyTitle.className = "tactical-encounter-enemy-title";
  encounterEnemyTitle.textContent = "未知生物体";
  const encounterAlert = document.createElement("div");
  encounterAlert.className = "tactical-combat-alert";
  const encounterMiniLog = document.createElement("div");
  encounterMiniLog.className = "tactical-encounter-mini-log";
  const encounterMiniLogLines = [];
  for (let i = 0; i < 4; i += 1) {
    const ln = document.createElement("div");
    ln.className = "tactical-encounter-mini-log-line";
    encounterMiniLog.appendChild(ln);
    encounterMiniLogLines.push(ln);
  }
  encounterBlock.appendChild(encounterHeader);
  encounterBlock.appendChild(encounterEnemyTitle);
  encounterBlock.appendChild(encounterAlert);
  encounterBlock.appendChild(encounterMiniLog);
  const encounterActions = document.createElement("div");
  encounterActions.className = "tactical-combat-encounter-actions tactical-encounter-actions-row";
  const engageBtn = document.createElement("button");
  engageBtn.type = "button";
  engageBtn.className = "tactical-combat-cmd tactical-encounter-cmd-large";
  engageBtn.textContent = "[ 发起攻击 ]";
  const fleeEncounterBtn = document.createElement("button");
  fleeEncounterBtn.type = "button";
  fleeEncounterBtn.className = "tactical-combat-cmd tactical-encounter-cmd-large";
  fleeEncounterBtn.textContent = "[ 紧急撤离 ]";
  encounterActions.appendChild(engageBtn);
  encounterActions.appendChild(fleeEncounterBtn);
  encounterBlock.appendChild(encounterActions);

  const combatActive = document.createElement("div");
  combatActive.className = "tactical-combat-active";
  const combatMainPanel = document.createElement("div");
  combatMainPanel.className = "tactical-combat-main";
  const combatTurnHeader = document.createElement("div");
  combatTurnHeader.className = "tactical-combat-turn-header";
  const bossPhaseIndicator = document.createElement("div");
  bossPhaseIndicator.className = "tactical-combat-boss-phase";
  const enemyNameEl = document.createElement("div");
  enemyNameEl.className = "tactical-combat-enemy-name";
  const enemyBarEl = document.createElement("pre");
  enemyBarEl.className = "tactical-combat-hull-bar";
  const playerHullBarEl = document.createElement("pre");
  playerHullBarEl.className = "tactical-combat-player-hull-bar";
  const playerShieldBarEl = document.createElement("pre");
  playerShieldBarEl.className = "tactical-combat-player-shield-bar";
  const weaponRow = document.createElement("div");
  weaponRow.className = "tactical-combat-weapons";
  const wKinetic = makeWeaponButton("动能炮", CombatWeapons.KINETIC);
  const wLaser = makeWeaponButton("激光矩阵", CombatWeapons.LASER);
  const wMass = makeWeaponButton("质量投射器", CombatWeapons.MASS_DRIVER);
  const wShield = makeWeaponButton("等离子护盾", CombatWeapons.SHIELD);
  weaponRow.appendChild(wKinetic.wrap);
  weaponRow.appendChild(wLaser.wrap);
  weaponRow.appendChild(wMass.wrap);
  weaponRow.appendChild(wShield.wrap);
  combatMainPanel.appendChild(combatTurnHeader);
  combatMainPanel.appendChild(bossPhaseIndicator);
  combatMainPanel.appendChild(enemyNameEl);
  combatMainPanel.appendChild(enemyBarEl);
  combatMainPanel.appendChild(playerHullBarEl);
  combatMainPanel.appendChild(playerShieldBarEl);
  combatMainPanel.appendChild(weaponRow);

  const combatSidePanel = document.createElement("div");
  combatSidePanel.className = "tactical-combat-side";
  const combatLog = document.createElement("div");
  combatLog.className = "tactical-combat-log";
  const logLines = [];
  for (let i = 0; i < 10; i += 1) {
    const line = document.createElement("div");
    line.className = "tactical-combat-log-line";
    combatLog.appendChild(line);
    logLines.push(line);
  }
  combatSidePanel.appendChild(combatLog);
  combatActive.appendChild(combatMainPanel);
  combatActive.appendChild(combatSidePanel);

  combatOverlay.appendChild(combatActive);

  const encounterModal = document.createElement("div");
  encounterModal.className = "tactical-encounter-modal";
  encounterModal.setAttribute("aria-hidden", "true");
  encounterModal.appendChild(encounterBlock);

  root.appendChild(encounterModal);
  root.appendChild(normalLayer);
  root.appendChild(combatOverlay);

  const combatLogBuffer = [];

  function flushCombatLogUi() {
    const start = Math.max(0, combatLogBuffer.length - 10);
    for (let i = 0; i < 10; i += 1) {
      logLines[i].textContent = combatLogBuffer[start + i] || "";
    }
  }

  function pushCombatLog(msg) {
    const text = String(msg || "").trim();
    if (!text) {
      return;
    }
    combatLogBuffer.push(text);
    while (combatLogBuffer.length > 10) {
      combatLogBuffer.shift();
    }
    flushCombatLogUi();
  }

  function clearCombatLog() {
    combatLogBuffer.length = 0;
    flushCombatLogUi();
  }

  function makeWeaponButton(label, weaponKey) {
    const wrap = document.createElement("div");
    wrap.className = "tactical-combat-weapon";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tactical-combat-cmd tactical-combat-weapon-btn";
    btn.textContent = label.toUpperCase();
    const status = document.createElement("div");
    status.className = "tactical-combat-weapon-status";
    wrap.appendChild(btn);
    wrap.appendChild(status);
    btn.addEventListener("click", () => fireWeapon(weaponKey, label));
    return { wrap, btn, status, weaponKey, label };
  }

  function fireWeapon(weaponKey, label) {
    if (!moundState || typeof moundState.setState !== "function") {
      return;
    }
    const before = getLiveState();
    const enc = before.systems && before.systems.combatEncounter;
    if (!enc || enc.phase !== COMBAT_PHASE.COMBAT_PHASE || !enc.enemy) {
      return;
    }
    // Guard: disallow actions during post-combat buffer
    if (before.combat && before.combat.isLocked) {
      return;
    }
    if (weaponKey === CombatWeapons.MASS_DRIVER && !before.massDriverBuilt) {
      pushCombatLog("质量投射器离线。");
      return;
    }
    const enemyBefore = enc.enemy;
    const beforeEn = Number(enemyBefore.currentHp);
    const beforeHull = Number((before.combatStats && before.combatStats.hull) ?? before.combat?.hullHp ?? 0);
    const beforeShield = Number((before.combatStats && before.combatStats.playerShield) || 0);
    const wasCharging = !!enc.massDriverCharging;
    playerCombatAction(before, moundState.setState, addGameLog, weaponKey);
    const after = getLiveState();
    const encA = after.systems && after.systems.combatEncounter;
    const enemyAfter = encA && encA.enemy;
    const afterEn = enemyAfter ? Number(enemyAfter.currentHp) : null;
    const afterHull = Number((after.combatStats && after.combatStats.hull) ?? after.combat?.hullHp ?? 0);
    const afterShield = Number((after.combatStats && after.combatStats.playerShield) || 0);
    if (weaponKey === CombatWeapons.MASS_DRIVER && !wasCharging && encA && encA.massDriverCharging) {
      pushCombatLog("质量投射器：充能中（下回合发射）。");
    } else if (weaponKey === CombatWeapons.SHIELD) {
      const shieldGain = afterShield - beforeShield;
      pushCombatLog(`等离子护盾部署：+${Math.max(0, shieldGain)} 护盾（总计 ${afterShield}）。`);
    } else if (afterEn != null && beforeEn > afterEn) {
      pushCombatLog(`${label} 开火，造成 ${beforeEn - afterEn} 点伤害。`);
    } else if (weaponKey === CombatWeapons.MASS_DRIVER && wasCharging) {
      pushCombatLog("质量投射器：释放序列完成。");
    }
    // Shield is a free action — no enemy counter-attack
    if (weaponKey !== CombatWeapons.SHIELD) {
      const hullLoss = Math.max(0, beforeHull - afterHull);
      const atk = Number(enemyBefore.attack || 0);
      const shield = Number((before.combatStats && before.combatStats.shield) || 0);
      if (after.combatState === COMBAT_PHASE.COMBAT_PHASE && enemyAfter) {
        if (hullLoss > 0) {
          const absorbed = Math.max(0, Math.round(atk - hullLoss));
          pushCombatLog(`敌方反击：舰体 -${hullLoss}。护盾吸收约 ${absorbed} 伤害。`);
        } else {
          pushCombatLog(`敌方反击：护盾吸收约 ${Math.round(atk * (0.35 + shield * 0.5))} 伤害。`);
        }
      }
    }
    onRefresh();
    refresh();
  }

  engageBtn.addEventListener("click", () => {
    const ok = engageCombat(getLiveState(), moundState && moundState.setState, addGameLog);
    if (ok) {
      addGameLog("[战术] 发起攻击 — 火控锁定。");
      pushCombatLog("交战：武器系统启动。");
    } else {
      addGameLog("[战术] 无法交战（状态未就绪）。");
    }
    onRefresh();
    refresh();
  });

  fleeEncounterBtn.addEventListener("click", () => {
    fleeCombat(getLiveState(), moundState && moundState.setState, addGameLog);
    pushCombatLog("撤离：丢弃货舱，全速脱离。");
    clearCombatLog();
    onRefresh();
    refresh();
  });

  function createCombatUpgradeRow(name, desc, host) {
    const row = document.createElement("div");
    row.className = "tactical-upgrade-row";
    const rowTitle = document.createElement("div");
    rowTitle.className = "research-tech-points";
    const meta = document.createElement("div");
    meta.className = "research-tech-points tactical-upgrade-meta";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "action-btn";
    row.appendChild(rowTitle);
    row.appendChild(meta);
    row.appendChild(button);
    host.appendChild(row);
    return { title: rowTitle, meta, button, name, desc };
  }

  function safeNum(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function sanitizeCombatDraft(draft) {
    draft.combat = draft.combat || {};
    draft.combat.attackSystems = draft.combat.attackSystems || {};
    draft.combat.defenseSystems = draft.combat.defenseSystems || {};
    draft.combat.attackSystems.kineticCannon = Math.max(0, safeNum(draft.combat.attackSystems.kineticCannon, 0));
    draft.combat.attackSystems.laserArray = Math.max(0, safeNum(draft.combat.attackSystems.laserArray, 0));
    draft.combat.defenseSystems.shieldGenerator = Math.max(0, safeNum(draft.combat.defenseSystems.shieldGenerator, 0));
    draft.combat.defenseSystems.ablativeArmor = Math.max(0, safeNum(draft.combat.defenseSystems.ablativeArmor, 0));
    draft.combat.attackLevel =
      Math.max(0, safeNum(draft.combat.attackSystems.kineticCannon, 0)) +
      Math.max(0, safeNum(draft.combat.attackSystems.laserArray, 0));
    draft.combat.defenseLevel =
      Math.max(0, safeNum(draft.combat.defenseSystems.shieldGenerator, 0)) +
      Math.max(0, safeNum(draft.combat.defenseSystems.ablativeArmor, 0));
    const baseDamage = Math.max(1, 1 + draft.combat.attackSystems.kineticCannon * 10);
    const critChance = Math.max(0, Math.min(0.75, draft.combat.attackSystems.laserArray * 0.05));
    const damageReduction = Math.max(0, Math.min(0.8, draft.combat.defenseSystems.shieldGenerator * 0.04));
    const hullHp = Math.max(100, 100 + draft.combat.defenseSystems.ablativeArmor * 40);
    draft.combat.baseDamage = Number.isFinite(baseDamage) ? baseDamage : 1;
    draft.combat.critChance = Number.isFinite(critChance) ? critChance : 0;
    draft.combat.damageReduction = Number.isFinite(damageReduction) ? damageReduction : 0;
    draft.combat.hullHp = Number.isFinite(hullHp) ? hullHp : 100;
  }

  function getCombatSnapshot() {
    const current = getLiveState();
    const combat = current.combat || {};
    const atk = combat.attackSystems || {};
    const def = combat.defenseSystems || {};
    return {
      current,
      tech: safeNum(current.resources && current.resources.techPoints, 0),
      singularity: safeNum((current.resources && current.resources.singularity) || current.singularity, 0),
      kinetic: Math.max(0, safeNum(atk.kineticCannon, 0)),
      laser: Math.max(0, safeNum(atk.laserArray, 0)),
      shield: Math.max(0, safeNum(def.shieldGenerator, 0)),
      armor: Math.max(0, safeNum(def.ablativeArmor, 0)),
      attackLevel: Math.max(0, safeNum(combat.attackLevel, 0)),
      defenseLevel: Math.max(0, safeNum(combat.defenseLevel, 0)),
      baseDamage: Math.max(1, safeNum(combat.baseDamage, 1)),
      critChance: Math.max(0, safeNum(combat.critChance, 0)),
      damageReduction: Math.max(0, safeNum(combat.damageReduction, 0)),
      hullHp: Math.max(100, safeNum(combat.hullHp, 100))
    };
  }

  function nextCost(level) {
    return Math.max(1, 1 + Math.floor(Math.max(0, safeNum(level, 0)) / 3));
  }

  function upgradeCombat(systemKey) {
    if (!moundState || typeof moundState.setState !== "function") {
      return false;
    }
    let applied = false;
    moundState.setState((draft) => {
      draft.resources = draft.resources || {};
      sanitizeCombatDraft(draft);
      const combat = draft.combat;
      let targetLevel = 0;
      if (systemKey === "kinetic") targetLevel = combat.attackSystems.kineticCannon;
      if (systemKey === "laser") targetLevel = combat.attackSystems.laserArray;
      if (systemKey === "shield") targetLevel = combat.defenseSystems.shieldGenerator;
      if (systemKey === "armor") targetLevel = combat.defenseSystems.ablativeArmor;
      const cost = nextCost(targetLevel);
      const bag = draft.resources;
      const singularity = Math.max(0, safeNum(bag.singularity, draft.singularity));
      if (singularity < cost) {
        return;
      }
      bag.singularity = singularity - cost;
      draft.singularity = bag.singularity;
      if (systemKey === "kinetic") combat.attackSystems.kineticCannon += 1;
      if (systemKey === "laser") combat.attackSystems.laserArray += 1;
      if (systemKey === "shield") combat.defenseSystems.shieldGenerator += 1;
      if (systemKey === "armor") combat.defenseSystems.ablativeArmor += 1;
      sanitizeCombatDraft(draft);
      applied = true;
    });
    return applied;
  }

  rows.kinetic.button.addEventListener("click", () => {
    if (upgradeCombat("kinetic")) {
      refresh();
      onRefresh();
    }
  });
  rows.laser.button.addEventListener("click", () => {
    if (upgradeCombat("laser")) {
      refresh();
      onRefresh();
    }
  });
  rows.shield.button.addEventListener("click", () => {
    if (upgradeCombat("shield")) {
      refresh();
      onRefresh();
    }
  });
  rows.armor.button.addEventListener("click", () => {
    if (upgradeCombat("armor")) {
      refresh();
      onRefresh();
    }
  });

  function refresh() {
    if (moundState && typeof moundState.setState === "function") {
      moundState.setState((draft) => {
        sanitizeCombatDraft(draft);
      });
    }
    const snapshot = getCombatSnapshot();
    const live = getLiveState();
    const enc = live.systems && live.systems.combatEncounter;
    const phaseFromEnc = enc && enc.phase;
    const combatState = live.combatState || phaseFromEnc || COMBAT_PHASE.IDLE;
    const enemyName = (enc?.enemy?.name) || (live.activeEnemy?.name) || "未知生物体";
    const inEncounterPending = combatState === COMBAT_PHASE.ENCOUNTER_PENDING;
    const inCombat = combatState === COMBAT_PHASE.COMBAT_PHASE;
    const combatNonIdle = combatState !== COMBAT_PHASE.IDLE;

    // If the full-screen CombatModal is active, hide all tactical overlays
    const combatModalActive = !!(live.systems && live.systems.ui && live.systems.ui.showCombatModal);

    if (combatNonIdle && !combatModalActive) {
      root.classList.add("tactical-combat-active");
      normalLayer.style.display = "none";
      scanningPlaceholder.style.display = "none";
    } else {
      root.classList.remove("tactical-combat-active");
      normalLayer.style.display = "";
      scanningPlaceholder.style.display = "";
      encounterModal.style.display = "none";
      encounterModal.setAttribute("aria-hidden", "true");
      combatOverlay.style.display = "none";
      combatOverlay.setAttribute("aria-hidden", "true");
      delete root.dataset.tacticalEncounterId;
    }

    if (inEncounterPending && !combatModalActive) {
      const eid = enc && enc.enemy ? String(enc.enemy.id || enc.enemy.name || "") : "pending";
      if (root.dataset.tacticalEncounterId !== eid) {
        clearCombatLog();
        root.dataset.tacticalEncounterId = eid;
        encounterMiniLogLines[0].textContent = "侦测到不明生物信号。";
        encounterMiniLogLines[1].textContent = `目标：${String(enemyName).toUpperCase()}`;
        encounterMiniLogLines[2].textContent = "护盾：正常。";
        encounterMiniLogLines[3].textContent = "等待指令：[ 发起攻击 ] 或 [ 紧急撤离 ] ——避免被同化";
      }
      encounterEnemyTitle.textContent = String(enemyName).toUpperCase();
      encounterHeader.textContent = "—— 侦测到生物反应 ——";
      encounterAlert.textContent =
        enc && enc.enemy
          ? `警告：高能信号。${String(enc.enemy.name || "").toUpperCase()} 正在接近。`
          : "生物质信号锁定——分类未完成，等待指令。";
      encounterModal.style.display = "flex";
      encounterModal.setAttribute("aria-hidden", "false");
      encounterBlock.style.display = "flex";
      combatActive.style.display = "none";
      combatOverlay.style.display = "none";
      combatOverlay.setAttribute("aria-hidden", "true");
    } else if (inCombat && enc && enc.enemy) {
      encounterModal.style.display = "none";
      encounterModal.setAttribute("aria-hidden", "true");
      encounterBlock.style.display = "none";
      combatOverlay.style.display = "flex";
      combatOverlay.setAttribute("aria-hidden", "false");
      combatActive.style.display = "flex";
      const e = enc.enemy;
      enemyNameEl.textContent = String(enemyName || "未知生物体").toUpperCase();

      // Boss phase indicator and name styling
      const inBossFight = !!(enc && enc.isBoss && e && e.id === "omega_boss");
      if (inBossFight) {
        const phaseNames = { 1: "噬能外壳", 2: "不稳定突变", 3: "塌缩临界" };
        const phaseNum = Number(enc.bossPhase || 1);
        let phaseText = `—— 阶段 ${phaseNum}：${phaseNames[phaseNum] || ""} ——`;
        if (phaseNum === 1 && (enc.bossAblationLayer || 0) > 0) {
          phaseText += ` | 消融隔热层: ${enc.bossAblationLayer}`;
        }
        if (phaseNum === 3 && Number(enc.bossVoidNovaCounter || 0) > 0) {
          phaseText += ` | 虚空新星 ${enc.bossVoidNovaCounter}/4`;
          bossPhaseIndicator.className = "tactical-combat-boss-phase phase-3-danger";
        } else {
          bossPhaseIndicator.className = "tactical-combat-boss-phase";
        }
        bossPhaseIndicator.style.display = "block";
        bossPhaseIndicator.textContent = phaseText;
        enemyNameEl.style.color = "#FFD700";
        enemyNameEl.style.textShadow = "0 0 6px rgba(255, 100, 50, 0.6)";
        enemyBarEl.className = "tactical-combat-hull-bar boss-bar";
      } else {
        bossPhaseIndicator.style.display = "none";
        bossPhaseIndicator.textContent = "";
        enemyNameEl.style.color = "#ffffff";
        enemyNameEl.style.textShadow = "none";
        enemyBarEl.className = "tactical-combat-hull-bar";
      }

      const maxHp = Math.max(0.0001, Number(e.maxHp || e.hp || 1));
      const cur = Math.max(0, Number(e.currentHp));
      enemyBarEl.textContent = asciiHullBar(cur, maxHp, "敌方舰体");

      // Turn counter header
      const combatStats = live.combatStats || {};
      const turn = Math.max(1, combatStats.turnCount || 1);
      combatTurnHeader.textContent = `—— 第 [${turn}] 回合 ——`;
      combatTurnHeader.style.cssText =
        "text-align:center;border-bottom:1px solid #333;padding-bottom:6px;margin-bottom:8px;color:#CCC;font-weight:700;";

      // Player hull bar
      const pHp = safeNum(combatStats.hull || live.combat?.hullHp || 100, 100);
      const pMax = Math.max(0.0001, safeNum(combatStats.hullMax || live.combat?.hullHp || 100, 100));
      playerHullBarEl.textContent = asciiHullBar(pHp, pMax, "我方舰体");
      playerHullBarEl.style.cssText =
        "text-align:center;margin:4px 0;white-space:pre;font:inherit;color:#FFF;";

      // Player shield bar
      const pShield = safeNum(combatStats.playerShield, 0);
      const pShieldMax = Math.max(1, safeNum(combatStats.playerShieldMax, 30));
      const shieldBarData = asciiShieldBar(pShield, pShieldMax, 8);
      playerShieldBarEl.textContent = `等离子护盾：[${shieldBarData.bar}] ${pShield}/${pShieldMax}`;
      playerShieldBarEl.style.cssText =
        "text-align:center;margin:0 0 8px 0;white-space:pre;font:inherit;color:#CCC;font-size:0.85em;";

      const charging = !!enc.massDriverCharging;
      const built = !!live.massDriverBuilt;
      const singNow = Math.max(0, Number((live.resources && live.resources.singularity) || 0));

      // Laser cooldown display
      const laserCooldown = Math.max(0, combatStats.laserCooldown || 0);
      if (laserCooldown > 0) {
        wLaser.status.textContent = `充能中… ${laserCooldown}回合`;
        wLaser.btn.disabled = true;
      } else {
        wLaser.status.textContent = "就绪";
        wLaser.btn.disabled = false;
      }
      wKinetic.status.textContent = "就绪";
      wKinetic.btn.disabled = false;

      // Shield cooldown and charges display
      const shieldCooldown = Math.max(0, combatStats.shieldCooldown || 0);
      const shieldCharges = typeof combatStats.shieldCharges === "number" ? combatStats.shieldCharges : 3;
      const shieldLevel = Math.max(0, Number((live.combat && live.combat.defenseSystems && live.combat.defenseSystems.shieldGenerator) || 0));
      const shieldCapacity = 80 + shieldLevel * 8;
      if (shieldCharges <= 0) {
        wShield.status.textContent = "能源耗尽";
        wShield.btn.disabled = true;
      } else if (shieldCooldown > 0) {
        wShield.status.textContent = `充能中… ${shieldCooldown}回合 (余: ${shieldCharges}) [${shieldCapacity}]`;
        wShield.btn.disabled = true;
      } else {
        wShield.status.textContent = `就绪 · 余 ${shieldCharges} 次 [${shieldCapacity}]`;
        wShield.btn.disabled = false;
      }
      if (!built) {
        wMass.status.textContent = "未部署";
        wMass.btn.disabled = true;
      } else if (charging) {
        wMass.status.textContent = singNow < 1 ? "充能中 — 需要 1 奇点释放" : "充能中…";
        wMass.btn.disabled = false;
      } else if (singNow < 1) {
        wMass.status.textContent = "需要 1 奇点";
        wMass.btn.disabled = true;
      } else {
        wMass.status.textContent = "就绪 · 1 奇点/发";
        wMass.btn.disabled = false;
      }
    } else if (combatNonIdle) {
      encounterModal.style.display = "none";
      encounterModal.setAttribute("aria-hidden", "true");
      encounterBlock.style.display = "none";
      combatOverlay.style.display = "flex";
      combatOverlay.setAttribute("aria-hidden", "false");
      combatActive.style.display = enc && enc.enemy ? "flex" : "none";

    } else {
      encounterBlock.style.display = "none";
      combatActive.style.display = "none";
      encounterMiniLogLines.forEach((el) => {
        el.textContent = "";
      });
    }

    singularityCount.textContent = `奇点储备: ${formatInt(snapshot.singularity)} ｜ 科技点: ${formatInt(snapshot.tech)}`;
    summaryLine1.textContent =
      `总攻 Lv.${formatInt(snapshot.attackLevel)} ｜ 总防 Lv.${formatInt(snapshot.defenseLevel)} ｜ 基础伤害 ${formatInt(snapshot.baseDamage)}`;
    summaryLine2.textContent =
      `暴击 ${(snapshot.critChance * 100).toFixed(1)}% ｜ 减伤 ${(snapshot.damageReduction * 100).toFixed(1)}% ｜ 船体 ${formatInt(snapshot.hullHp)}`;
    const canConvert = snapshot.tech >= 100;
    convertButton.disabled = !canConvert;
    convertButton.classList.toggle("btn-disabled", !canConvert);

    const map = [
      { row: rows.kinetic, level: snapshot.kinetic, valueText: `基础伤害 ${formatInt(snapshot.baseDamage)}` },
      { row: rows.laser, level: snapshot.laser, valueText: `每 2 回合可以发动一次高能打击，造成巨大伤害。` },
      { row: rows.shield, level: snapshot.shield, valueText: `产生等离子护盾抵扣即将到来的伤害。` },
      { row: rows.armor, level: snapshot.armor, valueText: `船体 ${formatInt(snapshot.hullHp)}` }
    ];
    map.forEach(({ row, level, valueText }) => {
      const cost = nextCost(level);
      const afford = snapshot.singularity >= cost;
      row.title.textContent = `${row.name} · Lv.${formatInt(level)}`;
      row.meta.textContent = `${row.desc} ｜ 当前: ${valueText}`;
      row.button.textContent = `升级（消耗 ${formatInt(cost)} 奇点）`;
      row.button.disabled = !afford;
      row.button.classList.toggle("btn-disabled", !afford);
    });
  }

  root.__tacticalRefresh = refresh;
  try {
    refresh();
  } catch (err) {
    console.error("[TacticalCenter] refresh() threw:", err);
  }
  return root;
}

/**
 * Build tactical DOM for the full-screen combat overlay (`#combat-ghost-ui-host`).
 * @returns {HTMLElement}
 */
export function renderTacticalCenter() {
  ensureWindowCombatBridge();
  const panel = createTacticalCenterPanel({
    formatInt: (n) => Math.floor(Number(n || 0)).toString(),
    onRefresh: () => {
      const ui = getUiApi();
      if (ui && typeof ui.renderAll === "function") {
        ui.renderAll(true);
      }
    }
  });
  if (panel && typeof panel.__tacticalRefresh === "function") {
    panel.__tacticalRefresh();
  }
  return panel;
}
