"use strict";

let pickerState = { selected: new Set(), config: null };

function openPlayerPicker(config) {
  // config: { title, initialIds: Set, exact?: number, min?: number, max?: number, onConfirm(Set) }
  pickerState.config = config;
  pickerState.selected = new Set(config.initialIds || []);

  document.querySelector("#modal-pick-players h3").textContent = config.title;

  const grid = document.getElementById("pick-players-grid");
  grid.innerHTML = "";
  for (const player of players) {
    const cell = document.createElement("div");
    cell.className = "pick-card" + (pickerState.selected.has(player.id) ? " selected" : "");
    const img = document.createElement("img");
    img.src = playerPhotoUrl(player);
    const nameEl = document.createElement("div");
    nameEl.className = "pick-name";
    nameEl.textContent = player.name;
    cell.appendChild(img);
    cell.appendChild(nameEl);
    cell.addEventListener("click", () => {
      if (pickerState.selected.has(player.id)) pickerState.selected.delete(player.id);
      else pickerState.selected.add(player.id);
      cell.classList.toggle("selected");
      updatePickerCount();
    });
    grid.appendChild(cell);
  }
  updatePickerCount();
  document.getElementById("modal-pick-players").classList.add("active");
}

function pickerIsValid() {
  const n = pickerState.selected.size;
  const c = pickerState.config;
  if (!c) return false;
  if (c.exact != null) return n === c.exact;
  if (c.min != null && n < c.min) return false;
  if (c.max != null && n > c.max) return false;
  return n > 0;
}

function updatePickerCount() {
  const n = pickerState.selected.size;
  const c = pickerState.config;
  const label = c.exact != null ? `${n}/${c.exact}` : `${n} (нужно от ${c.min} до ${c.max})`;
  document.getElementById("pick-players-count").textContent = label;
  document.getElementById("btn-confirm-pick-players").disabled = !pickerIsValid();
}

function initPlayerPicker() {
  document.getElementById("btn-close-pick-players").addEventListener("click", () => {
    document.getElementById("modal-pick-players").classList.remove("active");
  });
  document.getElementById("btn-confirm-pick-players").addEventListener("click", () => {
    if (!pickerIsValid()) return;
    document.getElementById("modal-pick-players").classList.remove("active");
    const selected = pickerState.selected;
    const cb = pickerState.config.onConfirm;
    if (cb) cb(selected);
  });
}

document.addEventListener("DOMContentLoaded", initPlayerPicker);
