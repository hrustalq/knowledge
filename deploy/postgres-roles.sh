#!/bin/sh
# Postgres roles for production (#790): migrations run as an owner role, the
# app (api, worker, git, learner) as a role that can only read and write rows.
# Neither is a superuser, so neither can bypass row-level security or reach
# the container through COPY … FROM PROGRAM.
#
# Runs as the image's superuser (PGHOST/PGUSER/PGPASSWORD/PGDATABASE) before
# every `prisma migrate deploy`: the init container of the homelab `migrate`
# Job, where deploy.yml syncs this file. Idempotent. An init script would
# not do: Postgres runs those only on an empty volume.
#
#   DATABASE_OWNER_URL  the owner's login, which migrations use
#   DATABASE_URL        the app's login
#
# The role names and passwords come from those URLs, so each lives in one
# place. Passwords must be URL-safe (`openssl rand -hex`), because nothing
# here undoes percent-encoding. Unset DATABASE_OWNER_URL = roles not managed,
# and migrations run as DATABASE_URL, as they did before.
set -eu

if [ -z "${DATABASE_OWNER_URL:-}" ]; then
  echo "postgres-roles: DATABASE_OWNER_URL unset, roles left as they are"
  exit 0
fi

# postgresql://user:password@host:port/db?… → user, password
creds() { c=${1#*://}; c=${c%%@*}; printf '%s' "$c"; }
owner=$(creds "$DATABASE_OWNER_URL"); owner_pass=${owner#*:}; owner=${owner%%:*}
app=$(creds "$DATABASE_URL"); app_pass=${app#*:}; app=${app%%:*}

for p in "$owner_pass" "$app_pass"; do
  case $p in '' | *%*) echo "postgres-roles: a password is empty or percent-encoded; use openssl rand -hex" >&2; exit 1 ;; esac
done
if [ "$app" = "$PGUSER" ] || [ "$owner" = "$PGUSER" ] || [ "$app" = "$owner" ]; then
  echo "postgres-roles: DATABASE_URL ($app), DATABASE_OWNER_URL ($owner) and the superuser ($PGUSER) must be three different roles" >&2
  exit 1
fi

psql -v ON_ERROR_STOP=1 -qX -v owner="$owner" -v owner_pass="$owner_pass" -v app="$app" -v app_pass="$app_pass" <<'SQL'
SELECT format('CREATE ROLE %I', r) FROM unnest(ARRAY[:'owner', :'app']) r
 WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = r) \gexec

-- Asserted on every run, so a rotated password lands and a hand-granted
-- attribute is taken back.
SELECT format('ALTER ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', r, p)
  FROM (VALUES (:'owner', :'owner_pass'), (:'app', :'app_pass')) v(r, p) \gexec

SELECT format('ALTER DATABASE %I OWNER TO %I', current_database(), :'owner') \gexec
ALTER SCHEMA public OWNER TO :"owner";

-- Every table the superuser created before this script existed moves to the
-- owner (REASSIGN OWNED cannot move objects off the bootstrap superuser), and
-- ALTER TABLE takes the sequences its columns own along. The migrations create
-- nothing else that outlives them: no views, enums, functions or free sequences.
SELECT format('ALTER TABLE %s OWNER TO %I', c.oid::regclass, :'owner') FROM pg_class c
 WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND c.relowner <> :'owner'::regrole \gexec

-- The app reads and writes rows, nothing else: no DDL, no TRUNCATE, and no
-- hand on the migration history. Default privileges cover every table a
-- later migration creates, so a release never needs a manual grant.
GRANT USAGE ON SCHEMA public TO :"app";
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO :"app";
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO :"app";
-- Absent on an empty volume until the first migrate; the next run revokes it.
SELECT format('REVOKE ALL ON TABLE public._prisma_migrations FROM %I', :'app')
 WHERE to_regclass('public._prisma_migrations') IS NOT NULL \gexec
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner" IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :"app";
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner" IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO :"app";
SQL

echo "postgres-roles: migrations as $owner, app as $app"
