.PHONY: build icons check clean open

build:
	./build.sh

icons:
	python3 tools/make-icons.py

check:
	node --check extension/background.js
	node --check extension/claude-inject.js
	node --check extension/popup.js
	for f in extension/vendor/*.js; do node --check "$$f" || exit 1; done
	node -e 'JSON.parse(require("fs").readFileSync("extension/manifest.json","utf8")); console.log("manifest.json ok")'

open:
	open "$$(find build/Build/Products/Release -maxdepth 1 -name '*.app' | head -n1)"

clean:
	./build.sh clean
