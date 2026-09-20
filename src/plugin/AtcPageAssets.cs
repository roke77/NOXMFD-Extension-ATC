using System;
using System.IO;
using System.Reflection;

namespace AtcModule
{
    // Embedded web assets for the ATC page — same suffix-match pattern NOXMFD's own pages and
    // its other extensions use for their embedded resources (EXTENSIONS.md's "2. Serving your page").
    internal static class AtcPageAssets
    {
        private static readonly Assembly Asm = typeof(AtcPageAssets).Assembly;

        internal static byte[]? Resolve(string relPath)
        {
            string name = string.IsNullOrEmpty(relPath) ? "atc.html" : relPath;
            string suffix = "." + ("web." + name).Replace('/', '.');
            foreach (string n in Asm.GetManifestResourceNames())
            {
                if (!n.EndsWith(suffix, StringComparison.OrdinalIgnoreCase)) continue;
                using Stream? s = Asm.GetManifestResourceStream(n);
                if (s == null) return null;
                var ms = new MemoryStream();
                s.CopyTo(ms);
                return ms.ToArray();
            }
            return null;
        }
    }
}
