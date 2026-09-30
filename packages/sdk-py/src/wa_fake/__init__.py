"""Local synthetic WhatsApp simulator client. No dependency on Meta credentials."""

from __future__ import annotations

import json
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any


class WaFakeError(RuntimeError):
    def __init__(self, status: int, response: dict[str, Any]):
        self.status = status
        self.response = response
        self.code = response.get("error", {}).get("code", status)
        super().__init__(response.get("error", {}).get("message", f"HTTP {status}"))


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise RuntimeError("wa-fake SDK refuses redirects")


class WaFake:
    def __init__(
        self,
        url: str = "http://127.0.0.1:58991",
        *,
        token: str = "wa-fake-sim",
        graph_token: str = "wa-fake-token",
        phone_id: str = "100000000001",
        ca_file: str | None = None,
        timeout: float = 15,
    ):
        parsed = urllib.parse.urlparse(url)
        if parsed.scheme not in {"http", "https"} or parsed.hostname not in {
            "127.0.0.1", "localhost", "::1"
        }:
            raise ValueError("wa-fake SDK requires a loopback HTTP(S) URL")
        self.url = url.rstrip("/")
        self.token, self.graph_token, self.phone_id = token, graph_token, phone_id
        self.timeout = timeout
        context = ssl.create_default_context(cafile=ca_file)
        self._opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({}), _NoRedirect(), urllib.request.HTTPSHandler(context=context)
        )

    def request(self, method: str, path: str, body: dict | None = None, *, graph=False):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(
            self.url + path, data=data, method=method,
            headers={"Authorization": f"Bearer {self.graph_token if graph else self.token}",
                     "Content-Type": "application/json"},
        )
        try:
            with self._opener.open(req, timeout=self.timeout) as response:
                return json.load(response)
        except urllib.error.HTTPError as exc:
            try:
                response = json.load(exc)
            except (ValueError, UnicodeError):
                response = {"error": {"message": f"HTTP {exc.code}"}}
            raise WaFakeError(exc.code, response) from None

    def user(self, wa_id: str, *, name: str | None = None):
        self.request("POST", "/_wa/users", {"wa_id": wa_id, "name": name or wa_id})
        return VirtualUser(self, wa_id)

    def state(self):
        return self.request("GET", "/_wa/state")

    def configure(self, **options):
        return self.request("POST", "/_wa/config", options)

    def advance(self, duration: str | int):
        return self.request("POST", "/_wa/clock", {"advance": duration})

    def fault(self, **rule):
        return self.request("POST", "/_wa/faults", rule)

    def drain(self, *, advance=False):
        return self.request("POST", "/_wa/webhooks/drain", {"advance": advance})

    def snapshot(self):
        return self.request("POST", "/_wa/snapshot", {})

    def restore(self, snapshot):
        return self.request("POST", "/_wa/restore", {"snapshot": snapshot})

    def reset(self):
        return self.request("POST", "/_wa/reset", {})

    def graph(self, method: str, path: str, payload: dict | None = None):
        return self.request(method, f"/v23.0/{path}", payload, graph=True)

    def send(self, to: str, **payload):
        return self.graph("POST", f"{self.phone_id}/messages", {
            "messaging_product": "whatsapp", "recipient_type": "individual", "to": to, **payload,
        })

    def review_template(self, template_id: str, status="APPROVED"):
        return self.request("POST", f"/_wa/templates/{template_id}/review", {"status": status})


class VirtualUser:
    def __init__(self, client: WaFake, wa_id: str):
        self.client, self.wa_id = client, wa_id
        self._seen: set[str] = set()

    def send(self, **payload):
        return self.client.request("POST", f"/_wa/users/{self.wa_id}/send", {
            "phone_number_id": self.client.phone_id, **payload,
        })

    def send_text(self, body: str):
        return self.send(type="text", text={"body": body})

    def tap_button(self, message: dict | str, button_id: str):
        return self.client.request("POST", f"/_wa/users/{self.wa_id}/tap", {
            "message_id": message if isinstance(message, str) else message["id"], "button_id": button_id,
        })

    def select_row(self, message: dict | str, row_id: str):
        return self.client.request("POST", f"/_wa/users/{self.wa_id}/select", {
            "message_id": message if isinstance(message, str) else message["id"], "row_id": row_id,
        })

    def react(self, message: dict | str, emoji: str):
        return self.client.request("POST", f"/_wa/users/{self.wa_id}/react", {
            "message_id": message if isinstance(message, str) else message["id"], "emoji": emoji,
        })

    def expect_message(self, *, type=None, interactive=None, timeout=10, predicate=None):
        deadline = time.monotonic() + timeout
        while True:
            wait = max(1, min(1000, int((deadline - time.monotonic()) * 1000)))
            result = self.client.request("GET", f"/_wa/outbox?to={self.wa_id}&wait={wait}")
            messages = result if isinstance(result, list) else result.get("messages", result.get("data", []))
            for message in messages:
                if message["id"] in self._seen:
                    continue
                if type and message["type"] != type:
                    continue
                if interactive and message.get("payload", {}).get("interactive", {}).get("type") != interactive:
                    continue
                if predicate and not predicate(message):
                    continue
                self._seen.add(message["id"])
                return message
            if time.monotonic() >= deadline:
                raise TimeoutError(f"Expected message for {self.wa_id} did not arrive")
            time.sleep(0.02)

    def expect_status(self, message_id: str, status: str):
        self.client.drain(advance=True)
        for message in self.client.state()["messages"]:
            if message["id"] == message_id:
                assert message.get("status") == status
                return message
        raise AssertionError(f"Missing message {message_id}")

    def open_flow(self, message: dict | str):
        result = self.client.request("POST", f"/_wa/users/{self.wa_id}/flows/open", {
            "message_id": message if isinstance(message, str) else message["id"],
        })
        return VirtualFlow(self, result.get("session", result))


class VirtualFlow:
    def __init__(self, user: VirtualUser, session: dict):
        self.user, self.session = user, session

    def _call(self, action: str, body: dict):
        result = self.user.client.request("POST", f"/_wa/users/{self.user.wa_id}/flows/{self.session['id']}/{action}", body)
        self.session = result.get("session", result)
        return self.session

    def fill(self, **data):
        self._call("fill", {"data": data})
        return self

    def submit(self, **data):
        return self._call("submit", {"data": data} if data else {})

    def back(self):
        return self._call("back", {})


__all__ = ["WaFake", "WaFakeError", "VirtualUser", "VirtualFlow"]
