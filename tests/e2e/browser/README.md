# Real-browser checks (headless Firefox, offline)

Drives the real UI in headless Firefox (WebDriver BiDi, Node 24's built-in WebSocket; no npm
packages) against the real backend, which runs in a `--network none` container. Discogs is
faked (`server.py` seeds two releases and stubs search), the config dir is a tmpfs, and the
browser uses a throwaway profile. Needs Docker, Node ≥ 22 and Firefox on the host.

The container has no network, so `proxy.mjs` listens on `127.0.0.1:8765` and bridges each
browser connection into the container with `docker exec -i … python /b/pipe.py`.

```bash
cd <repo>
OUT=$(mktemp -d)   # screenshots + throwaway Firefox profile
mkdir -p "$OUT/incoming/Album"   # put a test WAV here (see .claude/skills/verify/SKILL.md "Test audio")
docker run --rm -d --name vinylflow-browser --network none -e PYTHONDONTWRITEBYTECODE=1 \
  -e DISCOGS_USER_TOKEN=offline-fake -v "$PWD:/src:ro" -v "$OUT/incoming:/import:ro" \
  -v "$PWD/tests/e2e/browser:/b:ro" --tmpfs /src/config --tmpfs /tmp \
  -e VINYLFLOW_UPLOAD_DIR=/tmp/uploads -e DEFAULT_OUTPUT_DIR=/tmp/output -e VINYLFLOW_IMPORT_DIR=/import \
  -e VINYLFLOW_CONFIG_DIR=/tmp/config -w /src vinylflow-test python /b/server.py
node tests/e2e/browser/proxy.mjs &   # 127.0.0.1:8765
node tests/e2e/browser/change_release_snap.mjs "$OUT"   # prints state per step, writes PNGs to $OUT
kill %1; docker rm -f vinylflow-browser
```

`change_release_snap.mjs` reproduces "pick release → hand edit → Change release → pick another →
Snap to Discogs" and must end with 3 track regions + 2 dashed markers and no error notice. `release_by_id.mjs` checks the exact-pressing field (master link explained, release link selected
and split). Copy them for other flows: `bidi.mjs` exposes `goto`, `eval` (runs in the page; use
`Alpine.$data(document.querySelector('[x-data]'))` for app state) and `shot` (full-page PNG).
Alpine updates the DOM asynchronously: wait a moment after an action before a screenshot.
