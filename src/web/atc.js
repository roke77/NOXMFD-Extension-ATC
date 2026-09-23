// ATC page (docs/atc-mfd-plan.md). Opens its own TelemetrySource, the same client-side
// mechanism map.js uses (that module's own header comment: "the ONE EventSource('/stream')... in
// the whole MFD" describes avoiding a second connection from a co-located pane, not a rule against
// another PAGE also being a tap) — NOXMFD.Api has no method to fetch contacts into an extension's
// C#, so this is how the table gets live position/heading/pilot-name/speed/altitude at all. Range/
// distance math mirrors TGT's own telemetry-source.js derivation exactly (same d.world anchor).
import { TelemetrySource } from '/assets/services/telemetry-source.js';
import { fmtRng } from '/assets/services/range-format.js';

const rowsEl = document.getElementById('rows');
const emptyEl = document.getElementById('list-empty');
const selectedLineEl = document.getElementById('selected-line');
const rangeBtnsEl = document.getElementById('range-btns');
const rangeUnitEl = document.getElementById('range-unit');
const factionBtnsEl = document.getElementById('faction-btns');
const trackCheckboxEl = document.getElementById('track-checkbox');

const STATUS_VALUES = ['UNKNOWN', 'PARKED', 'TAXI', 'TAKEOFF', 'DEPARTURE', 'ENROUTE', 'HOLDING',
  'ARRIVAL', 'APPROACH', 'FINAL', 'LANDED', 'EMERGENCY'];

// Per-row STATUS picker — the page's own themed list rather than a native <select>, whose open
// option list is drawn by the browser/OS (light grey, serif) and ignores the page's CSS entirely.
// The list is one element on <body>, not inside the row, so the ~10 Hz row rebuild can't tear it
// down; render() also holds the rows still while it's open (see render()).
const statusMenuEl = document.createElement('div');
statusMenuEl.className = 'atc-status-menu';
statusMenuEl.hidden = true;
document.body.appendChild(statusMenuEl);
let statusMenuUnitId = 0;   // unit whose status the open list sets; 0 = closed

function openStatusMenu(unitId, anchor) {
  statusMenuUnitId = unitId;
  const current = statusById[unitId] || 'UNKNOWN';
  statusMenuEl.textContent = '';
  for (const s of STATUS_VALUES) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'atc-status-item' + (s === current ? ' on' : '');
    item.textContent = s;
    item.addEventListener('click', () => setStatus(unitId, s));
    statusMenuEl.appendChild(item);
  }
  statusMenuEl.hidden = false;
  // Below the button, or above it when there's more room there; capped to the room available so a
  // short pane scrolls the list instead of pushing it off-screen.
  const r = anchor.getBoundingClientRect();
  const below = window.innerHeight - r.bottom - 4, above = r.top - 4;
  const openUp = below < statusMenuEl.scrollHeight && above > below;
  statusMenuEl.style.left = r.left + 'px';
  statusMenuEl.style.minWidth = r.width + 'px';
  statusMenuEl.style.maxHeight = Math.max(80, openUp ? above : below) + 'px';
  statusMenuEl.style.top = openUp ? '' : r.bottom + 2 + 'px';
  statusMenuEl.style.bottom = openUp ? window.innerHeight - r.top + 2 + 'px' : '';
  statusMenuEl.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
}

function closeStatusMenu() {
  if (!statusMenuUnitId) return;
  statusMenuUnitId = 0;
  statusMenuEl.hidden = true;
  render();   // catch up on the frames held back while it was open
}

function setStatus(unitId, status) {
  postCommand({ cmd: 'set-status', id: unitId, status });
  // Optimistic local update — the next frame's published slice confirms/overwrites it, but there's
  // no reason to wait a tick to reflect the controller's own pick.
  statusById[unitId] = status;
  closeStatusMenu();
}

document.addEventListener('mousedown', (e) => {
  if (statusMenuUnitId && !statusMenuEl.contains(e.target) && !e.target.closest('.atc-c-status')) closeStatusMenu();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeStatusMenu(); });
// The list is positioned against the button once; if the table scrolls or the pane resizes, the
// button moves out from under it, so close rather than leave it floating in the wrong place.
document.querySelector('.atc-list-scroll').addEventListener('scroll', closeStatusMenu);
window.addEventListener('resize', closeStatusMenu);

let lastFrame = null;      // the raw frame from the last onFrame — re-rendered on a range change too
let rangeKm = 0;           // 0 = ALL
let factionFilter = 'all'; // 'all' | 'friendly' | 'enemy' — neutrals only ever show under 'all'
let rangeMetric = null;    // unit the RANGE labels currently show (frame's `metric`); null = not drawn yet
let selectedId = 0;        // 0 = nothing selected
let statusById = {};       // unitId -> status string, from this extension's own published slice
let trackOn = false;       // TRACK ON MAP checkbox state, mirrored to NOXMFD via the 'track' command

function fmtHdg(deg) {
  return Math.round(((deg % 360) + 360) % 360) + '°';
}

// u.pf is -1 for "no data" (docs/atc-mfd-plan.md decision 5 / NOXMFD's docs/atc-extension-support.md
// item 1) — a peer-broadcast value, only ever present for a faction-mate whose own NOXMFD instance
// is both running and within the broadcast's freshness window; an enemy contact can never carry
// one at all (FuelBroadcast only reaches the local player's own faction roster in the first place).
function fmtFuel(pf) {
  return typeof pf === 'number' && pf >= 0 ? Math.round(pf * 100) + '%' : '—';
}

function factionClass(f) {
  return f === 1 ? 'f-friendly' : f === 2 ? 'f-enemy' : 'f-neutral';
}

// The RANGE presets are fixed real distances (data-range, in km) — only their labels follow the
// player's Metric/Imperial setting (the frame's top-level `metric`, which the game's units option
// and NOXMFD's Toggle Units keybind both change), so switching units never changes what's shown.
const KM_PER_NM = 1.852;
function renderRangeUnits(metric) {
  if (metric === rangeMetric) return;
  rangeMetric = metric;
  rangeUnitEl.textContent = metric ? 'KM' : 'NM';
  for (const b of rangeBtnsEl.querySelectorAll('.atc-range-btn')) {
    const km = Number(b.dataset.range);
    if (km > 0) b.textContent = metric ? String(km) : String(Math.round(km / KM_PER_NM));
  }
}

// RANGE and SHOW are each a mutually exclusive button group: light the clicked one, unlight the rest.
function lightOnly(groupEl, btn) {
  for (const b of groupEl.querySelectorAll('.atc-range-btn')) b.classList.toggle('on', b === btn);
}

factionBtnsEl.addEventListener('click', (e) => {
  const btn = e.target.closest('.atc-range-btn');
  if (!btn) return;
  factionFilter = btn.dataset.faction;
  lightOnly(factionBtnsEl, btn);
  render();
});

rangeBtnsEl.addEventListener('click', (e) => {
  const btn = e.target.closest('.atc-range-btn');
  if (!btn) return;
  rangeKm = Number(btn.dataset.range) || 0;
  lightOnly(rangeBtnsEl, btn);
  render();
});

trackCheckboxEl.addEventListener('change', () => {
  if (!selectedId) { trackCheckboxEl.checked = false; return; }
  trackOn = trackCheckboxEl.checked;
  postCommand({ cmd: 'track', on: trackOn });
});

function postCommand(payload) {
  // NOXMFD's command endpoint requires an exact application/json Content-Type (CommandContentType.
  // IsJson) — fetch() defaults an unadorned string body to text/plain, which the server 415s. Every
  // command sent through this (set-status, locate, track) was silently rejected server-side until
  // this header was added; the status dropdown's own optimistic local update masked it client-side.
  // keepalive lets a command fired right as the page is torn down (see pagehide below) still land.
  // A rejected or unreachable command is logged, not thrown: the page keeps working, and the next
  // frame's published status slice shows what the server actually holds.
  fetch('/ext/atc/command', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    keepalive: true,
  }).then((r) => {
    if (!r.ok) console.warn('[ATC] command rejected:', payload.cmd, r.status);
  }, (err) => console.warn('[ATC] command failed:', payload.cmd, err && err.message));
}

// Click-to-select now doubles as LOCATE ON MAP — a newly selected row (not a click that just
// deselects) also asks MAP to jump to it. Deselecting drops TRACK ON MAP too: "keep following the
// selected unit" has no meaning once nothing is selected, same as it disables the checkbox below.
function selectRow(id) {
  const newlySelected = selectedId !== id && id !== 0;
  selectedId = selectedId === id ? 0 : id;
  if (newlySelected) postCommand({ cmd: 'locate', id: selectedId });
  if (!selectedId && trackOn) {
    trackOn = false;
    postCommand({ cmd: 'track', on: false });
  }
  render();
}

function updateFooter(contactsById) {
  const u = selectedId ? contactsById[selectedId] : null;
  if (!u) {
    selectedLineEl.innerHTML = 'SELECTED: <span class="atc-none">NONE</span>';
    trackCheckboxEl.disabled = true;
    trackCheckboxEl.checked = false;
    return;
  }
  selectedLineEl.textContent = 'SELECTED: ' + (u.pn || u.t);
  trackCheckboxEl.disabled = false;
  trackCheckboxEl.checked = trackOn;
}

function render() {
  if (!lastFrame) return;
  const d = lastFrame;
  const contacts = Array.isArray(d.contacts) ? d.contacts : [];
  const world = d.world;
  renderRangeUnits(!!d.metric);

  const contactsById = {};
  const rows = [];
  for (const u of contacts) {
    if (!u.ac) continue;
    contactsById[u.id] = u;   // before the faction/range filters: the footer still names a filtered-out selection
    if (factionFilter === 'friendly' ? u.f !== 1 : factionFilter === 'enemy' ? u.f !== 2 : false) continue;
    let dist = null;
    if (world) {
      const dx = u.x - world.x, dz = u.z - world.z;
      dist = Math.hypot(dx, dz) / 1000;
    }
    if (rangeKm > 0 && (dist === null || dist > rangeKm)) continue;
    rows.push({ u, dist });
  }
  rows.sort((a, b) => (a.dist ?? Infinity) - (b.dist ?? Infinity));

  // ponytail: render() runs on every ~10 Hz telemetry frame and rebuilds the whole row list from
  // scratch (rowsEl.textContent = '' below) — fine for plain text, but a rebuild while the STATUS
  // list is open would move rows out from under it mid-pick. Skip the rebuild entirely while it's
  // open rather than diffing per-row; the rows are stale only until it closes (closeStatusMenu
  // re-renders). A real fix would reuse row elements by id instead of wiping the list every frame.
  if (statusMenuUnitId) {
    updateFooter(contactsById);
    return;
  }

  rowsEl.textContent = '';
  for (const { u, dist } of rows) {
    const status = statusById[u.id] || 'UNKNOWN';
    const row = document.createElement('div');
    row.className = 'atc-row ' + factionClass(u.f) + (u.id === selectedId ? ' selected' : '');
    row.innerHTML =
      '<span class="atc-c-name">' + escapeHtml(u.pn || u.t) + '</span>' +
      '<button type="button" class="atc-c-status"><span>' + status + '</span></button>' +
      '<span class="atc-c-alt">' + (u.hd && u.al ? u.al : '—') + '</span>' +
      '<span class="atc-c-spd">' + (u.hd && u.sp ? u.sp : '—') + '</span>' +
      '<span class="atc-c-hdg">' + (u.hd && typeof u.h === 'number' ? fmtHdg(u.h) : '—') + '</span>' +
      '<span class="atc-c-dist">' + fmtRng(dist, d.metric) + '</span>' +
      '<span class="atc-c-fuel">' + fmtFuel(u.pf) + '</span>';
    // The row itself is the select action (also fires LOCATE ON MAP, see selectRow) — the STATUS
    // button lives inside the same row, so its own clicks must not bubble into that.
    row.addEventListener('click', (e) => { if (!e.target.closest('.atc-c-status')) selectRow(u.id); });
    const statusBtn = row.querySelector('.atc-c-status');
    statusBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (statusMenuUnitId === u.id) closeStatusMenu();
      else openStatusMenu(u.id, statusBtn);
    });
    rowsEl.appendChild(row);
  }
  emptyEl.style.display = rows.length ? 'none' : '';

  // A selected unit that dropped out of range/detection stays selected (so a brief datalink gap
  // doesn't silently clear the controller's own pick) but the footer reflects it's gone.
  updateFooter(contactsById);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderFrame(d) {
  document.body.classList.remove('no-mission');
  if (d.ext && d.ext.atc) statusById = d.ext.atc;
  lastFrame = d;
  render();
}

function handleNoMission() {
  document.body.classList.add('no-mission');
}

const source = new TelemetrySource({ onFrame: renderFrame, onNoMission: handleNoMission });
source.connect();
window.addEventListener('pagehide', () => {
  // Track mode is a server-side flag with no owner once this page is gone — leaving it on would
  // strand MAP following a unit nobody can un-track anymore.
  if (trackOn) postCommand({ cmd: 'track', on: false });
  source.disconnect();
});
