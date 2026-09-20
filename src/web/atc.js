// ATC page — Phase 1 (docs/atc-mfd-plan.md). Opens its own TelemetrySource, the same client-side
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
const statusSelectEl = document.getElementById('status-select');
const rangeBtnsEl = document.getElementById('range-btns');

let lastFrame = null;      // the raw frame from the last onFrame — re-rendered on a range change too
let rangeKm = 0;           // 0 = ALL
let selectedId = 0;        // 0 = nothing selected
let statusById = {};       // unitId -> status string, from this extension's own published slice

function fmtHdg(deg) {
  return Math.round(((deg % 360) + 360) % 360) + '°';
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

statusSelectEl.addEventListener('change', () => {
  if (!selectedId) return;
  fetch('/ext/atc/command', {
    method: 'POST',
    body: JSON.stringify({ cmd: 'set-status', id: selectedId, status: statusSelectEl.value }),
  });
  // Optimistic local update — the next frame's published slice will confirm/overwrite this, but
  // there's no reason to wait a tick to reflect the pilot's own click.
  statusById[selectedId] = statusSelectEl.value;
  render();
});

function selectRow(id) {
  selectedId = selectedId === id ? 0 : id;
  render();
}

function updateFooter(contactsById) {
  const u = selectedId ? contactsById[selectedId] : null;
  if (!u) {
    selectedLineEl.innerHTML = 'SELECTED: <span class="atc-none">NONE</span>';
    statusSelectEl.disabled = true;
    statusSelectEl.value = 'UNKNOWN';
    return;
  }
  const status = statusById[selectedId] || 'UNKNOWN';
  selectedLineEl.textContent = 'SELECTED: ' + (u.pn || u.t);
  statusSelectEl.disabled = false;
  statusSelectEl.value = status;
}

function render() {
  if (!lastFrame) return;
  const d = lastFrame;
  const contacts = Array.isArray(d.contacts) ? d.contacts : [];
  const world = d.world;

  const contactsById = {};
  const rows = [];
  for (const u of contacts) {
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

  rowsEl.textContent = '';
  for (const { u, dist } of rows) {
    const status = statusById[u.id] || 'UNKNOWN';
    const row = document.createElement('div');
    row.className = 'atc-row ' + factionClass(u.f) + (u.id === selectedId ? ' selected' : '');
    row.innerHTML =
      '<span class="atc-c-name">' + escapeHtml(u.pn || u.t) + '</span>' +
      '<span class="atc-c-status" data-status="' + status + '">' + status + '</span>' +
      '<span class="atc-c-alt">' + (u.hd && u.al ? u.al : '—') + '</span>' +
      '<span class="atc-c-spd">' + (u.hd && u.sp ? u.sp : '—') + '</span>' +
      '<span class="atc-c-hdg">' + (u.hd && typeof u.h === 'number' ? fmtHdg(u.h) : '—') + '</span>' +
      '<span class="atc-c-dist">' + fmtRng(dist, d.metric) + '</span>' +
      '<span class="atc-c-fuel">—</span>';
    row.addEventListener('click', () => selectRow(u.id));
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
window.addEventListener('pagehide', () => source.disconnect());
