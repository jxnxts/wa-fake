"""Curate official Postman response fixtures from an explicitly supplied checkout."""
import argparse
import json
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("source", type=Path)
parser.add_argument("--output", type=Path, default=Path("conformance/official"))
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=True)
selected = {"Send Text Message", "Send List Message", "Send Reply Button", "Retrieve Media URL", "Create Flow", "Publish Flow", "Get Preview URL"}
catalog = []
fixtures = []

def walk(items, collection):
    for item in items:
        if "item" in item:
            walk(item["item"], collection)
        for response in item.get("response", []):
            try:
                body = json.loads(response.get("body", ""))
            except (ValueError, TypeError):
                body = None
            catalog.append({"collection": collection, "request": item["name"], "response": response.get("name"), "status": response.get("code"), "keys": list(body) if isinstance(body, dict) else []})
            if item["name"] in selected and isinstance(body, dict):
                fixtures.append({"request": item["name"], "status": response.get("code"), "body": body})

for path in sorted((args.source / "postman/v1").glob("*.json")):
    walk(json.loads(path.read_text())["item"], path.name)
(args.output / "response-catalog.json").write_text(json.dumps(catalog, indent=2) + "\n")
(args.output / "responses.json").write_text(json.dumps(fixtures, indent=2) + "\n")
print(f"Catalogued {len(catalog)} official response examples; curated {len(fixtures)} fixtures.")
