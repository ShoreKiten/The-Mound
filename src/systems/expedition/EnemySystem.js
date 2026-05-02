
/**
 * Deep-space encounter definitions and helpers.
 * "Fuel" in escape penalties maps to fusion fuel: `resources.helium3`.
 */

const ENCOUNTER_THRESHOLD_KM = 100000;
const ENCOUNTER_INTERVAL_KM = 3000;
const TIER_SPAN_KM = 8000;
const MAX_TIER = 12;
const ESCAPE_ALLOY_FRACTION = 0.15;
const ESCAPE_FUEL_FRACTION = 0.15;
const ESCAPE_MATERIAL_FRACTION = 0.15;

/**
 * Ten archetypes (names / light stat flavor). Combat numbers scale with encounter tier.
 * @type {ReadonlyArray<{
 *   id: string,
 *   name: string,
 *   hpScale: number,
 *   attackScale: number,
 *   accuracyBonus: number
 * }>}
 */
export const ENEMY_DATABASE = Object.freeze([
  { id: "remnant_drone", name: "虚空浮游幼体", hpScale: 0.95, attackScale: 1.05, accuracyBonus: 0.02 },
  { id: "swarm_interceptor", name: "噬能寄生群", hpScale: 0.9, attackScale: 1.12, accuracyBonus: 0.04 },
  { id: "gravity_well_anchor", name: "深空定居肉瘤", hpScale: 1.25, attackScale: 0.92, accuracyBonus: -0.02 },
  { id: "kessler_cluster", name: "硅基骨骸集群", hpScale: 1.1, attackScale: 1.0, accuracyBonus: 0.01 },
  { id: "magnetic_lens_hunter", name: "电磁感应水母", hpScale: 1.0, attackScale: 1.08, accuracyBonus: 0.03 },
  { id: "solar_forager_node", name: "恒星虹吸触肢", hpScale: 1.05, attackScale: 0.98, accuracyBonus: 0.0 },
  { id: "oort_relay_specter", name: "奥尔特云潜伏者", hpScale: 0.92, attackScale: 1.1, accuracyBonus: 0.05 },
  { id: "microsingularity_probe", name: "坍缩态单细胞", hpScale: 0.88, attackScale: 1.15, accuracyBonus: 0.03 },
  { id: "ramscoop_leviathan", name: "冲压式虚空巨兽", hpScale: 1.35, attackScale: 0.88, accuracyBonus: -0.03 },
  { id: "dyson_swarm_splinter", name: "失控演化组织", hpScale: 1.15, attackScale: 1.02, accuracyBonus: 0.02 }
]);

/**
 * Boss: 虚空演化终点：欧米伽 (Evolutionary Apex: OMEGA)
 * Spawns at 200,000 km. Multi-phase fight with enrage, singularity drain,
 * bio-pulse, and Void Nova countdown mechanics.
 */
export const BOSS_DATA = Object.freeze({
  id: "omega_boss",
  name: "虚空演化终点：欧米伽",
  tier: 13,
  hp: 6000,
  attack: 75,
  accuracy: 0.88
});

/**
 * Boss phase HP thresholds relative to max HP.
 * Phase 1: 100%–60% | Phase 2: 60%–20% | Phase 3: 20%–0%
 */
export function computeBossHPThresholds(maxHp) {
  const m = Math.max(1, Number(maxHp) || 6000);
  return {
    phase1End: Math.round(m * 0.60),
    phase2End: Math.round(m * 0.20)
  };
}

/**
 * Create the Omega boss encounter object.
 * @returns {{ id: string, name: string, tier: number, hp: number, attack: number, accuracy: number }}
 */
export function createOmegaEncounter() {
  return {
    id: BOSS_DATA.id,
    name: BOSS_DATA.name,
    tier: BOSS_DATA.tier,
    hp: BOSS_DATA.hp,
    attack: BOSS_DATA.attack,
    accuracy: BOSS_DATA.accuracy
  };
}

function clampTier(level) {
  const n = Math.floor(Number(level) || 1);
  return Math.min(MAX_TIER, Math.max(1, n));
}

/**
 * Encounter tier used for scaling (1–10).
 * Level = floor((distance - 100000) / 10000) + 1, capped at 10.
 * @param {number} distanceKm
 * @returns {number}
 */
export function encounterTierFromDistance(distanceKm) {
  const d = Number(distanceKm) || 0;
  if (d < ENCOUNTER_THRESHOLD_KM) {
    return 1;
  }
  return clampTier(Math.floor((d - ENCOUNTER_THRESHOLD_KM) / TIER_SPAN_KM) + 1);
}

/**
 * Core scaling: HP = 245 * 1.25^lvl, Attack = 18 * 1.20^lvl (lvl = encounter tier 1–12).
 * Enemies are bullet-sponges that hit like trucks — survival curve demands high ammo / fragile armor.
 * Accuracy: baseline curve with per-archetype bonus, clamped to [0.35, 0.95].
 * @param {number} tier
 * @param {{ hpScale: number, attackScale: number, accuracyBonus: number }} archetype
 */
export function computeEnemyCombatStats(tier, archetype) {
  const lvl = clampTier(tier);
  const hp = 245 * 1.25 ** lvl * archetype.hpScale;
  const attack = 18 * 1.20 ** lvl * archetype.attackScale;
  const accuracy = Math.min(
    0.95,
    Math.max(0.35, 0.55 + 0.030 * (lvl - 1) + archetype.accuracyBonus)
  );
  return {
    tier: lvl,
    hp: Math.round(hp * 100) / 100,
    attack: Math.round(attack * 100) / 100,
    accuracy: Math.round(accuracy * 1000) / 1000
  };
}

function pickRandomArchetype() {
  const idx = Math.floor(Math.random() * ENEMY_DATABASE.length);
  return ENEMY_DATABASE[idx];
}

/**
 * When `distance >= 100000`, returns a resolved enemy for the current tier; otherwise `null`.
 * Boundary gating is handled by the combat watchdog in engine-runtime.
 * @param {number} distanceKm
 * @returns {null | {
 *   id: string,
 *   name: string,
 *   tier: number,
 *   hp: number,
 *   attack: number,
 *   accuracy: number
 * }}
 */
export function generateEncounter(distanceKm) {
  const d = Math.floor(Number(distanceKm) || 0);
  if (d < ENCOUNTER_THRESHOLD_KM) {
    return null;
  }
  const tier = encounterTierFromDistance(d);
  const archetype = pickRandomArchetype();
  const stats = computeEnemyCombatStats(tier, archetype);
  const enemy = {
    id: archetype.id,
    name: archetype.name,
    tier: stats.tier,
    hp: stats.hp,
    attack: stats.attack,
    accuracy: stats.accuracy
  };
  if (d >= 160000) {
    console.log(`[BALANCE_LOG] 警告：检测到极高能级生物反应，装甲厚度异常。Enemy: ${enemy.name}, HP: ${enemy.hp.toFixed(1)}, ATK: ${enemy.attack.toFixed(1)}, Tier: ${enemy.tier}, Distance: ${d}km`);
  } else {
    console.log(`[BALANCE_LOG] Enemy: ${enemy.name}, HP: ${enemy.hp.toFixed(1)}, ATK: ${enemy.attack.toFixed(1)}, Tier: ${enemy.tier}, Distance: ${d}km`);
  }
  return enemy;
}

/**
 * Resource loss if the player flees an encounter (15% of all material resources).
 * @param {object} state
 * @returns {{ alloyLoss: number, scrapLoss: number, dustLoss: number, sealantLoss: number, fuelLoss: number, totalLoss: number, alloyAfter: number, scrapAfter: number, dustAfter: number, sealantAfter: number, fuelAfter: number }}
 */
export function calculateEscapePenalty(state) {
  const r = (state && state.resources) || {};
  const alloy = Math.max(0, Number(r.alloy || 0));
  const scrap = Math.max(0, Number(r.scrapMetal || 0));
  const dust = Math.max(0, Number(r.stardust || 0));
  const sealant = Math.max(0, Number(r.sealant || 0));
  const fuel = Math.max(0, Number(r.helium3 || 0));
  const alloyLoss = Math.floor(alloy * ESCAPE_ALLOY_FRACTION);
  const scrapLoss = Math.floor(scrap * ESCAPE_MATERIAL_FRACTION);
  const dustLoss = Math.floor(dust * ESCAPE_MATERIAL_FRACTION);
  const sealantLoss = Math.floor(sealant * ESCAPE_MATERIAL_FRACTION);
  const fuelLoss = Math.floor(fuel * ESCAPE_FUEL_FRACTION);
  const totalLoss = alloyLoss + scrapLoss + dustLoss + sealantLoss + fuelLoss;
  return {
    alloyLoss,
    scrapLoss,
    dustLoss,
    sealantLoss,
    fuelLoss,
    totalLoss,
    alloyAfter: Math.max(0, alloy - alloyLoss),
    scrapAfter: Math.max(0, scrap - scrapLoss),
    dustAfter: Math.max(0, dust - dustLoss),
    sealantAfter: Math.max(0, sealant - sealantLoss),
    fuelAfter: Math.max(0, fuel - fuelLoss)
  };
}
