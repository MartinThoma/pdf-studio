# PDF Studio. The app itself needs no build step; these targets are for development.
#
#   make run           start a local web server, reachable from the local network; prints the URLs
#   make test          unit tests
#   make test-browser  end-to-end test in headless Chrome (updates docs/screenshot*.png)
#   make install       install the dev dependencies (pdf.js, pdf-lib, Playwright)
#   make vendor        copy pdf.js and pdf-lib from node_modules/ into vendor/
#   make manifest      rewrite asset-manifest.js (the files the service worker caches)
#   make icons         render icons/icon.svg into the PNG icons
#
# Overrides: make run PORT=8080   make run HOST=127.0.0.1   (this computer only)

PORT ?= 8000
HOST ?= 0.0.0.0

.PHONY: run test test-browser install vendor manifest icons

run:
	@HOST=$(HOST) PORT=$(PORT) node scripts/serve.js

test:
	npm test

test-browser: node_modules
	npm run test:browser

install node_modules: package.json package-lock.json
	npm install
	@touch node_modules

vendor: node_modules
	npm run vendor

manifest:
	npm run manifest

icons: node_modules
	npm run icons
