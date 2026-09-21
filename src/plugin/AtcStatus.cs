using System;
using System.Collections.Generic;
using System.Text;
using UnityEngine;

namespace AtcModule
{
    // ATC Status bookkeeping (docs/atc-mfd-plan.md, decision 3): pure bookkeeping the ATC player
    // assigns per unit, never touches the aircraft itself. Server-side and in-memory only — shared
    // across every connected pane/tab for the session (so a second ATC panel sees the same
    // assignments), reset on plugin reload/session restart by design, never persisted to disk.
    //
    // The unit id is opaque here — UnitInfo.Id (Unit.persistentID.Id) on NOXMFD's side, uint on the
    // wire — this plugin never resolves it to an actual Unit, it just echoes it back in the
    // published slice for the page's own JS to match against its own telemetry rows.
    internal static class AtcStatus
    {
        // Mirrors the ticket's own enum (issue #89) exactly — HandleCommand rejects anything else.
        private static readonly HashSet<string> Valid = new HashSet<string>
        {
            "PARKED", "TAXI", "TAKEOFF", "DEPARTURE", "ENROUTE", "HOLDING",
            "ARRIVAL", "APPROACH", "FINAL", "LANDED", "EMERGENCY", "UNKNOWN",
        };

        private static readonly Dictionary<uint, string> _status = new Dictionary<uint, string>();

        // MAP status ring color (docs/atc-mfd-plan.md Phase 2 item (b)) — reuses NOXMFD's own
        // theme.css semantic colors (--no-green/--no-amber/--no-red: nominal/caution/alert) rather
        // than inventing a new palette. HOLDING is the only "caution" state in the ticket's enum;
        // EMERGENCY is the only alert; every other assigned status reads as normal traffic flow.
        private const string ColorGreen = "#39FF14";
        private const string ColorAmber = "#FFAA00";
        private const string ColorRed = "#FF4040";

        private static string ColorFor(string status) => status switch
        {
            "EMERGENCY" => ColorRed,
            "HOLDING" => ColorAmber,
            _ => ColorGreen,
        };

        [Serializable]
        private class Command
        {
            public string cmd = "";
            public uint id;
            public string status = "";
            public bool on;   // 'track' only
        }

        // NOXMFD guarantees this runs on the Unity main thread (docs/extensions-api.md) — not that
        // it matters here (no Unity API touched), but it does mean HandleCommand and PushStatus
        // below never run concurrently with each other, so the dictionary needs no lock.
        internal static void HandleCommand(string json)
        {
            Command? cmd;
            try { cmd = JsonUtility.FromJson<Command>(json); }
            catch (Exception ex) { Plugin.Log?.LogWarning($"[ATC] malformed command: {ex.Message}"); return; }
            if (cmd == null) return;

            // TRACK ON MAP (the row-select-driven follow-on to LOCATE ON MAP) — no unit id of its
            // own, it just toggles whether MAP keeps following whatever 'locate' last selected, so
            // this is checked before the id == 0 guard below (every other command needs a real id).
            if (cmd.cmd == "track")
            {
                NOXMFD.Api.SetSelectedUnitTrack(cmd.on);
                return;
            }

            if (cmd.id == 0) return;

            // LOCATE ON MAP (docs/atc-mfd-plan.md Phase 2 item (c)) — one-way, extension -> MAP
            // only; NOXMFD's SharedSelection has no path back from a MAP click to here.
            if (cmd.cmd == "locate")
            {
                NOXMFD.Api.SetSelectedUnit(cmd.id);
                return;
            }

            if (cmd.cmd != "set-status") return;
            if (!Valid.Contains(cmd.status))
            {
                Plugin.Log?.LogWarning($"[ATC] unknown status '{cmd.status}' for unit {cmd.id}.");
                return;
            }

            // UNKNOWN is the "no assignment" state (issue #89's own default) — drop the entry
            // instead of storing it, so a long session doesn't accumulate UNKNOWN entries for
            // every unit anyone has ever glanced at.
            if (cmd.status == "UNKNOWN")
            {
                _status.Remove(cmd.id);
                NOXMFD.Api.ClearUnitColorOverride(cmd.id);
            }
            else
            {
                _status[cmd.id] = cmd.status;
                NOXMFD.Api.SetUnitColorOverride(cmd.id, ColorFor(cmd.status));
            }

            PushStatus();
        }

        // Re-published on every change rather than on a timer — NOXMFD folds the last-published
        // slice into every outgoing telemetry frame from then on (EXTENSIONS.md's PublishSlice:
        // "last write wins"), so a page connecting after the fact still gets the current map on its
        // very first frame without this needing its own polling loop.
        private static void PushStatus()
        {
            var sb = new StringBuilder(32 + _status.Count * 16);
            sb.Append('{');
            bool first = true;
            foreach (KeyValuePair<uint, string> kv in _status)
            {
                if (!first) sb.Append(',');
                first = false;
                sb.Append('"').Append(kv.Key).Append("\":\"").Append(kv.Value).Append('"');
            }
            sb.Append('}');
            NOXMFD.Api.PublishSlice(Plugin.ExtId, sb.ToString());
        }
    }
}
