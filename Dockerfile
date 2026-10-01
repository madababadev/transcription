FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    HF_HOME=/app/.models \
    LOCAL_ASR_PYTHON=/app/.venv/bin/python \
    NODE_ENV=production \
    PORT=10000

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git python3 python3-pip python3-venv \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json requirements-local.txt ./
RUN npm ci --include=dev \
    && python3 -m venv .venv \
    && .venv/bin/python -m pip install --no-cache-dir -r requirements-local.txt

COPY . .
RUN npm run build \
    && npm prune --omit=dev \
    && mkdir -p .models \
    && chown -R node:node .models

USER node
EXPOSE 10000
CMD ["npm", "start"]
