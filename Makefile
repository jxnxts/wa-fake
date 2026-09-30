.PHONY: setup dev demo build check test test-python certs up down status
setup:
	pnpm install --frozen-lockfile
	uv sync --project packages/sdk-py
dev:
	pnpm dev
demo:
	pnpm demo
build:
	pnpm build
check:
	pnpm check
	pnpm --filter @wa-fake/inspector check
test:
	pnpm test
test-python:
	pnpm test:python
certs:
	pnpm certs
up:
	python3 tools/runtime.py start
down:
	python3 tools/runtime.py stop
status:
	python3 tools/runtime.py status
