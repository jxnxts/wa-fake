# SDK guide

SDKs call the same Sim endpoints as the inspector. Use loopback HTTP(S), separate Graph/Sim tokens and verified TLS with `caFile`/`ca_file` for the local CA.

`createWaFake({port:0})` starts a same-process Node server on an ephemeral port. `WaFakeClient` connects to an existing process. `user.sendText` injects a customer message; `client.send` calls Graph as business. `tapButton`, `selectRow`, `react` produce customer webhooks.

`expectMessage` returns each matching message once per user client. `expectStatus` drains with virtual time advancement. `advance`, `fault`, `snapshot`, `restore`, `reset` and `drain({advance:true})` are deterministic controls. See README for executable examples.

Install Python with `uv sync --project packages/sdk-py` or `pip install -e packages/sdk-py`. The pytest entrypoint provides `wa_fake`. It starts/stops the checkout CLI, or connects to `WA_FAKE_URL` using `WA_FAKE_CA_FILE`. It resets state: use a dedicated instance.

Flows: `await user.openFlow(message)` / `user.open_flow(message)`. `fill` assigns visible form fields, `submit` executes Footer and `back` follows history. Screen data/action literals are not form fields. Encryption occurs between simulator and endpoint.

The external Kapso client supports `baseUrl`. Its media download auth detection depends on host: use `download({mediaId,auth:'always'})` for the required local Bearer.

Snapshots contain synthetic conversations/forms; keep them out of Git. Evidence is separately redacted. No SDK discovers real credentials or installs a remote service.
