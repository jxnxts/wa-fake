"""Manage this checkout's detached loopback demo processes."""
import argparse
import json
import os
import signal
import ssl
import subprocess
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LOCAL = ROOT / ".local"
STATE = LOCAL / "runtime.json"
parser = argparse.ArgumentParser()
parser.add_argument("action", choices=["start", "stop", "status"])
args = parser.parse_args()
LOCAL.mkdir(exist_ok=True)
state = json.loads(STATE.read_text()) if STATE.exists() else {}

def alive(record):
    result = subprocess.run(["ps", "-p", str(record["pid"]), "-o", "command="], capture_output=True, text=True)
    return result.returncode == 0 and str(ROOT) in result.stdout and record["script"] in result.stdout

def launch(name, script, extra):
    if name in state and alive(state[name]):
        return
    logfile = LOCAL / f"{name}.log"
    with logfile.open("a") as output:
        process = subprocess.Popen(["node", str(ROOT / script), *extra], cwd=ROOT, stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
    state[name] = {"pid": process.pid, "script": script, "log": str(logfile)}
    STATE.write_text(json.dumps(state, indent=2) + "\n")

def ready(url, context=None):
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        try:
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPSHandler(context=context))
            with opener.open(url + "/health", timeout=1) as response:
                if json.load(response).get("mode") == "synthetic-only":
                    return
        except Exception:
            time.sleep(0.1)
    raise SystemExit(f"Runtime did not become ready at {url}; inspect .local/*.log")

if args.action == "start":
    if not (ROOT / "dist/cli.js").exists():
        raise SystemExit("Run pnpm build first")
    certdir = LOCAL / "certs"
    if not (certdir / "server.pem").exists():
        subprocess.run(["node", str(ROOT / "dist/cli.js"), "certs"], cwd=ROOT, check=True)
    launch("server", "dist/cli.js", ["--port", "58991"])
    ready("http://127.0.0.1:58991")
    if not alive(state["server"]):
        raise SystemExit("Port 58991 is occupied by another process; inspect .local/server.log")
    launch("https", "dist/cli.js", ["--port", "58990", "--cert", str(certdir / "server.pem"), "--key", str(certdir / "server.key")])
    ready("https://127.0.0.1:58990", ssl.create_default_context(cafile=str(certdir / "ca.pem")))
    launch("demo", "dist/demo.js", [])
    print("Inspector: http://127.0.0.1:58991 · HTTPS Graph: https://127.0.0.1:58990 · demo callback: http://127.0.0.1:58992")
elif args.action == "stop":
    for name, record in list(state.items())[::-1]:
        if alive(record):
            os.kill(record["pid"], signal.SIGTERM)
        del state[name]
    STATE.write_text("{}\n")
    print("Stopped this checkout's processes")
else:
    print(json.dumps({name: {**record, "running": alive(record)} for name, record in state.items()}, indent=2))
