# Contributing

Run `pnpm format` before submitting changes; CI checks formatting with the pinned Prettier version. Official fixtures and the unmodified reference crypto helper retain their upstream formatting.

Use Node 20+, pnpm 9, OpenSSL and Python 3.12+/uv for Python tests. Run `make setup`, `make check`, `pnpm test`, `pnpm build`, `pnpm test:python` before submitting.

All authored UI, documentation, examples, comments and fixtures must be English. Never commit `.local`, private keys, real tokens, snapshots, reference checkouts or real customer data.

Inspector/SDK actions must use the existing engine interfaces. Add actual wire-contract/journey tests rather than tests mirroring implementation functions. Record sources/fixtures/limits in `docs/fidelity.md`; local approximations are not Meta-certified. Unsupported capabilities fail explicitly.

Preserve third-party license notices. Registry releases require a separate packaging/release review.
