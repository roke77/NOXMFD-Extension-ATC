// Placeholder — no telemetry or commands wired up yet. Listens on the standard NOXMFD extension
// message contract (EXTENSIONS.md's "2. Serving your page") so the shell's postMessage traffic has
// somewhere to land once real content replaces the "COMING SOON" placeholder.
window.addEventListener('message', function (e) {
  var m = e.data;
  if (!m || m.mfd !== true) return;
  // m.type === 'ext'    -> m.data is this page's last NOXMFD.Api.PublishSlice payload.
  // m.type === 'orient' -> m.orientation is 'portrait' or 'landscape'.
});
