# Project OS Claude orchestrator for runtime.host: dokploy. Build from the project root:
#   docker build -f .project-os/orchestrator/Dockerfile .
# Mount a volume at /data: it holds feature state, workspaces and the Claude
# sessions (/data/home/.claude), which must survive redeploys.
FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends git openssh-client ca-certificates curl \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli.gpg \
 && echo "deb [signed-by=/usr/share/keyrings/githubcli.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
RUN npm init -y >/dev/null \
 && npm install --omit=dev --no-audit --no-fund yaml@2.9.1 @anthropic-ai/claude-agent-sdk@0.3.319
COPY project.yaml WORKFLOW.md ./
COPY .project-os/ .project-os/
RUN mkdir -p /data/home && chown -R node:node /data
ENV NODE_ENV=production HOME=/data/home ORCHESTRATOR_STATE=/data
VOLUME /data
USER node
CMD ["node", ".project-os/orchestrator/start.mjs"]
