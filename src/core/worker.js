/* eslint-disable no-restricted-globals */
(() => {
  const TICK_RATE = 100;
  let tickHandle = null;
  let tickMs = TICK_RATE;
  let lastTickAt = 0;
  let lastTickOverrunMs = 0;
  let state = {
    resources: { techPoints: 0, singularity: 0 },
    netRates: {},
    systems: {
      expedition: {
        distanceKm: 0,
        status: "IDLE",
        currentRegion: "荒芜带",
        targetDistance: 5000,
        isNavigationLocked: false,
        milestonesReached: {},
        nextRandomEventKm: 0,
        lastBroadcastKm: 0
      }
    },
    combatState: "IDLE",
    thrustEfficiency: 1,
    thrustMultiplier: 1,
    weapons: {
      active: false,
      type: "singularity_cannon",
      level: 0,
      energy: 0,
      damage: 100
    },
    singularity: 0,
    population: 0,
    populationCap: 1,
    baseTechRate: 0.1,
    globalProdMod: 1,
    maxPopulation: 1,
    lastEventMilestone: 0,
    completedEvents: [],
    hasMetOutpost: false,
    isEventActive: false,
    triggeredEvents: [],
    flags: { isResearchStationBlueprintUnlocked: false }
  };
  const DEEP_SPACE_TEXTS = [
    "舷窗外只有一层不动的黑，像被时间按住了呼吸。",
    "推进段传回轻微啸叫，控制台自动降低了震荡阈值。",
    "冷凝管路出现短促白雾，工程组记录后未发现实体裂缝。",
    "长波频道里有一瞬回声，像来自早已熄灭的航线。",
    "航向矢量稳定得反常，像整片深空在主动让路。"
  ];
  const previousPrimitiveState = new Map();
  const TRACKED_PATHS = [
    "oxygen",
    "population",
    "populationCap",
    "isTechEra",
    "techEraEnabled",
    "isAutoMaintenance",
    "hasMetOutpost",
    "isEventActive",
    "lastEventMilestone",
    "resources.techPoints",
    "resources.singularity",
    "singularity",
    "resources.power",
    "resources.oxygen",
    "resources.scrapMetal",
    "resources.stardust",
    "resources.alloy",
    "resources.sealant",
    "resources.helium3",
    "systems.oxygenCriticalLogged",
    "systems.productionSpeedBonusPct",
    "systems.ui.outpostMenuLocked",
    "systems.tech.singularityUnlocked",
    "systems.expedition.distanceKm",
    "systems.expedition.throttle",
    "systems.expedition.overdrive",
    "systems.expedition.active",
    "systems.expedition.drifting",
    "systems.expedition.nextEventAt",
    "systems.expedition.scanBlockedUntilKm",
    "systems.expedition.deepSpaceLogNextAt",
    "systems.expedition.orbitalScanUnlocked",
    "systems.expedition.milestone10000Reached",
    "isVaultRepaired",
    "blueprints.researchWorkstation",
    "blueprints.maintenanceCenter",
    "systems.expedition.milestone30000Reached",
    "systems.expedition.milestone60000Reached",
    "systems.expedition.milestone100000Reached",
    "weapons.active",
    "weapons.type",
    "weapons.level",
    "weapons.energy",
    "weapons.damage"
  ];

  function toNum(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function mergeDeep(target, source) {
    if (!source || typeof source !== "object") {
      return target;
    }
    Object.keys(source).forEach((key) => {
      const next = source[key];
      if (next && typeof next === "object" && !Array.isArray(next)) {
        if (!target[key] || typeof target[key] !== "object" || Array.isArray(target[key])) {
          target[key] = {};
        }
        mergeDeep(target[key], next);
      } else {
        target[key] = next;
      }
    });
    return target;
  }

  function normalizePrimitive(value) {
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        return 0;
      }
      return Math.round(value * 1000) / 1000;
    }
    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "string") {
      return value;
    }
    return value == null ? null : value;
  }

  function getPathValue(obj, path) {
    const segments = path.split(".");
    let cursor = obj;
    for (let i = 0; i < segments.length; i += 1) {
      if (!cursor || typeof cursor !== "object") {
        return null;
      }
      cursor = cursor[segments[i]];
    }
    return cursor;
  }

  function collectPrimitiveDelta() {
    const delta = {};
    TRACKED_PATHS.forEach((path) => {
      const nextValue = normalizePrimitive(getPathValue(state, path));
      const prevValue = previousPrimitiveState.get(path);
      if (!Object.is(nextValue, prevValue)) {
        delta[path] = nextValue;
        previousPrimitiveState.set(path, nextValue);
      }
    });
    return delta;
  }

  function emitPatch(rawPatch, now, dtSec) {
    const patch = rawPatch || {};
    const events = Array.isArray(patch.__events) ? patch.__events : null;
    const control = patch.__control && typeof patch.__control === "object" ? patch.__control : null;
    const delta = collectPrimitiveDelta();
    console.log('[Worker] emitPatch 准备发送 delta:', JSON.stringify(delta), 'events:', events ? events.length : 0, 'control:', control ? Object.keys(control) : null);
    if (Object.keys(delta).length === 0 && !events && !control) {
      console.log('[Worker] emitPatch 跳过: delta 为空且无 events/control');
      return;
    }
    postMessage({
      type: "STATE_PATCH",
      delta,
      events,
      control,
      now,
      dtSec,
      tickOverrunMs: lastTickOverrunMs
    });
  }

  function getDamage(baseDamage, singularity, level) {
    return Math.floor(baseDamage * (1 + singularity * 0.35 + level * 0.5));
  }

  function hasCompleted(milestone) {
    const list = Array.isArray(state.completedEvents) ? state.completedEvents : [];
    return list.includes(milestone);
  }

  function hasTriggered(id) {
    const list = Array.isArray(state.triggeredEvents) ? state.triggeredEvents : [];
    return list.includes(id);
  }

  function markTriggered(id, patch) {
    if (!id || hasTriggered(id)) {
      return;
    }
    const next = Array.isArray(state.triggeredEvents) ? state.triggeredEvents.slice() : [];
    next.push(id);
    patch.triggeredEvents = next;
    state.triggeredEvents = next;
  }

  function computePatch(dtSec) {
    const patch = {};
    const events = [];
    const controls = {};
    const pushedEventIds = new Set();
    const pushEvent = (entry) => {
      if (!entry) {
        return;
      }
      const normalized = typeof entry === "string" ? { text: entry } : entry;
      const text = typeof normalized.text === "string" ? normalized.text : "";
      if (!text) {
        return;
      }
      const id = normalized.id || "";
      if (id && pushedEventIds.has(id)) {
        return;
      }
      if (id) {
        pushedEventIds.add(id);
      }
      events.push({
        id: id || undefined,
        text,
        color: typeof normalized.color === "string" ? normalized.color : undefined,
        once: !!normalized.once
      });
    };
    const resources = state.resources || {};

    const expedition = state.systems && state.systems.expedition ? state.systems.expedition : {};
    const throttle = Math.max(0, toNum(expedition.throttle, 0));
    const active = !!expedition.active || throttle > 0;
    const showCombatModal = !!(state.systems && state.systems.ui && state.systems.ui.showCombatModal);
    // Failsafe: if CombatModal is not showing, isNavigationLocked MUST be false
    const effectiveNavLocked = showCombatModal ? !!expedition.isNavigationLocked : false;
    const isNavLocked = effectiveNavLocked || !!state.isEventActive;
    const power = toNum(resources.power, 0);
    console.log("[Worker] 档位:", throttle, "active:", active, "power:", power, "navLocked:", isNavLocked);
    if (active && throttle > 0 && !isNavLocked) {
      const dist = toNum(expedition.distanceKm, 0);
      const efficiency = toNum(state.thrustEfficiency) || 1;
      const thrustMultiplier = toNum(state.thrustMultiplier) || 1;
      const baseUnit = 4;
      const baseSpeed = baseUnit * throttle;
      const fusionCount = Math.max(0, toNum(state.fusionGenerators || (state.structures && state.structures.fusionGenerator), 0));
      const he3 = toNum(resources.helium3, 0);
      const techMultiplier = he3 > 0 && fusionCount >= 1 ? 2 : 1;
      const expeditionOverdrive = !!toNum(expedition.overdrive, 0);
      const expeditionBoost = toNum(expedition.nextSpeedBoost, 0) > 0 ? 1.15 : 1;
      const eventMultiplier = expeditionOverdrive ? 1.25 : expeditionBoost;
      console.log('[DEBUG-Speed]', { baseSpeed, efficiency, thrustMultiplier, techMultiplier, eventMultiplier });
      const speedPerSec = Math.max(0, baseSpeed * efficiency * thrustMultiplier * techMultiplier * eventMultiplier);
      const gain = speedPerSec * dtSec;
      const nextDistance = dist + gain;
      console.log("[Worker计算] 档位:", throttle, "速度:", speedPerSec.toFixed(4), "增量:", gain.toFixed(4), "新航程:", nextDistance.toFixed(4));
      console.log("【执行-Worker】dtSec:", dtSec, "本次增加距离:", gain.toFixed(4), "当前总航程:", nextDistance.toFixed(4));
      patch.systems = patch.systems || {};
      patch.systems.expedition = Object.assign(
        {},
        patch.systems.expedition || {},
        { distanceKm: nextDistance }
      );
    }

    const systems = state.systems || {};
    const expeditionState = systems.expedition || {};
    const curDistance = toNum(expedition.distanceKm, 0);
    const expeditionPatch = {};
    let hasExpeditionPatch = false;
    // Distance milestone and random-voyage logs are centralized in systems/events/runtime.
    if (curDistance >= 10000 && !expeditionState.milestone10000Reached) {
      expeditionPatch.milestone10000Reached = true;
      hasExpeditionPatch = true;
      patch.isTechEra = true;
      patch.techEraEnabled = true;
      patch.isAutoMaintenance = true;
      patch.populationCap = 8;
      patch.maxPopulation = Math.max(8, toNum(state.maxPopulation, 8));
      patch.blueprints = patch.blueprints || {};
      patch.blueprints.researchWorkstation = true;
      patch.blueprints.maintenanceCenter = true;
      patch.flags = patch.flags || {};
      patch.flags.isResearchStationBlueprintUnlocked = true;
      pushEvent({
        id: "milestone-10000",
        text: "[关键] 成功回收星火号先遣冷冻荚。载员上限已扩展至 8 人。",
        once: true
      });
      pushEvent({
        id: "research-blueprint-unlocked",
        text: "科研工作站蓝图已解析，科技点获取协议已激活。",
        once: true
      });
      markTriggered("milestone-10000", patch);
    }
    if (curDistance >= 30000 && !expeditionState.milestone30000Reached) {
      expeditionPatch.milestone30000Reached = true;
      hasExpeditionPatch = true;
      patch.systems = patch.systems || {};
      patch.systems.productionSpeedBonusPct = toNum(systems.productionSpeedBonusPct, 0) + 0.1;
      pushEvent({
        id: "milestone-30000",
        text: "[环境] 信号背景变得异常纯净，地表的杂音彻底消失了。",
        once: true
      });
      markTriggered("milestone-30000", patch);
    }
    if (curDistance >= 60000 && !expeditionState.milestone60000Reached) {
      expeditionPatch.milestone60000Reached = true;
      expeditionPatch.orbitalScanUnlocked = true;
      hasExpeditionPatch = true;
      patch.populationCap = Math.max(8, toNum(state.populationCap, 8));
      pushEvent({
        id: "milestone-60000",
        text: "[航向] 雷达捕捉到大型金属构件，这里曾是旧时代的轨道哨所。",
        once: true
      });
      markTriggered("milestone-60000", patch);
    }
    if (curDistance >= 100000 && !expeditionState.milestone100000Reached) {
      expeditionPatch.milestone100000Reached = true;
      hasExpeditionPatch = true;
      patch.blueprints = patch.blueprints || {};
      patch.blueprints.quantumCommArray = true;
      patch.systems = patch.systems || {};
      patch.systems.tech = patch.systems.tech || {};
      patch.systems.tech.singularityUnlocked = true;
      pushEvent({
        id: "milestone-100000",
        text: "[发现] 截获一段循环播放的加密坐标，指向更遥远的虚空。",
        once: true
      });
      markTriggered("milestone-100000", patch);
    }
    if (hasExpeditionPatch) {
      patch.systems = patch.systems || {};
      patch.systems.expedition = Object.assign(
        {},
        patch.systems.expedition || {},
        expeditionPatch
      );
    }

    const weapons = state.weapons || {};
    const weaponLevel = Math.max(0, toNum(weapons.level, 0));
    const singularity = Math.max(0, toNum(state.resources && state.resources.singularity, toNum(state.singularity, 0)));
    const baseDamage = Math.max(1, toNum(weapons.damage, 100));
    const currentEnergy = Math.max(0, Math.min(100, toNum(weapons.energy, 0)));
    const regen = (weaponLevel * 2 + singularity) * dtSec;
    const nextEnergy = Math.max(0, Math.min(100, currentEnergy + regen));
    const nextDamage = getDamage(baseDamage, singularity, weaponLevel);
    if (
      Math.abs(nextEnergy - currentEnergy) > 1e-6 ||
      nextDamage !== baseDamage ||
      weapons.active !== (singularity > 0 || weaponLevel > 0)
    ) {
      patch.weapons = {
        active: singularity > 0 || weaponLevel > 0,
        type: typeof weapons.type === "string" ? weapons.type : "singularity_cannon",
        level: weaponLevel,
        energy: nextEnergy,
        damage: nextDamage
      };
    }

    const oxygen = toNum(resources.oxygen, toNum(state.oxygen, 100));
    const systemsSnapshot = state.systems || {};
    if (oxygen < 20 && !systemsSnapshot.oxygenCriticalLogged) {
      patch.systems = patch.systems || {};
      patch.systems.oxygenCriticalLogged = true;
      pushEvent("[警告] 氧气储备跌至临界值，请检查电力供应。");
    } else if (oxygen >= 25 && systemsSnapshot.oxygenCriticalLogged) {
      patch.systems = patch.systems || {};
      patch.systems.oxygenCriticalLogged = false;
    }

    const lastMilestone = Math.max(0, toNum(state.lastEventMilestone, 0));
    const currentMilestone = Math.floor(curDistance / 2000);
    if (currentMilestone > lastMilestone) {
      patch.lastEventMilestone = currentMilestone;
      // simplified hazard sampling in worker mode
      if (Math.random() < 0.12) {
        const hazardRoll = Math.random();
        if (hazardRoll < 0.33) {
          const curSeal = toNum(resources.sealant, 0);
          patch.resources = patch.resources || {};
          patch.resources.sealant = Math.max(0, curSeal - 30);
          pushEvent("[警告] 远征震荡冲击外层防护，密封剂储备下降。");
        } else if (hazardRoll < 0.66) {
          const curPower = toNum(resources.power, 0);
          patch.resources = patch.resources || {};
          patch.resources.power = Math.max(0, curPower - 60);
          pushEvent("[异常] 推进链路遭遇磁扰动，主电网瞬时跌落。");
        } else {
          patch.systems = patch.systems || {};
          patch.systems.expedition = Object.assign(
            {},
            patch.systems.expedition || {},
            { scanBlockedUntilKm: curDistance + 5000 }
          );
          pushEvent("[异常] 捕获到强力杂讯干扰，雷达系统暂时瘫痪。");
        }
      }
    }

    // Outpost encounter control at 5k km.
    if (curDistance >= 5000 && !state.hasMetOutpost) {
      patch.hasMetOutpost = true;
      patch.resources = patch.resources || {};
      patch.resources.alloy = toNum(resources.alloy, 0) + 1000;
      patch.systems = patch.systems || {};
      patch.systems.ui = Object.assign({}, patch.systems.ui || {}, {
        outpostMenuLocked: true
      });
      patch.systems.expedition = Object.assign({}, patch.systems.expedition || {}, {
        throttle: 0,
        active: false,
        overdrive: false,
        isNavigationLocked: true,
        status: "SEARCHING",
        currentRegion: "补给星区",
        targetDistance: Math.max(15000, toNum(expeditionState.targetDistance, 0))
      });
      controls.showOutpostMenu = true;
      pushEvent("[航向] 已抵达补给坐标。主推进已切断。");
      pushEvent("[补给] 回收到哨站库存，合金 +1000。");
    }

    // Major decision control gates.
    const majorMilestones = [20000, 30000, 40000, 50000, 60000, 70000, 80000, 90000];
    if (!state.isEventActive) {
      const pendingMajor = majorMilestones.find((m) => curDistance >= m && !hasCompleted(m));
      if (pendingMajor) {
        patch.isEventActive = true;
        patch.systems = patch.systems || {};
        patch.systems.ui = Object.assign({}, patch.systems.ui || {}, {
          pendingDecision: true,
          pendingDecisionMilestone: pendingMajor
        });
        patch.systems.expedition = Object.assign({}, patch.systems.expedition || {}, {
          throttle: 0,
          active: false,
          overdrive: false
        });
        controls.showMajorDecision = pendingMajor;
        pushEvent("[决策] 深空里程碑事件已触发，等待指挥授权。");
      }
    }

    // Deep-space ambience logs between 60k and 90k.
    const currentNextLogAt = toNum(expeditionState.deepSpaceLogNextAt, 0);
    if (curDistance >= 60000 && curDistance < 90000 && !state.isEventActive && !controls.showMajorDecision) {
      if (!currentNextLogAt || currentNextLogAt <= Date.now()) {
        const nextAt = Date.now() + 6000 + Math.floor(Math.random() * 7000);
        patch.systems = patch.systems || {};
        patch.systems.expedition = Object.assign({}, patch.systems.expedition || {}, {
          deepSpaceLogNextAt: nextAt
        });
        if (Math.random() < 0.32) {
          const idx = Math.floor(Math.random() * DEEP_SPACE_TEXTS.length);
          pushEvent({
            id: `deep-space-${idx}`,
            text: DEEP_SPACE_TEXTS[idx],
            color: "#888"
          });
        }
      }
    }

    if (events.length) {
      patch.__events = events;
    }
    if (Object.keys(controls).length) {
      patch.__control = controls;
    }

    return patch;
  }

  function startTicking() {
    if (tickHandle) {
      clearInterval(tickHandle);
      tickHandle = null;
    }
    lastTickAt = Date.now();
    tickHandle = setInterval(() => {
      const now = Date.now();
      const elapsedMs = now - lastTickAt;
      if (elapsedMs > tickMs) {
        lastTickOverrunMs = elapsedMs - tickMs;
      } else {
        lastTickOverrunMs = 0;
      }
      const dtSecRaw = (now - lastTickAt) / 1000;
      const dtSec = Number.isFinite(dtSecRaw) && dtSecRaw > 0 ? dtSecRaw : (TICK_RATE / 1000);
      lastTickAt = now;
      const patch = computePatch(dtSec);
      if (Object.keys(patch).length > 0) {
        mergeDeep(state, patch);
        emitPatch(patch, now, dtSec);
      }
    }, TICK_RATE);
  }

  function stopTicking() {
    if (tickHandle) {
      clearInterval(tickHandle);
      tickHandle = null;
    }
  }

  function applyCommand(command, payload) {
    if (command === "CONVERT_SINGULARITY") {
      const conversionRate = Math.max(1, toNum((payload && payload.conversionRate) || 100, 100));
      state.resources = state.resources || {};
      const tech = toNum(state.resources.techPoints, 0);
      if (tech < conversionRate) {
        return;
      }
      state.resources.techPoints = tech - conversionRate;
      state.resources.singularity = Math.max(0, toNum(state.resources.singularity, state.singularity), 0) + 1;
      state.singularity = state.resources.singularity;
      console.log(`[Singularity Exchange] -${conversionRate} Tech, +1 Singularity. New Total: ${state.resources.singularity}`);
    } else if (command === "UPGRADE_WEAPON") {
      const techCost = Math.max(1, toNum((payload && payload.techCost) || 1000, 1000));
      const singularityCost = Math.max(1, toNum((payload && payload.singularityCost) || 1, 1));
      state.resources = state.resources || {};
      const tech = toNum(state.resources.techPoints, 0);
      const singularity = toNum(state.resources.singularity, state.singularity);
      if (tech < techCost || singularity < singularityCost) {
        return;
      }
      state.resources.techPoints = tech - techCost;
      state.resources.singularity = singularity - singularityCost;
      state.singularity = state.resources.singularity;
      state.weapons = state.weapons || {};
      state.weapons.level = Math.max(0, toNum(state.weapons.level, 0)) + 1;
      state.weapons.active = true;
    } else if (command === "SET_THROTTLE") {
      console.log("【入口-Worker】接收到新档位值:", payload && payload.value);
      const systems = state.systems || {};
      systems.ui = systems.ui || {};
      systems.expedition = systems.expedition || {};
      // Failsafe: if CombatModal is not showing, isNavigationLocked MUST be false
      const effectiveNavLocked = !!(systems.ui && systems.ui.showCombatModal) ? !!systems.expedition.isNavigationLocked : false;
      const isLocked = !!systems.ui.outpostMenuLocked || effectiveNavLocked || !!state.isEventActive;
      const maxThrust = Math.max(1, toNum(state.maxThrustLimit || state.maxThrustMultiplier, 10));
      const next = Math.max(0, Math.min(maxThrust, Math.floor(toNum(payload && payload.value, 0))));
      if (isLocked) {
        console.log("[Worker] SET_THROTTLE 被拦截: isLocked=", isLocked, "outpostMenuLocked=", !!systems.ui.outpostMenuLocked, "isNavigationLocked=", !!systems.expedition.isNavigationLocked, "isEventActive=", !!state.isEventActive);
        return;
      }
      systems.expedition.throttle = next;
      systems.expedition.overdrive = next > 5;
      systems.expedition.active = next > 0;
      systems.expedition.drifting = false;
      systems.expedition.status = next > 0 ? "VOYAGING" : "IDLE";
      systems.expedition.isNavigationLocked = false;
      if (next > 0 && toNum(systems.expedition.nextEventAt, 0) <= 0) {
        systems.expedition.nextEventAt = Date.now() + 60000;
      }
      state.systems = systems;
      emitPatch({
        systems: {
          expedition: {
            throttle: systems.expedition.throttle,
            overdrive: systems.expedition.overdrive,
            active: systems.expedition.active,
            drifting: systems.expedition.drifting,
            nextEventAt: systems.expedition.nextEventAt,
            status: systems.expedition.status,
            isNavigationLocked: systems.expedition.isNavigationLocked
          }
        }
      }, Date.now(), 0);
      return;
    }
    const patch = computePatch(0);
    mergeDeep(state, patch);
    emitPatch(patch, Date.now(), 0);
  }

  onmessage = (event) => {
    const data = event && event.data ? event.data : {};
    const type = data.type;
    if (type === "INIT") {
      void data.tickMs;
      tickMs = TICK_RATE;
      state = mergeDeep(state, data.snapshot || {});
      previousPrimitiveState.clear();
      startTicking();
      return;
    }
    if (type === "SYNC_STATE") {
      state = mergeDeep(state, data.snapshot || {});
      return;
    }
    if (type === "COMMAND") {
      applyCommand(data.command, data.payload || {});
      return;
    }
    if (type === "STOP") {
      stopTicking();
    }
  };
})();
