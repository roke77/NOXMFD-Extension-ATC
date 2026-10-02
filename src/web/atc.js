// ATC page (docs/atc-mfd-plan.md). Opens its own TelemetrySource, the same client-side
// mechanism map.js uses (that module's own header comment: "the ONE EventSource('/stream')... in
// the whole MFD" describes avoiding a second connection from a co-located pane, not a rule against
// another PAGE also being a tap) — NOXMFD.Api has no method to fetch contacts into an extension's
// C#, so this is how the table gets live position/heading/pilot-name/speed/altitude at all. Range/
// distance math mirrors TGT's own telemetry-source.js derivation exactly (same d.world anchor).
import { TelemetrySource } from '/assets/services/telemetry-source.js';
import { fmtRng } from '/assets/services/range-format.js';

const $ = (id) => document.getElementById(id);
const rowsEl = $('rows');
const emptyEl = $('list-empty');
const countEl = $('count');
const selectedLineEl = $('selected-line');
const rangeBtnsEl = $('range-btns');
const rangeUnitEl = $('range-unit');
const factionBtnsEl = $('faction-btns');
const statusBtnEl = $('status-btn');
const statusBtnLabelEl = $('status-btn-label');
const clearBtnEl = $('clear-btn');
const locateBtnEl = $('locate-btn');
const trackBtnEl = $('track-btn');
const statusMenuEl = $('status-menu');
const statusMenuNameEl = $('status-menu-name');
const statusGridEl = $('status-grid');
const scrimEl = $('status-scrim');

// The ticket's enum (issue #89) minus UNKNOWN, which is "no assignment" — CLEAR STATUS sends it.
// Flight-phase order; EMERGENCY last, set apart in the list.
const STATUS_VALUES = ['PARKED', 'TAXI', 'TAKEOFF', 'DEPARTURE', 'ENROUTE', 'HOLDING',
  'ARRIVAL', 'APPROACH', 'FINAL', 'LANDED', 'EMERGENCY'];
// Badge / lamp colour per status, matching the MAP ring (AtcStatus.cs ColorFor).
const STATUS_ACCENT = { HOLDING: 'var(--no-amber)', EMERGENCY: 'var(--no-red)' };

let lastFrame = null;      // the raw frame from the last onFrame — re-rendered on a filter change too
let rangePreset = 0;       // the RANGE button's number, 0 = ALL — km or nm, per the frame's `metric`
let showFriendly = true;   // SHOW toggles — neutrals only ever show while both are on
let showEnemy = true;
let rangeMetric = null;    // unit the RANGE labels currently show (frame's `metric`); null = not drawn yet
let selectedId = 0;        // 0 = nothing selected
let statusById = {};       // unitId -> status string, from this extension's own published slice
let trackOn = false;       // TRACK ON MAP state, mirrored to NOXMFD via the 'track' command
let menuOpen = false;

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
function fuelClass(pf) {
  return typeof pf !== 'number' || pf < 0 ? 'none' : pf < 0.15 ? 'low' : pf < 0.30 ? 'warn' : '';
}

function factionClass(f) {
  return f === 1 ? 'f-friendly' : f === 2 ? 'f-enemy' : 'f-neutral';
}

// u.t is the unit's name: a pilot's aircraft is "<callsign> [<type>]" (NOXMFD renames it, see its
// docs/squad-callsign-names.md), an AI unit is just its type name.
function aircraftType(u) {
  const m = /\[(.+)\]\s*$/.exec(u.t || '');
  return m ? m[1] : u.pn ? u.t : '';
}

// The RANGE presets are one set of round numbers; the unit follows the player's Metric/Imperial
// setting (the frame's top-level `metric`, which the game's units option and NOXMFD's Toggle Units
// keybind both change), so the same button filters at its number of km or of nm.
const KM_PER_NM = 1.852;
function renderRangeUnits(metric) {
  if (metric === rangeMetric) return;
  rangeMetric = metric;
  rangeUnitEl.textContent = metric ? 'KM' : 'NM';
}

rangeBtnsEl.addEventListener('click', (e) => {
  const btn = e.target.closest('.atc-btn');
  if (!btn) return;
  rangePreset = Number(btn.dataset.range) || 0;
  for (const b of rangeBtnsEl.querySelectorAll('.atc-btn')) b.classList.toggle('on', b === btn);
  render();
});

factionBtnsEl.addEventListener('click', (e) => {
  const btn = e.target.closest('.atc-btn');
  if (!btn) return;
  btn.classList.toggle('on');
  showFriendly = factionBtnsEl.querySelector('[data-faction="friendly"]').classList.contains('on');
  showEnemy = factionBtnsEl.querySelector('[data-faction="enemy"]').classList.contains('on');
  render();
});

function postCommand(payload) {
  // NOXMFD's command endpoint requires an exact application/json Content-Type (CommandContentType.
  // IsJson) — fetch() defaults an unadorned string body to text/plain, which the server 415s.
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

// Selecting a row doubles as LOCATE ON MAP — a newly selected row (not a click that just
// deselects) also asks MAP to jump to it. Deselecting drops TRACK ON MAP too: "keep following the
// selected unit" has no meaning once nothing is selected.
function selectRow(id) {
  const newlySelected = selectedId !== id && id !== 0;
  selectedId = selectedId === id ? 0 : id;
  if (newlySelected) postCommand({ cmd: 'locate', id: selectedId });
  if (!selectedId) {
    closeStatusMenu();
    if (trackOn) {
      trackOn = false;
      postCommand({ cmd: 'track', on: false });
    }
  }
  render();
}

rowsEl.addEventListener('click', (e) => {
  const row = e.target.closest('.atc-row');
  if (row) selectRow(Number(row.dataset.id));
});

// ── STATUS list: a themed panel rising from the action bar over the table. Its items are built
// once; openStatusMenu/refreshStatusMenu only light the current one.
for (const s of STATUS_VALUES) {
  const item = document.createElement('button');
  item.type = 'button';
  item.className = 'lit atc-status-item' + (s === 'EMERGENCY' ? ' emergency' : '');
  item.dataset.status = s;
  item.setAttribute('role', 'option');
  item.textContent = s;
  if (STATUS_ACCENT[s]) item.style.setProperty('--accent', STATUS_ACCENT[s]);
  statusGridEl.appendChild(item);
}

function refreshStatusMenu(u) {
  const current = statusById[selectedId] || 'UNKNOWN';
  statusMenuNameEl.textContent = u ? (u.pn || u.t) : '';
  for (const item of statusGridEl.children) {
    const on = item.dataset.status === current;
    item.classList.toggle('on', on);
    item.setAttribute('aria-selected', String(on));
  }
}

function openStatusMenu() {
  if (!selectedId) return;
  menuOpen = true;
  statusMenuEl.hidden = scrimEl.hidden = false;
  statusBtnEl.setAttribute('aria-expanded', 'true');
  refreshStatusMenu(lastContacts[selectedId]);
  // Rises from the action bar and leaves the bar itself uncovered, so STATUS closes it again.
  const bar = statusBtnEl.getBoundingClientRect();
  statusMenuEl.style.bottom = window.innerHeight - bar.top + 8 + 'px';
  scrimEl.style.bottom = window.innerHeight - bar.top + 'px';
}

function closeStatusMenu() {
  if (!menuOpen) return;
  menuOpen = false;
  statusMenuEl.hidden = scrimEl.hidden = true;
  statusBtnEl.setAttribute('aria-expanded', 'false');
}

function setStatus(unitId, status) {
  postCommand({ cmd: 'set-status', id: unitId, status });
  // Optimistic local update — the next frame's published slice confirms/overwrites it, but there's
  // no reason to wait a tick to reflect the controller's own pick.
  statusById[unitId] = status;
  closeStatusMenu();
  render();
}

statusBtnEl.addEventListener('click', () => (menuOpen ? closeStatusMenu() : openStatusMenu()));
statusGridEl.addEventListener('click', (e) => {
  const item = e.target.closest('.atc-status-item');
  if (item && selectedId) setStatus(selectedId, item.dataset.status);
});
clearBtnEl.addEventListener('click', () => { if (selectedId) setStatus(selectedId, 'UNKNOWN'); });
locateBtnEl.addEventListener('click', () => { if (selectedId) postCommand({ cmd: 'locate', id: selectedId }); });
trackBtnEl.addEventListener('click', () => {
  if (!selectedId) return;
  trackOn = !trackOn;
  postCommand({ cmd: 'track', on: trackOn });
  updateFooter(lastContacts);
});
// A click on the dimmed table, Escape, or a resize (the panel is placed against the action bar once)
// closes the list without a change.
scrimEl.addEventListener('click', closeStatusMenu);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeStatusMenu(); });
window.addEventListener('resize', closeStatusMenu);

let lastContacts = {};     // unitId -> contact, every aircraft in the frame (before the filters)

function updateFooter() {
  const u = selectedId ? lastContacts[selectedId] : null;
  const status = statusById[selectedId] || 'UNKNOWN';
  if (!u) {
    selectedLineEl.innerHTML = 'SELECTED <span class="atc-none">NONE</span>';
    statusBtnLabelEl.textContent = 'STATUS';
    closeStatusMenu();
  } else {
    const sub = u.psn || aircraftType(u);
    selectedLineEl.innerHTML = 'SELECTED <span class="atc-sel-name ' + factionClass(u.f) + '">' + escapeHtml(u.pn || u.t) + '</span>' +
      (sub ? '<span class="atc-sel-sub">' + escapeHtml(sub) + '</span>' : '');
    statusBtnLabelEl.textContent = 'STATUS · ' + (status === 'UNKNOWN' ? 'NONE' : status);
    if (menuOpen) refreshStatusMenu(u);
  }
  for (const b of [statusBtnEl, clearBtnEl, locateBtnEl, trackBtnEl]) b.disabled = !u;
  clearBtnEl.disabled = !u || status === 'UNKNOWN';
  trackBtnEl.classList.toggle('on', !!u && trackOn);
  trackBtnEl.setAttribute('aria-pressed', String(!!u && trackOn));
}

function rowHtml(u, dist, metric) {
  const status = statusById[u.id] || 'UNKNOWN';
  // A pilot running NOXMFD arrives under their callsign with their Steam name in `psn`; a friendly
  // pilot with a name but no `psn` isn't running it. Enemies never carry a callsign (it is only
  // broadcast within a faction), so they get no second line.
  const sub = u.psn ? '<i>' + escapeHtml(u.psn) + '</i>'
    : u.f === 1 && u.pn ? '<i class="plain">NO CALLSIGN</i>' : '';
  const type = aircraftType(u);
  const accent = status === 'EMERGENCY' ? ' emergency' : status === 'HOLDING' ? ' holding' : status === 'UNKNOWN' ? ' none' : '';
  return '<span class="atc-c-name"><b>' + escapeHtml(u.pn || u.t) + '</b>' + sub + '</span>' +
    '<span class="atc-c-type">' + (type ? escapeHtml(type) : '—') + '</span>' +
    '<span class="atc-c-status"><span class="atc-badge' + accent + '">' + (status === 'UNKNOWN' ? '—' : status) + '</span></span>' +
    '<span class="atc-c-alt">' + (u.hd && u.al ? escapeHtml(u.al) : '—') + '</span>' +
    '<span class="atc-c-spd">' + (u.hd && u.sp ? escapeHtml(u.sp) : '—') + '</span>' +
    '<span class="atc-c-hdg">' + (u.hd && typeof u.h === 'number' ? fmtHdg(u.h) : '—') + '</span>' +
    '<span class="atc-c-dist">' + fmtRng(dist, metric) + '</span>' +
    '<span class="atc-c-fuel ' + fuelClass(u.pf) + '">' + fmtFuel(u.pf) + '</span>';
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
    contactsById[u.id] = u;   // before the filters: the footer still names a filtered-out selection
    if (u.f === 1 ? !showFriendly : u.f === 2 ? !showEnemy : !(showFriendly && showEnemy)) continue;
    let dist = null;
    if (world) {
      const dx = u.x - world.x, dz = u.z - world.z;
      dist = Math.hypot(dx, dz) / 1000;
    }
    if (rangePreset > 0 && (dist === null || dist > rangePreset * (d.metric ? 1 : KM_PER_NM))) continue;
    rows.push({ u, dist });
  }
  rows.sort((a, b) => (a.dist ?? Infinity) - (b.dist ?? Infinity));
  lastContacts = contactsById;

  // ponytail: rebuilds the whole row list on every ~10 Hz telemetry frame — fine for plain text.
  // A real fix would reuse row elements by id instead of wiping the list every frame.
  rowsEl.textContent = '';
  for (const { u, dist } of rows) {
    const row = document.createElement('div');
    row.className = 'atc-row ' + factionClass(u.f) + (u.psn ? ' noxmfd' : '') + (u.id === selectedId ? ' selected' : '');
    row.dataset.id = u.id;
    row.innerHTML = rowHtml(u, dist, d.metric);
    rowsEl.appendChild(row);
  }
  emptyEl.style.display = rows.length ? 'none' : '';

  const noxmfd = rows.reduce((n, { u }) => n + (u.psn ? 1 : 0), 0);
  countEl.innerHTML = 'TRAFFIC <b>(' + rows.length + ')</b>' + (noxmfd ? ' · <i>' + noxmfd + ' NOXMFD</i>' : '');

  // A selected unit that dropped out of range/detection stays selected (so a brief datalink gap
  // doesn't silently clear the controller's own pick) but the footer reflects it's gone.
  updateFooter();
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
