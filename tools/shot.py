"""README screenshots of the ATC page, taken from the preview's mock traffic with headless Chrome.

    python tools/shot.py [port]      # preview.py must be running on that port (default 8792)

Writes docs/images/atc-page.png (a selected aircraft, TRACK ON MAP lit) and
docs/images/atc-status-list.png (the STATUS list open) at 996x820.
"""
import asyncio, base64, json, subprocess, sys, tempfile, time, urllib.request
from pathlib import Path
import websockets

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8792
OUT = Path(__file__).resolve().parent.parent / "docs" / "images"
CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
W, H, DEBUG = 996, 820, 9333


async def main():
    OUT.mkdir(parents=True, exist_ok=True)
    urllib.request.urlopen(f"http://127.0.0.1:{PORT}/scenario?freeze=1&metric=0").read()
    prof = tempfile.mkdtemp()
    proc = subprocess.Popen([CHROME, "--headless=new", f"--remote-debugging-port={DEBUG}", f"--user-data-dir={prof}",
                             f"--window-size={W},{H}", "about:blank"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(50):
            try:
                tabs = json.load(urllib.request.urlopen(f"http://127.0.0.1:{DEBUG}/json"))
                ws_url = next(t["webSocketDebuggerUrl"] for t in tabs if t["type"] == "page")
                break
            except Exception:
                time.sleep(0.2)
        async with websockets.connect(ws_url, max_size=None) as ws:
            n = 0

            async def cmd(method, **params):
                nonlocal n
                n += 1
                await ws.send(json.dumps({"id": n, "method": method, "params": params}))
                while True:
                    msg = json.loads(await ws.recv())
                    if msg.get("id") == n:
                        return msg.get("result", {})

            async def js(expr):
                return await cmd("Runtime.evaluate", expression=expr, awaitPromise=True)

            async def shot(name):
                r = await cmd("Page.captureScreenshot", format="png", clip={"x": 0, "y": 0, "width": W, "height": H, "scale": 1})
                (OUT / name).write_bytes(base64.b64decode(r["data"]))
                print("wrote", OUT / name)

            await cmd("Emulation.setDeviceMetricsOverride", width=W, height=H, deviceScaleFactor=1, mobile=False)
            await cmd("Page.navigate", url=f"http://127.0.0.1:{PORT}/")
            await asyncio.sleep(2.5)
            # Select VIPER 1-1 and light TRACK ON MAP, as a controller following one aircraft would.
            await js("""[...document.querySelectorAll('.atc-row')].find(r => r.querySelector('b').textContent === 'VIPER 1-1').click();
                        document.getElementById('track-btn').click();""")
            await asyncio.sleep(0.6)
            await shot("atc-page.png")
            await js("document.getElementById('status-btn').click()")
            await asyncio.sleep(0.4)
            await shot("atc-status-list.png")
    finally:
        proc.terminate()
        urllib.request.urlopen(f"http://127.0.0.1:{PORT}/scenario?freeze=0").read()


asyncio.run(main())
