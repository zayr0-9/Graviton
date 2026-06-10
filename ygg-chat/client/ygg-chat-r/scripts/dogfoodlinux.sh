#!/usr/bin/env bash
set -euo pipefail

# Stop any running Graviton instance without matching this script's own command line.
pkill -f '[G]raviton' || true

npm run build:linux

sudo apt install --reinstall ./release/Graviton-*.deb

YGG_LOCAL_SERVER_ALLOW_REMOTE=1 graviton
