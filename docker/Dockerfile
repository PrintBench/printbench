# syntax=docker/dockerfile:1.7
#
# One image, two commands: `web` runs Next.js, `worker` runs the job processor.
# Debian slim rather than Alpine — sharp's prebuilt binaries are glibc-linked,
# and fighting musl to save a few MB is a false economy.

FROM golang:1.26.11-alpine AS go-toolchain

# ---- deps ------------------------------------------------------------------
FROM node:26-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY apps/clipper/package.json apps/clipper/
COPY packages/db/package.json packages/db/
COPY packages/core/package.json packages/core/
COPY packages/mesh/package.json packages/mesh/
COPY packages/jobs/package.json packages/jobs/
COPY packages/auth/package.json packages/auth/
RUN --mount=type=cache,target=/root/.npm npm ci

# tsx and development tools bring their own esbuild versions. Rebuild each
# one with the patched Go standard library and keep the JS wrapper versions.
RUN --mount=type=bind,from=go-toolchain,source=/usr/local/go,target=/usr/local/go \
    --mount=type=bind,from=go-toolchain,source=/etc/ssl/certs/ca-certificates.crt,target=/tmp/go-ca-certificates.crt \
    --mount=type=cache,target=/root/.cache/go-build \
    --mount=type=cache,target=/root/go/pkg/mod <<'SH'
set -eu
export PATH="/usr/local/go/bin:$PATH" GOTOOLCHAIN=local CGO_ENABLED=0
export SSL_CERT_FILE=/tmp/go-ca-certificates.crt
build_dir=$(mktemp -d)
trap 'rm -rf "$build_dir"' EXIT

# npm installs both a CLI and a platform-specific binary beneath node_modules.
find node_modules -type f -path '*/bin/esbuild' -exec sh -ec '
  build_dir=$1
  shift
  for binary do
    version=$("$binary" --version)
    rebuilt="$build_dir/$version/esbuild"
    if [ ! -x "$rebuilt" ]; then
      GOBIN="$build_dir/$version" go install -trimpath -ldflags="-s -w" "github.com/evanw/esbuild/cmd/esbuild@v$version"
    fi
    install -m 0755 "$rebuilt" "$binary"
  done
' sh "$build_dir" {} +
SH

# ---- build -----------------------------------------------------------------
FROM node:26-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build -w @pb/web

# ---- runtime ---------------------------------------------------------------
FROM node:26-slim AS runtime
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
# Local operators need the same recovery command when the last admin is locked out.
COPY --from=build /app/scripts/issue-password-reset.mts ./scripts/issue-password-reset.mts

COPY docker/entrypoint.sh docker/local-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/local-entrypoint.sh \
 && useradd --system --uid 10001 --create-home app \
 && mkdir -p /data /libraries && chown -R app:app /data /libraries /app
USER app

EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["web"]
