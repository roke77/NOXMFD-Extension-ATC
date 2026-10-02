"""Browser preview of the ATC page without the game.

    python tools/preview.py [port] [path/to/NOXMFD]

Serves /ext/atc/* from this repo's src/web, /assets/shared|services/* from a NOXMFD checkout
(default: a sibling ../NOXMFD), and a mock /stream of traffic contacts with an ext.atc status slice.
POST /ext/atc/command applies set-status to that slice; GET /commands lists what was received.
GET /scenario?metric=0|1&s=traffic|nomission switches what the stream sends.
"""
import json, math, sys, time
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse, parse_qs

REPO = Path(__file__).resolve().parent.parent
EXT = REPO / "src" / "web"
NOX = (Path(sys.argv[2]) if len(sys.argv) > 2 else REPO.parent / "NOXMFD") / "src" / "web"
MIME = {".css": "text/css", ".js": "text/javascript", ".html": "text/html", ".woff2": "font/woff2"}

# pn is the in-game pilot name: a NOXMFD pilot's callsign (with psn = their Steam name), else the
# Steam name; AI aircraft have no pn and fall back to the type. pf is peer fuel, -1 = none.
# (id, type, faction, dx km, dz km, pn, psn, alt, spd, hdg, fuel)
TRAFFIC = [
    (101, "SFB-81 Darkreach", 1, 3.2, 1.1, "VIPER 1-1", "roke77", "4,200 ft", "312 kt", 75, 0.62),
    (102, "FS-12 Revoker", 1, 4.0, -2.4, "VIPER 1-2", "Kestrel_77", "4,900 ft", "330 kt", 80, 0.48),
    (103, "KR-67 Ifrit", 1, 12.5, 6.0, "TALON 2-1", "Mjolnir", "11,500 ft", "455 kt", 190, 0.81),
    (104, "T/A-30 Compass", 1, 0.4, 0.2, "BoxOfFrogs", "", "0 ft", "0 kt", 270, -1),
    (105, "CI-22 Cricket", 1, 22.0, -9.0, "", "", "1,200 ft", "95 kt", 330, -1),
    (106, "EW-25 Medusa", 1, 41.0, 15.0, "HAWK 3-4", "nightjar", "25,000 ft", "410 kt", 12, 0.09),
    (201, "FS-20 Vortex", 2, 58.0, 30.0, "Gr1mReaper", "", "18,000 ft", "520 kt", 220, -1),
    (202, "KR-67 Ifrit", 2, 75.0, -20.0, "", "", "9,000 ft", "480 kt", 250, -1),
]
state = {"s": "traffic", "metric": False}
status = {"101": "ENROUTE", "102": "ENROUTE", "104": "TAXI", "106": "EMERGENCY"}
commands = []


def frame(t):
    contacts = []
    for (uid, typ, f, dx, dz, pn, psn, al, sp, h, pf) in TRAFFIC:
        # drift along the heading so the table visibly updates
        r = math.radians(h)
        x, z = dx * 1000 + math.sin(r) * t * 30, dz * 1000 + math.cos(r) * t * 30
        c = {"id": uid, "t": f"{pn} [{typ}]" if pn else typ, "f": f, "x": x, "z": z, "h": h, "ac": 1, "hd": 1,
             "pn": pn, "al": al, "sp": sp, "pf": pf if f == 1 else -1}
        if psn:
            c["psn"] = psn
        contacts.append(c)
    return {"metric": state["metric"], "world": {"x": 0, "z": 0}, "contacts": contacts, "ext": {"atc": status}}


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _file(self, p):
        if not p.is_file():
            self.send_error(404); return
        self.send_response(200)
        self.send_header("Content-Type", MIME.get(p.suffix, "application/octet-stream"))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(p.read_bytes())

    def _json(self, obj):
        body = json.dumps(obj).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urlparse(self.path)
        path = u.path
        if path in ("/", "/ext/atc"):
            return self._file(EXT / "atc.html")
        if path.startswith("/ext/atc/"):
            return self._file(EXT / path[len("/ext/atc/"):])
        if path.startswith("/assets/shared/"):
            return self._file(NOX / "shared" / path[len("/assets/shared/"):])
        if path.startswith("/assets/services/"):
            return self._file(NOX / "services" / path[len("/assets/services/"):])
        if path == "/scenario":
            q = parse_qs(u.query)
            state["s"] = q.get("s", [state["s"]])[0]
            state["metric"] = q.get("metric", ["1" if state["metric"] else "0"])[0] == "1"
            return self._json(state)
        if path == "/commands":
            return self._json(commands)
        if path == "/stream":
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            t0 = time.time()
            try:
                while True:
                    d = {"ping": True, "missionRunning": False} if state["s"] == "nomission" else frame(time.time() - t0)
                    self.wfile.write(("data: " + json.dumps(d) + "\n\n").encode())
                    self.wfile.flush()
                    time.sleep(0.1)
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                return
        self.send_error(404)

    def do_POST(self):
        if urlparse(self.path).path != "/ext/atc/command":
            self.send_error(404); return
        if self.headers.get("Content-Type") != "application/json":
            self.send_error(415); return
        c = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
        commands.append(c)
        if c.get("cmd") == "set-status":
            if c.get("status") == "UNKNOWN":
                status.pop(str(c.get("id")), None)
            else:
                status[str(c.get("id"))] = c.get("status")
        self.send_response(204); self.end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8792
    ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()
