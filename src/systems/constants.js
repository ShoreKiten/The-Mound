(() => {
  const MAX_TECH_LEVEL = 10;
  const CONVERSION_RATE = 100;

  window.MoundConstants = window.MoundConstants || {};
  window.MoundConstants.MAX_TECH_LEVEL = MAX_TECH_LEVEL;
  window.MoundConstants.CONVERSION_RATE = CONVERSION_RATE;

  // Backward-compatible globals used by legacy modules.
  window.MAX_TECH_LEVEL = MAX_TECH_LEVEL;
  window.CONVERSION_RATE = CONVERSION_RATE;
})();

export const MAX_TECH_LEVEL =
  window.MoundConstants && typeof window.MoundConstants.MAX_TECH_LEVEL === "number"
    ? window.MoundConstants.MAX_TECH_LEVEL
    : 10;

export const CONVERSION_RATE =
  window.MoundConstants && typeof window.MoundConstants.CONVERSION_RATE === "number"
    ? window.MoundConstants.CONVERSION_RATE
    : 100;
