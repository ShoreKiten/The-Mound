/** @file Event log component — streaming terminal-style log with DOM recycling for performance. */

import { moundState } from "../../core/state.js";
import { getEngineApi, getUiApi } from "../../core/runtime-hooks.js";
import { saveTimeAnchor, loadTimeAnchor, isCombatActive } from "../../core/time-anchor.js";

export const MAX_LOG_LINES = 50;
const LOG_BATCH_MS = 100;
const events = globalThis.MoundEvents || [];
const setState = typeof moundState.setState === "function" ? moundState.setState : function () {};
let pendingRender = null;
let pendingTimer = null;

function getState() {
  return (moundState && moundState.state) || {};
}

function pickEvent(id) {
  return events.find((item) => item.id === id) || null;
}

function shouldSkip(event) {
  const state = getState();
  return !!(event.once && state.seenEvents && state.seenEvents[event.id]);
}

function markSeen(id) {
  setState((draft) => {
    draft.seenEvents = draft.seenEvents || {};
    draft.seenEvents[id] = true;
  });
}

export function pullEventTextById(id) {
  const event = pickEvent(id);
  if (!event || shouldSkip(event)) {
    return null;
  }
  markSeen(event.id);
  return event.text;
}

export function pullRandomEventText(group) {
  const pool = events.filter((item) => item.group === group && !shouldSkip(item));
  if (pool.length === 0) {
    return null;
  }
  const idx = Math.floor(Math.random() * pool.length);
  const event = pool[idx];
  markSeen(event.id);
  return event.text;
}

function normalizeLogEntry(line) {
  const rawText = typeof line === "string" ? line : (line && line.text ? line.text : "");
  const id = typeof line === "object" && line && typeof line.id === "string" ? line.id : "";
  if (!rawText) {
    return null;
  }
  const text = String(rawText)
    .replace(/^\s*\[[^\]]+\]\s*/g, "")
    .replace(/[\[\]•]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return {
    text: text || String(rawText).trim(),
    rawText: String(rawText).trim(),
    id
  };
}

function resolveLogClasses() {
  return ["log-line", "log-entry"];
}

function resolveLiveLogContainer() {
  if (typeof document === "undefined") {
    return null;
  }
  const systemLog = document.getElementById("system-log");
  if (systemLog) {
    return systemLog;
  }
  const existing = document.getElementById("log-content");
  if (existing) {
    return existing;
  }
  const streamHost = document.getElementById("log-stream");
  if (streamHost) {
    const content = document.createElement("div");
    content.id = "log-content";
    streamHost.appendChild(content);
    return content;
  }
  return null;
}

export function appendLiveLogEntry(line, maxEntries = 50) {
  const normalized = normalizeLogEntry(line);
  if (!normalized) {
    return false;
  }
  const container = resolveLiveLogContainer();
  if (!container) {
    return false;
  }
  const row = document.createElement("div");
  row.className = resolveLogClasses(normalized).join(" ");
  row.classList.add("fade-in");
  row.textContent = normalized.text;
  container.prepend(row);
  while (container.children.length > Math.max(1, Number(maxEntries || 50))) {
    container.removeChild(container.lastElementChild);
  }
  return true;
}

// saveTimeAnchor / loadTimeAnchor imported from ../../core/time-anchor.js

function ensureLogStructure(host) {
  let control = host.querySelector(".log-control");
  if (!control) {
    control = document.createElement("div");
    control.className = "log-control";
    host.prepend(control);
  }

  // Always ensure the log toggle button exists (first .log-toggle in control)
  let toggleBtn = control.querySelector(".log-toggle");
  if (!toggleBtn) {
    toggleBtn = document.createElement("button");
    toggleBtn.type = "button";
    toggleBtn.className = "log-toggle";
    control.appendChild(toggleBtn);
  }

  // Time anchor controls — idempotent, re-binds listeners on every call
  let debugBar = control.querySelector(".debug-controls");
  if (!debugBar) {
    debugBar = document.createElement("div");
    debugBar.className = "debug-controls";
    control.appendChild(debugBar);
  }

  let saveBtn = debugBar.querySelector("#btn-save-anchor");
  if (!saveBtn) {
    saveBtn = document.createElement("button");
    saveBtn.id = "btn-save-anchor";
    saveBtn.type = "button";
    saveBtn.className = "anchor-btn";
    saveBtn.textContent = "[ 创建时间锚点 ]";
    debugBar.appendChild(saveBtn);
  }
  saveBtn.onclick = () => {
    if (isCombatActive()) {
      const engineHook = getEngineApi();
      if (engineHook && typeof engineHook.addLog === "function") {
        engineHook.addLog("[时间锚点] 无法保存：战斗进行中，请先完成或脱离战斗。");
      }
      return;
    }
    saveTimeAnchor();
  };

  let loadBtn = debugBar.querySelector("#btn-load-anchor");
  if (!loadBtn) {
    loadBtn = document.createElement("button");
    loadBtn.id = "btn-load-anchor";
    loadBtn.type = "button";
    loadBtn.className = "anchor-btn";
    loadBtn.textContent = "[ 回溯时间线 ]";
    debugBar.appendChild(loadBtn);
  }
  loadBtn.onclick = () => loadTimeAnchor();

  let content = host.querySelector("#log-content");
  if (!content) {
    content = document.createElement("div");
    content.id = "log-content";
    host.appendChild(content);
  } else if (content.parentNode !== host) {
    host.appendChild(content);
  }
  return { control, content, button: toggleBtn };
}

function applyToggleButton(button, toggleEnabled, onToggle) {
  if (!button) {
    return;
  }
  button.textContent = toggleEnabled ? "系统日志（流式）" : "系统日志（静音）";
  button.onclick = () => {
    if (typeof onToggle === "function") {
      onToggle();
    }
  };
}

export function renderStream(container, logs, toggleEnabled, onToggle) {
  if (!container) {
    return;
  }
  const { content, button } = ensureLogStructure(container);
  applyToggleButton(button, !!toggleEnabled, onToggle);
  const normalized = (Array.isArray(logs) ? logs : [])
    .map((line) => normalizeLogEntry(line))
    .filter(Boolean)
    .slice(0, MAX_LOG_LINES);
  pendingRender = { content, logs: normalized };
  if (pendingTimer) {
    return;
  }
  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    const payload = pendingRender;
    pendingRender = null;
    if (!payload || !payload.content) {
      return;
    }
    payload.content.textContent = "";
    for (let i = payload.logs.length - 1; i >= 0; i -= 1) {
      const line = payload.logs[i];
      const row = document.createElement("div");
      row.className = resolveLogClasses(line).join(" ");
      if (i === 0) {
        row.classList.add("fade-in");
      }
      row.textContent = line.text;
      payload.content.prepend(row);
    }
  }, LOG_BATCH_MS);
}

export function addLog(payload, color) {
  const engineHook = getEngineApi();
  if (engineHook && typeof engineHook.addLog === "function") {
    return engineHook.addLog(payload, color);
  }
  return false;
}
