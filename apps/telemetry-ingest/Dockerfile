# Self-contained build — this service has no workspace deps, so the build
# context is just this directory (no monorepo root needed).
FROM oven/bun:1.3-slim

WORKDIR /app

# Install deps first for layer caching.
COPY package.json ./
RUN bun install --production

COPY src ./src

ENV PORT=8080
EXPOSE 8080

CMD ["bun", "run", "src/index.ts"]
