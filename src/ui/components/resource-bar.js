/** @file Resource bar utilities — rate formatting, tooltip HTML generation, CSS class helpers. */

export function formatRate(value) {
  const sign = value >= 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}/s`;
}

export function rateClass(value) {
  return value >= 0 ? "rate-pos" : "rate-neg";
}

export function buildResourceRateTipHtml(state, key) {
  const net = state && state.netRates ? state.netRates : {};
  const valueSources = (state && (state.valueSources || state.productionSource)) || {};
  const powerParts = state && state.systems && state.systems.rates && state.systems.rates.powerParts
    ? state.systems.rates.powerParts
    : null;
  const total = key === "power" && Number.isFinite(Number(powerParts && powerParts.netPower))
    ? Number(powerParts.netPower)
    : Number(net[key] || 0);
  const sources = valueSources[key] || {};
  const positiveColor = window.colors && window.colors.positive ? window.colors.positive : "#33ff33";
  const negativeColor = window.colors && window.colors.negative ? window.colors.negative : "#ff4a4a";
  const rows = Object.keys(sources).map((name) => {
    const v = Number(sources[name] || 0);
    const color = v >= 0 ? positiveColor : negativeColor;
    const sign = v >= 0 ? "+" : "";
    const marker = v >= 0 ? "+" : "-";
    return `<div style="color:${color}">${marker} ${name}: ${sign}${v.toFixed(2)}/s</div>`;
  });
  if (!rows.length) {
    rows.push("<div>暂无来源分解</div>");
  }
  const totalColor = total >= 0 ? positiveColor : negativeColor;
  let powerSummary = "";
  if (key === "power") {
    const prod = Number(powerParts && powerParts.totalProduction);
    const cons = Number(powerParts && powerParts.totalConsumption);
    const hasParts = Number.isFinite(prod) && Number.isFinite(cons);
    const viewProd = hasParts
      ? prod
      : Object.keys(sources).reduce((sum, name) => {
        const value = Number(sources[name] || 0);
        return value > 0 ? sum + value : sum;
      }, 0);
    const viewCons = hasParts
      ? cons
      : Object.keys(sources).reduce((sum, name) => {
        const value = Number(sources[name] || 0);
        return value < 0 ? sum + Math.abs(value) : sum;
      }, 0);
    powerSummary = `<div>产出: +${viewProd.toFixed(2)}/s  消耗: -${viewCons.toFixed(2)}/s</div>`;
  }
  return `
    <div>实时状态</div>
    ${powerSummary}
    <div style="color:${totalColor}">净增长: ${formatRate(total)}</div>
    ${rows.join("")}
  `;
}
