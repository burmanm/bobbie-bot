# review-bot action image (C-2, C-3a). Built by action.yml with the
# repository root as context.
#
# - Base image pinned by digest (multi-arch index of node:24.22.3-trixie-slim).
# - rg, fd and gh from pinned release assets, SHA-256 verified (tools.json), at
#   build time only. No apt-get: nothing unpinned enters the image.
# - Dependencies from package-lock.json with `npm ci --ignore-scripts`.
# - PI_OFFLINE=1: pi never downloads binaries or refreshes its catalog.
#
# No `# syntax=` line on purpose: it would pull a frontend image by tag.

FROM node:24.22.3-trixie-slim@sha256:af02d57b57719b9657a45199a79264a9437940cd55b3c7b3fc99615654f124a0 AS tools
COPY action/tools.json action/install-tools.mjs /build/
RUN node /build/install-tools.mjs /build/tools.json /build/bin

FROM node:24.22.3-trixie-slim@sha256:af02d57b57719b9657a45199a79264a9437940cd55b3c7b3fc99615654f124a0
COPY --from=tools /build/bin/rg /build/bin/fd /build/bin/gh /usr/local/bin/
WORKDIR /opt/review-bot
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --omit=dev --no-audit --no-fund \
 && npm cache clean --force
COPY src ./src
COPY pi-review ./pi-review
ENV PI_OFFLINE=1 \
    NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    GH_NO_UPDATE_NOTIFIER=1 \
    GH_PROMPT_DISABLED=1
USER node
ENTRYPOINT ["node", "/opt/review-bot/src/cli/main.ts"]
