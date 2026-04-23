# Postgres 16 + pg_cron for local dev.
#
# Stock postgres:16 doesn't ship pg_cron, and no maintained upstream
# image bundles it cleanly on both arm64 and amd64 (Citus dropped it in
# Citus 13; Supabase/CNPG/Tembo drag in much more than we need). This
# is the smallest path: add the Debian-packaged build of pg_cron on top
# of the official image.
#
# Runtime still needs shared_preload_libraries=pg_cron and
# cron.database_name=<db> — those live in docker-compose.yml's
# `command:` so the config is visible next to the service definition.
FROM postgres:16-bookworm

RUN apt-get update \
  && apt-get install -y --no-install-recommends postgresql-16-cron \
  && rm -rf /var/lib/apt/lists/*
