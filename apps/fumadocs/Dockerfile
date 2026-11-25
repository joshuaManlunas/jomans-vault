FROM node:24-slim AS builder
COPY --from=oven/bun:1 /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app

COPY . .
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --frozen-lockfile
WORKDIR /app/apps/fumadocs
RUN --network=none bun run build

FROM caddy:2-alpine AS runner
COPY apps/fumadocs/Caddyfile /etc/caddy/Caddyfile
COPY --from=builder /app/apps/fumadocs/.output/public /srv

RUN chown -R nobody:nogroup /config /data
USER nobody:nogroup
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=5s --retries=5 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/docs || exit 1
