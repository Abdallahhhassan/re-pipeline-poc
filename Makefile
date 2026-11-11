PG ?= postgres://postgres@127.0.0.1:5432
RE = npx tsx pipeline/src/run.ts

.PHONY: setup re-pipeline rebuild fix step app app-rebuilt

## One-time: install, build the demo target, create the sandbox databases.
setup:
	npm install
	npm run build:demo
	npm run build:rebuilt
	npx playwright install chromium
	-psql $(PG)/postgres -c "create database re_demo" -c "create database re_rebuilt"

## Full run: capture -> analyze -> verify -> spec -> parity (if a rebuild exists) -> report.
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

## For a live demo: the original app on http://127.0.0.1:4001 (fresh data with alice, bob, carol).
app:
	psql $(PG)/re_demo -q -f demo-target/schema.sql 2>/dev/null
	PORT=4001 DATABASE_URL=$(PG)/re_demo node demo-target/dist/server.js > /tmp/re-app.log 2>&1 & sleep 1; \
	  W=$$(curl -s -XPOST -H 'content-type: application/json' -d '{"owner":"alice"}' 127.0.0.1:4001/wallets | sed 's/.*"id":"\([^"]*\)".*/\1/'); \
	  curl -s -XPOST -H 'content-type: application/json' -d '{"owner":"bob"}' 127.0.0.1:4001/wallets >/dev/null; \
	  curl -s -XPOST -H 'content-type: application/json' -d '{"owner":"carol","currency":"EUR"}' 127.0.0.1:4001/wallets >/dev/null; \
	  curl -s -XPOST -H 'content-type: application/json' -d '{"amount":20000}' 127.0.0.1:4001/wallets/$$W/deposits >/dev/null; \
	  echo "Original app: http://127.0.0.1:4001  (stop it with: pkill -f demo-target/dist/server.js)"

## The rebuilt app on http://127.0.0.1:4002, same data.
app-rebuilt:
	psql $(PG)/re_rebuilt -q -f rebuilt/schema.sql 2>/dev/null
	PORT=4002 DATABASE_URL=$(PG)/re_rebuilt node rebuilt/dist/server.js > /tmp/re-app-rebuilt.log 2>&1 & sleep 1; \
	  W=$$(curl -s -XPOST -H 'content-type: application/json' -d '{"owner":"alice"}' 127.0.0.1:4002/wallets | sed 's/.*"id":"\([^"]*\)".*/\1/'); \
	  curl -s -XPOST -H 'content-type: application/json' -d '{"owner":"bob"}' 127.0.0.1:4002/wallets >/dev/null; \
	  curl -s -XPOST -H 'content-type: application/json' -d '{"owner":"carol","currency":"EUR"}' 127.0.0.1:4002/wallets >/dev/null; \
	  curl -s -XPOST -H 'content-type: application/json' -d '{"amount":20000}' 127.0.0.1:4002/wallets/$$W/deposits >/dev/null; \
	  echo "Rebuilt app: http://127.0.0.1:4002  (stop it with: pkill -f rebuilt/dist/server.js)"

## Run one step: make step S=verify
step:
	$(RE) $(S)
