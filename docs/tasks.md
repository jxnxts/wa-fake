# Task breakdown

| ID   | Delivery                                       | Dependencies | Owner           | Acceptance                        | Status               |
| ---- | ---------------------------------------------- | ------------ | --------------- | --------------------------------- | -------------------- |
| P00  | Analysis, assumptions, architecture, contracts | —            | Coordinator     | Reviewable documents              | complete             |
| C01  | State/clock/IDs/errors/auth/Graph/Sim          | P00          | Core agent      | Window/error/ownership checks     | complete locally     |
| C02  | Messaging/media/status/HMAC/retry/fault/SSE    | C01          | Core agent      | Actual HTTP tests                 | complete locally     |
| C03  | HTTP/HTTPS/private CA/CLI/static inspector     | C01          | Core agent      | Chain verification/local listener | complete locally     |
| D01  | Template lifecycle/parameters/rendering        | P00          | Domain agent    | Valid/invalid cases/events        | complete locally     |
| D02  | Flow lifecycle/assets/validation/preview       | P00          | Domain agent    | State transitions/errors          | complete locally     |
| D03  | Crypto/INIT/exchange/BACK/SUCCESS/nfm_reply    | D02          | Domain agent    | Real encrypted endpoint           | complete locally     |
| U01  | Vue conversations/personas/business/SSE        | P00          | Inspector agent | Browser/build                     | complete locally     |
| U02  | Media/buttons/lists/Flowso/evidence/controls   | U01          | Inspector agent | Sim interactions/screenshots      | complete locally     |
| S01  | JS client/in-process launcher                  | C01          | Coordinator     | Actual HTTP                       | complete             |
| S02  | Python SDK/pytest fixture                      | C01          | Coordinator     | HTTP/HTTPS tests                  | complete locally     |
| E01  | Demo application/encrypted Flow                | C02,D03      | Coordinator     | Text→menu→Flow→nfm_reply          | complete             |
| E02  | External client/official shapes/Quites adapter | C02,D01,D03  | Coordinator     | Client/adapter contract           | complete locally     |
| R01  | Build/English docs/Docker/CI                   | C03,U02,S02  | Coordinator     | Reproducible builds               | complete locally     |
| R02  | Retained runtime/screenshots/report            | E01,E02,R01  | Coordinator     | Healthy URLs/evidence             | complete locally     |
| OS01 | Public MIT GitHub repository                   | R02          | Coordinator     | English source/verified remote    | complete: public MIT |
| B01  | Calling/commerce/SQLite/version fidelity       | R02          | Future work     | Requested increments              | backlog              |
| B02  | npm/PyPI/container-registry releases           | OS01         | Future work     | Packaging/release review          | backlog              |

Waves: plan/contracts → three parallel workers → SDK integration → corrections/tests → English/open-source preparation → local runtime/publication. Workers share one checkout with package ownership and actual Orca dispatch records.
