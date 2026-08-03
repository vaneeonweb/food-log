// resolver.js — on-device food resolver.
//
// A faithful port of nutrition.py (rungs 1–4 of the PLAN.md §3.6 ladder: exact,
// normalized, alias, longest-token-overlap). No network, no model, no API key.
// The phone stores the resolved food KEY; the Mac derives macros from the same
// foods.json, so both agree on every food. Anything this cannot resolve is a
// genuinely new dish — it is captured raw and computed on the Mac later (§3.4).

const MACROS = ["calories", "protein_g", "carbs_g", "fat_g", "fiber_g"];

// Words that carry no meaning for matching ("a cup of dal").
const STOPWORDS = new Set(["of", "a", "an", "the", "some", "with", "and", "plus", "my", "one"]);

const NUMBER_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, half: 0.5, quarter: 0.25, couple: 2, few: 3,
};

// Unit spellings normalised to the keys used in foods.json. 'bowl' was retired
// as a distinct measure (2026-08) but is still parsed and mapped to cup so older
// text and casual phrasing resolve.
const UNIT_ALIASES = {
  cup: "cup", cups: "cup", c: "cup",
  bowl: "cup", bowls: "cup",
  katori: "katori", katoris: "katori",
  glass: "glass", glasses: "glass",
  mug: "mug", mugs: "mug",
  tbsp: "tbsp", tablespoon: "tbsp", tablespoons: "tbsp", tbs: "tbsp",
  tsp: "tsp", teaspoon: "tsp", teaspoons: "tsp",
  piece: "piece", pieces: "piece", pc: "piece", pcs: "piece",
  slice: "slice", slices: "slice",
  cube: "cube", cubes: "cube",
  handful: "handful", handfuls: "handful",
  medium: "medium", whole: "whole",
  g: "g", gram: "g", grams: "g", gm: "g", gms: "g",
  litre: "litre", liter: "litre", l: "litre", litres: "litre",
};

function round1(x) { return Math.round(x * 10) / 10; }

function parseFraction(str) {
  const m = str.match(/^(\d+)\/(\d+)$/);
  return m ? parseInt(m[1], 10) / parseInt(m[2], 10) : null;
}

// Handle 2, 2.5, 1/2, 1-1/2 and number words.
function parseNumber(token) {
  token = token.trim();
  if (token in NUMBER_WORDS) return NUMBER_WORDS[token];
  if (/^\d+(\.\d+)?$/.test(token)) return parseFloat(token);
  if (/^\d+\/\d+$/.test(token)) return parseFraction(token);
  const m = token.match(/^(\d+)[-\s](\d+\/\d+)$/);
  if (m) return parseInt(m[1], 10) + parseFraction(m[2]);
  return null;
}

// Pull a quantity and unit out of a phrase, wherever they sit. Order-free, so
// "1/2 cup oats", "oats 1/2 cup" and "oats: 1/2 cup" all yield (0.5, cup, oats).
// Returns { amount, unit, remainder }; missing parts come back null.
function tokenizeQuantity(text) {
  const words = text.split(/\s+/).filter(Boolean);
  let amount = null, unit = null;
  const consumed = new Set();

  for (let i = 0; i < words.length; i++) {
    const n = parseNumber(words[i]);
    if (n !== null) {
      amount = n;
      consumed.add(i);
      let j = i + 1;
      if (j < words.length && /^\d+\/\d+$/.test(words[j])) { // mixed "1 1/2"
        amount += parseFraction(words[j]);
        consumed.add(j);
        j += 1;
      }
      if (j < words.length && UNIT_ALIASES[words[j].toLowerCase()]) {
        unit = UNIT_ALIASES[words[j].toLowerCase()];
        consumed.add(j);
      }
      break;
    }
    const m = words[i].match(/^(\d+(?:\.\d+)?)([a-z]+)$/); // "100g" with no space
    if (m && UNIT_ALIASES[m[2]]) {
      amount = parseFloat(m[1]);
      unit = UNIT_ALIASES[m[2]];
      consumed.add(i);
      break;
    }
  }

  // A bare unit with no number ("handful almonds", "cup dal") means one of it.
  if (amount === null) {
    for (let i = 0; i < words.length; i++) {
      if (UNIT_ALIASES[words[i].toLowerCase()]) {
        unit = UNIT_ALIASES[words[i].toLowerCase()];
        consumed.add(i);
        break;
      }
    }
  }

  const remainder = words.filter((_, k) => !consumed.has(k)).join(" ");
  return { amount, unit, remainder };
}

// Levenshtein-ratio fuzzy match — must stay identical to nutrition.py so the
// phone and Mac resolve the same typo to the same food.
function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a || !b) return a.length || b.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] !== b[j - 1] ? 1 : 0));
    }
    prev = cur;
  }
  return prev[b.length];
}
function ratio(a, b) {
  const m = Math.max(a.length, b.length);
  return m ? 1 - levenshtein(a, b) / m : 1.0;
}

// Map every name and alias to its canonical food key. A food's own name always
// wins over another food's alias (aliases first, then names override).
function buildIndex(foods) {
  const index = {};
  for (const key in foods) {
    for (const alias of (foods[key].aliases || [])) index[alias.toLowerCase()] = key;
  }
  for (const key in foods) index[key.toLowerCase()] = key;
  return index;
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

// Find the food whose name or alias best matches the phrase. Prefers the longest
// match so "greek yogurt" beats "yogurt".
function matchFood(phrase, index) {
  const cleaned = phrase.toLowerCase().replace(/[^\w\s/.-]/g, " ").split(/\s+/)
    .filter((w) => w && !STOPWORDS.has(w)).join(" ");
  if (!cleaned) return { key: null, alias: null };
  if (cleaned in index) return { key: index[cleaned], alias: cleaned };

  let bestKey = null, bestAlias = "";
  for (const alias in index) {
    if (new RegExp("\\b" + escapeRe(alias) + "\\b").test(cleaned) && alias.length > bestAlias.length) {
      bestKey = index[alias];
      bestAlias = alias;
    }
  }
  if (bestKey !== null) return { key: bestKey, alias: bestAlias };

  // rung 3: fuzzy for typos ("ats" -> oats). Only a proposal; the user confirms.
  if (cleaned.length >= 3) {
    let bestR = 0.7;
    for (const alias in index) {
      const r = ratio(cleaned, alias);
      if (r > bestR) { bestR = r; bestKey = index[alias]; bestAlias = alias; }
    }
  }
  return { key: bestKey, alias: bestAlias || null };
}

// Compute scaled macros for a known food at a given amount + unit.
// Returns { grams, macros, unit, note } — unit may fall back to the food default.
function computeMacros(food, amount, unit) {
  const units = food.units || {};
  let note = null;
  if (unit === null || !(unit in units)) {
    const fallback = food.default_unit || "g";
    if (unit !== null && !(unit in units)) note = `unit '${unit}' not valid here — used ${fallback}`;
    unit = fallback;
  }
  if (!(unit in units)) return null;
  if (amount === null || amount === undefined) { amount = 1.0; note = (note ? note + "; " : "") + "assumed 1"; }

  const grams = amount * units[unit];
  const per100 = food.per_100g;
  const macros = {};
  for (const m of MACROS) macros[m] = round1((per100[m] || 0) * grams / 100);
  return { grams: round1(grams), macros, amount, unit, note };
}

function resolveOne(phrase, foods, index) {
  phrase = phrase.replace(/:/g, " "); // accept "oats: 1/2 cup" style input
  const { amount, unit, remainder } = tokenizeQuantity(phrase.trim());
  const { key, alias } = matchFood(remainder || phrase, index);
  if (key === null) return { item: null, problem: { text: phrase.trim(), reason: "not in food list" } };

  const food = foods[key];
  const c = computeMacros(food, amount, unit);
  if (!c) return { item: null, problem: { text: phrase.trim(), reason: `no unit conversion for ${key}` } };

  return {
    item: {
      input: phrase.trim(), food: key, matched_as: alias,
      amount: c.amount, unit: c.unit, grams: c.grams, ...c.macros,
      tags: food.tags || [], flags: food.flags || [], state: food.state || null,
      note: c.note, units: Object.keys(food.units || {}),
    },
    problem: null,
  };
}

// Split a line into individual food phrases on commas, '+', 'and', newlines.
function splitItems(text) {
  return text.split(/[,\n;]+|\s+\+\s+|\s+and\s+/).map((p) => p.trim()).filter(Boolean);
}

function resolve(text, foods) {
  const index = buildIndex(foods);
  const resolved = [], unresolved = [];
  for (const phrase of splitItems(text)) {
    const { item, problem } = resolveOne(phrase, foods, index);
    if (item) resolved.push(item); else unresolved.push(problem);
  }
  return { resolved, unresolved };
}

window.Resolver = { resolve, computeMacros, splitItems, MACROS };
