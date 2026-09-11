"use strict";
/* =========================================================
   NOTE ON SIMPLIFICATIONS (flagged for review):
   - Loot and the skull trigger when a player LANDS exactly on
     that step, not merely passes over it mid-move.
   - Mandatory shooting is checked at the start of a player's
     turn and again right after their move resolves (not on
     every intermediate step of a long move).
   These are pragmatic simplifications to get a playable
   prototype; tell me if you want exact pass-through detection
   instead and I'll tighten it.
   ========================================================= */

const TRACK_STEPS = 70;
const LAPS = 2;
const TOTAL_DISTANCE = TRACK_STEPS * LAPS;

const LOOT_ICONS = {
  gun: "assets/icon-gun.png",
  dgun: "assets/icon-gun.png",
  shield: "assets/icon-shield.png",
  dshield: "assets/icon-shield.png",
  nitro: null, // no licensed asset for nitro — shown as a small lightning glyph instead
  respawn: "assets/icon-respawn.png",
  joker: "assets/icon-joker.png",
};
const LOOT_NAMES = { gun: "Пулемёт", dgun: "Двойной пулемёт", shield: "Щит", dshield: "Двойной щит", nitro: "Нитро", respawn: "Респаун", joker: "Джокер" };
const SKULL_SVG = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C7 2 3 5.6 3 10c0 2.7 1.5 5 3.7 6.4L6 20h2.5l.6-2h1.8v2h2.2v-2h1.8l.6 2H18l-.7-3.6C19.5 15 21 12.7 21 10c0-4.4-4-8-9-8zM8.5 12A1.5 1.5 0 1 1 8.5 9a1.5 1.5 0 0 1 0 3zm7 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zM12 13l1.2 2h-2.4z"/></svg>';
const CRATE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><text x="12" y="16.5" font-size="12" font-weight="900" text-anchor="middle" fill="currentColor" stroke="none">?</text></svg>';

/* Track geometry — a real RECTANGLE loop, drawn as a 24x13 CSS grid where only
   the border cells are used (2*24 + 2*13 - 4 = 70 cells, exactly TRACK_STEPS).
   Going clockwise from the top-left corner: top row, right column, bottom row
   (right-to-left), left column — see cellForStep() for the exact mapping. */
const GRID_COLS = 24, GRID_ROWS = 13;

function cellForStep(step) {
  if (step <= 24) return { col: step - 1, row: 0 };
  if (step <= 36) return { col: GRID_COLS - 1, row: step - 24 };
  if (step <= 59) return { col: 59 - step, row: GRID_ROWS - 1 };
  return { col: 0, row: 71 - step };
}
function sideOfStep(step) {
  if (step <= 24) return "top";
  if (step <= 36) return "right";
  if (step <= 59) return "bottom";
  return "left";
}
function stepFrac(step) {
  const { col, row } = cellForStep(step);
  return { xFrac: (col + 0.5) / GRID_COLS, yFrac: (row + 0.5) / GRID_ROWS };
}

let race = null; // current race state
let raceResolve = null;

function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

/* ---------- SETUP ---------- */
function createRaceState(ids) {
  const lootPool = ["gun", "gun", "dgun", "dgun", "shield", "shield", "dshield", "dshield", "nitro", "nitro", "respawn", "joker"];
  const usableSteps = shuffle(Array.from({ length: TRACK_STEPS - 10 }, (_, i) => i + 4)); // steps 4..63
  const lootBoard = new Map();
  lootPool.forEach((code, i) => lootBoard.set(usableSteps[i], code));
  const skullStep = TRACK_STEPS - 6; // fixed, near the end of the lap, always visible

  const playersState = {};
  ids.forEach((id, i) => {
    playersState[id] = {
      id, pos: 0, lap: 1, alive: true, finished: false, finishOrder: null,
      lootHeld: [], gunCharges: 0, shieldCharges: 0, nitroPending: false,
      hasRespawn: false, kills: 0, eliminatedCause: null, arrivedTick: i,
    };
  });

  return {
    ids: ids.slice(),
    order: ids.slice(),
    turnIndex: 0,
    turnCounter: ids.length,
    finishCounter: 0,
    lootBoard,
    skull: { step: skullStep, active: false, resolved: false, activatorId: null },
    players: playersState,
  };
}

/* ---------- PUBLIC ENTRY POINT ---------- */
function runInteractiveRace(ids) {
  race = createRaceState(ids);
  goToScreen("arena");
  renderArena();
  return new Promise((resolve) => {
    raceResolve = resolve;
    runTurnLoop();
  });
}

function initArena() {
  document.getElementById("btn-arena-exit").addEventListener("click", async () => {
    const confirmed = await askConfirm("Прервать гонку? Результат не сохранится.");
    if (confirmed && raceResolve) {
      const r = raceResolve; raceResolve = null; race = null;
      r(null);
    }
  });
  window.addEventListener("resize", () => { if (race) renderArena(); });
}

/* ---------- TURN LOOP ---------- */
function alivePlayers() { return race.order.filter((id) => race.players[id].alive && !race.players[id].finished); }

async function runTurnLoop() {
  while (race && alivePlayers().length > 0) {
    const currentId = nextTurnPlayer();
    if (!currentId) break;
    await playOneTurn(currentId);
  }
  if (race) finishRace();
}

function nextTurnPlayer() {
  const n = race.order.length;
  for (let i = 0; i < n; i++) {
    const id = race.order[race.turnIndex % n];
    race.turnIndex++;
    const p = race.players[id];
    if (p.alive && !p.finished) return id;
  }
  return null;
}

function findAdjacentTarget(shooterId) {
  const shooter = race.players[shooterId];
  for (const id of race.order) {
    if (id === shooterId) continue;
    const p = race.players[id];
    if (p.alive && !p.finished && p.pos === shooter.pos + 1) return id;
  }
  return null;
}

async function playOneTurn(currentId) {
  const player = race.players[currentId];
  renderArena(currentId);

  // mandatory shooting before the roll
  let target = player.gunCharges > 0 ? findAdjacentTarget(currentId) : null;
  while (target) {
    await performShoot(currentId, target);
    if (!player.alive) return; // shouldn't happen (shooter isn't the target) but stay safe
    target = player.gunCharges > 0 ? findAdjacentTarget(currentId) : null;
  }

  document.getElementById("arena-turn-label").textContent = `Ход: ${playerName(currentId)}`;
  await waitForDiceRoll();
  if (!race || !player.alive) return;

  let roll = randInt(1, 6);
  const nitroUsed = player.nitroPending;
  if (nitroUsed) { roll *= 2; player.nitroPending = false; }
  const newPos = Math.min(player.pos + roll, TOTAL_DISTANCE);
  player.pos = newPos;
  player.lap = newPos >= TOTAL_DISTANCE ? LAPS : Math.floor((newPos - 1) / TRACK_STEPS) + 1;
  player.arrivedTick = ++race.turnCounter;

  await showRaceEvent("Кубик", `${playerName(currentId)} бросает кость: ${roll}${nitroUsed ? " (нитро ×2)" : ""}. Новая позиция: ${Math.min(newPos, TOTAL_DISTANCE)}/${TOTAL_DISTANCE}.`);

  if (newPos >= TOTAL_DISTANCE) {
    player.finished = true;
    player.finishOrder = ++race.finishCounter;
    renderArena();
    return;
  }

  const physicalStep = physicalStepOf(player);

  // loot
  if (race.lootBoard.has(physicalStep)) {
    const code = race.lootBoard.get(physicalStep);
    race.lootBoard.delete(physicalStep);
    await grantLoot(currentId, code);
    if (!player.alive) { renderArena(); return; }
  }

  // skull
  if (physicalStep === race.skull.step && !race.skull.resolved) {
    if (!race.skull.active) {
      race.skull.active = true;
      race.skull.activatorId = currentId;
      await showRaceEvent("Череп", `${playerName(currentId)} активирует череп! Он загорается красным — теперь опасен для остальных.`);
    } else {
      const roll2 = randInt(1, 6);
      if (roll2 % 2 !== 0) {
        player.alive = false;
        player.eliminatedCause = { cause: "skull", causeBy: race.skull.activatorId };
        race.players[race.skull.activatorId].kills += 1;
        race.skull.resolved = true;
        await showRaceEvent("Череп", `${playerName(currentId)} бросает кость: ${roll2} — погиб от черепа! Очко за убийство получает ${playerName(race.skull.activatorId)}.`);
        renderArena();
        return;
      } else {
        await showRaceEvent("Череп", `${playerName(currentId)} бросает кость: ${roll2} — уцелел. Череп остаётся активным.`);
      }
    }
  }

  // mandatory shooting after the move
  let target2 = player.gunCharges > 0 ? findAdjacentTarget(currentId) : null;
  while (target2) {
    await performShoot(currentId, target2);
    target2 = player.alive && player.gunCharges > 0 ? findAdjacentTarget(currentId) : null;
  }

  renderArena();
}

async function grantLoot(playerId, code) {
  const player = race.players[playerId];
  const names = {
    gun: "Пулемёт", dgun: "Двойной пулемёт", shield: "Щит", dshield: "Двойной щит",
    nitro: "Нитро", respawn: "Респаун", joker: "Джокер",
  };
  if (code === "gun") { player.gunCharges += 1; player.lootHeld.push("gun"); }
  else if (code === "dgun") { player.gunCharges += 2; player.lootHeld.push("dgun"); }
  else if (code === "shield") { player.shieldCharges += 1; player.lootHeld.push("shield"); }
  else if (code === "dshield") { player.shieldCharges += 2; player.lootHeld.push("dshield"); }
  else if (code === "nitro") { player.nitroPending = true; player.lootHeld.push("nitro"); }
  else if (code === "respawn") { player.hasRespawn = true; player.lootHeld.push("respawn"); }
  else if (code === "joker") {
    const roll = randInt(1, 6);
    if (roll % 2 !== 0) {
      player.alive = false;
      player.eliminatedCause = { cause: "joker", causeBy: null };
      await showRaceEvent("Джокер", `${playerName(playerId)} поднимает джокера и бросает кость: ${roll} — уничтожен джокером!`);
      return;
    } else {
      await showRaceEvent("Джокер", `${playerName(playerId)} поднимает джокера и бросает кость: ${roll} — уцелел.`);
      return;
    }
  }
  await showRaceEvent("Лут", `${playerName(playerId)} подбирает: ${names[code]}.`);
}

async function performShoot(shooterId, targetId) {
  const shooter = race.players[shooterId];
  const target = race.players[targetId];
  await showRaceEvent("Стрельба обязательна", `${playerName(shooterId)} видит ${playerName(targetId)} прямо впереди и обязан открыть огонь.`, "Стрелять");

  const roll = randInt(1, 6);
  let penetrates;
  if (target.shieldCharges > 0) {
    penetrates = roll === 1 || roll === 6;
    target.shieldCharges -= 1;
  } else {
    penetrates = roll % 2 !== 0;
  }
  shooter.gunCharges -= 1;

  if (penetrates) {
    target.alive = false;
    target.eliminatedCause = { cause: "gun", causeBy: shooterId };
    shooter.kills += 1;
    await showRaceEvent("Стрельба", `Кость: ${roll}. Броня пробита — ${playerName(targetId)} уничтожен пулемётом (${playerName(shooterId)}).`);
  } else {
    await showRaceEvent("Стрельба", `Кость: ${roll}. ${playerName(targetId)} уцелел.`);
  }
  renderArena();
}

/* ---------- MODALS ---------- */
function showRaceEvent(title, text, btnLabel) {
  return new Promise((resolve) => {
    document.getElementById("race-event-title").textContent = title;
    document.getElementById("race-event-text").textContent = text;
    const btn = document.getElementById("btn-race-event-ok");
    btn.textContent = btnLabel || "Продолжить";
    const overlay = document.getElementById("modal-race-event");
    overlay.classList.add("active");
    function onClick() {
      overlay.classList.remove("active");
      btn.removeEventListener("click", onClick);
      resolve();
    }
    btn.addEventListener("click", onClick);
  });
}

function waitForDiceRoll() {
  return new Promise((resolve) => {
    const btn = document.getElementById("btn-roll-dice");
    btn.disabled = false;
    function onClick() {
      btn.disabled = true;
      btn.removeEventListener("click", onClick);
      resolve();
    }
    btn.addEventListener("click", onClick);
  });
}

/* ---------- RENDER (rectangular grid track) ---------- */
let trackBuilt = false;
let cellPx = 0;

function sizeTrackBox() {
  const wrap = document.getElementById("arena-track-wrap");
  const box = document.getElementById("arena-track-box");
  const availW = wrap.clientWidth - 8;
  const availH = wrap.clientHeight - 8;
  const ratio = GRID_COLS / GRID_ROWS;
  let w = availW, h = w / ratio;
  if (h > availH) { h = availH; w = h * ratio; }
  box.style.width = `${w}px`;
  box.style.height = `${h}px`;
  cellPx = w / GRID_COLS;
}

function buildTrackGrid() {
  const box = document.getElementById("arena-track-box");
  box.innerHTML = '<div class="arena-overlay" id="arena-overlay"></div>';
  box.style.gridTemplateColumns = `repeat(${GRID_COLS}, 1fr)`;
  box.style.gridTemplateRows = `repeat(${GRID_ROWS}, 1fr)`;
  for (let step = 1; step <= TRACK_STEPS; step++) {
    const { col, row } = cellForStep(step);
    const cell = document.createElement("div");
    cell.className = "track-cell";
    cell.style.gridColumn = col + 1;
    cell.style.gridRow = row + 1;
    if (step % 5 === 0) {
      const num = document.createElement("span");
      num.className = "track-cell-num";
      num.textContent = step;
      cell.appendChild(num);
    }
    box.appendChild(cell);
  }
  trackBuilt = true;
}

function buildTrackMarkers(overlay) {
  overlay.querySelectorAll(".arena-marker, .arena-skull-marker").forEach((el) => el.remove());

  // loot stays hidden (a plain "?" crate) until a player lands on it and reveals it
  race.lootBoard.forEach((code, step) => {
    const { xFrac, yFrac } = stepFrac(step);
    const el = document.createElement("div");
    el.className = "arena-marker arena-marker-hidden";
    el.innerHTML = CRATE_SVG;
    el.style.left = `${xFrac * 100}%`;
    el.style.top = `${yFrac * 100}%`;
    el.style.width = `${cellPx * 0.55}px`;
    el.style.height = `${cellPx * 0.55}px`;
    overlay.appendChild(el);
  });

  const { xFrac, yFrac } = stepFrac(race.skull.step);
  const skullEl = document.createElement("div");
  skullEl.className = "arena-skull-marker" + (race.skull.active ? " active" : "") + (race.skull.resolved ? " resolved" : "");
  skullEl.style.left = `${xFrac * 100}%`;
  skullEl.style.top = `${yFrac * 100}%`;
  skullEl.style.width = `${cellPx * 0.6}px`;
  skullEl.style.height = `${cellPx * 0.6}px`;
  skullEl.innerHTML = SKULL_SVG;
  overlay.appendChild(skullEl);
}

function physicalStepOf(p) {
  if (p.finished) return TRACK_STEPS;
  if (p.pos <= 0) return 1;
  return ((p.pos - 1) % TRACK_STEPS) + 1;
}

const SIDE_OFFSET = { top: [0, 1], bottom: [0, -1], left: [1, 0], right: [-1, 0] };

function renderArena(currentTurnId) {
  if (!trackBuilt) buildTrackGrid();
  sizeTrackBox();
  const overlay = document.getElementById("arena-overlay");
  buildTrackMarkers(overlay);
  overlay.querySelectorAll(".arena-token").forEach((el) => el.remove());

  // group players by physical step, front-of-queue (earliest arrival) sits ON the step
  const byStep = {};
  race.order.forEach((id) => {
    const step = physicalStepOf(race.players[id]);
    (byStep[step] = byStep[step] || []).push(id);
  });

  Object.entries(byStep).forEach(([stepStr, idsHere]) => {
    const step = Number(stepStr);
    idsHere.sort((a, b) => race.players[a].arrivedTick - race.players[b].arrivedTick);
    const { xFrac, yFrac } = stepFrac(step);
    const [ox, oy] = SIDE_OFFSET[sideOfStep(step)];

    idsHere.forEach((id, queueIndex) => {
      const p = race.players[id];
      const token = document.createElement("div");
      token.className = "arena-token" + (!p.alive ? " eliminated" : "") + (id === currentTurnId ? " current-turn" : "");
      const size = queueIndex === 0 ? cellPx : cellPx * 0.8;
      token.style.width = `${size}px`;
      token.style.height = `${size}px`;
      const offsetCells = queueIndex === 0 ? 0 : 0.62 * queueIndex;
      token.style.left = `${xFrac * 100 + (ox * offsetCells * 100) / GRID_COLS}%`;
      token.style.top = `${yFrac * 100 + (oy * offsetCells * 100) / GRID_ROWS}%`;

      const img = document.createElement("img");
      const pl = findPlayer(id);
      if (pl) img.src = playerPhotoUrl(pl);
      token.appendChild(img);

      const lapEl = document.createElement("div");
      lapEl.className = "token-lap";
      lapEl.textContent = p.finished ? "🏁" : p.lap;
      token.appendChild(lapEl);

      const nameEl = document.createElement("div");
      nameEl.className = "token-name";
      nameEl.textContent = playerName(id);
      token.appendChild(nameEl);

      const lootEl = document.createElement("div");
      lootEl.className = "token-loot";
      if (p.gunCharges > 0) lootEl.appendChild(lootBadge(LOOT_ICONS.gun, p.gunCharges));
      if (p.shieldCharges > 0) lootEl.appendChild(lootBadge(LOOT_ICONS.shield, p.shieldCharges));
      if (p.nitroPending) lootEl.appendChild(textBadge("⚡"));
      if (p.hasRespawn) lootEl.appendChild(lootBadge(LOOT_ICONS.respawn, null));
      if (lootEl.childNodes.length) token.appendChild(lootEl);

      if (!p.alive && p.eliminatedCause) {
        const status = document.createElement("div");
        status.className = "token-status";
        status.textContent = causeLabel({ cause: p.eliminatedCause.cause, causeBy: p.eliminatedCause.causeBy });
        token.appendChild(status);
      } else if (p.finished) {
        const status = document.createElement("div");
        status.className = "token-status";
        status.style.color = "var(--accent)";
        status.textContent = `Место ${p.finishOrder}`;
        token.appendChild(status);
      }

      overlay.appendChild(token);
    });
  });
}

function lootBadge(src, count) {
  const wrap = document.createElement("span");
  const img = document.createElement("img");
  img.src = src;
  wrap.appendChild(img);
  if (count) wrap.appendChild(document.createTextNode(count));
  return wrap;
}
function textBadge(text) { const s = document.createElement("span"); s.textContent = text; return s; }

/* ---------- FINISH ---------- */
function finishRace() {
  const results = race.order.map((id) => {
    const p = race.players[id];
    if (p.finished) {
      const place = p.finishOrder;
      const placePoints = Math.max(9 - place, 0);
      return { playerId: id, eliminated: false, place, placePoints, kills: p.kills, total: placePoints + p.kills };
    }
    return { playerId: id, eliminated: true, cause: p.eliminatedCause.cause, causeBy: p.eliminatedCause.causeBy, kills: p.kills, total: p.kills };
  });
  const resolve = raceResolve;
  race = null; raceResolve = null;
  if (resolve) resolve(results);
}

/* ---------- SINGLE RACE SCREEN ---------- */
function renderRaceResultModal(results) {
  const list = document.getElementById("race-result-list");
  list.innerHTML = "";
  const sorted = results.slice().sort((a, b) => {
    const pa = a.eliminated ? 999 : a.place;
    const pb = b.eliminated ? 999 : b.place;
    return pa - pb;
  });
  sorted.forEach((r) => {
    const row = document.createElement("div");
    row.className = "race-result-row" + (r.eliminated ? " eliminated" : "");
    const left = document.createElement("span");
    left.textContent = playerName(r.playerId);
    const right = document.createElement("span");
    right.textContent = r.eliminated ? causeLabel(r) : `${r.place}-е место · ${r.total} очк.`;
    row.appendChild(left); row.appendChild(right);
    list.appendChild(row);
  });
  document.getElementById("modal-race-result").classList.add("active");
}

function initSingleRaceScreen() {
  document.getElementById("btn-assemble-race").addEventListener("click", () => {
    openPlayerPicker({
      title: "Выберите от 2 до 8 игроков",
      initialIds: new Set(),
      min: 2, max: 8,
      onConfirm: async (ids) => {
        const results = await runInteractiveRace(Array.from(ids));
        goToScreen("race");
        if (results) renderRaceResultModal(results);
      },
    });
  });

  document.getElementById("btn-close-race-result").addEventListener("click", () => {
    document.getElementById("modal-race-result").classList.remove("active");
  });
}

document.addEventListener("DOMContentLoaded", () => {
  initArena();
  initSingleRaceScreen();
});
