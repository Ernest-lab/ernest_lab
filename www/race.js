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

const TRACK_STEPS = 54;
const LAPS = 2;
const TOTAL_DISTANCE = TRACK_STEPS * LAPS + 1; // finish line sits one step past the 108th cell — reached at cell 109

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
const SKULL_ICON_URI = "data:image/svg+xml;utf8," + encodeURIComponent(SKULL_SVG.replace(/currentColor/g, "#ff4d4d"));

/* Timing — every animation is 2x slower than a "normal" pace, per request. */
const STEP_ANIM_MS = 900;
const DICE_SPIN_TICK_MS = 140;
const DICE_SPIN_TOTAL_MS = 1100;
const DICE_SETTLE_MS = 1000;
const SHOOT_ANIM_MS = 4000;
const EXPLOSION_MS = 1000;
const NITRO_FX_MS = 1000;

/* Track geometry — a real RECTANGLE loop, drawn as a GRID_COLSxGRID_ROWS CSS
   grid where only the border cells are used: 2*cols + 2*rows - 4 must equal
   TRACK_STEPS. Going clockwise from the top-left corner: top row, right
   column, bottom row (right-to-left), left column — see cellForStep(). */
const GRID_COLS = 19, GRID_ROWS = 10; // 2*19 + 2*10 - 4 = 54 = TRACK_STEPS

function cellForStep(step) {
  const topEnd = GRID_COLS;
  const rightEnd = topEnd + (GRID_ROWS - 1);
  const bottomEnd = rightEnd + (GRID_COLS - 1);
  if (step <= topEnd) return { col: step - 1, row: 0 };
  if (step <= rightEnd) return { col: GRID_COLS - 1, row: step - topEnd };
  if (step <= bottomEnd) return { col: bottomEnd - step, row: GRID_ROWS - 1 };
  return { col: 0, row: GRID_ROWS - 1 - (step - bottomEnd) };
}
function sideOfStep(step) {
  const topEnd = GRID_COLS;
  const rightEnd = topEnd + (GRID_ROWS - 1);
  const bottomEnd = rightEnd + (GRID_COLS - 1);
  if (step <= topEnd) return "top";
  if (step <= rightEnd) return "right";
  if (step <= bottomEnd) return "bottom";
  return "left";
}
function stepFrac(step) {
  const { col, row } = cellForStep(step);
  return { xFrac: (col + 0.5) / GRID_COLS, yFrac: (row + 0.5) / GRID_ROWS };
}

let race = null; // current race state
let raceResolve = null;
let raceGeneration = 0;
function isStale(gen) { return !race || race.gen !== gen; }

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
      lootHeld: [], gunCharges: 0, pendingGun: 0, shieldCharges: 0, nitroPending: false,
      hasRespawn: false, kills: 0, eliminatedCause: null, arrivedTick: i, hasAppeared: false,
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
  if (race) {
    showToast("Гонка уже идёт — подождите, пока она закончится");
    return Promise.resolve(null);
  }
  race = createRaceState(ids);
  race.gen = ++raceGeneration;
  goToScreen("arena");
  document.getElementById("arena-log").innerHTML = "";
  trackBuilt = false;
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
  const gen = race.gen;
  while (race && race.gen === gen && alivePlayers().length > 0) {
    const currentId = nextTurnPlayer();
    if (!currentId) break;
    try {
      await playOneTurn(currentId, gen);
    } catch (err) {
      logEvent(`ОШИБКА в ходе ${playerName(currentId)}: ${err.message}`);
      console.error("playOneTurn error", err);
      // don't let one broken turn kill the whole race — force this player to
      // just keep their current spot and move on, so the loop can't silently stall
      if (!isStale(gen)) {
        race.players[currentId].arrivedTick = ++race.turnCounter;
        const btn = document.getElementById("btn-roll-dice");
        if (btn) btn.disabled = true;
      }
    }
  }
  if (!isStale(gen)) finishRace();
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

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function logEvent(text) {
  if (race) { race.log = race.log || []; race.log.push(text); }
  const el = document.getElementById("arena-log");
  if (!el) return;
  const row = document.createElement("div");
  row.className = "log-row";
  row.textContent = text;
  el.appendChild(row);
  el.scrollTop = el.scrollHeight;
}

function tryRespawnSave(player) {
  if (player.hasRespawn) {
    player.hasRespawn = false;
    logEvent(`${playerName(player.id)} применяет лут: Респаун — спасён от гибели`);
    return true;
  }
  return false;
}

async function resolveSkullHazard(currentId, player, gen) {
  const step = physicalStepOf(player);
  if (step !== race.skull.step || race.skull.resolved) return false;

  if (!race.skull.active) {
    race.skull.active = true;
    race.skull.activatorId = currentId;
    renderArena(currentId);
    await showRaceEvent(
      "Череп активирован!",
      `${playerName(currentId)} проезжает через череп — он загорается красным и теперь опасен для всех, кто проедет по нему следующим.`,
      "Понятно"
    );
    return false;
  }
  if (isStale(gen)) return true; // stop this turn from continuing on a dead race

  const { roll: roll2, survived } = await resolveHazardRoll(
    currentId, "Череп!",
    null,
    `${playerName(currentId)} проезжает через активный череп. Шанс проехать — 50 на 50.`
  );
  if (isStale(gen)) return true;
  if (survived) {
    await showRaceEvent("Череп", `${playerName(currentId)} уцелел. Череп остаётся активным для следующих игроков.`, "Продолжить", { highlight: `🎲 ${roll2}` });
    return false;
  }
  if (tryRespawnSave(player)) {
    await showRaceEvent("Череп", `${playerName(currentId)} должен был погибнуть, но респаун спасает его!`, "Продолжить", { highlight: `🎲 ${roll2}` });
    return false;
  }
  player.alive = false;
  player.eliminatedCause = { cause: "skull", causeBy: race.skull.activatorId };
  race.players[race.skull.activatorId].kills += 1;
  race.skull.resolved = true;
  logEvent(`${playerName(currentId)} погиб: уничтожен черепом (${playerName(race.skull.activatorId)})`);
  fadeOutToken(currentId);
  await showExplosion(currentId);
  if (isStale(gen)) return true;
  await showRaceEvent("Череп", `${playerName(currentId)} погиб от черепа! Очко за убийство получает ${playerName(race.skull.activatorId)}.`, "Продолжить", { highlight: `🎲 ${roll2}` });
  renderArena();
  return true;
}

async function playOneTurn(currentId, gen) {
  const player = race.players[currentId];
  player.hasAppeared = true;
  document.getElementById("btn-roll-dice").disabled = true;
  if (player.pendingGun > 0) {
    player.gunCharges += player.pendingGun;
    player.pendingGun = 0;
  }
  renderArena(currentId);
  let firedThisTurn = false; // at most one shot per turn, even with a double gun

  // mandatory shooting before the roll — at most one shot here; a second charge
  // (double gun) waits for the next opportunity rather than firing right away
  const target = !firedThisTurn && player.gunCharges > 0 ? findAdjacentTarget(currentId) : null;
  if (target) {
    firedThisTurn = true;
    await performShoot(currentId, target, gen);
    if (isStale(gen) || !player.alive) return;
  }
  if (isStale(gen)) return;

  document.getElementById("arena-turn-label").textContent = `Ход: ${playerName(currentId)}`;
  await waitForDiceRoll();
  if (isStale(gen) || !player.alive) return;

  let baseRoll = randInt(1, 6);
  await showDiceAnimation(baseRoll);
  if (isStale(gen) || !player.alive) return;

  let roll = baseRoll;
  const nitroUsed = player.nitroPending;
  if (nitroUsed) {
    roll *= 2;
    player.nitroPending = false;
    logEvent(`${playerName(currentId)} применяет лут: Нитро — ход удвоен до ${roll}`);
    await showNitroExhaust(currentId);
    if (isStale(gen)) return;
  }

  const wasLap = player.lap;
  const targetPos = Math.min(player.pos + roll, TOTAL_DISTANCE);
  while (player.pos < targetPos) {
    player.pos += 1;
    player.lap = player.pos >= TOTAL_DISTANCE ? LAPS : Math.floor((player.pos - 1) / TRACK_STEPS) + 1;
    moveTokenSmoothly(currentId);
    await sleep(STEP_ANIM_MS);
    if (isStale(gen)) return;

    if (player.pos < TOTAL_DISTANCE) {
      const died = await resolveSkullHazard(currentId, player, gen);
      if (died || isStale(gen)) return;
    }
  }
  player.arrivedTick = ++race.turnCounter;
  if (wasLap === 1 && player.lap === 2) logEvent(`${playerName(currentId)} проходит первый круг`);

  if (targetPos >= TOTAL_DISTANCE) {
    player.finished = true;
    player.finishOrder = ++race.finishCounter;
    logEvent(`${playerName(currentId)} приходит к финишу — место ${player.finishOrder}`);
    fadeOutFinishedToken(currentId);
    await sleep(800);
    if (isStale(gen)) return;
    renderArena();
    return;
  }

  // loot — only if the player actually stops on this cell
  const landedStep = physicalStepOf(player);
  if (race.lootBoard.has(landedStep)) {
    const code = race.lootBoard.get(landedStep);
    race.lootBoard.delete(landedStep);
    await grantLoot(currentId, code, gen);
    if (isStale(gen)) return;
    if (!player.alive) { renderArena(); return; }
  }

  // mandatory shooting after the move — same rule, at most one shot per whole turn
  const target2 = !firedThisTurn && player.gunCharges > 0 ? findAdjacentTarget(currentId) : null;
  if (target2) {
    firedThisTurn = true;
    await performShoot(currentId, target2, gen);
    if (isStale(gen)) return;
  }

  renderArena();
}

async function grantLoot(playerId, code, gen) {
  const player = race.players[playerId];
  if (code === "gun") { player.pendingGun += 1; player.lootHeld.push("gun"); }
  else if (code === "dgun") { player.pendingGun += 2; player.lootHeld.push("dgun"); }
  else if (code === "shield") { player.shieldCharges += 1; player.lootHeld.push("shield"); }
  else if (code === "dshield") { player.shieldCharges += 2; player.lootHeld.push("dshield"); }
  else if (code === "nitro") { player.nitroPending = true; player.lootHeld.push("nitro"); }
  else if (code === "respawn") { player.hasRespawn = true; player.lootHeld.push("respawn"); }
  else if (code === "joker") {
    logEvent(`${playerName(playerId)} подбирает лут: Джокер`);
    const { roll, survived } = await resolveHazardRoll(
      playerId, "Джокер!",
      "assets/icon-joker.png",
      `${playerName(playerId)} поднимает джокера. Шанс уцелеть — 50 на 50.`
    );
    if (isStale(gen)) return;
    if (!survived) {
      if (tryRespawnSave(player)) {
        await showRaceEvent("Джокер", `${playerName(playerId)} должен был погибнуть, но респаун спасает его!`, "Продолжить", { highlight: `🎲 ${roll}` });
      } else {
        player.alive = false;
        player.eliminatedCause = { cause: "joker", causeBy: null };
        logEvent(`${playerName(playerId)} погиб: уничтожен Джокером`);
        fadeOutToken(playerId);
        await showExplosion(playerId);
        if (isStale(gen)) return;
        await showRaceEvent("Джокер", `${playerName(playerId)} уничтожен джокером!`, "Продолжить", { highlight: `🎲 ${roll}` });
      }
    } else {
      await showRaceEvent("Джокер", `${playerName(playerId)} уцелел.`, "Продолжить", { highlight: `🎲 ${roll}` });
    }
    return;
  }
  logEvent(`${playerName(playerId)} подбирает лут: ${LOOT_NAMES[code]}`);
  await showRaceEvent("Лут", `${playerName(playerId)} подбирает:`, "Продолжить", { highlight: LOOT_NAMES[code] });
}

function showShootAnimation(shooterId, targetId) {
  const overlay = document.getElementById("shoot-overlay");
  document.getElementById("shoot-overlay-text").textContent = `${playerName(shooterId)} стреляет в ${playerName(targetId)}`;
  overlay.classList.add("active");
  return new Promise((resolve) => {
    setTimeout(() => { overlay.classList.remove("active"); resolve(); }, SHOOT_ANIM_MS);
  });
}

async function performShoot(shooterId, targetId, gen) {
  const shooter = race.players[shooterId];
  const target = race.players[targetId];

  logEvent(`${playerName(shooterId)} применяет лут: Пулемёт (стреляет в ${playerName(targetId)})`);
  await showShootAnimation(shooterId, targetId);
  if (isStale(gen)) return;

  await showRaceEvent("Стрельба обязательна", `${playerName(shooterId)} видит ${playerName(targetId)} прямо впереди и обязан открыть огонь.`, "Стрелять");
  if (isStale(gen)) return;

  const roll = randInt(1, 6);
  await showDiceAnimation(roll);
  if (isStale(gen)) return;

  let penetrates;
  if (target.shieldCharges > 0) {
    penetrates = roll === 1 || roll === 6;
    target.shieldCharges -= 1;
    logEvent(`${playerName(targetId)} применяет лут: Щит`);
  } else {
    penetrates = roll % 2 !== 0;
  }
  shooter.gunCharges -= 1;

  if (penetrates) {
    if (tryRespawnSave(target)) {
      await showRaceEvent("Стрельба", `Броня пробита, но респаун спасает ${playerName(targetId)}!`, "Продолжить", { highlight: `🎲 ${roll}` });
    } else {
      target.alive = false;
      target.eliminatedCause = { cause: "gun", causeBy: shooterId };
      shooter.kills += 1;
      logEvent(`${playerName(targetId)} погиб: уничтожен пулемётом (${playerName(shooterId)})`);
      fadeOutToken(targetId);
      await showExplosion(targetId);
      if (isStale(gen)) return;
      await showRaceEvent("Стрельба", `Броня пробита — ${playerName(targetId)} уничтожен пулемётом (${playerName(shooterId)}).`, "Продолжить", { highlight: `🎲 ${roll}` });
    }
  } else {
    await showRaceEvent("Стрельба", `${playerName(targetId)} уцелел.`, "Продолжить", { highlight: `🎲 ${roll}` });
  }
  if (isStale(gen)) return;
  renderArena(shooterId);
}

/* ---------- MODALS ---------- */
function showRaceEvent(title, text, btnLabel, opts) {
  opts = opts || {};
  return new Promise((resolve) => {
    document.getElementById("race-event-title").textContent = title;
    document.getElementById("race-event-text").textContent = text;
    const icon = document.getElementById("race-event-icon");
    if (opts.iconSrc) {
      icon.src = opts.iconSrc;
      icon.hidden = false;
      icon.style.display = "block";
      icon.className = "race-event-icon" + (opts.glow ? " icon-glow-hazard" : "");
    } else {
      icon.hidden = true;
      icon.style.display = "none";
      icon.removeAttribute("src");
    }
    const highlight = document.getElementById("race-event-highlight");
    if (opts.highlight) {
      highlight.textContent = opts.highlight;
      highlight.hidden = false;
      highlight.style.display = "block";
    } else {
      highlight.hidden = true;
      highlight.style.display = "none";
      highlight.textContent = "";
    }
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

/* ---------- POSITIONAL FX (explosion / nitro puff) on the track ---------- */
function spawnFxAtStep(step, className, durationMs) {
  const overlay = document.getElementById("arena-overlay");
  if (!overlay || !cellPx) return Promise.resolve();
  const { xFrac, yFrac } = stepFrac(step);
  const el = document.createElement("div");
  el.className = className;
  el.style.left = `${xFrac * 100}%`;
  el.style.top = `${yFrac * 100}%`;
  el.style.width = `${cellPx * 1.8}px`;
  el.style.height = `${cellPx * 1.8}px`;
  overlay.appendChild(el);
  return new Promise((resolve) => setTimeout(() => { el.remove(); resolve(); }, durationMs));
}
function showExplosion(playerId) {
  return spawnFxAtStep(physicalStepOf(race.players[playerId]), "fx-explosion", EXPLOSION_MS);
}
function showNitroExhaust(playerId) {
  return spawnFxAtStep(physicalStepOf(race.players[playerId]), "fx-nitro", NITRO_FX_MS);
}
function fadeOutToken(playerId) {
  const el = document.querySelector(`.arena-token[data-player-id="${playerId}"]`);
  if (el) el.classList.add("token-dying");
}
function fadeOutFinishedToken(playerId) {
  const el = document.querySelector(`.arena-token[data-player-id="${playerId}"]`);
  if (el) el.classList.add("token-finish-fx");
}

/* ---------- SHARED 50/50 HAZARD FLOW (Joker loot + the Skull) ---------- */
async function resolveHazardRoll(playerId, hazardTitle, iconSrc, introText) {
  await showRaceEvent(hazardTitle, introText, "Бросить кость", { iconSrc, glow: true });
  const roll = randInt(1, 6);
  await showDiceAnimation(roll);
  return { roll, survived: roll % 2 === 0 };
}

/* ---------- RENDER (rectangular grid track) ---------- */
let trackBuilt = false;
let cellPx = 0;

function sizeTrackBox() {
  const wrap = document.getElementById("arena-track-wrap");
  const box = document.getElementById("arena-track-box");
  const screen = document.getElementById("screen-arena");
  const header = screen.querySelector(".screen-header");
  const standings = document.getElementById("arena-standings");
  const footer = screen.querySelector(".arena-footer");
  const MIN_LOG_HEIGHT = 110;

  const availW = wrap.clientWidth - 8;
  const usedH = (header ? header.offsetHeight : 0) + (standings ? standings.offsetHeight : 0) + (footer ? footer.offsetHeight : 0) + MIN_LOG_HEIGHT;
  const availH = screen.clientHeight - usedH - 30; // -30 accounts for the wrap's extra bottom padding

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

function standingCompare(a, b) {
  const pa = race.players[a], pb = race.players[b];
  if (pa.finished && pb.finished) return pa.finishOrder - pb.finishOrder;
  if (pa.finished) return -1;
  if (pb.finished) return 1;
  if (pa.alive && pb.alive) return pb.pos - pa.pos;
  if (pa.alive) return -1;
  if (pb.alive) return 1;
  return pb.pos - pa.pos;
}

function renderStandings() {
  const bar = document.getElementById("arena-standings");
  bar.innerHTML = "";
  const ranked = race.order.slice().sort(standingCompare);
  ranked.forEach((id, i) => {
    const p = race.players[id];
    const card = document.createElement("div");
    card.className = "standing-card" + (!p.alive ? " eliminated" : "") + (p.finished ? " finished" : "");

    const rank = document.createElement("span");
    rank.className = "s-rank";
    rank.textContent = i + 1;

    const img = document.createElement("img");
    const pl = findPlayer(id);
    if (pl) img.src = playerPhotoUrl(pl);

    const info = document.createElement("div");
    const name = document.createElement("div");
    name.className = "s-name";
    name.textContent = playerName(id);
    const sub = document.createElement("div");
    sub.className = "s-sub";
    sub.textContent = p.finished ? `Финиш ${p.finishOrder}` : !p.alive ? "Выбыл" : `${p.pos}/${TOTAL_DISTANCE}`;
    info.appendChild(name); info.appendChild(sub);

    card.appendChild(rank); card.appendChild(img); card.appendChild(info);
    bar.appendChild(card);
  });
}

function showDiceAnimation(finalRoll) {
  const faces = ["⚀", "⚁", "⚂", "⚃", "⚄", "⚅"];
  const overlay = document.getElementById("dice-overlay");
  const face = document.getElementById("dice-face");
  overlay.classList.add("active");
  return new Promise((resolve) => {
    const start = Date.now();
    const spin = setInterval(() => {
      face.textContent = faces[Math.floor(Math.random() * 6)];
      if (Date.now() - start > DICE_SPIN_TOTAL_MS) {
        clearInterval(spin);
        face.textContent = faces[finalRoll - 1];
        setTimeout(() => { overlay.classList.remove("active"); resolve(); }, DICE_SETTLE_MS);
      }
    }, DICE_SPIN_TICK_MS);
  });
}

function moveTokenSmoothly(playerId) {
  const p = race.players[playerId];
  const step = physicalStepOf(p);
  const { xFrac, yFrac } = stepFrac(step);
  const token = document.querySelector(`.arena-token[data-player-id="${playerId}"]`);
  if (!token) { renderArena(playerId); return; }

  // count other appeared/alive/unfinished players already sitting on this exact
  // step, so the moving token offsets beside them instead of overlapping exactly
  let occupantsHere = 0;
  race.order.forEach((id) => {
    if (id === playerId) return;
    const q = race.players[id];
    if (!q.alive || q.finished || !q.hasAppeared) return;
    if (physicalStepOf(q) === step) occupantsHere++;
  });

  if (occupantsHere > 0) {
    const [ox, oy] = SIDE_OFFSET[sideOfStep(step)];
    const offsetCells = 0.62 * occupantsHere;
    token.style.left = `${xFrac * 100 + (ox * offsetCells * 100) / GRID_COLS}%`;
    token.style.top = `${yFrac * 100 + (oy * offsetCells * 100) / GRID_ROWS}%`;
  } else {
    token.style.left = `${xFrac * 100}%`;
    token.style.top = `${yFrac * 100}%`;
  }
}

function physicalStepOf(p) {
  if (p.finished) return TRACK_STEPS;
  if (p.pos <= 0) return 1;
  return ((p.pos - 1) % TRACK_STEPS) + 1;
}

const SIDE_OFFSET = { top: [0, 1], bottom: [0, -1], left: [1, 0], right: [-1, 0] };

function renderArena(currentTurnId) {
  renderStandings();
  if (!trackBuilt) buildTrackGrid();
  sizeTrackBox();
  const overlay = document.getElementById("arena-overlay");
  buildTrackMarkers(overlay);
  overlay.querySelectorAll(".arena-token").forEach((el) => el.remove());

  // group players by physical step, front-of-queue (earliest arrival) sits ON the step
  // eliminated players are excluded here — they fade out separately via fadeOutToken()
  const byStep = {};
  race.order.forEach((id) => {
    if (!race.players[id].alive || race.players[id].finished || !race.players[id].hasAppeared) return;
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
      token.dataset.playerId = id;
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
      lapEl.textContent = race.order.indexOf(id) + 1;
      token.appendChild(lapEl);

      const lootEl = document.createElement("div");
      lootEl.className = "token-loot";
      if (p.gunCharges > 0) lootEl.appendChild(lootBadge(LOOT_ICONS.gun, p.gunCharges));
      else if (p.pendingGun > 0) lootEl.appendChild(lootBadge(LOOT_ICONS.gun, p.pendingGun, true));
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

function lootBadge(src, count, pending) {
  const wrap = document.createElement("span");
  if (pending) wrap.classList.add("loot-pending");
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
  const log = race.log || [];
  const resolve = raceResolve;
  race = null; raceResolve = null;
  if (resolve) resolve({ results, log });
}

/* ---------- SINGLE RACE SCREEN ---------- */
function killWord(n) {
  const mod10 = n % 10, mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "убийство";
  if ([2, 3, 4].includes(mod10) && ![12, 13, 14].includes(mod100)) return "убийства";
  return "убийств";
}

let currentModalLog = [];

function showLogModal(log) {
  currentModalLog = log || [];
  const content = document.getElementById("race-log-content");
  content.innerHTML = "";
  if (!currentModalLog.length) {
    const empty = document.createElement("div");
    empty.className = "placeholder-hint";
    empty.textContent = "Событий не было.";
    content.appendChild(empty);
  } else {
    currentModalLog.forEach((text) => {
      const row = document.createElement("div");
      row.className = "log-row";
      row.textContent = text;
      content.appendChild(row);
    });
  }
  document.getElementById("modal-race-log").classList.add("active");
}

function initLogModal() {
  document.getElementById("btn-close-race-log").addEventListener("click", () => {
    document.getElementById("modal-race-log").classList.remove("active");
  });
}

function renderRaceResultModal(results, log) {
  currentModalLog = log || [];
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

    const main = document.createElement("div");
    main.className = "rr-main";
    const left = document.createElement("span");
    left.textContent = playerName(r.playerId);
    const right = document.createElement("span");
    right.textContent = r.eliminated ? causeLabel(r) : `${r.place}-е место · ${r.total} очк.`;
    main.appendChild(left); main.appendChild(right);
    row.appendChild(main);

    if (!r.eliminated && r.kills > 0) {
      const breakdown = document.createElement("div");
      breakdown.className = "rr-breakdown";
      breakdown.textContent = `${r.placePoints} очков + ${r.kills} ${killWord(r.kills)} = ${r.total}`;
      row.appendChild(breakdown);
    }

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
        const outcome = await runInteractiveRace(shuffle(Array.from(ids)));
        goToScreen("race");
        if (outcome) renderRaceResultModal(outcome.results, outcome.log);
      },
    });
  });

  document.getElementById("btn-close-race-result").addEventListener("click", () => {
    document.getElementById("modal-race-result").classList.remove("active");
  });
  document.getElementById("btn-view-race-log").addEventListener("click", () => {
    showLogModal(currentModalLog);
  });
}

document.addEventListener("DOMContentLoaded", () => {
  initArena();
  initSingleRaceScreen();
  initLogModal();
});
