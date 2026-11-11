PG ?= postgres://postgres@127.0.0.1:5432
RE = npx tsx pipeline/src/run.ts

.PHONY: setup re-pipeline rebuild fix step

## One-time: install, build the demo target, create the sandbox databases.
setup:
	npm install
	npm run build:demo
	-psql $(PG)/postgres -c "create database re_demo" -c "create database re_rebuilt"

## Nightly: capture -> analyze -> verify -> spec -> parity (if a rebuild exists) -> report.
re-pipeline:
	$(RE) all

## On demand: write the rebuild from the spec, then check parity.
rebuild:
	$(RE) rebuild
	$(RE) parity
	$(RE) report

## Send parity differences back to the builder.
fix:
	$(RE) rebuild --fix
	$(RE) parity
	$(RE) report

## Run one step: make step S=verify
step:
	$(RE) $(S)
