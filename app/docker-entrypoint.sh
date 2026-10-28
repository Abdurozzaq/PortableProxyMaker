#!/bin/sh
set -e
# Trust extra root CAs bundled from certs/ (see Dockerfile) for outgoing HTTPS.
if [ -s /etc/extra-ca.pem ] && [ -z "$NODE_EXTRA_CA_CERTS" ]; then
  export NODE_EXTRA_CA_CERTS=/etc/extra-ca.pem
fi
# The data dir is usually a host bind mount created by root; hand it to the
# unprivileged "node" user, then drop privileges.
if [ "$(id -u)" = "0" ]; then
  mkdir -p "${DATA_DIR:-/data}"
  # Some mounts (e.g. Windows-backed folders) refuse chown; they are writable anyway.
  chown -R node:node "${DATA_DIR:-/data}" 2>/dev/null || true
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi
exec "$@"
