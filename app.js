// app.js — capture UI controller.
//
// Flow (PLAN.md §Phase 3): open → describe a meal → app proposes food + portion
// → you confirm or CORRECT the portion → written to IndexedDB → running daily
// total shown. New dishes the resolver can't place are captured raw and flagged
// "computed on your Mac"; they never block logging.

let FOODS = {};
let TARGETS = {};
let proposals = []; // current unconfirmed cards: {kind:'known'|'new', ...}

const MACRO_META = [
  ["calories", "Calories", "kcal"],
  ["protein_g", "Protein", "g"],
  ["carbs_g", "Carbs", "g"],
  ["fat_g", "Fat", "g"],
  ["fiber_g", "Fiber", "g"],
];

const MEAL_LABELS = {
  wake_up: "Wake-up", breakfast: "Breakfast", mid_morning: "Mid-morning",
  lunch: "Lunch", mid_afternoon: "Mid-afternoon", dinner: "Dinner", other: "Other",
};

const $ = (sel) => document.querySelector(sel);

async function boot() {
  [FOODS, TARGETS] = await Promise.all([
    fetch("./data/foods.json").then((r) => r.json()).then((d) => d.foods),
    fetch("./data/targets.json").then((r) => r.json()),
  ]);
  renderMealChips();
  $("#meal-input").value = "";
  wireEvents();
  await refreshToday();
  registerSW();
  updateSyncStatus();
  window.addEventListener("online", trySync);
  trySync(); // flush anything queued from a previous offline session
  syncFavorites(); // load favorites from Drive (recompute if >4 days old)
}

// ---- Drive sync ----------------------------------------------------------

function updateSyncStatus() {
  const btn = $("#sync-btn");
  if (!btn) return;
  const dirty = window.Store.getDirtyDates().length;
  if (!window.Drive || !window.Drive.isConnected()) {
    btn.textContent = "Connect Drive";
    btn.classList.remove("conn--ok");
  } else if (!navigator.onLine) {
    btn.textContent = `${dirty} to sync (offline)`;
    btn.classList.remove("conn--ok");
  } else if (dirty > 0) {
    btn.textContent = `${dirty} to sync…`;
    btn.classList.remove("conn--ok");
  } else {
    btn.textContent = "Synced ✓";
    btn.classList.add("conn--ok");
  }
}

async function trySync() {
  if (!window.Drive || !window.Drive.isConnected() || !navigator.onLine) {
    updateSyncStatus();
    return;
  }
  updateSyncStatus();
  try {
    await window.Drive.sync();
  } catch (e) {
    console.warn("Drive sync failed (will retry):", e);
  }
  updateSyncStatus();
}

async function onSyncButton() {
  const btn = $("#sync-btn");
  btn.textContent = "Connecting…";
  // Open the Google sign-in immediately, in the same tick as your tap — any
  // async work first (a silent-token attempt) would spend the "user gesture"
  // and the browser would then block the popup (popup_failed_to_open).
  try {
    await window.Drive.connect(); // requests token within the gesture, then pushes the queue
  } catch (e) {
    alert("Couldn't sync to Google Drive — please try again.\n" + (e.message || e));
  }
  updateSyncStatus();
  syncFavorites();
}

// ---- meal selector -------------------------------------------------------

function guessMeal() {
  const h = new Date().getHours();
  if (h < 7) return "wake_up";
  if (h < 10) return "breakfast";
  if (h < 12) return "mid_morning";
  if (h < 15) return "lunch";
  if (h < 18) return "mid_afternoon";
  return "dinner";
}

let selectedMeal = null;
function renderMealChips() {
  selectedMeal = selectedMeal || guessMeal();
  const wrap = $("#meal-chips");
  wrap.innerHTML = "";
  for (const meal of TARGETS.meals) {
    const b = document.createElement("button");
    b.className = "chip" + (meal === selectedMeal ? " chip--on" : "");
    b.textContent = MEAL_LABELS[meal] || meal;
    b.onclick = () => { selectedMeal = meal; renderMealChips(); };
    wrap.appendChild(b);
  }
}

// ---- favorites -----------------------------------------------------------
// Your most-logged foods, each at the portion you most often use. The list is
// recomputed from your own history at most every 4 days, stored in YOUR Drive
// (food_log/favorites.json), and loaded from there — so it is portable across
// your devices and never shared with anyone else's account. Tap one to drop it
// into the entry at that portion (still confirmed, still adjustable).

const FAV_INTERVAL_MS = 4 * 24 * 60 * 60 * 1000; // 4 days
let currentFavorites = [];

function cacheFavorites(payload) {
  try { localStorage.setItem("favoritesCache", JSON.stringify(payload)); } catch (e) {}
}
function loadCachedFavorites() {
  try { return (JSON.parse(localStorage.getItem("favoritesCache")) || {}).favorites || []; }
  catch (e) { return []; }
}

// Load favorites from Drive; recompute + push only if the stored list is missing
// or older than 4 days, and only from a device that actually has history (so a
// freshly-signed-in device can't overwrite your list with an empty one).
async function syncFavorites() {
  if (!window.Drive || !window.Drive.isConnected() || !navigator.onLine) {
    currentFavorites = loadCachedFavorites();
    renderFavorites();
    return;
  }
  let remote = null;
  try { remote = await window.Drive.readFavorites(); } catch (e) { console.warn("favorites read failed", e); }
  if (remote && Array.isArray(remote.favorites)) {
    currentFavorites = remote.favorites;
    cacheFavorites(remote);
  }
  const last = remote && remote.computed_at;
  const stale = !last || (Date.now() - new Date(last).getTime()) >= FAV_INTERVAL_MS;
  if (stale) {
    const all = await window.Store.getAllEntries();
    const hasHistory = all.filter((e) => e.resolved && e.food).length >= 5;
    if (hasHistory) {
      const computed = await computeFavorites(15);
      const payload = { computed_at: new Date().toISOString(), favorites: computed };
      try { await window.Drive.writeFavorites(payload); } catch (e) { console.warn("favorites write failed", e); }
      currentFavorites = computed;
      cacheFavorites(payload);
    }
  }
  renderFavorites();
}

async function computeFavorites(limit = 15) {
  const all = await window.Store.getAllEntries();
  const byFood = {}; // food -> { count, portions: {"amount|unit": n} }
  for (const e of all) {
    if (!e.resolved || !e.food || !FOODS[e.food]) continue;
    const f = byFood[e.food] || (byFood[e.food] = { count: 0, portions: {} });
    f.count += 1;
    const pk = `${e.amount}|${e.unit}`;
    f.portions[pk] = (f.portions[pk] || 0) + 1;
  }
  const favs = Object.entries(byFood).map(([food, d]) => {
    let best = null, bestN = -1;
    for (const [pk, n] of Object.entries(d.portions)) {
      if (n > bestN) { bestN = n; best = pk; }
    }
    const [amount, unit] = best.split("|");
    return { food, count: d.count, amount: parseFloat(amount), unit };
  });
  favs.sort((a, b) => b.count - a.count);
  return favs.slice(0, limit);
}

function renderFavorites() {
  const section = $("#favorites-section");
  const box = $("#favorites");
  box.innerHTML = "";
  for (const fav of (currentFavorites || [])) {
    if (!FOODS[fav.food]) continue; // food no longer in the list
    const chip = document.createElement("button");
    chip.className = "fav";
    chip.textContent = `${fmtAmt(fav.amount)} ${fav.unit} ${fav.food}`;
    chip.onclick = () => addFavorite(fav);
    box.appendChild(chip);
  }
  section.hidden = box.children.length === 0;
}

function addFavorite(fav) {
  const food = FOODS[fav.food];
  if (!food) return;
  proposals.push({
    kind: "known", key: fav.food, label: fav.food,
    amount: fav.amount, unit: fav.unit, units: Object.keys(food.units),
    note: null, raw: `${fav.amount} ${fav.unit} ${fav.food}`,
  });
  renderProposals();
}

// ---- parsing → proposals -------------------------------------------------

function parseInput() {
  const text = $("#meal-input").value.trim();
  if (!text) return;
  const { resolved, unresolved } = window.Resolver.resolve(text, FOODS);
  proposals = [];
  for (const r of resolved) {
    proposals.push({ kind: "known", key: r.food, label: r.food, amount: r.amount,
      unit: r.unit, units: r.units, note: r.note, raw: r.input });
  }
  for (const u of unresolved) {
    // Unknown dish: capture the wording verbatim. The Mac resolves both the
    // food AND the portion later (§3.4), so no meaningless cup stepper here.
    proposals.push({ kind: "new", label: u.text, text: u.text });
  }
  renderProposals();
}

function macrosFor(p) {
  if (p.kind !== "known") return null;
  const c = window.Resolver.computeMacros(FOODS[p.key], p.amount, p.unit);
  return c ? c.macros : null;
}

function renderProposals() {
  const box = $("#proposals");
  box.innerHTML = "";
  if (!proposals.length) { $("#confirm-bar").hidden = true; return; }

  proposals.forEach((p, i) => {
    const card = document.createElement("div");
    card.className = "card" + (p.kind === "new" ? " card--new" : "");

    const head = document.createElement("div");
    head.className = "card__head";
    head.innerHTML = `<span class="card__name">${escapeHtml(p.label)}</span>`;
    const del = document.createElement("button");
    del.className = "card__x"; del.textContent = "✕";
    del.onclick = () => { proposals.splice(i, 1); renderProposals(); };
    head.appendChild(del);
    card.appendChild(head);

    if (p.kind === "known") {
      // portion row — the weak link, so it is the easiest thing to adjust (§3.3)
      const portion = document.createElement("div");
      portion.className = "portion";
      const quick = [0.5, 1, 1.5, 2];
      const qwrap = document.createElement("div");
      qwrap.className = "portion__quick";
      for (const q of quick) {
        const qb = document.createElement("button");
        qb.className = "pill" + (Math.abs(p.amount - q) < 1e-9 ? " pill--on" : "");
        qb.textContent = q === 0.5 ? "½" : q === 1.5 ? "1½" : String(q);
        qb.onclick = () => { p.amount = q; renderProposals(); };
        qwrap.appendChild(qb);
      }
      const minus = document.createElement("button");
      minus.className = "step"; minus.textContent = "−";
      minus.onclick = () => { p.amount = Math.max(0, round2(p.amount - 0.25)); renderProposals(); };
      const amt = document.createElement("span");
      amt.className = "portion__amt"; amt.textContent = fmtAmt(p.amount);
      const plus = document.createElement("button");
      plus.className = "step"; plus.textContent = "+";
      plus.onclick = () => { p.amount = round2(p.amount + 0.25); renderProposals(); };

      const unitSel = document.createElement("select");
      unitSel.className = "portion__unit";
      for (const u of p.units) {
        const o = document.createElement("option");
        o.value = u; o.textContent = u; if (u === p.unit) o.selected = true;
        unitSel.appendChild(o);
      }
      unitSel.onchange = () => { p.unit = unitSel.value; renderProposals(); };

      portion.append(qwrap, minus, amt, plus, unitSel);
      card.appendChild(portion);

      const m = macrosFor(p);
      const macro = document.createElement("div");
      macro.className = "card__macros";
      macro.textContent = `${Math.round(m.calories)} kcal · P ${m.protein_g} · C ${m.carbs_g} · F ${m.fat_g} · Fib ${m.fiber_g}`;
      card.appendChild(macro);
      if (p.note) {
        const n = document.createElement("div");
        n.className = "card__note"; n.textContent = p.note;
        card.appendChild(n);
      }
    } else {
      // New dish: an editable free-text field, captured verbatim for the Mac.
      const edit = document.createElement("input");
      edit.type = "text"; edit.className = "card__edit"; edit.value = p.text;
      edit.oninput = () => { p.text = edit.value; };
      card.appendChild(edit);
      const n = document.createElement("div");
      n.className = "card__note card__note--new";
      n.textContent = "New dish — macros will be computed on your Mac and added to your food list.";
      card.appendChild(n);
    }
    box.appendChild(card);
  });

  $("#confirm-bar").hidden = false;
  $("#confirm-count").textContent = `${proposals.length} item${proposals.length === 1 ? "" : "s"}`;
}

// ---- confirm → store -----------------------------------------------------

async function confirmAll() {
  const now = new Date();
  const date = ymd(now);
  const time = hm(now);
  for (const p of proposals) {
    const rand = Math.random().toString(16).slice(2, 6);
    const base = {
      id: `${date.replace(/-/g, "")}-${time.replace(":", "")}-${rand}`,
      logged_at: now.toISOString().slice(0, 19),
      date, time, meal: selectedMeal,
      source: "text", synced: false,
    };
    if (p.kind === "known") {
      const food = FOODS[p.key];
      const c = window.Resolver.computeMacros(food, p.amount, p.unit);
      Object.assign(base, {
        food: p.key, raw_text: p.raw, amount: p.amount, unit: p.unit,
        resolved: true, confidence: "high", state: food.state || null,
        tags: food.tags || [], flags: food.flags || [], ...c.macros,
      });
    } else {
      Object.assign(base, {
        food: null, raw_text: p.text.trim(), amount: null, unit: null,
        resolved: false, confidence: "pending", state: null,
        tags: [], flags: [],
        calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0,
      });
    }
    if (base.raw_text) await window.Store.addEntry(base);
  }
  proposals = [];
  $("#meal-input").value = "";
  renderProposals();
  await refreshToday();
  trySync();
}

// ---- today panel ---------------------------------------------------------

async function refreshToday() {
  const date = ymd(new Date());
  const entries = await window.Store.getEntriesByDate(date);
  entries.sort((a, b) => (a.time || "").localeCompare(b.time || ""));

  const totals = { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0 };
  let pending = 0;
  for (const e of entries) {
    for (const k in totals) totals[k] += Number(e[k] || 0);
    if (!e.resolved) pending += 1;
  }

  renderTotals(totals, pending);
  renderEntryList(entries);
}

function renderTotals(totals, pending) {
  const box = $("#totals");
  box.innerHTML = "";
  const dt = TARGETS.daily_targets;
  for (const [key, label, unit] of MACRO_META) {
    const got = round1(totals[key]);
    const target = dt[key];
    const pct = target ? Math.min(100, (got / target) * 100) : 0;
    const over = target && got > target * 1.001;
    const row = document.createElement("div");
    row.className = "trow";
    row.innerHTML = `
      <div class="trow__top">
        <span>${label}</span>
        <span class="trow__num">${fmtNum(got)} / ${fmtNum(target)} ${unit}</span>
      </div>
      <div class="bar"><div class="bar__fill${over ? " bar__fill--over" : ""}" style="width:${pct}%"></div></div>`;
    box.appendChild(row);
  }
  $("#pending-note").hidden = pending === 0;
  if (pending) $("#pending-note").textContent =
    `${pending} new dish${pending === 1 ? "" : "es"} pending — total will fill in after your Mac computes ${pending === 1 ? "it" : "them"}.`;
}

function renderEntryList(entries) {
  const box = $("#entries");
  box.innerHTML = "";
  if (!entries.length) {
    box.innerHTML = `<p class="empty">Nothing logged yet today.</p>`;
    return;
  }
  let currentMeal = null;
  for (const e of entries) {
    if (e.meal !== currentMeal) {
      currentMeal = e.meal;
      const h = document.createElement("div");
      h.className = "meal-head";
      h.textContent = MEAL_LABELS[e.meal] || e.meal;
      box.appendChild(h);
    }
    const row = document.createElement("div");
    row.className = "entry";
    const label = e.resolved
      ? `${escapeHtml(fmtAmt(e.amount))} ${escapeHtml(e.unit)} ${escapeHtml(e.food)}`
      : `${escapeHtml(e.raw_text)} <span class='badge'>new</span>`;
    const macros = e.resolved
      ? `${Math.round(e.calories)} kcal · P ${e.protein_g} · C ${e.carbs_g} · F ${e.fat_g}`
      : `pending — computed on Mac`;
    row.innerHTML = `
      <div class="entry__main">
        <span class="entry__name">${label}</span>
        <span class="entry__macros">${macros}</span>
      </div>`;
    const del = document.createElement("button");
    del.className = "entry__x"; del.textContent = "✕";
    del.onclick = async () => { await window.Store.deleteEntry(e.id, e.date); await refreshToday(); trySync(); };
    row.appendChild(del);
    box.appendChild(row);
  }
}

// ---- helpers -------------------------------------------------------------

function wireEvents() {
  $("#add-btn").onclick = parseInput;
  $("#confirm-btn").onclick = confirmAll;
  $("#sync-btn").onclick = onSyncButton;
  $("#meal-input").addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") parseInput();
  });
}

function registerSW() {
  if (!("serviceWorker" in navigator)) return;
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register("./sw.js")
    .then((reg) => { reg.update(); }) // check for a newer version each launch
    .catch(() => {});
  // When a new service worker takes over (it self-activates via skipWaiting),
  // reload once so the page runs the new code automatically — no manual
  // double-relaunch needed. Skip on the very first install (no prior controller).
  let refreshing = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (refreshing || !hadController) return;
    refreshing = true;
    window.location.reload();
  });
}

function ymd(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function hm(d) { return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }
function pad(n) { return String(n).padStart(2, "0"); }
function round1(x) { return Math.round(x * 10) / 10; }
function round2(x) { return Math.round(x * 100) / 100; }
function fmtAmt(a) { return a === 0.5 ? "½" : a === 1.5 ? "1½" : a === 0.25 ? "¼" : a === 0.75 ? "¾" : String(a); }
function fmtNum(n) { return Number.isInteger(n) ? String(n) : n.toFixed(1); }
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

boot();
