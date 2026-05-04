/** @file Milestone event runtime — triggers pivot decisions at key distance checkpoints (60k-90k km). */

import { getUiSpaceApi, getUiApi } from "../../core/runtime-hooks.js";
import { saveGame } from "../../core/storage.js";
import { PIVOT_MILESTONE_KEYS, PIVOT_MILESTONE_DECISIONS } from "./milestone-data.js";

(() => {
  // Runtime event helpers only.
  let lastMajorCheckDebugAt = 0;
  const MAJOR_EVENT_KEYS = [20000, 30000, 40000, 50000, ...PIVOT_MILESTONE_KEYS, 100000];
  const MAJOR_DECISIONS = {
    20000: {
      title: "遗落信号",
      description: "传感器捕获到一段古老文明的超光速扰动。",
      options: [
        { id: "A", label: "深度解析", costText: "消耗 100000 电力", rewardText: "获得 1000 科技点" },
        { id: "B", label: "信号干扰", costText: "永久牺牲 200 科技点", rewardText: "推力效率提升 10%" },
        { id: "C", label: "数据挖掘", costText: "消耗 5000 废金属", rewardText: "获得 30 氦-3" }
      ]
    },
    30000: {
      title: "引力透镜",
      description: "飞船正滑向一个流浪黑洞的引力边缘。",
      options: [
        { id: "A", label: "引力弹弓", costText: "扣除密封剂总量 50%（至少 3000）", rewardText: "瞬间前移 5000km" },
        { id: "B", label: "奇点观测", costText: "停船 90 秒", rewardText: "获得 40 科技点" },
        { id: "C", label: "精控补偿", costText: "消耗 50 氦-3", rewardText: "航行电力消耗永久降低 15%" }
      ]
    },
    40000: {
      title: "幽灵船坞",
      description: "一座静默的巨型货船遗骸，像钢铁墓碑般漂浮。",
      options: [
        { id: "A", label: "暴力强拆", costText: "30% 概率失去 1 名载员", rewardText: "获得 25000 废金属" },
        { id: "B", label: "系统回溯", costText: "消耗 2000 星尘", rewardText: "获得 8000 密封剂" },
        { id: "C", label: "结构加固", costText: "消耗 5000 合金", rewardText: "灾难资源损失永久降低 25%" }
      ]
    },
    50000: {
      title: "深空门户",
      description: "物理常数开始波动，探测器显示前方进入高能空域。",
      options: [
        { id: "A", label: "暗物质重组", costText: "氦-3 消耗增加 50%", rewardText: "推力上限提升至 20x" },
        { id: "B", label: "秩序锚定", costText: "最高推力锁定 8x", rewardText: "灾难触发概率永久降低 60%" },
        { id: "C", label: "虚空洗礼", costText: "消耗 50 科技点", rewardText: "自动生成效率永久提升 20%" }
      ]
    },
    100000: {
      title: "不明生物反应确认",
      description: "深空监听阵列锁定到高强度生物质信号，战术窗口已被强制接管。",
      options: [
        { id: "A", label: "进入一级战备", costText: "无额外消耗", rewardText: "解锁战术指挥部与奇点重组" }
      ]
    },
    ...PIVOT_MILESTONE_DECISIONS
  };

  function resolveDistance(state) {
    if (!state) {
      return 0;
    }
    const exp = state.systems && state.systems.expedition ? state.systems.expedition : null;
    if (exp && typeof exp.distanceKm === "number") {
      return Math.max(0, exp.distanceKm);
    }
    return 0;
  }

  function shouldRunDisasterCheck(state) {
    const distance = resolveDistance(state);
    if (distance < 2000) {
      return { shouldRun: false, currentMilestone: 0 };
    }
    const currentMilestone = Math.floor(distance / 2000);
    const lastMilestone = Math.max(0, state && typeof state.lastEventMilestone === "number" ? state.lastEventMilestone : 0);
    return { shouldRun: currentMilestone > lastMilestone, currentMilestone };
  }

  function getMajorDecision(distance) {
    const key = Number(distance || 0);
    return MAJOR_DECISIONS[key] || null;
  }

  function getTechPoints(state) {
    if (!state) {
      return 0;
    }
    return state.resources && typeof state.resources.techPoints === "number"
      ? state.resources.techPoints
      : 0;
  }

  function applyTechPoints(draft, nextValue) {
    const safe = Math.max(0, Math.floor(nextValue || 0));
    draft.resources = draft.resources || {};
    draft.resources.techPoints = safe;
  }

  function ensureCombatReadinessFlag(draft) {
    draft.flags = draft.flags || {};
    if (typeof draft.flags.combatReadiness !== "number") {
      draft.flags.combatReadiness = 0;
    }
    return draft.flags.combatReadiness;
  }

  function addCombatReadiness(draft, amount) {
    const current = ensureCombatReadinessFlag(draft);
    draft.flags.combatReadiness = Math.max(0, current + Math.max(0, Number(amount || 0)));
  }

  function applyPowerCapacityPenalty(draft, ratio = 0.8) {
    draft.resources = draft.resources || {};
    const current = Math.max(5000000, Number(draft.resources.powerCapacity || 5000000));
    const next = Math.max(5000000, Math.floor(current * Math.max(0.1, Math.min(1, ratio))));
    draft.resources.powerCapacity = next;
    draft.resources.power = Math.min(Number(draft.resources.power || 0), next);
  }

  function isCompleted(state, milestone) {
    return !!(state && Array.isArray(state.completedEvents) && state.completedEvents.includes(milestone));
  }

  function getPendingMajorMilestone(state) {
    const distance = resolveDistance(state);
    for (let i = 0; i < MAJOR_EVENT_KEYS.length; i += 1) {
      const key = MAJOR_EVENT_KEYS[i];
      if (distance >= key && !isCompleted(state, key)) {
        return key;
      }
    }
    return 0;
  }

  function getNextMajorMilestone(state) {
    const distance = resolveDistance(state);
    for (let i = 0; i < MAJOR_EVENT_KEYS.length; i += 1) {
      const key = MAJOR_EVENT_KEYS[i];
      if (distance < key && !isCompleted(state, key)) {
        return key;
      }
    }
    return 0;
  }

  function tryActivateMajorDecision(state, setState, onShowDecision) {
    if (!state || typeof setState !== "function") {
      return false;
    }
    const now = Date.now();
    if ((now - lastMajorCheckDebugAt) >= 1000) {
      lastMajorCheckDebugAt = now;
      console.log(
        "Checking Milestones. Distance:",
        resolveDistance(state),
        "Next expected:",
        getNextMajorMilestone(state)
      );
    }
    if (state.isEventActive) {
      return false;
    }
    const milestone = getPendingMajorMilestone(state);
    if (!milestone) {
      return false;
    }
    setState((draft) => {
      draft.isEventActive = true;
      draft.thrustMultiplier = 0;
      draft.systems = draft.systems || {};
      draft.systems.ui = draft.systems.ui || {};
      draft.systems.ui.pendingDecision = true;
      draft.systems.ui.pendingDecisionMilestone = milestone;
      draft.systems.expedition = draft.systems.expedition || {};
      draft.systems.expedition.active = false;
      draft.systems.expedition.overdrive = false;
      draft.systems.expedition.throttle = 0;
    });
    if (typeof onShowDecision === "function") {
      onShowDecision(milestone, getMajorDecision(milestone));
    }
    return true;
  }

  function canAffordMajorDecision(state, milestone, optionId) {
    const s = state || {};
    const r = s.resources || {};
    if (milestone === 20000 && optionId === "A") return (r.power || 0) >= 100000;
    if (milestone === 20000 && optionId === "B") return getTechPoints(s) >= 200;
    if (milestone === 20000 && optionId === "C") return (r.scrapMetal || 0) >= 5000;
    if (milestone === 30000 && optionId === "C") return (r.helium3 || 0) >= 50;
    if (milestone === 40000 && optionId === "B") return (r.stardust || 0) >= 2000;
    if (milestone === 40000 && optionId === "C") return (r.alloy || 0) >= 5000;
    if (milestone === 50000 && optionId === "C") return getTechPoints(s) >= 50;
    if (milestone === 60000 && optionId === "A") return (r.power || 0) >= 60000;
    if (milestone === 60000 && optionId === "C") return getTechPoints(s) >= 350;
    if (milestone === 70000 && optionId === "A") return (r.power || 0) >= 90000;
    if (milestone === 70000 && optionId === "C") return (r.alloy || 0) >= 8000;
    if (milestone === 80000 && optionId === "A") return (r.power || 0) >= 120000;
    if (milestone === 80000 && optionId === "C") return (r.sealant || 0) >= 5000;
    if (milestone === 90000 && optionId === "A") return (r.power || 0) >= 180000 && (r.helium3 || 0) >= 200;
    if (milestone === 90000 && optionId === "C") return (r.alloy || 0) >= 12000;
    return true;
  }

  function applyMajorDecisionChoice(state, setState, milestone, optionId) {
    if (!state || typeof setState !== "function" || !getMajorDecision(milestone)) {
      return { ok: false, reason: "invalid" };
    }
    if (!canAffordMajorDecision(state, milestone, optionId)) {
      return { ok: false, reason: "resource" };
    }
    let decisionLog = "[决策] 深空参数已更新。";
    setState((draft) => {
      draft.resources = draft.resources || {};
      draft.systems = draft.systems || {};
      draft.systems.expedition = draft.systems.expedition || {};
      draft.completedEvents = Array.isArray(draft.completedEvents) ? draft.completedEvents : [];
      if (!draft.completedEvents.includes(milestone)) {
        draft.completedEvents.push(milestone);
      }
      if (milestone === 20000 && optionId === "A") {
        draft.resources.power = Math.max(0, (draft.resources.power || 0) - 100000);
        applyTechPoints(draft, getTechPoints(draft) + 1000);
        decisionLog = "[决策] 深度解析完成，获得大量科技点。";
      } else if (milestone === 20000 && optionId === "B") {
        applyTechPoints(draft, getTechPoints(draft) - 200);
        draft.thrustEfficiency = (draft.thrustEfficiency || 1) * 1.10;
        decisionLog = "[决策] 已执行信号干扰，推进效率提升。";
      } else if (milestone === 20000 && optionId === "C") {
        draft.resources.scrapMetal = Math.max(0, (draft.resources.scrapMetal || 0) - 5000);
        draft.resources.helium3 = (draft.resources.helium3 || 0) + 30;
        decisionLog = "[决策] 数据挖掘完成，回收了额外氦-3。";
      } else if (milestone === 30000 && optionId === "A") {
        const currentSealant = draft.resources.sealant || 0;
        const loss = Math.min(currentSealant, Math.max(3000, currentSealant * 0.5));
        draft.resources.sealant = Math.max(0, currentSealant - loss);
        draft.systems.expedition.distanceKm = (draft.systems.expedition.distanceKm || 0) + 5000;
        decisionLog = "[决策] 引力弹弓生效，航程跃迁 5000km。";
      } else if (milestone === 30000 && optionId === "B") {
        applyTechPoints(draft, getTechPoints(draft) + 40);
        draft.systems.expedition.pauseUntil = Date.now() + 90000;
        decisionLog = "[决策] 奇点观测开始，飞船将停船 90 秒。";
      } else if (milestone === 30000 && optionId === "C") {
        draft.resources.helium3 = Math.max(0, (draft.resources.helium3 || 0) - 50);
        draft.powerUsageMod = Math.max(0.2, (draft.powerUsageMod || 1) * 0.85);
        decisionLog = "[决策] 精控补偿完成，航行电耗下降。";
      } else if (milestone === 40000 && optionId === "A") {
        draft.resources.scrapMetal = (draft.resources.scrapMetal || 0) + 25000;
        if (Math.random() < 0.3) {
          draft.population = Math.max(0, (draft.population || 0) - 1);
        }
        decisionLog = "[决策] 暴力强拆完成，残骸资源已转入仓储。";
      } else if (milestone === 40000 && optionId === "B") {
        draft.resources.stardust = Math.max(0, (draft.resources.stardust || 0) - 2000);
        draft.resources.sealant = (draft.resources.sealant || 0) + 8000;
        decisionLog = "[决策] 系统回溯完成，密封剂储备显著提升。";
      } else if (milestone === 40000 && optionId === "C") {
        draft.resources.alloy = Math.max(0, (draft.resources.alloy || 0) - 5000);
        draft.disasterDamageMod = Math.max(0.1, (draft.disasterDamageMod || 1) * 0.75);
        decisionLog = "[决策] 船体结构加固完成，灾害损失降低。";
      } else if (milestone === 50000 && optionId === "A") {
        draft.he3UsageMod = Math.max(0.5, (draft.he3UsageMod || 1) * 1.5);
        draft.maxThrustLimit = Math.max(draft.maxThrustLimit || draft.maxThrustMultiplier || 10, 20);
        draft.maxThrustMultiplier = draft.maxThrustLimit;
        decisionLog = "[决策] 暗物质重组完成，推力上限已提升至 20x。";
      } else if (milestone === 50000 && optionId === "B") {
        draft.disasterChanceMod = Math.max(0.05, (draft.disasterChanceMod || 1) * 0.4);
        draft.maxThrustLimit = Math.min(draft.maxThrustLimit || draft.maxThrustMultiplier || 10, 8);
        draft.maxThrustMultiplier = draft.maxThrustLimit;
        decisionLog = "[决策] 秩序锚定完成，灾害触发概率大幅下降。";
      } else if (milestone === 50000 && optionId === "C") {
        applyTechPoints(draft, getTechPoints(draft) - 50);
        draft.globalProdMod = (draft.globalProdMod || 1) * 1.2;
        decisionLog = "[决策] 虚空洗礼完成，自动生产效率全面提升。";
      } else if (milestone === 60000 && optionId === "A") {
        draft.resources.power = Math.max(0, (draft.resources.power || 0) - 60000);
        draft.systems.combatIntel = draft.systems.combatIntel || {};
        draft.systems.combatIntel.fireControlData = true;
        addCombatReadiness(draft, 1);
        decisionLog = "[决策] 敌意波束已反解，火控数据入库。";
      } else if (milestone === 60000 && optionId === "B") {
        draft.populationCap = Math.max(1, Number(draft.populationCap || draft.maxPopulation || 1) - 1);
        draft.maxPopulation = Math.max(1, Number(draft.maxPopulation || draft.populationCap || 1) - 1);
        draft.systems.combatIntel = draft.systems.combatIntel || {};
        draft.systems.combatIntel.kineticBlueprints = true;
        addCombatReadiness(draft, 1);
        decisionLog = "[决策] 诱饵编队生效，代价是永久载员编制缩减。";
      } else if (milestone === 60000 && optionId === "C") {
        applyTechPoints(draft, getTechPoints(draft) - 350);
        draft.systems.combatIntel = draft.systems.combatIntel || {};
        draft.systems.combatIntel.armorReinforcement = true;
        addCombatReadiness(draft, 2);
        decisionLog = "[决策] 反向锁定成功，护甲参数完成重标定。";
      } else if (milestone === 70000 && optionId === "A") {
        draft.resources.power = Math.max(0, (draft.resources.power || 0) - 90000);
        draft.systems.combatIntel = draft.systems.combatIntel || {};
        draft.systems.combatIntel.fireControlData = true;
        addCombatReadiness(draft, 1);
        decisionLog = "[决策] 电磁冲刷压制蜂群，火控链路稳定。";
      } else if (milestone === 70000 && optionId === "B") {
        applyPowerCapacityPenalty(draft, 0.8);
        draft.systems.combatIntel = draft.systems.combatIntel || {};
        draft.systems.combatIntel.armorReinforcement = true;
        addCombatReadiness(draft, 1);
        decisionLog = "[决策] 船体承压通过，但永久电力容量被削减。";
      } else if (milestone === 70000 && optionId === "C") {
        draft.resources.alloy = Math.max(0, (draft.resources.alloy || 0) - 8000);
        draft.systems.combatIntel = draft.systems.combatIntel || {};
        draft.systems.combatIntel.kineticBlueprints = true;
        addCombatReadiness(draft, 2);
        decisionLog = "[决策] 残骸核心拆解完成，动能蓝图已归档。";
      } else if (milestone === 80000 && optionId === "A") {
        draft.resources.power = Math.max(0, (draft.resources.power || 0) - 120000);
        draft.systems.expedition.distanceKm = Number(draft.systems.expedition.distanceKm || 0) + 8000;
        draft.systems.combatIntel = draft.systems.combatIntel || {};
        draft.systems.combatIntel.fireControlData = true;
        addCombatReadiness(draft, 2);
        decisionLog = "[决策] 主推进硬切封锁带，获得关键火控样本。";
      } else if (milestone === 80000 && optionId === "B") {
        draft.populationCap = Math.max(1, Number(draft.populationCap || draft.maxPopulation || 1) - 1);
        draft.maxPopulation = Math.max(1, Number(draft.maxPopulation || draft.populationCap || 1) - 1);
        draft.systems.combatIntel = draft.systems.combatIntel || {};
        draft.systems.combatIntel.armorReinforcement = true;
        addCombatReadiness(draft, 1);
        decisionLog = "[决策] 牺牲居住舱换得装甲余量，代价不可逆。";
      } else if (milestone === 80000 && optionId === "C") {
        draft.resources.sealant = Math.max(0, (draft.resources.sealant || 0) - 5000);
        draft.systems.combatIntel = draft.systems.combatIntel || {};
        draft.systems.combatIntel.kineticBlueprints = true;
        draft.systems.combatIntel.armorReinforcement = true;
        addCombatReadiness(draft, 2);
        decisionLog = "[决策] 封锁牵引网部署完毕，防护与动能参数同步完成。";
      } else if (milestone === 90000 && optionId === "A") {
        draft.resources.power = Math.max(0, (draft.resources.power || 0) - 180000);
        draft.resources.helium3 = Math.max(0, (draft.resources.helium3 || 0) - 200);
        addCombatReadiness(draft, 3);
        decisionLog = "[决策] 全舰过载反击完成，战备指数显著抬升。";
      } else if (milestone === 90000 && optionId === "B") {
        applyPowerCapacityPenalty(draft, 0.8);
        draft.systems.combatIntel = draft.systems.combatIntel || {};
        draft.systems.combatIntel.armorReinforcement = true;
        addCombatReadiness(draft, 2);
        decisionLog = "[决策] 副反应堆被弃置，防护框架勉强维持。";
      } else if (milestone === 90000 && optionId === "C") {
        draft.resources.alloy = Math.max(0, (draft.resources.alloy || 0) - 12000);
        draft.systems.combatIntel = draft.systems.combatIntel || {};
        draft.systems.combatIntel.kineticBlueprints = true;
        addCombatReadiness(draft, 3);
        decisionLog = "[决策] 楔形突围成功，最终动能蓝图已解锁。";
      } else if (milestone === 100000 && optionId === "A") {
        draft.flags = draft.flags || {};
        draft.flags.combatSystemUnlocked = true;
        draft.systems.tech = draft.systems.tech || {};
        draft.systems.tech.singularityUnlocked = true;
        draft.resources.singularity = Math.max(0, Number(draft.resources.singularity || draft.singularity || 0));
        draft.singularity = draft.resources.singularity;
        draft.systems.ui = draft.systems.ui || {};
        decisionLog = "[警报] 战术指挥部上线，奇点重组协议已装填。";
      }
      draft.isEventActive = false;
      draft.systems.ui = draft.systems.ui || {};
      draft.systems.ui.pendingDecision = false;
      draft.systems.ui.pendingDecisionMilestone = 0;
      if (milestone !== 30000 || optionId !== "B") {
        draft.thrustMultiplier = 1;
      }
    });
    if (typeof window.refreshThrustUI === "function") {
      window.refreshThrustUI();
    } else if (typeof window.updateSliderRange === "function") {
      window.updateSliderRange();
    } else {
      const uiSpaceApi = getUiSpaceApi();
      if (uiSpaceApi && typeof uiSpaceApi.refreshThrustUI === "function") {
        uiSpaceApi.refreshThrustUI();
      } else if (uiSpaceApi && typeof uiSpaceApi.updateSliderRange === "function") {
        uiSpaceApi.updateSliderRange();
      }
    }
    saveGame();
    if (milestone === 50000 || milestone === 100000) {
      const uiApi = getUiApi();
      if (uiApi && typeof uiApi.renderAll === "function") {
        uiApi.renderAll();
      }
    }
    return { ok: true, logText: decisionLog };
  }

  function shouldTriggerOutpost(state) {
    const distance = resolveDistance(state);
    return distance >= 5000 && !(state && state.hasMetOutpost);
  }

  function applyOutpostEncounter(state, setState, onShowMenu) {
    if (!shouldTriggerOutpost(state) || typeof setState !== "function") {
      return false;
    }
    setState((draft) => {
      const prev = typeof draft.thrustMultiplier === "number" ? draft.thrustMultiplier : 1;
      draft.systems = draft.systems || {};
      draft.systems.ui = draft.systems.ui || {};
      draft.systems.ui.outpostSavedThrust = prev;
      draft.thrustMultiplier = 0;
      draft.hasMetOutpost = true;
      draft.systems.ui.outpostMenuLocked = true;
      draft.systems.expedition = draft.systems.expedition || {};
      draft.systems.expedition.throttle = 0;
      draft.systems.expedition.overdrive = false;
      draft.systems.expedition.active = false;
      draft.systems.expedition.isNavigationLocked = true;
      draft.systems.expedition.status = "SEARCHING";
      draft.systems.expedition.currentRegion = "补给星区";
      draft.systems.expedition.targetDistance = Math.max(15000, Number(draft.systems.expedition.targetDistance || 0));
      draft.resources = draft.resources || {};
      draft.resources.alloy = Number(draft.resources.alloy || 0) + 1000;
    });
    if (typeof onShowMenu === "function") {
      onShowMenu();
    }
    return true;
  }

  function resolveShieldLevel(state) {
    if (!state) {
      return 0;
    }
    const fromUpgrade = state.upgrades && typeof state.upgrades.shieldLevel === "number" ? state.upgrades.shieldLevel : null;
    if (fromUpgrade !== null) return Math.max(0, fromUpgrade);
    const fromTech = state.systems && state.systems.tech && typeof state.systems.tech.shieldLevel === "number" ? state.systems.tech.shieldLevel : 0;
    return Math.max(0, fromTech);
  }

  function getMiningDroneBaseLossChance(state) {
    const distance = resolveDistance(state);
    if (distance <= 2000) {
      return 0;
    }
    return 0.10;
  }

  function getMiningDroneLossChance(state, maintenanceActive) {
    const baseChance = getMiningDroneBaseLossChance(state);
    const shieldLevel = resolveShieldLevel(state);
    const shieldFactor = Math.max(0, 1 - shieldLevel * 0.15);
    const maintenanceFactor = maintenanceActive ? 0.7 : 1;
    return Math.max(0, Math.min(1, baseChance * shieldFactor * maintenanceFactor));
  }

  function resolveMinerCount(state) {
    if (!state) return 0;
    if (typeof state.miners === "number") return Math.max(0, Math.floor(state.miners));
    if (typeof state.miningDrones === "number") return Math.max(0, Math.floor(state.miningDrones));
    return 0;
  }

  function rollMiningDroneDamage(state, maintenanceActive) {
    const miners = resolveMinerCount(state);
    if (miners <= 0) {
      return { destroyed: 0, blocked: false, chance: 0 };
    }
    const chance = getMiningDroneLossChance(state, maintenanceActive);
    if (chance <= 0) {
      return { destroyed: 0, blocked: false, chance };
    }
    const hit = Math.random() < chance;
    return { destroyed: hit ? 1 : 0, blocked: !hit, chance };
  }

  window.MoundEventRuntime = {
    resolveDistance,
    shouldRunDisasterCheck,
    getMajorDecision,
    tryActivateMajorDecision,
    canAffordMajorDecision,
    applyMajorDecisionChoice,
    shouldTriggerOutpost,
    applyOutpostEncounter,
    resolveShieldLevel,
    getMiningDroneBaseLossChance,
    getMiningDroneLossChance,
    resolveMinerCount,
    rollMiningDroneDamage
  };
})();

export function tryActivateMajorDecision(state, setState, onShowDecision) {
  const runtime = window.MoundEventRuntime;
  if (runtime && typeof runtime.tryActivateMajorDecision === "function") {
    return runtime.tryActivateMajorDecision(state, setState, onShowDecision);
  }
  return false;
}

export function applyMajorDecisionChoice(state, setState, milestone, optionId) {
  const runtime = window.MoundEventRuntime;
  if (runtime && typeof runtime.applyMajorDecisionChoice === "function") {
    return runtime.applyMajorDecisionChoice(state, setState, milestone, optionId);
  }
  return { ok: false, reason: "runtime_unavailable" };
}
