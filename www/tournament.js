"use strict";
/* Tournament bracket: creation, group draw (random 48->6 groups of 8),
   round advancement (round1 stage1/stage2 -> top24 -> round2 -> top8 ->
   round3), standings, and podium. Actual races run via runInteractiveRace()
   in race.js; this file just wires results back into the bracket. */

let tournaments = [];
let currentTournamentId = null;
let tournamentPickedIds = new Set();

/* ---------- helpers ---------- */
function findPlayer(id) { return players.find((p) => p.id === id); }
function playerName(id) { const p = findPlayer(id); return p ? p.name : "???"; }

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/* Draw a second grouping of the same ids that shares as few groupmates as
   possible with a reference grouping — tries a handful of random shuffles
   and keeps the one with the lowest total overlap. */
function countOverlap(referenceGroups, candidateGroups) {
  const groupOf = {};
  referenceGroups.forEach((g, gi) => g.forEach((id) => { groupOf[id] = gi; }));
  let overlap = 0;
  candidateGroups.forEach((g) => {
    for (let i = 0; i < g.length; i++) {
      for (let j = i + 1; j < g.length; j++) {
        if (groupOf[g[i]] === groupOf[g[j]]) overlap++;
      }
    }
  });
  return overlap;
}
function drawMinimalOverlapGroups(allIds, groupSize, referenceGroups, attempts) {
  let best = null, bestScore = Infinity;
  for (let a = 0; a < (attempts || 25); a++) {
    const groups = chunk(shuffle(allIds), groupSize);
    const score = countOverlap(referenceGroups, groups);
    if (score < bestScore) { bestScore = score; best = groups; }
    if (bestScore === 0) break;
  }
  return best;
}

/* ---------- shared helpers ---------- */

function causeLabel(r) {
  if (r.cause === "joker") return "уничтожен Джокером";
  if (r.cause === "skull") return `уничтожен черепом (${playerName(r.causeBy)})`;
  return `уничтожен пулемётом (${playerName(r.causeBy)})`;
}

/* ---------- TOURNAMENT LIST ---------- */
function renderTournamentList() {
  const grid = document.getElementById("tournament-list-view");
  const emptyHint = document.getElementById("tournaments-empty-hint");
  grid.querySelectorAll(".tournament-card").forEach((el) => el.remove());
  emptyHint.style.display = tournaments.length ? "none" : "block";

  for (const t of tournaments) {
    const card = document.createElement("div");
    card.className = "tournament-card";
    const statusLabel = {
      round1: "Тур 1 в процессе",
      round2: "Тур 2 в процессе",
      round3: "Тур 3 в процессе",
      complete: "Завершён",
    }[t.status] || t.status;
    card.innerHTML = `<div><div class="t-name"></div><div class="t-status">${statusLabel}</div></div><button class="card-remove" aria-label="Удалить">✕</button>`;
    card.querySelector(".t-name").textContent = t.name;
    card.addEventListener("click", () => openTournamentBracket(t.id));
    card.querySelector(".card-remove").addEventListener("click", async (e) => {
      e.stopPropagation();
      const confirmed = await askConfirm(`Удалить турнир «${t.name}»? Это действие необратимо.`);
      if (!confirmed) return;
      tournaments = tournaments.filter((x) => x.id !== t.id);
      await dbDelete("tournaments", t.id);
      renderTournamentList();
    });
    grid.appendChild(card);
  }
}

function showTournamentListView() {
  currentTournamentId = null;
  document.getElementById("tournament-list-view").hidden = false;
  document.getElementById("tournament-bracket-view").hidden = true;
  document.getElementById("btn-open-create-tournament").hidden = false;
  document.getElementById("btn-tournament-standings").hidden = true;
  document.getElementById("tournament-header-title").textContent = "Турнир";
  renderTournamentList();
}

function openTournamentBracket(id) {
  currentTournamentId = id;
  document.getElementById("tournament-list-view").hidden = true;
  document.getElementById("tournament-bracket-view").hidden = false;
  document.getElementById("btn-open-create-tournament").hidden = true;
  document.getElementById("btn-tournament-standings").hidden = false;
  const t = tournaments.find((x) => x.id === id);
  document.getElementById("tournament-header-title").textContent = t.name;
  renderBracket(t);
}

/* ---------- CREATE TOURNAMENT MODAL ---------- */
function initTournamentCreateModal() {
  const overlay = document.getElementById("modal-tournament");

  document.getElementById("btn-open-create-tournament").addEventListener("click", () => {
    tournamentPickedIds = new Set();
    document.getElementById("tournament-name-input").value = "";
    document.getElementById("tournament-name-input").classList.remove("invalid");
    document.getElementById("tournament-name-count").textContent = "0/15";
    document.getElementById("picked-players-hint").textContent = "Выбрано: 0/48";
    overlay.classList.add("active");
  });

  document.getElementById("btn-close-tournament-modal").addEventListener("click", async () => {
    const confirmed = await askConfirm("Прекратить создание этого турнира?");
    if (confirmed) overlay.classList.remove("active");
  });

  const nameInput = document.getElementById("tournament-name-input");
  nameInput.addEventListener("input", () => {
    document.getElementById("tournament-name-count").textContent = `${nameInput.value.length}/15`;
    if (nameInput.value.length > 0) nameInput.classList.remove("invalid");
  });

  document.getElementById("btn-open-pick-players").addEventListener("click", () => {
    openPlayerPicker({
      title: "Выберите 48 игроков",
      initialIds: tournamentPickedIds,
      exact: 48,
      onConfirm: (ids) => {
        tournamentPickedIds = ids;
        document.getElementById("picked-players-hint").textContent = `Выбрано: ${ids.size}/48`;
      },
    });
  });

  document.getElementById("btn-confirm-tournament").addEventListener("click", async () => {
    const name = nameInput.value;
    let ok = true;
    if (name.length < 1 || name.length > 15) { nameInput.classList.add("invalid"); ok = false; }
    if (tournamentPickedIds.size !== 48) { showToast("Выберите ровно 48 игроков"); ok = false; }
    if (!ok) return;

    const ids = Array.from(tournamentPickedIds);
    const stage1Groups = chunk(shuffle(ids), 8);
    const stage2Groups = drawMinimalOverlapGroups(ids, 8, stage1Groups);
    const tournament = {
      id: "tr_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8),
      name,
      createdAt: Date.now(),
      status: "round1",
      cumulativeKills: {},
      round1: {
        stage1Groups,
        stage2Groups,
        stage1: stage1Groups.map(() => ({ results: null })),
        stage2: stage2Groups.map(() => ({ results: null })),
      },
      round2: { groups: null, races: null },
      round3: { group: null, race: null },
    };
    tournaments.push(tournament);
    await dbPut("tournaments", tournament);
    overlay.classList.remove("active");
    renderTournamentList();
    openTournamentBracket(tournament.id);
  });
}

/* ---------- PLAYER PICKER (see picker.js for the shared modal logic) ---------- */

/* ---------- PLAYING A GROUP RACE ---------- */
async function playRace(tournament, roundKey, stageKeyOrNull, groupIndex) {
  let ids, slot;
  if (roundKey === "round1") {
    const groups = stageKeyOrNull === "stage1" ? tournament.round1.stage1Groups : tournament.round1.stage2Groups;
    ids = groups[groupIndex];
    slot = tournament.round1[stageKeyOrNull][groupIndex];
  } else if (roundKey === "round2") {
    ids = tournament.round2.groups[groupIndex];
    slot = tournament.round2.races[groupIndex];
  } else {
    ids = tournament.round3.group;
    slot = tournament.round3.race;
  }

  const outcome = await runInteractiveRace(ids);
  goToScreen("tournament");
  openTournamentBracket(tournament.id);
  if (!outcome) return; // race was aborted — slot stays unplayed

  slot.results = outcome.results;
  slot.log = outcome.log;
  outcome.results.forEach((r) => {
    if (r.kills > 0) tournament.cumulativeKills[r.playerId] = (tournament.cumulativeKills[r.playerId] || 0) + r.kills;
  });

  advanceIfReady(tournament);
  await dbPut("tournaments", tournament);
  renderBracket(tournament);
  renderTournamentList();
}

function sumPoints(...slots) {
  const totals = {};
  slots.forEach((slot) => {
    if (!slot || !slot.results) return;
    slot.results.forEach((r) => { totals[r.playerId] = (totals[r.playerId] || 0) + r.total; });
  });
  return totals;
}

function advanceIfReady(tournament) {
  if (tournament.status === "round1") {
    const stage1Done = tournament.round1.stage1.every((s) => s.results);
    const stage2Done = tournament.round1.stage2.every((s) => s.results);
    if (stage1Done && stage2Done) {
      const totals = sumPoints(...tournament.round1.stage1, ...tournament.round1.stage2);
      const allIds = tournament.round1.stage1Groups.flat();
      const ranked = allIds.slice().sort((a, b) => {
        const diff = (totals[b] || 0) - (totals[a] || 0);
        if (diff !== 0) return diff;
        return (tournament.cumulativeKills[b] || 0) - (tournament.cumulativeKills[a] || 0);
      });
      tournament.round1standings = ranked.map((id) => ({ id, points: totals[id] || 0, kills: tournament.cumulativeKills[id] || 0 }));
      const top24 = ranked.slice(0, 24);
      tournament.round2.groups = chunk(shuffle(top24), 8);
      tournament.round2.races = tournament.round2.groups.map(() => ({ results: null }));
      tournament.status = "round2";
    }
  } else if (tournament.status === "round2") {
    const done = tournament.round2.races.every((s) => s.results);
    if (done) {
      const totals = sumPoints(...tournament.round2.races);
      const allIds = tournament.round2.groups.flat();
      const ranked = allIds.slice().sort((a, b) => {
        const diff = (totals[b] || 0) - (totals[a] || 0);
        if (diff !== 0) return diff;
        return (tournament.cumulativeKills[b] || 0) - (tournament.cumulativeKills[a] || 0);
      });
      tournament.round2standings = ranked.map((id) => ({ id, points: totals[id] || 0, kills: tournament.cumulativeKills[id] || 0 }));
      const top8 = ranked.slice(0, 8);
      tournament.round3.group = shuffle(top8);
      tournament.round3.race = { results: null };
      tournament.status = "round3";
    }
  } else if (tournament.status === "round3") {
    if (tournament.round3.race.results) {
      tournament.status = "complete";
    }
  }
}

/* ---------- LIVE OVERALL STANDINGS (for the "Таблица" button) ---------- */
function computeLiveOverallStandings(tournament) {
  let ids, totals, qualifySlots;
  if (tournament.status === "round1") {
    ids = tournament.round1.stage1Groups.flat();
    totals = sumPoints(...tournament.round1.stage1, ...tournament.round1.stage2);
    qualifySlots = 24;
  } else if (tournament.status === "round2") {
    ids = tournament.round2.groups.flat();
    totals = sumPoints(...tournament.round2.races);
    qualifySlots = 8;
  } else {
    ids = tournament.round3.group || [];
    totals = sumPoints(tournament.round3.race);
    qualifySlots = ids.length;
  }
  const standings = ids.slice().sort((a, b) => {
    const diff = (totals[b] || 0) - (totals[a] || 0);
    if (diff !== 0) return diff;
    return (tournament.cumulativeKills[b] || 0) - (tournament.cumulativeKills[a] || 0);
  }).map((id) => ({ id, points: totals[id] || 0, kills: tournament.cumulativeKills[id] || 0 }));
  return { standings, qualifySlots };
}

function initTournamentStandingsModal() {
  document.getElementById("btn-tournament-standings").addEventListener("click", () => {
    const t = tournaments.find((x) => x.id === currentTournamentId);
    if (!t) return;
    const { standings, qualifySlots } = computeLiveOverallStandings(t);
    const content = document.getElementById("tournament-standings-content");
    content.innerHTML = "";
    content.appendChild(renderStandingsTable("Текущий зачёт", standings, qualifySlots));
    document.getElementById("modal-tournament-standings").classList.add("active");
  });
  document.getElementById("btn-close-tournament-standings").addEventListener("click", () => {
    document.getElementById("modal-tournament-standings").classList.remove("active");
  });
}

/* ---------- RENDERING ---------- */
function renderPlayerRow(id, result) {
  const row = document.createElement("div");
  row.className = "player-row" + (result && result.eliminated ? " row-eliminated" : "");
  const player = findPlayer(id);
  const img = document.createElement("img");
  img.src = player ? playerPhotoUrl(player) : "";
  const name = document.createElement("span");
  name.className = "p-name";
  name.textContent = player ? player.name : "???";
  const res = document.createElement("span");
  res.className = "p-result";
  if (!result) res.textContent = "";
  else if (result.eliminated) res.textContent = causeLabel(result);
  else {
    const killPart = result.kills > 0 ? ` +${result.kills} за убийства` : "";
    res.textContent = `${result.place}-е место · ${result.total} очк.${killPart}`;
  }
  row.appendChild(img); row.appendChild(name); row.appendChild(res);
  return row;
}

function renderGroupCard(title, ids, slot, onPlay, lockedHint) {
  const card = document.createElement("div");
  card.className = "group-card";
  const header = document.createElement("div");
  header.className = "group-card-header";
  header.textContent = title;
  card.appendChild(header);

  ids.forEach((id) => {
    const result = slot.results ? slot.results.find((r) => r.playerId === id) : null;
    card.appendChild(renderPlayerRow(id, result));
  });

  if (!slot.results) {
    const btn = document.createElement("button");
    btn.className = "primary-btn btn-play-group";
    if (lockedHint) {
      btn.textContent = lockedHint;
      btn.disabled = true;
    } else {
      btn.textContent = "Играть";
      btn.addEventListener("click", onPlay);
    }
    card.appendChild(btn);
  } else {
    const logBtn = document.createElement("button");
    logBtn.className = "ghost-btn btn-play-group";
    logBtn.textContent = "Лог";
    logBtn.addEventListener("click", () => showLogModal(slot.log));
    card.appendChild(logBtn);
  }
  return card;
}

function renderPlaceholderGroupCard(title) {
  const card = document.createElement("div");
  card.className = "group-card group-card-placeholder";
  const header = document.createElement("div");
  header.className = "group-card-header";
  header.textContent = title;
  card.appendChild(header);
  const hint = document.createElement("div");
  hint.className = "placeholder-hint";
  hint.textContent = "Заполнится автоматически по итогам предыдущего тура";
  card.appendChild(hint);
  return card;
}

function renderStandingsTable(title, standings, qualifySlots) {
  const wrap = document.createElement("div");
  const h = document.createElement("div");
  h.className = "stage-title";
  h.textContent = title;
  wrap.appendChild(h);

  const table = document.createElement("table");
  table.className = "standings-table";
  const pointsDesc = standings.map((s) => s.points);
  table.innerHTML = "<thead><tr><th>Игрок</th><th>Очки</th><th>Убийства</th></tr></thead>";
  const tbody = document.createElement("tbody");
  standings.forEach((s) => {
    const tr = document.createElement("tr");
    const cls = classifyStandingPoints(s.points, pointsDesc, qualifySlots);
    const tdName = document.createElement("td");
    tdName.textContent = playerName(s.id);
    tdName.className = cls;
    const tdPts = document.createElement("td");
    tdPts.textContent = s.points;
    tdPts.className = "num " + cls;
    const tdKills = document.createElement("td");
    tdKills.textContent = s.kills;
    tdKills.className = "num";
    tr.appendChild(tdName); tr.appendChild(tdPts); tr.appendChild(tdKills);
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

function renderBracket(tournament) {
  const root = document.getElementById("tournament-bracket-view");
  root.innerHTML = "";
  const stage1Done = tournament.round1.stage1.every((s) => s.results);

  // ---- Round 1 · Stage 1 ----
  const r1title = document.createElement("div");
  r1title.className = "round-title";
  r1title.textContent = "Тур 1 · Этап 1 · 6 групп по 8 игроков";
  root.appendChild(r1title);

  const stage1Row = document.createElement("div");
  stage1Row.className = "groups-row";
  tournament.round1.stage1Groups.forEach((ids, gi) => {
    const slot = tournament.round1.stage1[gi];
    stage1Row.appendChild(renderGroupCard(`Группа ${gi + 1}`, ids, slot, () => playRace(tournament, "round1", "stage1", gi)));
  });
  root.appendChild(stage1Row);

  // ---- Round 1 · Stage 2 (always visible, locked until stage 1 is fully played) ----
  const stage2Title = document.createElement("div");
  stage2Title.className = "round-title";
  stage2Title.textContent = "Тур 1 · Этап 2 · 6 групп по 8 игроков";
  root.appendChild(stage2Title);

  const stage2Row = document.createElement("div");
  stage2Row.className = "groups-row";
  tournament.round1.stage2Groups.forEach((ids, gi) => {
    const slot = tournament.round1.stage2[gi];
    const lockedHint = stage1Done ? null : "Сначала завершите этап 1";
    stage2Row.appendChild(renderGroupCard(`Группа ${gi + 1}`, ids, slot, () => playRace(tournament, "round1", "stage2", gi), lockedHint));
  });
  root.appendChild(stage2Row);

  if (tournament.round1standings) {
    root.appendChild(renderStandingsTable("Общий зачёт тура 1 (топ-24 проходят дальше)", tournament.round1standings, 24));
  }

  // ---- Round 2 (always visible; placeholders until round 1 fully resolves) ----
  const r2title = document.createElement("div");
  r2title.className = "round-title";
  r2title.textContent = "Тур 2 · 3 группы по 8 игроков";
  root.appendChild(r2title);

  const r2Row = document.createElement("div");
  r2Row.className = "groups-row";
  if (tournament.round2.groups) {
    tournament.round2.groups.forEach((ids, gi) => {
      const slot = tournament.round2.races[gi];
      r2Row.appendChild(renderGroupCard(`Группа ${gi + 1}`, ids, slot, () => playRace(tournament, "round2", null, gi)));
    });
  } else {
    for (let gi = 0; gi < 3; gi++) r2Row.appendChild(renderPlaceholderGroupCard(`Группа ${gi + 1}`));
  }
  root.appendChild(r2Row);

  if (tournament.round2standings) {
    root.appendChild(renderStandingsTable("Общий зачёт тура 2 (топ-8 проходят в финал)", tournament.round2standings, 8));
  }

  // ---- Round 3 · Final (always visible) ----
  const r3title = document.createElement("div");
  r3title.className = "round-title";
  r3title.textContent = "Тур 3 · Финал (8 игроков)";
  root.appendChild(r3title);

  const r3Row = document.createElement("div");
  r3Row.className = "groups-row";
  if (tournament.round3.group) {
    r3Row.appendChild(renderGroupCard("Финальная группа", tournament.round3.group, tournament.round3.race, () => playRace(tournament, "round3", null, 0)));
  } else {
    r3Row.appendChild(renderPlaceholderGroupCard("Финальная группа"));
  }
  root.appendChild(r3Row);

  // ---- Podium (always visible) ----
  const podiumTitle = document.createElement("div");
  podiumTitle.className = "round-title";
  podiumTitle.textContent = "Призовые места";
  root.appendChild(podiumTitle);

  if (tournament.status === "complete") {
    const finalResults = tournament.round3.race.results.slice().sort((a, b) => {
      const pa = a.eliminated ? 99 : a.place;
      const pb = b.eliminated ? 99 : b.place;
      return pa - pb;
    });
    const bestKillerId = Object.entries(tournament.cumulativeKills).sort((a, b) => b[1] - a[1])[0];

    const podium = document.createElement("div");
    podium.className = "podium";
    const medalTitles = ["1 место", "2 место", "3 место"];
    finalResults.slice(0, 3).forEach((r, i) => {
      const row = document.createElement("div");
      row.className = "podium-row";
      row.innerHTML = `<span class="podium-place">${medalTitles[i]}</span><span></span>`;
      row.querySelector("span:last-child").textContent = playerName(r.playerId);
      podium.appendChild(row);
    });
    if (bestKillerId) {
      const row = document.createElement("div");
      row.className = "podium-row";
      row.innerHTML = `<span class="podium-place">Лучший киллер</span><span></span>`;
      row.querySelector("span:last-child").textContent = `${playerName(bestKillerId[0])} (${bestKillerId[1]})`;
      podium.appendChild(row);
    }
    root.appendChild(podium);
  } else {
    const placeholder = document.createElement("div");
    placeholder.className = "podium placeholder-hint";
    placeholder.textContent = "Появится после финальной гонки";
    root.appendChild(placeholder);
  }
}

/* ---------- BOOT ---------- */
async function tournamentBoot() {
  initTournamentCreateModal();
  initTournamentStandingsModal();
  tournaments = await dbGetAll("tournaments");

  document.getElementById("btn-tournament-back").addEventListener("click", () => {
    if (currentTournamentId) showTournamentListView();
    else goToScreen("menu");
  });

  // whenever the menu "Турнир" button is used, reset to the list view
  document.querySelector('.menu-btn[data-nav="tournament"]').addEventListener("click", () => {
    if (players.length >= 48) showTournamentListView();
  });
}

document.addEventListener("DOMContentLoaded", tournamentBoot);
