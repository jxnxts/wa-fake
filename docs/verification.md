# Verification

Initial-release verification, 29–30 September 2026. Tests used synthetic data and local listeners. No supplier account, message, payment or production credential was used. This is local integration evidence, not supplier certification.

## Executed checks

| Check                                             | Result                    | What it establishes                                                                                                                   |
| ------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm format:check`                               | passed                    | Public source uses pinned formatting; third-party originals excluded.                                                                 |
| `pnpm install --frozen-lockfile`                  | passed                    | Workspace installation matches the committed lock.                                                                                    |
| `pnpm check` and inspector `check`                | passed                    | Strict TypeScript and Vue checks.                                                                                                     |
| `pnpm test`                                       | 34 passed across 8 suites | Core, server, templates, encrypted Flows, inspector client, official response shapes, Kapso client and full HTTP application journey. |
| `pnpm build`                                      | passed                    | Bundled Node CLI/SDK/demo and embedded production inspector.                                                                          |
| `pnpm test:python`                                | 2 passed                  | Checkout-launched HTTP SDK tests.                                                                                                     |
| Python tests with dedicated HTTPS URL and CA      | 2 passed                  | Real certificate verification, window/snapshot behavior and invalid Graph credential handling over HTTPS.                             |
| Existing Quites sender/parser against local HTTPS | passed; 4 parsed events   | Unchanged adapter send/read/typing and generated webhook-envelope compatibility.                                                      |
| `docker build -t wa-fake:local .`                 | passed                    | Node 20 Alpine installation/build.                                                                                                    |
| Container SDK HTTP journey                        | passed                    | Built container can launch an ephemeral server and send/receive a synthetic message.                                                  |
| Inspector browser journey                         | passed                    | Actual UI events traverse the Sim API, application webhook callback and encrypted Flow endpoint.                                      |
| Responsive browser checks                         | passed                    | 390 × 844 chat/Flow has no horizontal document overflow; desktop and mobile screenshots saved.                                        |

The coordinator independently repeated the final strict checks, 34-test suite and production build after the ownership and versionless-response regressions were corrected. The final built runtime also passed the complete English encrypted application journey, and the final container passed its HTTP SDK smoke test.

Public MIT source: [jxnxts/wa-fake](https://github.com/jxnxts/wa-fake). GitHub visibility and license detection were verified after pushing. The clean-install GitHub Actions result is available under [Actions](https://github.com/jxnxts/wa-fake/actions).

[Initial clean-install CI passed](https://github.com/jxnxts/wa-fake/actions/runs/36661035778) on Linux with Node 20: frozen install, formatting, root/Vue checks, all 34 TypeScript tests, production build and both Python tests.

## End-to-end journey

`conformance/journey.test.ts` starts a server and a separate application endpoint on ephemeral HTTP ports. A virtual user sends text, receives reply buttons, selects a list, opens a Flow, fills visible fields and confirms the review screen. Endpoint requests use real RSA-OAEP/AES-GCM and HMAC; terminal completion produces a signed nfm_reply webhook and an application acknowledgement.

The Flow tests independently use the unmodified Meta crypto helper. They verify key rotation/fresh encryption after 421, closed/rejected sessions on 427/432, malformed responses, snapshot resume and a measured ten-second deadline. The complete official endpoint application suite was not executed.

The external `@kapso/whatsapp-cloud-api` 0.3.0 client is not patched. Its documented local base URL and media `auth: "always"` option exercise sends, read/typing, multipart upload, metadata, exact downloaded bytes and deletion.

## Browser evidence

- [Desktop](../packages/inspector/evidence/desktop.png)
- [Mobile](../packages/inspector/evidence/mobile.png)
- [English Flow form](../packages/inspector/evidence/flow-form.png)
- [Completed Flow](../packages/inspector/evidence/flow-complete.png)
- [Inspector report](../packages/inspector/evidence/REPORT.md)

Screenshots show actual local synthetic state. The coordinator inspected the saved images. Browser input/click handlers were exercised, rather than replacing interactions with direct API calls.

## Reproduce

```sh
pnpm install --frozen-lockfile
make check
pnpm test
pnpm build
pnpm test:python
make up
WA_FAKE_URL=https://127.0.0.1:58990 \
  WA_FAKE_CA_FILE=.local/certs/ca.pem pnpm test:python
```

The HTTPS fixture resets its dedicated instance; the HTTP interactive demo is a separate process. See the [Quites recipe](integrations/quites.md) to run the optional external adapter contract with an explicit checkout path. Full Quites identity/database/application tests were not run and its checkout was not modified.

## Scope limits

The official catalog has 169 saved examples and ten curated response fixtures; selected message response shapes are compared. This is not exhaustive coverage of every example. Advanced commerce/calling, additional webhook families and registry releases remain backlog, as detailed in the [fidelity register](fidelity.md).
