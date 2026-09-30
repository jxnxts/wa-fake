# Templates and Flows implementation report

This report describes the shared template and Flow extensions and their local integration evidence.

## Delivered

`packages/templates/src/index.ts` exports `createTemplates(engine: EngineHost): GraphExtension`. It implements WABA template create/list/delete, resource read/edit/delete, duplicate name-language detection, cursor pagination, component validation, positional and named examples, authentication OTP, explicit review transitions, template/category webhooks, and outbound rendering. Errors distinguish unapproved/missing language (`132001`), parameter count/name (`132000`), and parameter format (`132012`). Media headers check phone ownership and MIME, and template Flow buttons resolve IDs or names in their WABA. Unsupported carousel and inline Flow creation fail explicitly.

`packages/flows/src/index.ts` exports `createFlows(engine: EngineHost): GraphExtension`. It implements create/list/clone/read/edit/delete, multipart Flow JSON assets, local asset download, validation errors, draft/publish/deprecate, preview, and phone RSA public-key GET/POST. Endpoint and legacy data-channel URLs must be loopback. Publish requires valid JSON and an encrypted healthy ping when an endpoint exists. Flow and template resource IDs are deterministic numeric strings derived from the engine namespace/seed/counter.

Flow sessions implement INIT, data_exchange, implicit or refreshed BACK, SUCCESS, local navigate/complete/update_data, visible-field filling, client validation, and engine-generated nfm_reply. Outbound interactive and template Flow messages share the session controller. Sessions survive snapshots; parallel actions on one session serialize. Completion is submitted through `engine.receiveMessage`, so normal webhook envelopes and HMAC delivery apply.

Transport uses flowso RSA-OAEP SHA256/AES-128-GCM crypto with a 16-byte IV and inverted response IV. Raw encrypted requests receive X-Hub-Signature-256 HMAC. Native HTTP(S) exposes 421 to a single controlled retry, re-reading the registered RSA key and generating fresh AES/IV material. 427 closes a session, 432 fails explicitly, a real ten-second deadline aborts the request, and invalid responses send a best-effort data_exchange error acknowledgment request. Redirect responses fail without being followed. Event payloads contain IDs/action/status only, never raw content or tokens.

## Integration contract

- Exact dependency: `flowso@0.1.0`, declared in `packages/flows/package.json`; root manifest and lock remain coordinator-owned.
- Imports use actual published `flowso/validator`, `flowso/runtime`, `flowso/schema`, and `flowso/endpoint` exports.
- Engine config supplies `appSecret` or `app_secret`; phone records store `public_key`.
- Template render: `{type, template_id, name, category, language, header?: {text, values} | {format, media}, body: {text, values}, footer?, buttons}`.
- Sim session routes follow the shared contracts. Session output includes `{id, screen, data, flow, complete, fields, values, errors, status, renderedScreen, result?, nfm_reply?}`. `screen` is the ID, `flow` is Flow JSON, `fields` are flowso RenderedNode entries, and `renderedScreen` is the flowso RenderedScreen expected by its Vue renderer.
- `fill` and `submit.data` accept current visible field names only. Optional `submit.action` must exactly match a current visible component's declared on-click-action; absent action uses the Footer. Arbitrary caller-created actions are rejected.
- JSON `{flow_json: ...}` asset upload is an explicitly synthetic convenience in addition to multipart. The preview Sim endpoint returns Flow JSON; Graph preview points to the inspector.
- Persisted session `runtime_state` supports snapshot resume using flowso 0.1.0's exposed live state. Cached runtimes are invalidated when the restored record identity changes.
- The final authorized integration fix in `packages/graph/src/index.ts` guards phone/media/template/Flow/WABA record lookups with own-property checks. This prevents inherited object keys from becoming synthetic resources. Domain template/Flow status webhooks select the phone in their actual WABA.

## Validation completed

- `pnpm check`: passed.
- `pnpm test`: passed, 8 files / 34 tests in the final complete workspace run, including the strict inherited-key/WABA regression.
- `pnpm build`: passed, including Vue typechecking, Vite inspector, bundled CLI and SDK.
- `pnpm test:python`: passed, 2 SDK tests.
- Domain tests include 8 template and 8 Flow tests with multiple invalid-template cases. They cover full management, named/positional rendering, OTP, buttons, media ownership, a template Flow journey, correct WABA webhook envelopes, rejection of inherited map keys, independent encrypted endpoint INIT/exchange/BACK/SUCCESS, signed nfm_reply delivery, snapshots, 421/427/432, malformed declared data/version/token, versionless official response compatibility, publish health failure, and a measured ten-second real timeout.
- The final strengthened 421 test rotates the endpoint RSA key and updates the registered public key before the retry; it also checks regenerated encrypted signatures.

The independent endpoint test uses the unmodified Meta reference implementation at `fixtures/flows/meta-encryption.mjs`, with its full MIT license at `fixtures/flows/META-LICENSE`. Its source is WhatsApp-Flows-Tools `examples/endpoint/nodejs/basic/src/encryption.js`, clone commit `ad304df3bc72db21d5540b8b06edaf595400cb08`. The inspected flowso clone is commit `90de018304ce49ac3fc16f2536d39e049781d15a`; runtime dependency is the published 0.1.0 package.

## Fidelity limits for the coordinator's gap register

- Local tests prove interoperability with the official crypto helper and selected SDK journeys, not live Meta acceptance. The complete official example application suite and twenty vendor template-error comparisons were not run. Management error prose/subcodes, opaque cursor encoding, and template review/category policy are local approximations.
- Review is manual: PENDING -> APPROVED/REJECTED, APPROVED -> PAUSED/DISABLED, PAUSED -> APPROVED/DISABLED; editing re-enters PENDING. No supplier moderation, automatic category detection, real quality scoring, or review delay is simulated. OTP wording is English and one-tap metadata is validated; actual app autofill is not executed.
- Template carousels, inline Flow JSON template creation, OTP zero-tap, and unsupported button/header families return 501. Currency/date-time rendering uses fallback_value rather than locale-specific supplier formatting.
- Flow JSON coverage is 4.0 through 7.3 through flowso's validator/runtime. PhotoPicker, DocumentPicker, and NavigationList return 501 at upload; unsupported component/version errors have Flow JSON pointers. Flow open_url actions fail explicitly at submit. Other limits and expressions inherit flowso 0.1.0 behavior and have not been certified against supplier clients.
- Flow metrics/migration and unsupported fields/edges return 501. BLOCKED/THROTTLED remote policies are not generated. Health checks occur before publish; there is no periodic scheduler.
- RSA signature status VALID represents a structurally accepted local key, not a supplier signature verification. Health and session exchanges prove possession of the matching endpoint private key. HTTPS endpoints use Node's configured trust store; no separate per-Flow private CA configuration exists.
- Only one controlled retry follows 421; arbitrary retries/backoff for Flow data exchanges are not simulated. Invalid-response notification is a best-effort encrypted data_exchange with error/error_message; this acknowledgment behavior has not been checked against a live supplier.
- Explicit response versions must match the requested data API version. Missing version is accepted because the current official Node examples return versionless ping and screen responses; this corrects the original plan's stricter assumption.
- Snapshot resume depends on flowso's live public state object because version 0.1.0 has no importState API. Runtime events containing endpoint payloads are removed from persisted runtime_state; authenticated synthetic session data remains available for inspection.

No git commit, external publishing, root manifest/lock modification, or changes outside this checkout were made by this worker. The small shared Graph integration fix was explicitly authorized after the core worker completed; all other authored files are in the assigned packages and fixtures.
