#!/bin/sh
set -eu

# Serve the program directory even when launched from another working directory.
cd -- "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
port="${1:-8080}"

for python_command in python3 python; do
    if command -v "$python_command" >/dev/null 2>&1 &&
        "$python_command" -c 'import sys; sys.exit(sys.version_info.major != 3)' >/dev/null 2>&1; then
        printf 'Open http://127.0.0.1:%s in your browser. Press Ctrl+C to stop.\n' "$port"
        exec "$python_command" -m http.server "$port" --bind 127.0.0.1 --directory .
    fi
done

printf '%s\n' 'Python 3 was not found. Install Python 3 and run this script again.' >&2
exit 1
