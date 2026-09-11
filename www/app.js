"use strict";

/* =========================================================
   STORAGE — IndexedDB (photos as Blob, no size limit like localStorage)
   ========================================================= */
const DB_NAME = "race-tournament";
const DB_VERSION = 1;
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("players")) {
        db.createObjectStore("players", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("tournaments")) {
        db.createObjectStore("tournaments", { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function dbGetAll(store) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbPut(store, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function dbDelete(store, id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/* =========================================================
   STATE
   ========================================================= */
let players = [];              // [{id, name, photoBlob}]
const objectUrlCache = new Map(); // player id -> blob object URL

function playerPhotoUrl(player) {
  if (objectUrlCache.has(player.id)) return objectUrlCache.get(player.id);
  const url = URL.createObjectURL(player.photoBlob);
  objectUrlCache.set(player.id, url);
  return url;
}

/* =========================================================
   TOASTS
   ========================================================= */
function showToast(message) {
  const layer = document.getElementById("toast-layer");
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = message;
  layer.appendChild(el);
  setTimeout(() => el.remove(), 2400);
}

/* =========================================================
   NAVIGATION
   ========================================================= */
const SCREEN_IDS = ["menu", "create-player", "tournament", "race", "arena"];

function goToScreen(name) {
  SCREEN_IDS.forEach((id) => {
    document.getElementById("screen-" + id).classList.toggle("active", id === name);
  });
  if (name === "create-player") renderPlayersGrid();
}

function initNav() {
  document.querySelectorAll("[data-nav]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.getAttribute("data-nav");
      const requires = btn.getAttribute("data-requires");
      if (requires && players.length < Number(requires)) {
        showToast(`Сначала создайте ${requires} игроков`);
        return;
      }
      goToScreen(target);
    });
  });
}

function refreshMenuState() {
  document.getElementById("count-players").textContent = players.length;
  document.querySelectorAll(".menu-btn[data-requires]").forEach((btn) => {
    const need = Number(btn.getAttribute("data-requires"));
    btn.classList.toggle("disabled", players.length < need);
  });
}

/* =========================================================
   GENERIC CONFIRM MODAL
   ========================================================= */
function askConfirm(text) {
  return new Promise((resolve) => {
    const overlay = document.getElementById("modal-confirm");
    document.getElementById("confirm-text").textContent = text;
    overlay.classList.add("active");

    const okBtn = document.getElementById("btn-confirm-ok");
    const cancelBtn = document.getElementById("btn-confirm-cancel");

    function cleanup(result) {
      overlay.classList.remove("active");
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      resolve(result);
    }
    function onOk() { cleanup(true); }
    function onCancel() { cleanup(false); }

    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
  });
}

/* =========================================================
   PLAYER CREATE / EDIT MODAL
   ========================================================= */
const playerModal = {
  overlay: null,
  editingId: null,   // null = creating new
  pendingBlob: null,  // resized photo blob staged for save
  pendingPhotoUrl: null,
};

function initPlayerModal() {
  playerModal.overlay = document.getElementById("modal-player");

  document.getElementById("btn-open-create-player").addEventListener("click", () => {
    openPlayerModal(null);
  });

  document.getElementById("btn-close-player-modal").addEventListener("click", async () => {
    const confirmed = await askConfirm("Прекратить создание этого игрока?");
    if (confirmed) closePlayerModal();
  });

  document.getElementById("photo-picker").addEventListener("click", () => {
    document.getElementById("photo-input").click();
  });

  document.getElementById("photo-input").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const blob = await resizeImageToSquareBlob(file, 480);
      playerModal.pendingBlob = blob;
      if (playerModal.pendingPhotoUrl) URL.revokeObjectURL(playerModal.pendingPhotoUrl);
      playerModal.pendingPhotoUrl = URL.createObjectURL(blob);
      const img = document.getElementById("photo-preview");
      img.src = playerModal.pendingPhotoUrl;
      img.hidden = false;
      document.getElementById("photo-placeholder").hidden = true;
      document.getElementById("photo-picker").classList.remove("invalid");
    } catch (err) {
      showToast("Не удалось загрузить фото, попробуйте другое");
    }
    e.target.value = "";
  });

  const nameInput = document.getElementById("player-name-input");
  nameInput.addEventListener("input", () => {
    document.getElementById("name-count").textContent = `${nameInput.value.length}/25`;
    if (nameInput.value.length > 0) nameInput.classList.remove("invalid");
  });

  document.getElementById("btn-confirm-player").addEventListener("click", onSubmitPlayer);
}

function openPlayerModal(player) {
  playerModal.editingId = player ? player.id : null;
  playerModal.pendingBlob = null;
  if (playerModal.pendingPhotoUrl) { URL.revokeObjectURL(playerModal.pendingPhotoUrl); playerModal.pendingPhotoUrl = null; }

  document.getElementById("player-modal-title").textContent = player ? "Редактировать игрока" : "Новый игрок";
  document.getElementById("btn-confirm-player").textContent = player ? "Сохранить" : "Создать игрока";

  const nameInput = document.getElementById("player-name-input");
  nameInput.value = player ? player.name : "";
  nameInput.classList.remove("invalid");
  document.getElementById("name-count").textContent = `${nameInput.value.length}/25`;

  const img = document.getElementById("photo-preview");
  const placeholder = document.getElementById("photo-placeholder");
  const picker = document.getElementById("photo-picker");
  picker.classList.remove("invalid");
  if (player) {
    img.src = playerPhotoUrl(player);
    img.hidden = false;
    placeholder.hidden = true;
  } else {
    img.hidden = true;
    placeholder.hidden = false;
  }

  playerModal.overlay.classList.add("active");
}

function closePlayerModal() {
  playerModal.overlay.classList.remove("active");
  if (playerModal.pendingPhotoUrl) { URL.revokeObjectURL(playerModal.pendingPhotoUrl); playerModal.pendingPhotoUrl = null; }
  playerModal.pendingBlob = null;
  playerModal.editingId = null;
}

async function onSubmitPlayer() {
  const nameInput = document.getElementById("player-name-input");
  const name = nameInput.value;
  const picker = document.getElementById("photo-picker");

  const editing = playerModal.editingId ? players.find((p) => p.id === playerModal.editingId) : null;
  const hasPhoto = !!playerModal.pendingBlob || !!(editing && editing.photoBlob);
  const nameValid = name.length >= 1 && name.length <= 25;

  let ok = true;
  if (!nameValid) { nameInput.classList.add("invalid"); ok = false; }
  if (!hasPhoto) { picker.classList.add("invalid"); ok = false; }
  if (!ok) return;

  if (editing) {
    editing.name = name;
    if (playerModal.pendingBlob) editing.photoBlob = playerModal.pendingBlob;
    if (objectUrlCache.has(editing.id)) { URL.revokeObjectURL(objectUrlCache.get(editing.id)); objectUrlCache.delete(editing.id); }
    await dbPut("players", editing);
  } else {
    const newPlayer = {
      id: "p_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8),
      name,
      photoBlob: playerModal.pendingBlob,
    };
    players.push(newPlayer);
    await dbPut("players", newPlayer);
  }

  closePlayerModal();
  refreshMenuState();
  renderPlayersGrid();
}

/* =========================================================
   IMAGE RESIZE — any source format/size -> square JPEG blob
   ========================================================= */
function resizeImageToSquareBlob(file, targetSize) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("bad image"));
      img.onload = () => {
        const side = Math.min(img.width, img.height);
        const sx = (img.width - side) / 2;
        const sy = (img.height - side) / 2;
        const canvas = document.createElement("canvas");
        canvas.width = targetSize;
        canvas.height = targetSize;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, sx, sy, side, side, 0, 0, targetSize, targetSize);
        canvas.toBlob((blob) => {
          if (blob) resolve(blob); else reject(new Error("toBlob failed"));
        }, "image/jpeg", 0.85);
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

/* =========================================================
   PLAYERS GRID
   ========================================================= */
function renderPlayersGrid() {
  const grid = document.getElementById("players-grid");
  const emptyHint = document.getElementById("players-empty-hint");
  grid.querySelectorAll(".player-card").forEach((el) => el.remove());
  emptyHint.style.display = players.length ? "none" : "block";

  for (const player of players) {
    const card = document.createElement("div");
    card.className = "player-card";

    const img = document.createElement("img");
    img.src = playerPhotoUrl(player);
    img.alt = player.name;
    img.addEventListener("click", () => openPlayerModal(player));

    const nameEl = document.createElement("div");
    nameEl.className = "player-name";
    nameEl.textContent = player.name;
    nameEl.addEventListener("click", () => openPlayerModal(player));

    const removeBtn = document.createElement("button");
    removeBtn.className = "card-remove";
    removeBtn.textContent = "✕";
    removeBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const confirmed = await askConfirm(`Удалить игрока «${player.name}»?`);
      if (!confirmed) return;
      players = players.filter((p) => p.id !== player.id);
      if (objectUrlCache.has(player.id)) { URL.revokeObjectURL(objectUrlCache.get(player.id)); objectUrlCache.delete(player.id); }
      await dbDelete("players", player.id);
      refreshMenuState();
      renderPlayersGrid();
    });

    card.appendChild(img);
    card.appendChild(nameEl);
    card.appendChild(removeBtn);
    grid.appendChild(card);
  }
}

/* =========================================================
   STANDINGS COLORING — relative to the qualification cutoff
   green = favorite, orange = average, yellow = borderline, none = doesn't qualify
   ========================================================= */
function classifyStandingPoints(points, allPointsDesc, qualifySlots) {
  if (allPointsDesc.length < qualifySlots) return "pts-out";
  const cutoff = allPointsDesc[qualifySlots - 1]; // points of the last qualifying spot
  if (points < cutoff) return "pts-out";
  const lead = allPointsDesc[0];
  const margin = points - cutoff;      // how far above the cutoff
  const span = Math.max(lead - cutoff, 1);
  const ratio = margin / span;         // 0 = right at cutoff, 1 = matches the leader
  if (points === cutoff) return "pts-border";
  if (ratio >= 0.4) return "pts-favorite";
  return "pts-average";
}

/* =========================================================
   BOOT
   ========================================================= */
async function boot() {
  initNav();
  initPlayerModal();
  players = await dbGetAll("players");
  refreshMenuState();
  renderPlayersGrid();
}

document.addEventListener("DOMContentLoaded", boot);
