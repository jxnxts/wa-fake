"""Exercise the existing Quites adapter against wa-fake. Does not edit Quites."""

import argparse
import json
import sys
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

from pydantic import SecretStr

parser = argparse.ArgumentParser()
parser.add_argument("--url", required=True)
parser.add_argument("--ca-file", type=Path)
parser.add_argument("--source", type=Path, required=True, help="Path to the existing Quites apps/api/src checkout")
args = parser.parse_args()
sys.path.insert(0, str(args.source))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "packages/sdk-py/src"))

from wa_fake import WaFake  # noqa: E402
from quites.canal.whatsapp import WhatsAppSender, parse_webhook  # noqa: E402

wa = WaFake(args.url, ca_file=str(args.ca_file) if args.ca_file else None)
user = wa.user("5511900000099", name="Synthetic Quites contract")
incoming = user.send_text("contract test")
config = SimpleNamespace(
    waba_id="200000000001", phone_number_id="100000000001", graph_version="v23.0",
    graph_base_url=args.url, graph_ca_file=args.ca_file, access_token=SecretStr("wa-fake-token"),
)
sender = WhatsAppSender()
result = sender.send(config, user.wa_id, uuid4(), {"kind": "text", "text": "Quites contract through wa-fake"})
assert result.status == "sent" and result.provider_ref
message = user.expect_message(type="text")
assert message["id"] == result.provider_ref
assert sender.mark_read_typing(config, incoming.get("id", incoming.get("message", {}).get("id")))
state = wa.state()
events = state.get("webhooks", [])
parsed_count = 0
for event in events:
    envelope = event.get("body", event.get("payload", event.get("envelope")))
    if isinstance(envelope, dict) and envelope.get("object") == "whatsapp_business_account":
        parsed = parse_webhook(envelope, config)
        parsed_count += len(parsed[0]) + len(parsed[1])
assert parsed_count > 0, "Expected generated webhook envelopes consumable by Quites"
print(json.dumps({"adapter": "Quites WhatsAppSender/parse_webhook", "result": "passed", "transport": args.url.split(':')[0], "parsed_events": parsed_count}))
