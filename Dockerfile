ARG BASE_IMAGE=node:20-bookworm-slim
FROM ${BASE_IMAGE}

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates \
      git \
      gh \
      openssh-client \
      python3 \
      python3-venv \
      tini \
    && rm -rf /var/lib/apt/lists/*

ARG APP_USER=teamsbot
ARG APP_UID=1000
ARG APP_GID=1000

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev
RUN groupadd --gid "${APP_GID}" "${APP_USER}" \
    && useradd --uid "${APP_UID}" --gid "${APP_GID}" --create-home --home-dir "/home/${APP_USER}" --shell /bin/bash "${APP_USER}"

COPY . .

RUN mkdir -p /app/state /app/logs /app/secrets /app/workspace/repos /app/workspace/worktrees \
    && chown -R "${APP_UID}:${APP_GID}" /app

USER ${APP_USER}

ENV NODE_ENV=production \
    HOME=/home/${APP_USER} \
    APP_STATE_DIR=/app/state \
    APP_LOG_DIR=/app/logs \
    APP_SECRETS_DIR=/app/secrets \
    APP_WORKSPACE_DIR=/app/workspace \
    ALOLA_SSH_KEY_FILE=/run/secrets/alola_ssh_key \
    ALOLA_SSH_OPTIONS="-o BatchMode=yes -o StrictHostKeyChecking=yes" \
    HARNESS_APPEND_SYSTEM_PROMPT=1 \
    HARNESS_SKIP_PERMISSIONS=1

EXPOSE 3978

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/index.js"]
