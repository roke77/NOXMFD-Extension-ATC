# ATC MFD — planning

## Status

Planning — nothing built yet. This records a feasibility pass of
[roke77/NOXMFD#89](https://github.com/roke77/NOXMFD/issues/89) against NOXMFD's actual telemetry
and extension API (as of NOXMFD 0.51.1), lays out a phased plan, and records the design decisions
below. Phase 1 is ready to start.

## Source ticket

Player-submitted, [issue #89](https://github.com/roke77/NOXMFD/issues/89): a single-page ATC MFD
for a human player acting as Air Traffic Control in multiplayer. Guiding principle from the
ticket: **"MAP MFD = Where are the aircraft? ATC MFD = Who are they and what are they doing?"**

Requirements, as written:

1. **Traffic table** — one row per detected aircraft: Callsign, ATC Status, Altitude, Speed,
   Heading, Distance from an ATC/reference position, Fuel level. Auto-updating.
2. **ATC Status** — the controller assigns a status (PARKED/TAXI/TAKEOFF/DEPARTURE/ENROUTE/
   HOLDING/ARRIVAL/APPROACH/FINAL/LANDED/EMERGENCY/UNKNOWN) to a selected aircraft via a dropdown.
   Bookkeeping only — it doesn't need to control the aircraft.
3. **Range presets** — 5 / 10 / 25 / 50 / 100 / ALL km, filtering the table to aircraft within
   that range of the ATC/reference position.
4. **Two-way selection sync with MAP** — selecting a row offers a LOCATE ON MAP action
   (select + center + label on the MAP page); selecting a unit on MAP selects the matching ATC row.
5. **ATC status on MAP** — a colored ring/marker per aircraft *instance*, layered over its normal
   faction/type icon, reflecting its currently assigned ATC status.
6. **Explicitly not wanted**: a second map, a radar interface, automatic ATC commands, a
   simulated clearance system, flight-plan management.

## Feasibility findings

| # | Requirement | Status | Notes |
|---|---|---|---|
| 1 | Traffic table | Partial | `UnitInfo` (`TelemetrySnapshot.cs:522-578`, serialized by `TelemetryJson.cs`'s `UnitsArray`) already carries a stable id, unit type, position, heading, faction, `PilotName`, and `SpeedReading`/`AltReading` (only when `HasDetail`). No field maps cleanly to "Callsign" (resolved as `PilotName`, see decisions), and there's no per-unit fuel or distance field. |
| 2 | Fuel | Missing — needs a NOXMFD core change | `TelemetryReader.cs:874` reads fuel (`aircraft.GetFuelLevel()`) only for the local player's own aircraft; `TelemetrySnapshot.Fuel` is one top-level `float`, not an array. `UnitInfo` has no fuel field for any other unit. Also needs its own visibility gate — see [Data-visibility model](#data-visibility-model) and decision 5. |
| 3 | Distance / range presets | Partial — pattern exists, anchor doesn't | No server-side "reference position" concept exists anywhere. TGT's own RNG column computes range client-side against the local player's `WorldX/WorldZ` (`telemetry-source.js:333-335`, formatted by `range-format.js:5-9`). The same client-side formula covers range presets directly — resolved to use that same local-player anchor, see decisions. |
| 4 | ATC Status assignment | Supported today, no core change | Pure bookkeeping — doesn't touch the aircraft. The extension can own an in-memory `Dictionary<unitId, status>` and publish it back through its own `NOXMFD.Api.PublishSlice`, keyed by `UnitInfo.Id` (`TelemetrySnapshot.cs:524`, `Unit.persistentID.Id` — stable across frames). |
| 5 | Two-way MAP ↔ ATC selection | Missing — needs a NOXMFD core change | MAP's click-to-select is local-only client state (`map.js:1200`, `selectAt`) — never sent to the server, never broadcast anywhere. The only existing "selected/focused unit" concept, `TargetFocus.cs` / `TelemetrySnapshot.FocusedTargetId`, tracks a *weapon lock*, is read-only from JS, and has no `Api` method to set it from outside. |
| 6 | Per-instance status ring on MAP | Missing — needs a NOXMFD core change | `Api.cs`'s only coloring surface (`SetFactionColorOverride`/`SetUnitTypeColorOverride`) keys by unit **type** string, optionally filtered by faction (`IconColorRegistry.cs:64-98`) — there's no per-unit-id override anywhere. |
| 7 | Aircraft-only filtering | Missing — needs a NOXMFD core change | The `contacts` array (`UnitInfo`) carries no per-contact "is this an aircraft" tag. One already exists server-side, just not exposed there: HSD's own `BuildHsd` (`TelemetryReader.cs:1352-1353`) filters with `u.definition.typeIdentity.air <= 0.5f` — the game's own native classification score. See decision 6. |

## Data-visibility model

Since the traffic table shows all factions (decision 4), checked what NOXMFD's telemetry already
restricts for enemy/neutral contacts, so nothing in this extension leaks data a real ATC
controller couldn't have.

NOXMFD has exactly **one** faction-sensitive gate today: fog-of-war / lock freshness. `HasDetail`
(`TelemetryReader.cs:1624`: `(u is Aircraft || u is Missile) && !stale`) is what blanks
`SpeedReading`/`AltReading` for a contact — and `stale` (`TelemetryReader.cs:1610`) only ever
applies to enemies, derived from the faction HQ's own tracking database (`datalink`,
`TelemetryReader.cs:1603`, itself enemy-only). Position/heading pass through the same gate
(`TryGetKnownPosition`, `TelemetryReader.cs:1586` — the game's own fog-of-war resolution, same one
the native HUD/radar blip uses). Once a contact clears that gate — i.e. it's actively sensor-locked,
not stale — SPD/ALT/HDG show identically regardless of faction, which is realistic: you can infer
kinematics from an active radar lock.

`PilotName` (the Callsign column, decision 1) is **explicitly not** faction-gated beyond that same
check — confirmed intentional by a comment at `TelemetrySnapshot.cs:557-561` ("works on enemy
aircraft too"). So Phase 1's existing columns (Callsign, SPD/ALT/HDG, position-derived distance)
need no new restriction — they already inherit the correct, existing trust model as-is.

**Fuel doesn't fit that model.** Speed/altitude/heading are things a lock plausibly reveals; a
fuel quantity isn't observable by radar or visual tracking the way kinematics are. Reusing the
`HasDetail` gate for fuel (Phase 2) would let a locked enemy's fuel show, which is the leak
flagged during planning — see decision 5.

## Telemetry wiring

`NOXMFD.Api` has no method to fetch the current contacts/position snapshot into an extension's C#
— `PublishSlice` only pushes data the extension itself computed. To get live contacts (position,
heading, `PilotName`, faction, `SpeedReading`/`AltReading`) into the ATC page at all, its JS imports
`/assets/services/telemetry-source.js` and opens its own `TelemetrySource(...).connect()` — the
exact same mechanism `map.js` uses (`telemetry-source.js:66-140`), reading `d.contacts`/`d.world`
straight off the frame. Same-origin, no gate, zero new NOXMFD core surface needed.

Worth naming as a real trade-off: `telemetry-source.js` is an internal module (`src/web/services/`),
not part of the versioned surface `EXTENSIONS.md` documents and `BepInDependency` version-pins
protect. A future NOXMFD refactor of the wire format could break this extension silently, with no
version bump to warn it. The alternative — reimplementing NOXMFD's own unit-scanning and
fog-of-war/trust logic independently in this extension's C# — is worse: far more code, and it would
bypass the same trust boundary [Data-visibility model](#data-visibility-model) relies on, undoing
the friendly-only fuel gate's whole point. Taking the dependency on the internal module is the
better trade.

## Recommended phasing

### Phase 1 — extension-only, ships against NOXMFD as it stands today

No NOXMFD core changes required. Scope: the table, status assignment, and range presets — no MAP
visual or selection integration yet.

- **Table columns**: id, unit type, `PilotName` (as Callsign — decision 1), heading,
  `SpeedReading`/`AltReading` (blank when `!HasDetail`, matching TGT's own COMPACT behavior),
  distance computed client-side against the local player's own `WorldX/WorldZ` (decision 2, TGT's
  exact formula, no new anchor UI needed). **Fuel column shows `—` for every row** — no per-unit
  data exists yet; the column stays in the layout so Phase 2 can fill it in without a table
  redesign.
- **Rows**: every detected *contact* across all factions (decision 4) — no friendly-only filter.
  `UnitInfo.Faction` is already in the payload, so the column can show/color by faction for free.
  **Not filtered to aircraft** (decision 6) — ground/ship/building contacts show up alongside
  aircraft until Phase 2's real classification flag lands; a known, temporary gap, not a bug.
- **ATC Status**: dropdown on a selected row, backed by an in-memory `Dictionary<unitId, status>`
  inside the extension's own plugin. Resets on plugin reload/session restart by design — not
  persisted (decision 3).
- **Range presets**: client-side filter over the same distance value.
- **Not in this phase**: LOCATE ON MAP, MAP → ATC sync, and the MAP status ring all require the
  Phase 2 core surfaces below and are left as future work indicators in the UI (disabled/no-op)
  rather than blocking the rest of the page.

### Phase 2 — needs new NOXMFD core surface

Each item is a feature request against `roke77/NOXMFD` itself — a separate PR/release in the main
repo, not something buildable from this extension's own source, following the same boundary every
other NOXMFD extension already respects (EXTENSIONS.md: extensions never edit NOXMFD's own code).

- **(a) Fuel — squad-only, not a telemetry field.** Revised after investigation on the NOXMFD side
  (`roke77/NOXMFD` `docs/atc-extension-support.md`, item 1): `GetFuelLevel()` only works for the
  local player's own aircraft — a non-local aircraft's `FuelTank` component is disabled entirely
  (`aircraft.LocalSim` gate), so its fuel reading is simply wrong, not approximate. The game has no
  networked "current fuel" value for any aircraft besides the one the reading player is flying.
  Fuel now travels player-to-player over NOXMFD's existing squadron transport instead — which also
  narrows the column from **friendly** to **squad**: only aircraft flown by a pilot in the ATC
  controller's own squad ever show a fuel number; every other row, friendly or not, always shows
  `—`. Decision 5 below is updated to match.
- **(b) Per-instance icon color/ring override.** A new `Api` surface keyed by unit id (e.g.
  `SetUnitColorOverride(id, hex)` or a ring-only variant, alongside the existing type-keyed
  overrides), plus a MAP.js change to draw it layered over the existing faction/type icon rather
  than replacing it.
- **(c) A shared, extension-writable "selected unit" concept.** A new `Api` method pair (e.g.
  `SetSelectedUnit(id)` plus a way to read the current selection) that both MAP.js and any
  extension can read and write, so LOCATE ON MAP and MAP → ATC sync both go through one mechanism.
  `TargetFocus.cs` is the closest existing analog but is lock-specific and read-only — this needs
  its own, more general concept rather than repurposing it.
- **(d) A real aircraft-classification flag on `UnitInfo`.** Not a new design — `BuildHsd` already
  filters aircraft this way for HSD's own contact list (`u.definition.typeIdentity.air <= 0.5f`,
  `TelemetryReader.cs:1352-1353`). Exposing the same check as an `IsAircraft` (or similar) field on
  the main `contacts`/`UnitInfo` array is a small, low-risk addition, not novel classification work.

## Design decisions

1. **Callsign → `PilotName`.** NOXMFD's telemetry has no squadron-style callsign field (the
   ticket mockup's `VIPER2`/`ACE01` look invented for the example) — the Callsign column shows the
   controlling pilot's display name. Revisit only if this feels wrong once played.
2. **ATC/reference position → the ATC player's own current position.** Same convention TGT's RNG
   column already uses. No settable/fixed anchor, no new UI to place or move one.
3. **ATC Status is session-only.** The in-memory `Dictionary<unitId, status>` resets on plugin
   reload/session restart. Not persisted to disk.
4. **Traffic table shows all factions** (friendly, enemy, neutral) — not friendly-only. The
   ticket never states a scope; "detected aircraft" is read literally, matching section 5's
   implication that faction stays visible alongside the status ring. `UnitInfo.Faction`
   (`TelemetrySnapshot.cs:529`) is already present per row, so this needs no new telemetry — just
   no client-side faction filter in Phase 1.
5. **Fuel is squad-only, always** (Phase 2; revised from "friendly-only" — see phasing item (a)).
   No networked value exists for another aircraft's true current fuel, so it can't come through
   telemetry at all — the only accurate source is each pilot's own NOXMFD instance, shared with
   their squad over the existing squadron transport. A friendly aircraft outside the controller's
   own squad shows `—` for fuel, same as an enemy or neutral row — this is narrower than the
   original "friendly-only" framing in [Data-visibility model](#data-visibility-model), not a
   relaxation of it.
6. **Phase 1 ships without aircraft-only filtering.** No per-contact tag exists to filter on today
   (decision — see feasibility row 7); rather than approximate it with an unreliable heuristic,
   Phase 1 shows every detected contact type and Phase 2 adds the real flag (item (d), reusing
   HSD's own existing `typeIdentity.air` check server-side).

## What's built

**Status**: Phase 1 built, layout-verified against synthetic data. Not yet checked in-game.

| File | What |
|---|---|
| [`src/plugin/Plugin.cs`](../src/plugin/Plugin.cs) | Registers the **ATC** EXT page with a command handler (`AtcStatus.HandleCommand`). |
| [`src/plugin/AtcStatus.cs`](../src/plugin/AtcStatus.cs) | The session-only `unitId → status` map (decision 3), the `set-status` command handler (validates against the ticket's own 12-value enum), and the push back to every connected pane via `NOXMFD.Api.PublishSlice`. |
| [`src/web/atc.js`](../src/web/atc.js) | Opens its own `TelemetrySource` (see [Telemetry wiring](#telemetry-wiring)), renders the table (sorted by distance, faction-tinted per TGT's own convention), range-preset filtering, row selection, and posts status changes to `/ext/atc/command`. |
| [`src/web/atc.html`](../src/web/atc.html) / [`atc.css`](../src/web/atc.css) | The page itself — header, range-preset bar, table, SELECTED/STATUS/LOCATE ON MAP footer (issue #89's own mockup), and a shared `.mfd-empty` no-mission state. |

Not built this phase (Phase 2, needs core NOXMFD changes first): fuel column (always shows `—`),
aircraft-only filtering (every contact type shows), LOCATE ON MAP (button renders disabled), and
MAP → ATC sync.

**Verification performed**:
- `dotnet build -c Release` — 0 errors.
- No dev-server harness exists for extension pages (`tools/serve_web.py` only mocks NOXMFD's own
  first-party pages), so the real `atc.html`/`atc.css`/`atc.js` were checked against a synthetic
  `TelemetrySource` stub emitting a fixed six-contact frame (mixed factions, mixed `HasDetail`, an
  `ext.atc` status slice) over a local static server: confirmed faction tinting, the `ext.atc`
  status merge, blank ALT/SPD/HDG when `!hd`, distance sort, range-preset filtering, row selection
  (amber outline, footer SELECTED/STATUS populate and enable), and the always-blank fuel column.
- Not exercised: the real `/stream` connection, the real `/ext/atc/command` POST round-trip, and
  the no-mission empty state — all need the actual game running NOXMFD + this extension together.
