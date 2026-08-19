# syntax=docker/dockerfile:1.7
#
# One image, two commands: `web` runs Next.js, `worker` runs the job processor.
# Debian slim rather than Alpine — sharp's prebuilt binaries are glibc-linked,
# and fighting musl to save a few MB is a false economy.

# ---- deps ------------------------------------------------------------------
FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/db/package.json packages/db/
COPY packages/core/package.json packages/core/
COPY packages/mesh/package.json packages/mesh/
COPY packages/jobs/package.json packages/jobs/
COPY packages/auth/package.json packages/auth/
RUN --mount=type=cache,target=/root/.npm npm ci

# ---- build -----------------------------------------------------------------
FROM node:24-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build -w @pm/web

# ---- runtime ---------------------------------------------------------------
FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini curl \
 && rm -rf /var/lib/apt/lists/*

# Next standalone output already contains the pruned node_modules it needs.
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /app/apps/web/public ./apps/web/public

# The worker runs from TypeScript source via tsx, so it needs the full tree.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/apps/worker ./apps/worker
COPY --from=build /app/packages ./packages
COPY --from=build /app/package.json ./package.json

COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh \
 && useradd --system --uid 10001 --create-home app \
 && mkdir -p /data /libraries && chown -R app:app /data /libraries /app
USER app

EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["web"]
