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
| 2 | Fuel | Missing — needs a NOXMFD core change | `TelemetryReader.cs:874` reads fuel (`aircraft.GetFuelLevel()`) only for the local player's own aircraft; `TelemetrySnapshot.Fuel` is one top-level `float`, not an array. `UnitInfo` has no fuel field for any other unit. |
| 3 | Distance / range presets | Partial — pattern exists, anchor doesn't | No server-side "reference position" concept exists anywhere. TGT's own RNG column computes range client-side against the local player's `WorldX/WorldZ` (`telemetry-source.js:333-335`, formatted by `range-format.js:5-9`). The same client-side formula covers range presets directly — resolved to use that same local-player anchor, see decisions. |
| 4 | ATC Status assignment | Supported today, no core change | Pure bookkeeping — doesn't touch the aircraft. The extension can own an in-memory `Dictionary<unitId, status>` and publish it back through its own `NOXMFD.Api.PublishSlice`, keyed by `UnitInfo.Id` (`TelemetrySnapshot.cs:524`, `Unit.persistentID.Id` — stable across frames). |
| 5 | Two-way MAP ↔ ATC selection | Missing — needs a NOXMFD core change | MAP's click-to-select is local-only client state (`map.js:1200`, `selectAt`) — never sent to the server, never broadcast anywhere. The only existing "selected/focused unit" concept, `TargetFocus.cs` / `TelemetrySnapshot.FocusedTargetId`, tracks a *weapon lock*, is read-only from JS, and has no `Api` method to set it from outside. |
| 6 | Per-instance status ring on MAP | Missing — needs a NOXMFD core change | `Api.cs`'s only coloring surface (`SetFactionColorOverride`/`SetUnitTypeColorOverride`) keys by unit **type** string, optionally filtered by faction (`IconColorRegistry.cs:64-98`) — there's no per-unit-id override anywhere. |

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

- **(a) Per-unit fuel in telemetry.** Extend `UnitInfo`/`TelemetryReader` to read fuel for every
  aircraft, not just the local player's (`TelemetryReader.cs:874` is local-player-only today).
  Needs confirming first whether `GetFuelLevel()` (or an equivalent) is even readable against a
  non-local `Aircraft` component before committing to the design.
- **(b) Per-instance icon color/ring override.** A new `Api` surface keyed by unit id (e.g.
  `SetUnitColorOverride(id, hex)` or a ring-only variant, alongside the existing type-keyed
  overrides), plus a MAP.js change to draw it layered over the existing faction/type icon rather
  than replacing it.
- **(c) A shared, extension-writable "selected unit" concept.** A new `Api` method pair (e.g.
  `SetSelectedUnit(id)` plus a way to read the current selection) that both MAP.js and any
  extension can read and write, so LOCATE ON MAP and MAP → ATC sync both go through one mechanism.
  `TargetFocus.cs` is the closest existing analog but is lock-specific and read-only — this needs
  its own, more general concept rather than repurposing it.

## Design decisions

1. **Callsign → `PilotName`.** NOXMFD's telemetry has no squadron-style callsign field (the
   ticket mockup's `VIPER2`/`ACE01` look invented for the example) — the Callsign column shows the
   controlling pilot's display name. Revisit only if this feels wrong once played.
2. **ATC/reference position → the ATC player's own current position.** Same convention TGT's RNG
   column already uses. No settable/fixed anchor, no new UI to place or move one.
3. **ATC Status is session-only.** The in-memory `Dictionary<unitId, status>` resets on plugin
   reload/session restart. Not persisted to disk.

## What's built

Nothing yet. Phase 1 scope is fully decided — ready to start implementation.
