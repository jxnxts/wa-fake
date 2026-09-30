# Quites integration

Quites was the first application contract used for validation. The test exercises its existing `WhatsAppSender` and `parse_webhook` over actual local HTTPS without editing its checkout.

Use synthetic IDs/tokens from README, `graph_version=v23.0`, `graph_base_url=https://127.0.0.1:58990`, local `graph_ca_file` and application environment `local`. Keep TLS verification enabled.

```sh
make up
# Set QUITES_REPO to your application checkout.
uv run --project "$QUITES_REPO/apps/api" python conformance/quites_contract.py \
  --source "$QUITES_REPO/apps/api/src" \
  --url https://127.0.0.1:58990 --ca-file .local/certs/ca.pem
```

This verifies sending, provider IDs, read/typing and envelope parsing. It does not initialize database/Keycloak/Temporal, execute financial operations or establish Vopi/Meta homologation.

Future migration: replace the old fake process with CLI; configure callback handshake; replace user/outbox helpers with Python SDK; register Flow/public key and use `open_flow().submit()`; run the full application E2E before removing old helpers. Strict auth/status/window rules may expose assumptions in permissive mocks.
