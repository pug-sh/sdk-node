# pug-node developer tasks. Mirrors sdk-web / sdk-android / sdk-flutter proto vendoring: the
# published package carries generated code (src/gen), so consumers just `npm install` with no
# Buf Schema Registry entry in their .npmrc.

.PHONY: sync-protos protos typed-events check-codegen check-proto-pin proto-latest build lint test check ci

# These recipes have order-only dependencies that make's prerequisite lists don't fully express
# (e.g. `ci` must run `protos` before `check-codegen` diffs src/gen, and `protos` rewrites files
# `build` reads). Keep everything serial even under `make -jN` so a parallel run can't race.
.NOTPARALLEL:

# BSR module + pinned commit that proto/ is vendored from. The pin makes `make sync-protos`
# reproducible and taking newer upstream protos a deliberate, reviewable change. Builds and CI
# never touch BSR (proto/ + src/gen are committed). To bump: run `make proto-latest` for the
# newest commit, set PROTO_COMMIT below, then `make sync-protos && make protos` and review the diff.
PROTO_MODULE  := buf.build/pugsh/pug
PROTO_COMMIT  := 35d2a94a2a654a45a773e9184e3f6324

# The --path allowlist for `buf export`; buf pulls in transitive imports (buf/validate, google WKTs)
# automatically. Node is a server SDK, so unlike the web client it also vendors the shared/**
# services it consumes. Add a --path when the SDK starts consuming a new package.
PROTO_PATHS := --path sdk --path common/events/v1 --path common/v1/property_value.proto \
  --path shared/activity/v1 --path shared/insights/v1 --path shared/profiles/v1

# Re-vendor proto/ from the pinned BSR commit. `buf export` is a read-only download.
sync-protos:
	@command -v buf >/dev/null || { echo "buf CLI required: https://buf.build/docs/installation"; exit 1; }
	rm -rf proto
	buf export $(PROTO_MODULE):$(PROTO_COMMIT) --output proto $(PROTO_PATHS)
	@echo "Synced SDK protos into proto/ at $(PROTO_COMMIT). Run 'make protos' to regenerate src/gen."

# Release gate: proto/ must be exactly what the pinned commit exports, so nothing ships hand-patched
# ahead of the pin. It needs BSR network access, so the release workflow runs it, not CI.
check-proto-pin:
	@command -v buf >/dev/null || { echo "buf CLI required: https://buf.build/docs/installation"; exit 1; }
	@rm -rf .proto-pin-check
	@buf export $(PROTO_MODULE):$(PROTO_COMMIT) --output .proto-pin-check $(PROTO_PATHS)
	@diff -r proto .proto-pin-check \
	  && { rm -rf .proto-pin-check; echo "proto/ matches $(PROTO_MODULE):$(PROTO_COMMIT)."; } \
	  || { rm -rf .proto-pin-check; echo "proto/ diverges from $(PROTO_COMMIT): bump PROTO_COMMIT, then 'make sync-protos protos'."; exit 1; }

# Regenerate committed protobuf-es TypeScript from the vendored proto/ mirror, then refresh the
# typed track() surface derived from it. protoc-gen-es is a devDependency, from node_modules/.bin.
protos:
	@command -v buf >/dev/null || { echo "buf CLI required: https://buf.build/docs/installation"; exit 1; }
	PATH="$(CURDIR)/node_modules/.bin:$$PATH" buf generate
	$(MAKE) typed-events

# Rebuild the well-known-event registry (src/well-known-events.generated.ts) from the generated
# schemas. The script introspects a throwaway compile of src/gen (node can't import the .ts source
# directly), so nothing here touches the Buf Schema Registry.
typed-events:
	node_modules/.bin/tsc -p tsconfig.gen.json
	node scripts/gen-well-known-events.mjs
	rm -rf .codegen-tmp

# CI gate: the whole committed generated tree must match a fresh generate: both the protobuf-es
# output (src/gen, rewritten by `protos`) and the derived typed-event registry. In `ci`, `protos`
# runs first (ordering guaranteed by .NOTPARALLEL), so this diff catches drift in either one; a
# change under sdk/**, shared/**, or a non-event common/** schema no longer slips through unseen.
# `git diff` skips untracked files, so a newly generated file nobody committed is listed separately;
# tsc would otherwise compile it into dist/ unnoticed.
check-codegen: typed-events
	@git diff --exit-code -- src/gen src/well-known-events.generated.ts \
	  && test -z "$$(git ls-files --others --exclude-standard -- src/gen)" \
	  || { git ls-files --others --exclude-standard -- src/gen; echo "codegen drift: run 'make protos' and commit"; exit 1; }

# Print the newest commit on the module's main branch, to update PROTO_COMMIT above.
proto-latest:
	@buf registry module commit resolve $(PROTO_MODULE):main

build:
	bun run build
lint:
	bun run lint
test:
	bun run test

check: lint test build
# Strict CI target: regenerate protobufs from scratch, then run every check.
ci: protos check-codegen check
