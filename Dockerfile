ARG BASE_IMAGE=node:20-bookworm-slim
FROM ${BASE_IMAGE}

# Custom BASE_IMAGE values must be Debian/Ubuntu compatible: this app layer uses
# apt-get for OS dependencies and installs Node.js 20 from NodeSource when the
# base image does not already provide node >=20 and npm on PATH.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      git \
      gh \
      gnupg \
      openssh-client \
      python3 \
      python3-venv \
      tini; \
    node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"; \
    if [ "$node_major" -lt 20 ] || ! command -v npm >/dev/null 2>&1; then \
      mkdir -p /etc/apt/keyrings; \
      curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
        | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg; \
      echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" \
        > /etc/apt/sources.list.d/nodesource.list; \
      apt-get update; \
      apt-get install -y --no-install-recommends nodejs; \
    fi; \
    rm -rf /var/lib/apt/lists/*

ARG APP_USER=teamsbot
ARG APP_UID=1000
ARG APP_GID=1000

RUN set -eux; \
    if ! getent group "${APP_GID}" >/dev/null; then \
      if getent group "${APP_USER}" >/dev/null; then \
        echo "Group ${APP_USER} already exists with a different gid than ${APP_GID}" >&2; \
        exit 1; \
      fi; \
      groupadd --gid "${APP_GID}" "${APP_USER}"; \
    fi; \
    if ! getent passwd "${APP_UID}" >/dev/null; then \
      if getent passwd "${APP_USER}" >/dev/null; then \
        echo "User ${APP_USER} already exists with a different uid than ${APP_UID}" >&2; \
        exit 1; \
      fi; \
      useradd --uid "${APP_UID}" --gid "${APP_GID}" --create-home --home-dir "/home/${APP_USER}" --shell /bin/bash "${APP_USER}"; \
    fi; \
    mkdir -p "/home/${APP_USER}"; \
    chown "${APP_UID}:${APP_GID}" "/home/${APP_USER}"

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

RUN mkdir -p /app/state /app/logs /app/secrets /app/workspace/repos /app/workspace/worktrees \
    && chown -R "${APP_UID}:${APP_GID}" /app

USER ${APP_UID}:${APP_GID}

ENV NODE_ENV=production \
    HOME=/home/${APP_USER} \
    PATH=/home/${APP_USER}/.local/bin:/home/${APP_USER}/.bun/bin:${PATH} \
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
CMD ["node", "/app/src/index.js"]
