#!/usr/bin/env bash
# Runs a command; if it fails, publishes the end of its output as a GitHub
# annotation so the error is readable from the API without downloading logs.
# Usage: bash scripts/run-and-annotate.sh "<title>" <command...>
title="$1"; shift
log="$(mktemp)"
"$@" 2>&1 | tee "$log"
code=${PIPESTATUS[0]}
[ "$code" -eq 0 ] && exit 0
body="$( (grep -nE '^(error|Error)|failed|panicked' "$log" | head -20; echo '---'; tail -n 60 "$log") | cut -c1-300 | sed -e 's/%/%25/g' | awk 'BEGIN{ORS="%0A"} {print}')"
echo "::error title=${title}::${body}"
exit $code
