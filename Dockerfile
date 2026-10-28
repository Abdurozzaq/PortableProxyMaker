FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    DATA_DIR=/data

WORKDIR /app

# Extra root CAs (e.g. antivirus / corporate HTTPS inspection). Any *.pem / *.crt in
# certs/ is bundled into /etc/extra-ca.pem and trusted by npm and by the app.
COPY certs/ /usr/local/share/extra-ca/
RUN cat /usr/local/share/extra-ca/*.pem /usr/local/share/extra-ca/*.crt 2>/dev/null | sed 's/\r$//' > /etc/extra-ca.pem || true

COPY app/package.json app/package-lock.json ./
RUN if [ -s /etc/extra-ca.pem ]; then export NODE_EXTRA_CA_CERTS=/etc/extra-ca.pem; fi \
 && npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY app/ ./
RUN sed -i 's/\r$//' docker-entrypoint.sh && chmod +x docker-entrypoint.sh && mkdir -p /data

VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PANEL_PORT||8080)+'/',r=>process.exit(r.statusCode<500?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
