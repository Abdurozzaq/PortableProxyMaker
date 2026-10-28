Extra root CA certificates for the container (PEM format, *.pem or *.crt).

Needed when something between the machine and the internet re-signs HTTPS
traffic, e.g. antivirus HTTPS scanning (Avast, AVG, Kaspersky, ESET) or a
corporate proxy (Zscaler, Fortinet). Without it, "npm ci" fails during the
build with UNABLE_TO_VERIFY_LEAF_SIGNATURE, and MITM proxies fail to verify
upstream servers.

scripts/install.ps1 exports the host's root automatically to
host-intercept-root.pem. Rebuild after changing files here:

  docker compose up -d --build
