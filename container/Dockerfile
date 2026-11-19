# The container of a Claude Code job in the workspace (SPEC 4.5). Claude Code at a pinned version, Candor built
# from source in a first stage, the sample project and Node. Build from the repository root:
#   docker build -f container/Dockerfile -t candor-job .
# Separate users keep the worker away from Candor (src/core/run/isolation.ts): root runs Candor, agent runs
# Claude Code, worker runs its shell commands. The API key is never in the image or the container.
FROM node:22-bookworm-slim AS node

# Candor, built from source, so the image does not depend on a build that ran before it.
FROM node:22-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
RUN --mount=type=secret,id=proxyca,required=false \
    if [ -f /run/secrets/proxyca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxyca; fi; \
    npm ci --ignore-scripts
COPY src ./src
RUN npx tsc -p tsconfig.build.json

FROM ubuntu:24.04
# Optional, for building behind a proxy: --build-arg APT_PROXY=... and --secret id=proxyca,src=<ca file>.
ARG APT_PROXY=""
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx
RUN --mount=type=secret,id=proxyca,required=false \
    if [ -f /run/secrets/proxyca ]; then mkdir -p /usr/local/share/ca-certificates && cp /run/secrets/proxyca /usr/local/share/ca-certificates/build-proxy.crt; chmod 0644 /usr/local/share/ca-certificates/build-proxy.crt; \
      sed -i 's|http://|https://|g' /etc/apt/sources.list.d/ubuntu.sources; \
      echo "Acquire::https::Proxy \"$APT_PROXY\"; Acquire::https::CaInfo \"/usr/local/share/ca-certificates/build-proxy.crt\";" > /etc/apt/apt.conf.d/90proxy; fi \
 && apt-get update && apt-get install -y --no-install-recommends ca-certificates git sudo procps ripgrep \
 && rm -f /usr/local/share/ca-certificates/build-proxy.crt && update-ca-certificates --fresh >/dev/null \
 && sed -i 's|https://|http://|g' /etc/apt/sources.list.d/ubuntu.sources && rm -rf /var/lib/apt/lists/* /etc/apt/apt.conf.d/90proxy
RUN --mount=type=secret,id=proxyca,required=false \
    if [ -f /run/secrets/proxyca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxyca; fi; \
    npm install -g @anthropic-ai/claude-code@2.1.327 && npm cache clean --force
RUN groupadd -g 1003 proj && useradd -m -u 1001 -U -G proj -s /bin/bash agent && useradd -m -u 1002 -g proj -s /bin/bash worker \
 && chmod 0755 /home/agent \
 && echo 'agent ALL=(worker) NOPASSWD:SETENV: ALL' > /etc/sudoers.d/agent && chmod 0440 /etc/sudoers.d/agent \
 && echo 'Defaults:agent !requiretty' >> /etc/sudoers.d/agent
WORKDIR /opt/candor
COPY package.json package-lock.json ./
RUN --mount=type=secret,id=proxyca,required=false \
    if [ -f /run/secrets/proxyca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxyca; fi; \
    npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY bin ./bin
COPY --from=build /src/dist ./dist
COPY docs/COVERAGE.md ./docs/COVERAGE.md
COPY demo/invoices/original ./sample
COPY container/as-worker container/controller.mjs ./container/
RUN chmod 0755 container/as-worker && ln -s /opt/candor/bin/candor.js /usr/local/bin/candor && chmod -R go-w /opt/candor
ENV CANDOR_ISOLATION=users CANDOR_AGENT_UID=1001 CANDOR_AGENT_GID=1001 CANDOR_WORKER_UID=1002 CANDOR_WORKER_GID=1003 \
    CANDOR_AGENT_HOME=/home/agent CANDOR_SHELL_PREFIX=/opt/candor/container/as-worker CANDOR_HOME=/var/candor \
    CLAUDE_CONFIG_DIR=/home/agent/.claude CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_AUTOUPDATER=1 \
    CANDOR_WATCHER_MODEL=claude-opus-5-5 CANDOR_WATCHER_BUDGET_USD=2 CANDOR_WATCHER_CALL_USD=0.3
EXPOSE 8080
CMD ["node", "/opt/candor/container/controller.mjs"]
