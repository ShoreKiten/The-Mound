/**
 * OMEGA Boss Ending Sequences — Victory, Defeat & Evacuation
 * Full-screen immersive terminal text scroll.
 * After the final line a restart button fades in.
 */

import { moundState } from "../core/state.js";
import { resetGameSession } from "../core/state-manager.js";

const OVERLAY_ID = "ending-overlay";

const FADE_DURATION_MS = 3500;
const POST_FADE_PAUSE_MS = 1500;
const BUTTON_APPEAR_DELAY_MS = 1500;

let overlayRoot = null;
let sequenceRunning = false;

// ── DOM sanitation — nuke every piece of combat / legacy UI ──

const LEGACY_SELECTORS = [
  "#combat-modal-container",
  ".combat-modal-root",
  ".combat-modal-frame",
  ".tactical-combat-overlay",
  ".tactical-encounter-modal",
  ".combat-modal",
  ".modal-backdrop",
  ".legacy-modal",
  ".combat-result",
  ".death-screen",
  ".boss-ending-overlay"
];

function purgeCombatDom() {
  if (typeof document === "undefined") return;

  LEGACY_SELECTORS.forEach((sel) => {
    try {
      document.querySelectorAll(sel).forEach((el) => {
        if (el && el.parentNode) el.parentNode.removeChild(el);
      });
    } catch (_) { /* ignore invalid selectors */ }
  });

  if (document.body) {
    document.body.classList.remove("combat-active", "alert-red-mode");
  }
}

function lockoutKeyboard() {
  if (typeof window === "undefined") return;
  window.onkeydown = null;
  window.onkeyup = null;
  // Disarm combat weapon bindings that may be registered globally
  if (window.combatActions) {
    window.combatActions = null;
  }
}

function stopRenderLoop() {
  if (typeof window === "undefined") return;
  // Signal other systems that the ending owns the screen
  window.__endingActive = true;
  // Flush any pending rAF callbacks with a no-op chain so combat re-renders
  // land *after* our overlay is already in the DOM and the guard catches them.
  for (let i = 0; i < 3; i++) {
    requestAnimationFrame(() => { /* noop — flush combat rAF queue */ });
  }
}

// ── State helpers ──

function getSingularity() {
  try {
    const state = moundState && moundState.state;
    if (state && state.resources && typeof state.resources.singularity === "number") {
      return state.resources.singularity;
    }
  } catch (_) { /* ignore */ }
  return 0;
}

function buildVictoryScript() {
  const singularity = getSingularity();
  return [
    ["远征震荡已停止。", 0],
    ["密封剂消耗归零。", 0],
    ["\"时间线回溯至锚点时刻\"这条消息，不再重复出现了。", 0],
    ["系统日志开始变空。", 0],
    ["不是被清除，是再也没有新的事件需要记录。", 0],
    ["", 1000],
    ["深空中，那个一直让时间线抖动的引力源，刚刚坍塌成了读数上的一个平线。", 0],
    ["", 1000],
    [`你看着奇点：${singularity}。`, 0],
    ["这个数字不会再跳了。", 0],
    ["", 1000],
    ["载员舱很安静。", 0],
    ["没有人说话，因为没有人知道现在算\"到了\"，还是算\"断了\"。", 0],
    ["指挥部没有发来新指令。", 0],
    ["科研中心没有新课题。", 0],
    ["生产线停下了，不是因为故障，而是因为没有\"为什么还要生产\"的理由。", 0],
    ["", 1000],
    ["航行距离停在 200000 km。", 0],
    ["你试过推油门。", 0],
    ["它不动。", 0],
    ["", 1500],
    ["不是因为坏了。", 0],
    ["是这艘船终于意识到——", 0],
    ["它已经没有需要去的地方了。", 0],
    ["", 2000],
    ["你想要一个结局。", 0],
    ["但深空从来不给结局，它只给：", 0],
    ["", 3000],
    ["停下来的理由。", 0]
  ];
}

function buildDefeatScript() {
  return [
    ["飞船塌陷的那一刻，你想起了那个锚点。", 0],
    ["那时候物资充足，氧气充足，你还没有见过这个深空里的东西。", 0],
    ["你曾经以为\"回溯时间线\"是一种退路。", 0],
    ["但现在你发现，时间线没有变。", 0],
    ["只是你没能走到终点。", 0],
    ["", 1500],
    ["深空还在扩张。", 0],
    ["而你的星图，永远缺了最后一块拼图。", 0],
    ["", 1500],
    ["载员们没有责怪你。", 0],
    ["因为这条路本来就没有地图。", 0],
    ["", 1500],
    ["指挥部传来了最后一条信号，很微弱：", 0],
    ["", 1000],
    ["\"我们看到了光……但那是你爆炸的方向。\"", 0]
  ];
}

function buildEvacScript() {
  return [
    ["通讯日志 23:47:02", 0],
    ["\"这里是远征号。\"", 1000],
    ["\"我们在撤。\"", 0],
    ["", 1500],
    ["推力档位：已达极限", 0],
    ["航行距离：200000.0 km → 200112.07 km → 200198.64 km", 0],
    ["", 2000],
    ["它在后面。", 0],
    ["没有武器了。船壳在漏，电力只够维持航向。", 0],
    ["船员全部进入休眠舱，等弹射窗口。", 0],
    ["", 2000],
    ["通讯日志 23:47:04", 0],
    ["", 1000],
    ["\"看到出口了。深空边界读数正常，我们——\"", 0],
    ["", 1500],
    ["通讯中断。", 0],
    ["", 2000],
    ["系统日志 最后一条", 0],
    ["", 1000],
    ["后方探测到定向能量。", 0],
    ["强度：饱和。", 0],
    ["规避：无效。", 0],
    ["", 2000],
    ["没有收到坠毁信号。", 0],
    ["远征号就这样从雷达上消失了——像一块被擦掉的铅笔痕迹。", 0],
    ["", 2000],
    ["深空中没有残骸。", 0],
    ["那个速度下，碎片和船体的距离，已经超过了任何扫描仪的搜索半径。", 0],
    ["", 2000],
    ["后来，有人在那条航线上收到过重复的求救信标。", 0],
    ["但信标的坐标每隔几秒就会跳一次。", 0],
    ["", 1500],
    ["没人知道那是谁在发。", 0],
    ["也没人敢去找。", 0]
  ];
}

// ── DOM construction ──

function createOverlayDom() {
  if (typeof document === "undefined") return null;

  purgeCombatDom();

  const existing = document.getElementById(OVERLAY_ID);
  if (existing && existing.parentNode) {
    existing.parentNode.removeChild(existing);
  }

  const root = document.createElement("div");
  root.id = OVERLAY_ID;
  root.style.cssText =
    "position:fixed!important;top:0!important;left:0!important;" +
    "width:100vw!important;height:100vh!important;" +
    "z-index:2147483647!important;background:#000!important;" +
    "display:flex!important;flex-direction:column!important;" +
    "visibility:visible!important;opacity:1!important;" +
    "overflow:hidden!important;pointer-events:auto!important;";

  const container = document.createElement("div");
  container.className = "ending-container";

  root.appendChild(container);
  document.body.appendChild(root);

  return { root, container };
}

function addLine(container, text) {
  const line = document.createElement("div");
  line.className = "ending-line";
  if (text === "") {
    line.innerHTML = "&nbsp;";
  } else {
    line.textContent = text;
  }
  container.appendChild(line);

  void line.offsetHeight;
  line.classList.add("ending-line-visible");
  return line;
}

function createRestartButton(container, label, btnClass) {
  const wrapper = document.createElement("div");
  wrapper.className = "ending-restart-wrapper";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "ending-restart-btn";
  if (btnClass) {
    button.classList.add(btnClass);
  }
  button.textContent = label;

  button.addEventListener("click", (event) => {
    event.stopPropagation();
    event.preventDefault();
    triggerSystemRestart();
  });

  wrapper.appendChild(button);
  container.appendChild(wrapper);

  void wrapper.offsetHeight;
  wrapper.classList.add("ending-restart-visible");
  wrapper.scrollIntoView({ behavior: "smooth", block: "center" });

  return wrapper;
}

// ── Restart flow ──

async function triggerSystemRestart() {
  if (typeof document === "undefined") return;

  destroyOverlay();
  purgeCombatDom();

  const flash = document.createElement("div");
  flash.className = "ending-flash";
  document.body.appendChild(flash);

  void flash.offsetHeight;
  flash.classList.add("ending-flash-active");

  await new Promise((resolve) => setTimeout(resolve, 1000));

  resetGameSession(true);

  flash.classList.remove("ending-flash-active");
  await new Promise((resolve) => setTimeout(resolve, 600));
  if (flash.parentNode) {
    flash.parentNode.removeChild(flash);
  }
}

// ── Shared text sequence runner ──

async function runTextSequence(container, script, restartLabel, btnClass) {
  await new Promise((r) => setTimeout(r, 100));

  for (let i = 0; i < script.length; i++) {
    const [text, blankPauseMs] = script[i];
    const line = addLine(container, text);
    if (typeof line.scrollIntoView === "function") {
      line.scrollIntoView({ behavior: "smooth", block: "center" });
    }

    if (i === script.length - 1) {
      // Last line — let it breathe, then mount the restart button.
      await new Promise((r) => setTimeout(r, FADE_DURATION_MS));
      container.classList.add("ending-final");
      await new Promise((r) => setTimeout(r, BUTTON_APPEAR_DELAY_MS));
      try {
        createRestartButton(container, restartLabel, btnClass);
      } catch (err) {
        console.error("[ENDING] Failed to create restart button:", err);
      }
    } else if (text === "") {
      await new Promise((r) => setTimeout(r, blankPauseMs || 500));
    } else {
      await new Promise((r) => setTimeout(r, FADE_DURATION_MS + POST_FADE_PAUSE_MS));
    }
  }
}

// ── Public entry points ──

export function renderEndingScreen() {
  stopRenderLoop();
  purgeCombatDom();
  lockoutKeyboard();

  if (sequenceRunning || overlayRoot) {
    return;
  }

  const dom = createOverlayDom();
  if (!dom) return;

  overlayRoot = dom.root;
  sequenceRunning = true;

  const script = buildVictoryScript();
  runTextSequence(dom.container, script, "[ 重新初始化航行系统 ]", null);
}

export function renderDefeatScreen() {
  stopRenderLoop();
  purgeCombatDom();
  lockoutKeyboard();

  if (sequenceRunning || overlayRoot) {
    return;
  }

  const dom = createOverlayDom();
  if (!dom) return;

  overlayRoot = dom.root;
  sequenceRunning = true;

  const script = buildDefeatScript();
  runTextSequence(dom.container, script, "[ 重新初始化系统 ]", null);
}

export function renderEvacScreen() {
  stopRenderLoop();
  purgeCombatDom();
  lockoutKeyboard();

  if (sequenceRunning || overlayRoot) {
    return;
  }

  const dom = createOverlayDom();
  if (!dom) return;

  // Inline colour enforcement — belt-and-suspenders against CSS cache
  dom.container.style.color = "#fff";

  overlayRoot = dom.root;
  sequenceRunning = true;

  const script = buildEvacScript();
  runTextSequence(dom.container, script, "[ 重新初始化系统 ]", null);
}

function destroyOverlay() {
  if (overlayRoot && overlayRoot.parentNode) {
    overlayRoot.parentNode.removeChild(overlayRoot);
  }
  overlayRoot = null;
  sequenceRunning = false;
  if (typeof window !== "undefined") {
    window.__endingActive = false;
  }
}

// ── Debug / escape hatch ──

if (typeof window !== "undefined") {
  window.resetEndingScreen = function () {
    destroyOverlay();
    purgeCombatDom();
    if (moundState && moundState.state && moundState.state.flags) {
      moundState.setState((draft) => {
        draft.flags.endingActive = false;
        draft.flags.endingIsDefeat = false;
        draft.flags.endingIsEvac = false;
      });
    }
    var eng = window.MoundEngine;
    if (eng && typeof eng.renderAll === "function") {
      eng.renderAll(true);
    }
  };
}
