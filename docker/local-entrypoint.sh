#!/bin/sh
set -eu

credentials=/run/printbench

create_secret() {
  path="$credentials/$1"
  if [ -s "$path" ]; then
    return
  fi

  # Publish a fully written file without replacing one another initializer created.
  temp=$(mktemp "$path.XXXXXX")
  trap 'rm -f "$temp"' EXIT
  node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))' > "$temp"
  chown app:app "$temp"
  if ! ln "$temp" "$path"; then
    test -s "$path"
  fi
  rm -f "$temp"
  trap - EXIT
}

if [ "$1" = init ]; then
  if [ -s /var/lib/postgresql/18/docker/PG_VERSION ] &&
    { [ ! -s "$credentials/postgres-password" ] || [ ! -s "$credentials/auth-secret" ]; }; then
    echo 'PrintBench credentials are missing for an existing database. Restore the credentials volume.' >&2
    exit 1
  fi

  create_secret postgres-password
  create_secret auth-secret
  exit 0
fi

password=$(cat "$credentials/postgres-password")
BETTER_AUTH_SECRET=$(cat "$credentials/auth-secret")
DATABASE_URL="postgres://printbench:$password@db:5432/printbench"
export BETTER_AUTH_SECRET DATABASE_URL

exec /usr/local/bin/entrypoint.sh "$@"
