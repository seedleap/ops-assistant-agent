#!/bin/sh
set -eu

umask 027

data_dir="${DATA_DIR:-/app/data}"
config_dir="${data_dir}/config"
skills_dir="${SKILLS_DIR:-${data_dir}/skills}"
seed_root="${SEED_ROOT:-/app/seed}"

mkdir -p "${data_dir}" "${config_dir}" "${skills_dir}" "${HOME:-${data_dir}/home}" "${XDG_CACHE_HOME:-${data_dir}/cache}"

# The image contains versioned defaults. Runtime edits live on the persistent
# volume and win on restart; newly added defaults are copied only when absent.
if [ -d "${seed_root}/config" ]; then
  cp -a -n "${seed_root}/config/." "${config_dir}/"
fi
if [ -d "${seed_root}/skills" ]; then
  cp -a -n "${seed_root}/skills/." "${skills_dir}/"
fi

if [ ! -w "${data_dir}" ]; then
  echo "[entrypoint] DATA_DIR is not writable: ${data_dir}" >&2
  exit 1
fi

exec "$@"
