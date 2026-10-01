"use strict";

/* ---------------------------------------------------------------------- */
/* Color ramps (sequential, one hue per variable — blue=moisture, orange=temperature) */
/* ---------------------------------------------------------------------- */
const RAMPS = {
  VW: ["#eaf2fb", "#cfe3f6", "#a9cbef", "#7fb0e3", "#5897d6", "#3f7dc2", "#2e65a8", "#21508c", "#173c6d", "#0f2c52"],
  T:  ["#fdf0e7", "#fbdcc2", "#f5be92", "#ed9c66", "#df7a40", "#cc5f27", "#b04a18", "#8f3912", "#6e2b0f", "#4f1e0c"],
};
function hexToRgb(h) { h = h.replace("#", ""); return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]; }
function lerpRgb(a, b, f) { return [Math.round(a[0] + (b[0] - a[0]) * f), Math.round(a[1] + (b[1] - a[1]) * f), Math.round(a[2] + (b[2] - a[2]) * f)]; }
function colorFor(v, lo, hi, varName) {
  const ramp = RAMPS[varName].map(hexToRgb);
  let t = hi > lo ? (v - lo) / (hi - lo) : 0.5;
  t = Math.max(0, Math.min(1, t));
  const idx = t * (ramp.length - 1);
  const i0 = Math.floor(idx), i1 = Math.min(ramp.length - 1, i0 + 1), f = idx - i0;
  return lerpRgb(ramp[i0], ramp[i1], f);
}

/* ---------------------------------------------------------------------- */
/* State                                                                   */
/* ---------------------------------------------------------------------- */
const state = {
  meta: null,
  apiOk: false,
  variable: "VW",
  method: "kriging",
  depth: null,
  sensors: [],      // {id, x, y, vw, t, date}  (x,y in field meters)
  timelineDays: 0,  // days since date_range.start
  playing: false,
  editing: null,    // sensor id being edited
  lastGrid: null,
  nextId: 1,
};

const els = {};
["apiBadge", "sensorBadge", "methodSeg", "depthRow", "sensorsCard", "replayCard", "timelineCard",
 "sensorCount", "randomCount", "addRandomBtn", "clearBtn", "playBtn", "dateReadout",
 "timelineSlider", "dateStart", "dateEnd", "varToggle", "methodLabel", "fieldCanvas", "markerCanvas",
 "cornerTL", "cornerBR", "emptyHint", "legendMin", "legendMax", "legendBar",
 "statCount", "statMean", "statSpread", "statMethod", "apiBaseLabel"].forEach(id => { els[id] = document.getElementById(id); });

/* ---------------------------------------------------------------------- */
/* API                                                                     */
/* ---------------------------------------------------------------------- */
const API_BASE = window.API_BASE || "";

async function fetchMeta() {
  try {
    const r = await fetch(API_BASE + "/api/meta");
    if (!r.ok) throw new Error("meta " + r.status);
    state.meta = await r.json();
    state.apiOk = true;
    els.apiBadge.textContent = "api live";
    els.apiBadge.classList.add("live");
  } catch (e) {
    state.apiOk = false;
    els.apiBadge.textContent = "api unreachable";
    els.apiBadge.classList.add("down");
    els.emptyHint.textContent = "Backend not reachable yet — deploy the Hugging Face Space, then reload this page.";
    els.emptyHint.style.display = "block";
    console.error(e);
  }
}

let reconstructAbort = null;
let reconstructTimer = null;
function scheduleReconstruct(delay = 120) {
  clearTimeout(reconstructTimer);
  reconstructTimer = setTimeout(doReconstruct, delay);
}

async function doReconstruct() {
  if (!state.apiOk || !state.meta) return;
  if (state.method === "kriging" && state.sensors.length === 0) {
    state.lastGrid = null;
    drawField(null);
    updateStats(null);
    els.emptyHint.style.display = "block";
    return;
  }
  els.emptyHint.style.display = "none";

  if (reconstructAbort) reconstructAbort.abort();
  reconstructAbort = new AbortController();

  const dateStr = dayOffsetToISO(state.timelineDays);
  const body = {
    variable: state.variable, method: state.method, depth: state.depth,
    date: dateStr, grid_n: 45,
  };
  if (state.method === "kriging") {
    body.sensors = state.sensors.map(s => ({ x: s.x, y: s.y, value: state.variable === "VW" ? s.vw : s.t }));
  }

  try {
    const r = await fetch(API_BASE + "/api/reconstruct", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: reconstructAbort.signal,
    });
    if (!r.ok) throw new Error("reconstruct " + r.status);
    const data = await r.json();
    state.lastGrid = data;
    drawField(data);
    updateStats(data);
  } catch (e) {
    if (e.name !== "AbortError") console.error(e);
  }
}

/* ---------------------------------------------------------------------- */
/* Date helpers                                                            */
/* ---------------------------------------------------------------------- */
function dayOffsetToISO(days) {
  const start = new Date(state.meta.date_range.start + "T00:00:00Z");
  const d = new Date(start.getTime() + days * 86400000);
  return d.toISOString().slice(0, 10);
}
function totalRangeDays() {
  const start = new Date(state.meta.date_range.start + "T00:00:00Z");
  const end = new Date(state.meta.date_range.end + "T00:00:00Z");
  return Math.round((end - start) / 86400000);
}

/* ---------------------------------------------------------------------- */
/* Canvas drawing                                                          */
/* ---------------------------------------------------------------------- */
function sizeCanvases() {
  const holder = els.fieldCanvas.parentElement;
  const rect = holder.getBoundingClientRect();
  [els.fieldCanvas, els.markerCanvas].forEach(c => {
    c.width = rect.width * devicePixelRatio; c.height = rect.height * devicePixelRatio;
  });
}

function drawField(data) {
  const ctx = els.fieldCanvas.getContext("2d");
  const W = els.fieldCanvas.width, H = els.fieldCanvas.height;
  ctx.clearRect(0, 0, W, H);
  if (!data) return;

  const n = data.grid.length;
  const off = document.createElement("canvas");
  off.width = n; off.height = n;
  const octx = off.getContext("2d");
  const img = octx.createImageData(n, n);
  const vmeta = state.meta.variables[state.variable];
  const lo = vmeta.min_observed, hi = vmeta.max_observed;

  for (let row = 0; row < n; row++) {
    const srcRow = n - 1 - row; // flip so higher y (north) is up
    for (let col = 0; col < n; col++) {
      const v = data.grid[srcRow][col];
      const [r, g, b] = colorFor(v, lo, hi, state.variable);
      const idx = (row * n + col) * 4;
      img.data[idx] = r; img.data[idx + 1] = g; img.data[idx + 2] = b; img.data[idx + 3] = 255;
    }
  }
  octx.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(off, 0, 0, W, H);

  els.legendMin.textContent = lo.toFixed(2) + " " + vmeta.unit;
  els.legendMax.textContent = hi.toFixed(2) + " " + vmeta.unit;
  const stops = RAMPS[state.variable];
  els.legendBar.style.background = `linear-gradient(90deg, ${stops.join(",")})`;
}

function fieldToCanvasXY(x, y) {
  const extent = state.meta.field_extent_m;
  const rect = els.markerCanvas.getBoundingClientRect();
  const px = ((x - extent.x_min) / (extent.x_max - extent.x_min)) * rect.width;
  const py = (1 - (y - extent.y_min) / (extent.y_max - extent.y_min)) * rect.height;
  return [px, py];
}
function canvasToFieldXY(px, py) {
  const extent = state.meta.field_extent_m;
  const rect = els.markerCanvas.getBoundingClientRect();
  const x = extent.x_min + (px / rect.width) * (extent.x_max - extent.x_min);
  const y = extent.y_min + (1 - py / rect.height) * (extent.y_max - extent.y_min);
  return [x, y];
}

function drawMarkers() {
  const ctx = els.markerCanvas.getContext("2d");
  const W = els.markerCanvas.width, H = els.markerCanvas.height;
  ctx.clearRect(0, 0, W, H);
  ctx.save();
  ctx.scale(devicePixelRatio, devicePixelRatio);

  if (state.method === "kriging") {
    const vmeta = state.meta.variables[state.variable];
    for (const s of state.sensors) {
      const [px, py] = fieldToCanvasXY(s.x, s.y);
      const v = state.variable === "VW" ? s.vw : s.t;
      const [r, g, b] = colorFor(v, vmeta.min_observed, vmeta.max_observed, state.variable);
      ctx.beginPath(); ctx.arc(px, py, 7, 0, Math.PI * 2);
      ctx.fillStyle = `rgb(${r},${g},${b})`; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = s.id === state.editing ? "#000" : "#fff"; ctx.stroke();
    }
  } else if (state.meta.sensor_coords) {
    ctx.fillStyle = "#ffffffaa";
    ctx.strokeStyle = "#00000066";
    for (const loc in state.meta.sensor_coords) {
      const [x, y] = state.meta.sensor_coords[loc];
      const [px, py] = fieldToCanvasXY(x, y);
      ctx.beginPath(); ctx.arc(px, py, 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
  }
  ctx.restore();
}

function updateStats(data) {
  els.statMethod.textContent = state.method[0].toUpperCase() + state.method.slice(1);
  if (state.method === "kriging") {
    els.statCount.textContent = state.sensors.length;
  } else {
    els.statCount.textContent = state.meta.sensor_locations ? state.meta.sensor_locations.length : "—";
  }
  if (!data) { els.statMean.textContent = "—"; els.statSpread.textContent = "—"; return; }
  const flat = data.grid.flat();
  const mean = flat.reduce((a, b) => a + b, 0) / flat.length;
  const variance = flat.reduce((a, b) => a + (b - mean) ** 2, 0) / flat.length;
  const vmeta = state.meta.variables[state.variable];
  els.statMean.textContent = mean.toFixed(3) + " " + vmeta.unit;
  els.statSpread.textContent = Math.sqrt(variance).toFixed(3);
}

/* ---------------------------------------------------------------------- */
/* Edit card                                                               */
/* ---------------------------------------------------------------------- */
function closeEditCard() {
  const existing = document.getElementById("editCard");
  if (existing) existing.remove();
  state.editing = null;
  drawMarkers();
}

function openEditCard(sensor, px, py) {
  closeEditCard();
  state.editing = sensor.id;
  drawMarkers();
  const vw = state.meta.variables.VW, t = state.meta.variables.T;
  const card = document.createElement("div");
  card.className = "editcard"; card.id = "editCard";
  card.style.left = Math.min(px + 12, els.markerCanvas.parentElement.clientWidth - 232) + "px";
  card.style.top = Math.min(py + 12, els.markerCanvas.parentElement.clientHeight - 230) + "px";
  card.innerHTML = `
    <h3>Sensor <span style="cursor:pointer" id="ecClose">✕</span></h3>
    <div class="erow"><label>Moisture <span class="readout mono" id="ecVwVal"></span></label>
      <input type="range" id="ecVw" min="${vw.q25}" max="${vw.q75}" step="0.001" value="${sensor.vw}"></div>
    <div class="erow"><label>Temperature <span class="readout mono" id="ecTVal"></span></label>
      <input type="range" id="ecT" min="${t.q25}" max="${t.q75}" step="0.1" value="${sensor.t}"></div>
    <div class="erow"><label>Date <span class="readout mono" id="ecDateVal"></span></label>
      <input type="range" id="ecDate" min="0" max="${totalRangeDays()}" step="1" value="${sensor.dateDays}"></div>
    <button class="btn danger" id="ecDelete">Remove sensor</button>
  `;
  els.markerCanvas.parentElement.appendChild(card);

  const vwInput = card.querySelector("#ecVw"), tInput = card.querySelector("#ecT"), dateInput = card.querySelector("#ecDate");
  const refresh = () => {
    card.querySelector("#ecVwVal").textContent = parseFloat(vwInput.value).toFixed(3);
    card.querySelector("#ecTVal").textContent = parseFloat(tInput.value).toFixed(1) + "°";
    card.querySelector("#ecDateVal").textContent = dayOffsetToISO(parseInt(dateInput.value, 10));
  };
  refresh();
  vwInput.addEventListener("input", () => { sensor.vw = parseFloat(vwInput.value); refresh(); drawMarkers(); scheduleReconstruct(); });
  tInput.addEventListener("input", () => { sensor.t = parseFloat(tInput.value); refresh(); drawMarkers(); scheduleReconstruct(); });
  dateInput.addEventListener("input", () => { sensor.dateDays = parseInt(dateInput.value, 10); refresh(); });
  card.querySelector("#ecClose").addEventListener("click", closeEditCard);
  card.querySelector("#ecDelete").addEventListener("click", () => {
    state.sensors = state.sensors.filter(s => s.id !== sensor.id);
    closeEditCard(); refreshSensorCount(); scheduleReconstruct();
  });
}

/* ---------------------------------------------------------------------- */
/* Sensor management                                                       */
/* ---------------------------------------------------------------------- */
function midpoint(lo, hi) { return (lo + hi) / 2; }

function addSensorAt(x, y) {
  const vw = state.meta.variables.VW, t = state.meta.variables.T;
  const sensor = {
    id: state.nextId++, x, y,
    vw: midpoint(vw.q25, vw.q75), t: midpoint(t.q25, t.q75),
    dateDays: Math.round(totalRangeDays() / 2),
  };
  state.sensors.push(sensor);
  refreshSensorCount();
  drawMarkers();
  scheduleReconstruct();
  return sensor;
}

function addRandomSensors(n) {
  const extent = state.meta.field_extent_m;
  const vw = state.meta.variables.VW, t = state.meta.variables.T;
  for (let i = 0; i < n; i++) {
    const x = extent.x_min + Math.random() * (extent.x_max - extent.x_min);
    const y = extent.y_min + Math.random() * (extent.y_max - extent.y_min);
    state.sensors.push({
      id: state.nextId++, x, y,
      vw: vw.q25 + Math.random() * (vw.q75 - vw.q25),
      t: t.q25 + Math.random() * (t.q75 - t.q25),
      dateDays: Math.round(Math.random() * totalRangeDays()),
    });
  }
  refreshSensorCount();
  drawMarkers();
  scheduleReconstruct();
}

function refreshSensorCount() {
  els.sensorCount.textContent = state.sensors.length;
  els.sensorBadge.textContent = state.sensors.length + (state.sensors.length === 1 ? " sensor" : " sensors");
}

/* ---------------------------------------------------------------------- */
/* UI wiring                                                               */
/* ---------------------------------------------------------------------- */
function applyMethodVisibility() {
  const isKriging = state.method === "kriging";
  els.sensorsCard.style.display = isKriging ? "" : "none";
  els.replayCard.style.display = isKriging ? "none" : "";
  els.timelineCard.style.display = isKriging ? "none" : "";
  els.methodLabel.textContent = state.method[0].toUpperCase() + state.method.slice(1);
  document.querySelectorAll("#methodSeg button").forEach(b => b.setAttribute("aria-pressed", b.dataset.method === state.method));
}

function buildDepthButtons() {
  els.depthRow.innerHTML = "";
  state.meta.depths_cm.forEach((d, i) => {
    const b = document.createElement("button");
    b.textContent = d + "cm"; b.dataset.depth = d;
    b.setAttribute("aria-pressed", i === 0);
    b.addEventListener("click", () => {
      state.depth = d;
      document.querySelectorAll("#depthRow button").forEach(x => x.setAttribute("aria-pressed", x === b));
      scheduleReconstruct();
    });
    els.depthRow.appendChild(b);
  });
  state.depth = state.meta.depths_cm[0];
}

function initTimeline() {
  els.dateStart.textContent = state.meta.date_range.start;
  els.dateEnd.textContent = state.meta.date_range.end;
  const maxDays = totalRangeDays();
  els.timelineSlider.max = maxDays;
  els.timelineSlider.value = Math.round(maxDays / 2);
  state.timelineDays = parseInt(els.timelineSlider.value, 10);
  els.dateReadout.textContent = dayOffsetToISO(state.timelineDays);
  els.timelineSlider.addEventListener("input", () => {
    state.timelineDays = parseInt(els.timelineSlider.value, 10);
    els.dateReadout.textContent = dayOffsetToISO(state.timelineDays);
    scheduleReconstruct();
  });
  els.playBtn.addEventListener("click", () => {
    state.playing = !state.playing;
    els.playBtn.textContent = state.playing ? "❚❚" : "▶";
    if (state.playing) playTick();
  });
}
function playTick() {
  if (!state.playing) return;
  let v = parseInt(els.timelineSlider.value, 10) + Math.max(1, Math.round(totalRangeDays() / 200));
  if (v > parseInt(els.timelineSlider.max, 10)) v = 0;
  els.timelineSlider.value = v;
  state.timelineDays = v;
  els.dateReadout.textContent = dayOffsetToISO(v);
  scheduleReconstruct(0);
  setTimeout(playTick, 220);
}

function wireEvents() {
  document.querySelectorAll("#methodSeg button").forEach(b => {
    b.addEventListener("click", () => {
      state.method = b.dataset.method;
      closeEditCard();
      applyMethodVisibility();
      drawMarkers();
      scheduleReconstruct();
    });
  });
  document.querySelectorAll("#varToggle button").forEach(b => {
    b.addEventListener("click", () => {
      state.variable = b.dataset.var;
      document.querySelectorAll("#varToggle button").forEach(x => x.setAttribute("aria-pressed", x === b));
      drawMarkers();
      scheduleReconstruct();
    });
  });

  els.addRandomBtn.addEventListener("click", () => addRandomSensors(Math.max(1, parseInt(els.randomCount.value, 10) || 1)));
  els.clearBtn.addEventListener("click", () => { state.sensors = []; closeEditCard(); refreshSensorCount(); scheduleReconstruct(); });

  els.markerCanvas.addEventListener("click", (ev) => {
    if (state.method !== "kriging") return;
    const rect = els.markerCanvas.getBoundingClientRect();
    const px = ev.clientX - rect.left, py = ev.clientY - rect.top;
    const hit = state.sensors.find(s => {
      const [sx, sy] = fieldToCanvasXY(s.x, s.y);
      return Math.hypot(sx - px, sy - py) < 10;
    });
    if (hit) {
      openEditCard(hit, px, py);
    } else {
      const [x, y] = canvasToFieldXY(px, py);
      const s = addSensorAt(x, y);
      openEditCard(s, px, py);
    }
  });

  window.addEventListener("resize", () => { sizeCanvases(); drawField(state.lastGrid); drawMarkers(); });
}

/* ---------------------------------------------------------------------- */
/* Boot                                                                    */
/* ---------------------------------------------------------------------- */
(async function init() {
  sizeCanvases();
  await fetchMeta();
  if (!state.meta) return;
  const extent = state.meta.field_extent_m;
  els.cornerBR.textContent = `${Math.round(extent.x_max - extent.x_min)} m × ${Math.round(extent.y_max - extent.y_min)} m`;
  buildDepthButtons();
  initTimeline();
  applyMethodVisibility();
  wireEvents();
  refreshSensorCount();
  drawMarkers();
  els.emptyHint.style.display = "block";
})();
