export const PIVOT_MILESTONE_KEYS = Object.freeze([60000, 70000, 80000, 90000]);

export const PIVOT_MILESTONE_DECISIONS = Object.freeze({
  60000: {
    title: "敌意波束",
    description: "远端扫描阵列持续锁定舰体，敌意波束正在建立火控解算。",
    options: [
      { id: "A", label: "强制静默突防", costText: "消耗 60000 电力", rewardText: "获得火控数据（战备 +1）" },
      { id: "B", label: "释放诱饵编队", costText: "永久载员上限 -1", rewardText: "获得动能蓝图（战备 +1）" },
      { id: "C", label: "反向锁定干扰", costText: "消耗 350 科技点", rewardText: "获得护甲加固数据（战备 +2）" }
    ]
  },
  70000: {
    title: "无人机蜂群",
    description: "数百个无人机信标在黑暗中亮起，蜂群已进入拦截轨道。",
    options: [
      { id: "A", label: "定向电磁冲刷", costText: "消耗 90000 电力", rewardText: "蜂群退散，火控数据完善（战备 +1）" },
      { id: "B", label: "硬吃冲击波", costText: "永久电力容量 -20%", rewardText: "保住船体并获得护甲加固（战备 +1）" },
      { id: "C", label: "拆解残骸核心", costText: "消耗 8000 合金", rewardText: "获得动能蓝图（战备 +2）" }
    ]
  },
  80000: {
    title: "碎片封锁带",
    description: "前方航道被高密度金属碎片完全封堵，任何迟疑都意味着停滞。",
    options: [
      { id: "A", label: "主推进硬切通道", costText: "消耗 120000 电力", rewardText: "突围并回收火控数据（战备 +2）" },
      { id: "B", label: "牺牲居住舱模块", costText: "永久载员上限 -1", rewardText: "获得重装甲强化参数（战备 +1）" },
      { id: "C", label: "部署碎片牵引网", costText: "消耗 5000 密封剂", rewardText: "获得动能蓝图与防护曲线（战备 +2）" }
    ]
  },
  90000: {
    title: "深空伏击",
    description: "未知信号源从死角同时点亮，伏击阵型已经完成闭环。",
    options: [
      { id: "A", label: "全舰过载反击", costText: "消耗 180000 电力 + 200 氦-3", rewardText: "战备大幅提升（战备 +3）" },
      { id: "B", label: "弃置副反应堆", costText: "永久电力容量 -20%", rewardText: "换取护甲强化与生存窗口（战备 +2）" },
      { id: "C", label: "装甲楔形突围", costText: "消耗 12000 合金", rewardText: "获得最终动能蓝图（战备 +3）" }
    ]
  }
});
