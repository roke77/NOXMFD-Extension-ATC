using BepInEx;
using BepInEx.Logging;

namespace AtcModule
{
    // A real, separate BepInEx plugin — not part of NOXMFD.dll. Registers itself with NOXMFD's
    // public Api at Awake() (EXTENSIONS.md) instead of anything in NOXMFD's own source knowing
    // this mod exists. The traffic table, range presets, and ATC Status assignment/MAP
    // integration (AtcStatus.cs) — see docs/atc-mfd-plan.md.
    [BepInPlugin("com.roque.atc-module", "NOXMFD: ATC Module Extension", MyPluginInfo.PLUGIN_VERSION)]
    // Pinned to 0.52.0 — the release that added SetUnitColorOverride/ClearUnitColorOverride,
    // SetSelectedUnit, and the "ac"/"pf" contact fields Phase 2 depends on
    // (docs/atc-mfd-plan.md), per EXTENSIONS.md's Versioning section.
    [BepInDependency("com.roque.NOXMFD", "0.52.0")]
    [BepInProcess("NuclearOption.exe")]
    [BepInProcess("NuclearOptionServer.exe")]
    public class Plugin : BaseUnityPlugin
    {
        internal const string ExtId = "atc";
        internal static ManualLogSource? Log;

        private void Awake()
        {
            Log = Logger;

            bool ok = NOXMFD.Api.RegisterExtension(ExtId, "ATC", AtcPageAssets.Resolve, AtcStatus.HandleCommand);
            if (!ok)
            {
                Log.LogError("[ATC] failed to register with NOXMFD (id already taken?) — extension disabled.");
                return;
            }

            Log.LogInfo("ATC loaded.");
        }
    }
}
