# review-bot action image (C-2, C-3a). Built by action.yml with the
# repository root as context.
#
# - Base image pinned by digest (multi-arch index of node:24.22.3-trixie-slim).
# - rg, fd and gh from pinned release assets, SHA-256 verified (tools.json), at
#   build time only. No apt-get: nothing unpinned enters the image.
# - git (for `review-bot setup`'s git package sources, F-7) and the Debian
#   packages it needs, from snapshot.debian.org URLs pinned with their SHA-256
#   in debs.json (action/update-debs.sh), installed with dpkg. Its CA bundle is
#   Node's own root certificates (the base image has no ca-certificates), so
#   it changes only with the pinned Node.
# - Dependencies from package-lock.json with `npm ci --ignore-scripts`.
# - PI_OFFLINE=1: pi never downloads binaries or refreshes its catalog.
#
# No `# syntax=` line on purpose: it would pull a frontend image by tag.

FROM node:24.22.3-trixie-slim@sha256:af02d57b57719b9657a45199a79264a9437940cd55b3c7b3fc99615654f124a0 AS tools
COPY action/tools.json action/install-tools.mjs action/debs.json action/fetch-debs.mjs /build/
RUN node /build/install-tools.mjs /build/tools.json /build/bin \
 && node /build/fetch-debs.mjs /build/debs.json /build/debs

FROM node:24.22.3-trixie-slim@sha256:af02d57b57719b9657a45199a79264a9437940cd55b3c7b3fc99615654f124a0
COPY --from=tools /build/bin/rg /build/bin/fd /build/bin/gh /usr/local/bin/
RUN --mount=type=bind,from=tools,source=/build/debs,target=/debs \
    dpkg -i /debs/*.deb \
 && if ldd /usr/lib/git-core/git-remote-https | grep -q 'not found'; then exit 1; fi \
 && git --version \
 && mkdir -p /etc/ssl/certs \
 && node -e 'require("fs").writeFileSync("/etc/ssl/certs/ca-certificates.crt", require("tls").rootCertificates.join("\n") + "\n")'
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
# The real node binary by absolute path, never a version-manager shim: SIGTERM
# from `docker stop` or the step's timeout must reach review-bot, which
# forwards it to pi (`review-bot launch`, F-3, S-9).
ENTRYPOINT ["/usr/local/bin/node", "/opt/review-bot/src/cli/main.ts"]
