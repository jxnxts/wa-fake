import os

import pytest

from wa_fake import WaFake, WaFakeError


def test_sdk_roundtrip_window_and_snapshot(wa_fake):
    ana = wa_fake.user("5511900000001", name="Synthetic Ana")
    incoming = ana.send_text("Hello")
    assert incoming
    sent = wa_fake.send(ana.wa_id, type="text", text={"body": "Hello Ana"})
    message = ana.expect_message(type="text")
    assert message["id"] == sent["messages"][0]["id"]
    assert message["payload"]["text"]["body"] == "Hello Ana"
    snap = wa_fake.snapshot()
    wa_fake.advance("25h")
    with pytest.raises(WaFakeError) as exc:
        wa_fake.send(ana.wa_id, type="text", text={"body": "outside the window"})
    assert exc.value.code == 131047
    wa_fake.restore(snap)
    assert len(wa_fake.state()["messages"]) == 2
    wa_fake.send(ana.wa_id, type="text", text={"body": "restored window"})


def test_sdk_auth_and_external_url_refusal(wa_fake):
    bad = WaFake(wa_fake.url, graph_token="invalid", ca_file=os.environ.get("WA_FAKE_CA_FILE"))
    with pytest.raises(WaFakeError) as exc:
        bad.send("5511900000001", type="text", text={"body": "no"})
    assert exc.value.code == 190
    with pytest.raises(ValueError):
        WaFake("https://graph.facebook.com")
