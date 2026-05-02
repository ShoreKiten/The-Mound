import { gameState } from "../../core/state.js";
import { MOUND_EVENTS } from "../../data/event-pool.js";

(() => {
window.MoundEvents = MOUND_EVENTS.map((entry) => Object.assign({}, entry));

const deepSpaceLogEvents = [
  {
    text: "舷窗只剩仪表反光，恒星像冷却中的焊点。",
    type: "ambient",
    effect: (state, setState, addLog) => {
      void state; void setState;
      addLog("舷窗只剩仪表反光，恒星像冷却中的焊点。", "#888");
    }
  },
  {
    text: "推进段传回空振回声，像有人在管道尽头敲击。",
    type: "ambient",
    effect: (state, setState, addLog) => {
      void state; void setState;
      addLog("推进段传回空振回声，像有人在管道尽头敲击。", "#888");
    }
  },
  {
    text: "观测台外是一整面黑，连噪点都在后退。",
    type: "ambient",
    effect: (state, setState, addLog) => {
      void state; void setState;
      addLog("观测台外是一整面黑，连噪点都在后退。", "#888");
    }
  },
  {
    text: "生命维持风道里有细碎回响，像旧时代广播残渣。",
    type: "ambient",
    effect: (state, setState, addLog) => {
      void state; void setState;
      addLog("生命维持风道里有细碎回响，像旧时代广播残渣。", "#888");
    }
  },
  {
    text: "热辐射图谱平滑得反常，仿佛深空在屏住呼吸。",
    type: "ambient",
    effect: (state, setState, addLog) => {
      void state; void setState;
      addLog("热辐射图谱平滑得反常，仿佛深空在屏住呼吸。", "#888");
    }
  },
  {
    text: "甲板脚步声被金属吞掉，只剩心跳打在面罩里。",
    type: "ambient",
    effect: (state, setState, addLog) => {
      void state; void setState;
      addLog("甲板脚步声被金属吞掉，只剩心跳打在面罩里。", "#888");
    }
  },
  {
    text: "远端星图轻微抖动，导航员怀疑是自己眨眼。",
    type: "ambient",
    effect: (state, setState, addLog) => {
      void state; void setState;
      addLog("远端星图轻微抖动，导航员怀疑是自己眨眼。", "#888");
    }
  },
  {
    text: "舰体外壳温差趋零，寂静比黑暗更重。",
    type: "ambient",
    effect: (state, setState, addLog) => {
      void state; void setState;
      addLog("舰体外壳温差趋零，寂静比黑暗更重。", "#888");
    }
  },
  {
    text: "太阳帆边缘抓住稀薄尘流。",
    type: "resource",
    effect: (state, setState, addLog) => {
      void state;
      setState((draft) => {
        draft.resources = draft.resources || {};
        draft.resources.stardust = Number(draft.resources.stardust || 0) + Number(3);
      });
      addLog("[回收] 太阳帆捕获微尘，星尘 +3。", "#4CAF50");
    }
  },
  {
    text: "磁栅回路筛出少量废屑。",
    type: "resource",
    effect: (state, setState, addLog) => {
      void state;
      setState((draft) => {
        draft.resources = draft.resources || {};
        draft.resources.scrapMetal = Number(draft.resources.scrapMetal || 0) + Number(2);
      });
      addLog("[回收] 磁栅回路分离残屑，废金属 +2。", "#4CAF50");
    }
  },
  {
    text: "冷凝阱壁结出可用冰晶。",
    type: "resource",
    effect: (state, setState, addLog) => {
      void state;
      setState((draft) => {
        draft.resources = draft.resources || {};
        draft.resources.iceOre = Number(draft.resources.iceOre || 0) + Number(1);
      });
      addLog("[回收] 冷凝阱收集冰晶，冰矿 +1。", "#4CAF50");
    }
  },
  {
    text: "边角密封层出现低温龟裂。",
    type: "resource",
    effect: (state, setState, addLog) => {
      void state;
      setState((draft) => {
        draft.resources = draft.resources || {};
        draft.resources.sealant = Math.max(0, Number(draft.resources.sealant || 0) - Number(1));
      });
      addLog("[损耗] 极寒导致结构微裂纹，密封剂 -1。", "#FF9800");
    }
  },
  {
    text: "护板接口磨损，修复耗去合金。",
    type: "resource",
    effect: (state, setState, addLog) => {
      void state;
      setState((draft) => {
        draft.resources = draft.resources || {};
        draft.resources.alloy = Math.max(0, Number(draft.resources.alloy || 0) - Number(1));
      });
      addLog("[损耗] 护板接口磨损，合金 -1。", "#FF9800");
    }
  },
  {
    text: "聚变引导脉冲偏移，额外烧蚀氦-3。",
    type: "resource",
    effect: (state, setState, addLog) => {
      void state;
      setState((draft) => {
        draft.resources = draft.resources || {};
        draft.resources.helium3 = Math.max(0, Number(draft.resources.helium3 || 0) - Number(1));
        draft.helium3 = draft.resources.helium3;
      });
      addLog("[损耗] 聚变引导偏移，氦-3 -1。", "#FF9800");
    }
  },
  {
    text: "微型静电网回收到稀薄金属雾。",
    type: "resource",
    effect: (state, setState, addLog) => {
      void state;
      setState((draft) => {
        draft.resources = draft.resources || {};
        draft.resources.scrapMetal = Number(draft.resources.scrapMetal || 0) + Number(1);
      });
      addLog("[回收] 静电网收拢金属雾，废金属 +1。", "#4CAF50");
    }
  },
  {
    text: "船体阴面吸附到一层高反射尘膜。",
    type: "resource",
    effect: (state, setState, addLog) => {
      void state;
      setState((draft) => {
        draft.resources = draft.resources || {};
        draft.resources.stardust = Number(draft.resources.stardust || 0) + Number(2);
      });
      addLog("[回收] 外壳尘膜刮收完成，星尘 +2。", "#4CAF50");
    }
  },
  {
    text: "推进阵列在高倍率下发出连续尖啸。",
    type: "technical",
    effect: (state, setState, addLog) => {
      void setState;
      const cap = Number(state && state.maxThrustLimit || (gameState && gameState.maxThrustLimit) || 10);
      addLog(`[校准] 推进阵列在 ${cap}x 上限附近出现高频啸叫，已自动微调阻尼。`, "#FF9800");
    }
  },
  {
    text: "导航核记录到微秒级坐标漂移。",
    type: "technical",
    effect: (state, setState, addLog) => {
      void setState;
      const cap = Number(state && state.maxThrustLimit || (gameState && gameState.maxThrustLimit) || 10);
      addLog(`[校准] ${cap}x 推力档下导航核出现微秒级漂移，星图已重对齐。`, "#888");
    }
  },
  {
    text: "反推喷口在阈值边缘重复点火。",
    type: "technical",
    effect: (state, setState, addLog) => {
      void setState;
      const cap = Number(state && state.maxThrustLimit || (gameState && gameState.maxThrustLimit) || 10);
      addLog(`[校准] 反推喷口按 ${cap}x 档位曲线重采样，瞬时震荡已抑制。`, "#888");
    }
  },
  {
    text: "主轴承温度跃升，控制器切到保守相位。",
    type: "technical",
    effect: (state, setState, addLog) => {
      void setState;
      const cap = Number(state && state.maxThrustLimit || (gameState && gameState.maxThrustLimit) || 10);
      addLog(`[校准] 在 ${cap}x 推力环境下完成主轴承相位降噪。`, "#FF9800");
    }
  }
];

window.deepSpaceLogEvents = deepSpaceLogEvents;
})();

export const eventsPool = window.MoundEvents || [];
export const deepSpaceLogEventsPool = window.deepSpaceLogEvents || [];
