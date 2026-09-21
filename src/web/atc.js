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
const trackCheckboxEl = document.getElementById('track-checkbox');

const STATUS_VALUES = ['UNKNOWN', 'PARKED', 'TAXI', 'TAKEOFF', 'DEPARTURE', 'ENROUTE', 'HOLDING',
  'ARRIVAL', 'APPROACH', 'FINAL', 'LANDED', 'EMERGENCY'];
function statusOptionsHtml(selected) {
  return STATUS_VALUES.map(function(s) {
    return '<option value="' + s + '"' + (s === selected ? ' selected' : '') + '>' + s + '</option>';
  }).join('');
}

let lastFrame = null;      // the raw frame from the last onFrame — re-rendered on a range change too
let rangeKm = 0;           // 0 = ALL
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

rangeBtnsEl.addEventListener('click', (e) => {
  const btn = e.target.closest('.atc-range-btn');
  if (!btn) return;
  rangeKm = Number(btn.dataset.range) || 0;
  for (const b of rangeBtnsEl.querySelectorAll('.atc-range-btn')) b.classList.toggle('on', b === btn);
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
  fetch('/ext/atc/command', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    keepalive: true,
  });
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

  const contactsById = {};
  const rows = [];
  for (const u of contacts) {
    if (!u.ac) continue;
    contactsById[u.id] = u;
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
  // scratch (rowsEl.textContent = '' below) — fine for plain text, but a live rebuild would yank a
  // status <select> out from under a pilot mid-pick, closing it before they can choose. Skip the
  // rebuild entirely while one has focus rather than diffing per-row; the list is stale for at most
  // a frame or two and self-heals the moment they blur it. A real fix would reuse row elements by
  // id instead of wiping the list every frame.
  if (rowsEl.contains(document.activeElement) && document.activeElement.classList.contains('atc-c-status')) {
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
      '<select class="atc-c-status" data-status="' + status + '">' + statusOptionsHtml(status) + '</select>' +
      '<span class="atc-c-alt">' + (u.hd && u.al ? u.al : '—') + '</span>' +
      '<span class="atc-c-spd">' + (u.hd && u.sp ? u.sp : '—') + '</span>' +
      '<span class="atc-c-hdg">' + (u.hd && typeof u.h === 'number' ? fmtHdg(u.h) : '—') + '</span>' +
      '<span class="atc-c-dist">' + fmtRng(dist, d.metric) + '</span>' +
      '<span class="atc-c-fuel">' + fmtFuel(u.pf) + '</span>';
    // The row itself is the select action (also fires LOCATE ON MAP, see selectRow) — the status
    // dropdown lives inside the same row, so its own clicks must not bubble into that.
    row.addEventListener('click', (e) => { if (!e.target.closest('select')) selectRow(u.id); });
    const statusSel = row.querySelector('.atc-c-status');
    statusSel.addEventListener('click', (e) => e.stopPropagation());
    statusSel.addEventListener('change', () => {
      postCommand({ cmd: 'set-status', id: u.id, status: statusSel.value });
      // Optimistic local update (and the dataset attribute the color-by-status CSS reads) — the
      // next frame's published slice will confirm/overwrite this, but there's no reason to wait a
      // tick to reflect the pilot's own pick.
      statusById[u.id] = statusSel.value;
      statusSel.dataset.status = statusSel.value;
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
