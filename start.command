#!/bin/bash
# Double-click to open Tapeline in your browser.
cd "$(dirname "$0")"
PORT=8321

if ! command -v python3 >/dev/null; then
  echo "Tapeline needs Python 3 to serve the page. Install it from python.org and try again."
  exit 1
fi

if ! curl -s -o /dev/null "http://localhost:$PORT/index.html"; then
  python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1 &
  SERVER=$!
  trap 'kill $SERVER 2>/dev/null' EXIT
  sleep 0.7
fi

open "http://localhost:$PORT"
echo "Tapeline is running at http://localhost:$PORT"
echo "Close this window to stop it."
wait
