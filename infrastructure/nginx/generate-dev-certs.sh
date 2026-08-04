#!/usr/bin/env bash
# Generate a self-signed TLS certificate for the JKANNEL reverse proxy (dev only).
# Output: infrastructure/nginx/certs/jkannel.crt + jkannel.key (gitignored).
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)/certs"
mkdir -p "$DIR"

openssl req -x509 -nodes -newkey rsa:2048 -days 365 \
  -keyout "$DIR/jkannel.key" \
  -out "$DIR/jkannel.crt" \
  -subj "/C=UG/O=JKANNEL/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,DNS:jkannel.local,IP:127.0.0.1"

chmod 600 "$DIR/jkannel.key"
echo "Wrote self-signed cert (valid 365 days):"
echo "  $DIR/jkannel.crt"
echo "  $DIR/jkannel.key"
echo
echo "Enable HTTPS with the profile-gated TLS proxy (leaves the HTTP-only"
echo "reverse-proxy untouched):"
echo "  docker compose --profile tls up -d reverse-proxy-tls"
echo "  curl -k https://127.0.0.1:\${PROXY_HTTPS_PORT:-8443}/healthz"
echo "See infrastructure/nginx/README.md for the production certificate flow."
