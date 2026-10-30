# Project OS board. Build from the project root:
#   docker build -f .project-os/board/Dockerfile .
FROM node:22-alpine
WORKDIR /app
RUN npm init -y >/dev/null && npm install --omit=dev --no-audit --no-fund yaml@2.9.1
COPY project.yaml ./
COPY .project-os/symphony/project.mjs .project-os/symphony/
COPY .project-os/board/ .project-os/board/
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
USER node
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", ".project-os/board/server.mjs"]
