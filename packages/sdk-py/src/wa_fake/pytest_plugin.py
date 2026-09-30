"""Starts the checked-out local server or connects to WA_FAKE_URL."""

import os
import shutil
import subprocess
import time
from pathlib import Path

import pytest

from . import WaFake


@pytest.fixture
def wa_fake():
    process = None
    url = os.environ.get("WA_FAKE_URL")
    if url is None:
        root = Path(__file__).resolve().parents[4]
        cli = root / "packages/server/src/cli.ts"
        built = root / "dist/cli.js"
        if built.exists():
            command = ["node", str(built), "--port", "0"]
        elif cli.exists() and shutil.which("pnpm"):
            command = ["pnpm", "exec", "tsx", str(cli), "--port", "0"]
        else:
            pytest.fail("Build the wa-fake checkout or set WA_FAKE_URL to its loopback URL")
        import socket
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        command[-1] = str(port)
        process = subprocess.Popen(command, cwd=root, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        url = f"http://127.0.0.1:{port}"
    client = WaFake(url, ca_file=os.environ.get("WA_FAKE_CA_FILE"))
    try:
        deadline = time.monotonic() + 15
        while True:
            try:
                client.request("GET", "/health")
                break
            except Exception:
                if process and process.poll() is not None:
                    pytest.fail("wa-fake server exited during startup")
                if time.monotonic() > deadline:
                    pytest.fail("wa-fake server did not become ready")
                time.sleep(0.05)
        client.reset()
        yield client
    finally:
        if process:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
