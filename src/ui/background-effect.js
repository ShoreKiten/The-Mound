/** @file Background starfield canvas — animated parallax stars effect behind all UI layers. */

const STARFIELD_CANVAS_ID = "starfield-canvas";

let rafId = 0;
let running = false;
let stars = [];
let nebulaLayers = [];
let canvas = null;
let ctx = null;
let noiseCanvas = null;
let noisePattern = null;
let cssWidth = 0;
let cssHeight = 0;
let lastTick = 0;
let resizeHandler = null;

function rand(min, max) {
  return min + Math.random() * (max - min);
}

function createStar(width, height) {
  const layerRoll = Math.random();
  const layer = layerRoll < 0.8 ? 0 : (layerRoll < 0.95 ? 1 : 2);
  const layerCfg = [
    // far: dimmest, slowest, smallest
    { rMin: 0.45, rMax: 0.85, aMin: 0.1, aMax: 0.3, speed: 0.008 },
    // mid
    { rMin: 0.7, rMax: 1.15, aMin: 0.16, aMax: 0.42, speed: 0.016 },
    // near
    { rMin: 1.0, rMax: 1.5, aMin: 0.24, aMax: 0.55, speed: 0.028 }
  ][layer];
  const angle = rand(0, Math.PI * 2);
  const speed = rand(layerCfg.speed * 0.45, layerCfg.speed);
  const alphaMin = layerCfg.aMin;
  const alphaMax = layerCfg.aMax;
  const alpha = rand(alphaMin, alphaMax);
  return {
    x: rand(0, width),
    y: rand(0, height),
    r: rand(layerCfg.rMin, layerCfg.rMax),
    vx: Math.cos(angle) * speed,
    vy: Math.sin(angle) * speed,
    alpha,
    alphaMin,
    alphaMax,
    alphaDrift: rand(-0.00008, 0.00008) || 0.00004,
    blur: rand(2, 7)
  };
}

function createNebulaLayers() {
  // Subtle offset glows to avoid a single flat hotspot.
  return [
    { cx: 0.3, cy: 0.36, scale: 0.74, driftX: 0.0032, driftY: 0.0023 },
    { cx: 0.7, cy: 0.62, scale: 0.78, driftX: -0.0026, driftY: 0.0031 },
    { cx: 0.52, cy: 0.5, scale: 0.66, driftX: 0.0021, driftY: -0.0024 }
  ];
}

function buildNoisePattern() {
  if (!ctx || typeof document === "undefined") {
    return;
  }
  noiseCanvas = document.createElement("canvas");
  noiseCanvas.width = 128;
  noiseCanvas.height = 128;
  const nctx = noiseCanvas.getContext("2d");
  if (!nctx) {
    noisePattern = null;
    return;
  }
  const img = nctx.createImageData(noiseCanvas.width, noiseCanvas.height);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = Math.floor(rand(108, 148));
    const a = Math.floor(rand(4, 14));
    img.data[i] = v;
    img.data[i + 1] = v;
    img.data[i + 2] = v;
    img.data[i + 3] = a;
  }
  nctx.putImageData(img, 0, 0);
  noisePattern = ctx.createPattern(noiseCanvas, "repeat");
}

function ensureCanvas() {
  if (canvas && ctx) {
    return true;
  }
  if (typeof document === "undefined") {
    return false;
  }
  canvas = document.getElementById(STARFIELD_CANVAS_ID);
  if (!canvas) {
    canvas = document.createElement("canvas");
    canvas.id = STARFIELD_CANVAS_ID;
    document.body.prepend(canvas);
  } else if (document.body.firstChild !== canvas) {
    document.body.prepend(canvas);
  }
  canvas.style.setProperty("position", "fixed");
  canvas.style.setProperty("top", "0");
  canvas.style.setProperty("left", "0");
  canvas.style.setProperty("width", "100vw");
  canvas.style.setProperty("height", "100vh");
  canvas.style.setProperty("pointer-events", "none");
  canvas.style.setProperty("z-index", "-999");
  canvas.style.setProperty("background", "#0d0d0d", "important");
  ctx = canvas.getContext("2d");
  return !!ctx;
}

function resizeCanvas() {
  if (!canvas || !ctx) {
    return;
  }
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  cssWidth = Math.max(1, Math.floor(window.innerWidth || 1));
  cssHeight = Math.max(1, Math.floor(window.innerHeight || 1));
  canvas.width = Math.floor(cssWidth * dpr);
  canvas.height = Math.floor(cssHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  buildNoisePattern();
}

function initStars() {
  const count = Math.floor(rand(50, 81));
  stars = Array.from({ length: count }, () => createStar(cssWidth, cssHeight));
  nebulaLayers = createNebulaLayers();
}

function drawNebulaGlow(now) {
  if (!ctx) {
    return;
  }
  ctx.globalCompositeOperation = "screen";
  for (let i = 0; i < nebulaLayers.length; i += 1) {
    const layer = nebulaLayers[i];
    const driftX = Math.sin(now * layer.driftX * 0.001) * (cssWidth * 0.03);
    const driftY = Math.cos(now * layer.driftY * 0.001) * (cssHeight * 0.03);
    const centerX = (cssWidth * layer.cx) + driftX;
    const centerY = (cssHeight * layer.cy) + driftY;
    const radius = Math.max(cssWidth, cssHeight) * layer.scale;
    const gradient = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, radius);
    gradient.addColorStop(0, "rgba(20, 25, 40, 0.12)");
    gradient.addColorStop(0.5, "rgba(15, 10, 25, 0.08)");
    gradient.addColorStop(1, "rgba(13, 13, 13, 0)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, cssWidth, cssHeight);
  }
  ctx.globalCompositeOperation = "source-over";
}

function drawFilmGrain(now) {
  if (!ctx || !noisePattern) {
    return;
  }
  const offsetX = Math.floor((now * 0.005) % 128);
  const offsetY = Math.floor((now * 0.003) % 128);
  ctx.save();
  ctx.globalAlpha = 0.06;
  ctx.translate(-offsetX, -offsetY);
  ctx.fillStyle = noisePattern;
  ctx.fillRect(0, 0, cssWidth + 128, cssHeight + 128);
  ctx.restore();
}

function step(now) {
  if (!running || !ctx) {
    return;
  }
  const dt = Math.min(40, Math.max(0, now - lastTick));
  lastTick = now;
  ctx.clearRect(0, 0, cssWidth, cssHeight);
  ctx.fillStyle = "#0d0d0d";
  ctx.fillRect(0, 0, cssWidth, cssHeight);
  drawNebulaGlow(now);
  drawFilmGrain(now);

  for (let i = 0; i < stars.length; i += 1) {
    const star = stars[i];
    star.x += star.vx * dt;
    star.y += star.vy * dt;
    star.alpha += star.alphaDrift * dt;
    if (star.alpha <= star.alphaMin || star.alpha >= star.alphaMax) {
      star.alphaDrift *= -1;
      star.alpha = Math.max(star.alphaMin, Math.min(star.alphaMax, star.alpha));
    }

    if (star.x < -2) star.x = cssWidth + 2;
    if (star.x > cssWidth + 2) star.x = -2;
    if (star.y < -2) star.y = cssHeight + 2;
    if (star.y > cssHeight + 2) star.y = -2;

    if (star.r > 1.0) {
      ctx.shadowBlur = star.blur;
      ctx.shadowColor = "rgba(255, 255, 255, 0.5)";
    } else {
      ctx.shadowBlur = 0;
      ctx.shadowColor = "rgba(0, 0, 0, 0)";
    }
    ctx.fillStyle = `rgba(255, 255, 255, ${star.alpha.toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(star.x, star.y, star.r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.shadowBlur = 0;
  ctx.shadowColor = "rgba(0, 0, 0, 0)";
  rafId = requestAnimationFrame(step);
}

export function initBackgroundEffect() {
  if (running) {
    return;
  }
  if (!ensureCanvas()) {
    return;
  }
  running = true;
  resizeCanvas();
  initStars();
  resizeHandler = () => {
    resizeCanvas();
    initStars();
  };
  window.addEventListener("resize", resizeHandler);
  lastTick = performance.now();
  window.STARFIELD_ACTIVE = true;
  rafId = requestAnimationFrame(step);
}

export function destroyBackgroundEffect() {
  running = false;
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = 0;
  }
  if (resizeHandler) {
    window.removeEventListener("resize", resizeHandler);
    resizeHandler = null;
  }
}

(function autoStartBackgroundEffect() {
  if (typeof document === "undefined") {
    return;
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      initBackgroundEffect();
    }, { once: true });
    return;
  }
  initBackgroundEffect();
})();

if (typeof window !== "undefined") {
  window.STARFIELD_ACTIVE = true;
}
