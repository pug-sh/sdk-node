# pug-node developer tasks. Mirrors sdk-web / sdk-android / sdk-flutter proto vendoring: the
# published package carries generated code (src/gen), so consumers just `npm install` with no
# Buf Schema Registry entry in their .npmrc.

.PHONY: sync-protos protos typed-events check-codegen proto-latest build lint test check ci

# BSR module + pinned commit that proto/ is vendored from. The pin makes `make sync-protos`
# reproducible and taking newer upstream protos a deliberate, reviewable change — builds and CI
# never touch BSR (proto/ + src/gen are committed). To bump: run `make proto-latest` for the
# newest commit, set PROTO_COMMIT below, then `make sync-protos && make protos` and review the diff.
PROTO_MODULE  := buf.build/pugsh/pug
PROTO_COMMIT  := 739d784162d649a3be748db76d3fafd8

# Re-vendor proto/ from the pinned BSR commit. `buf export` is a read-only download; --path is an
# allowlist and buf pulls in transitive imports (buf/validate, google WKTs) automatically. Node is
# a server SDK, so unlike the web client it also vendors the shared/** services it consumes. Add a
# --path when the SDK starts consuming a new package.
sync-protos:
	@command -v buf >/dev/null || { echo "buf CLI required: https://buf.build/docs/installation"; exit 1; }
	rm -rf proto
	buf export $(PROTO_MODULE):$(PROTO_COMMIT) --output proto \
	  --path sdk \
	  --path common/events/v1 \
	  --path common/v1/property_value.proto \
	  --path shared/activity/v1 \
	  --path shared/insights/v1 \
	  --path shared/profiles/v1
	@echo "Synced SDK protos into proto/ at $(PROTO_COMMIT). Run 'make protos' to regenerate src/gen."

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

# CI gate: committed typed-event codegen must match a fresh generate.
check-codegen: typed-events
	@git diff --exit-code -- src/well-known-events.generated.ts \
	  || { echo "codegen drift — run 'make typed-events' and commit"; exit 1; }

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
