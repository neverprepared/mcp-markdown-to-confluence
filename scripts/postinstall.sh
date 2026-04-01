#!/bin/sh
# Copy docker-compose files to ~/.config/neverprepared-mcp-servers/
# Only copies if the target file does not already exist (preserves user modifications)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG_DIR="${HOME}/.config/neverprepared-mcp-servers"

# Kroki
KROKI_DIR="${CONFIG_DIR}/kroki"
KROKI_SOURCE="${SCRIPT_DIR}/../docker/kroki/docker-compose.yml"
KROKI_TARGET="${KROKI_DIR}/docker-compose.yml"

if [ -f "$KROKI_SOURCE" ]; then
  mkdir -p "$KROKI_DIR"
  if [ ! -f "$KROKI_TARGET" ]; then
    cp "$KROKI_SOURCE" "$KROKI_TARGET"
    echo "mcp-markdown-to-confluence: Installed Kroki docker-compose.yml to ${KROKI_TARGET}"
    echo "mcp-markdown-to-confluence: Run 'docker compose -f ${KROKI_TARGET} up -d' to start Kroki"
  fi
fi
