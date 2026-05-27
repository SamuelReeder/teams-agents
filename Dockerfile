FROM node:20-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates \
      git \
      openssh-client \
      python3 \
      python3-venv \
      tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

RUN mkdir -p /app/state /app/logs /app/secrets \
    && chown -R node:node /app

USER node

ENV NODE_ENV=production \
    APP_STATE_DIR=/app/state \
    APP_LOG_DIR=/app/logs \
    APP_SECRETS_DIR=/app/secrets \
    ALOLA_SSH_KEY=/run/secrets/alola_ssh_key \
    ALOLA_SSH_OPTIONS="-o BatchMode=yes -o StrictHostKeyChecking=yes" \
    HARNESS_APPEND_SYSTEM_PROMPT=1 \
    HARNESS_SKIP_PERMISSIONS=1

EXPOSE 3978

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]
