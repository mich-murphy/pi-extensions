#!/usr/bin/env bash
# Runs `fallow mutation` in a throwaway Docker container, so mutated code and the tests it runs
# cannot touch this checkout, your home directory or other processes. The container copies the
# checkout into a Docker volume, installs dependencies when package-lock.json changes, builds the
# pi-peers gateway when the run includes pi-peers, and passes every argument to `fallow mutation`
# with config/fallow-mutation.jsonc. The report goes to stdout; progress goes to stderr.
#
#   scripts/mutation-sandbox.sh packages/pi-retry --kill-matrix --format json --quiet \
#     > .fallow/reports/pi-retry.json
#   scripts/mutation-sandbox.sh packages/pi-retry --kill-matrix --format json --quiet \
#     --compare /reports/pi-retry.json
#
# .fallow/reports is mounted at /reports. The copy lives at /sandbox/repo, not /work: some tests
# use /work/project as a fake project path.
#
# Runs share one volume and wait for each other. To run several checkouts at once, give each its
# own volume: MUTATION_SANDBOX_VOLUME=pi-extensions-mutation-web scripts/mutation-sandbox.sh ...
set -euo pipefail

image=pi-extensions-mutation
volume=${MUTATION_SANDBOX_VOLUME:-$image}

if [[ "${1:-}" == "--inside" ]]; then
  shift
  # Runs share one volume; a second run waits here instead of syncing over the first one's copy.
  exec 9>/sandbox/.lock
  flock 9
  rsync -a --delete --exclude node_modules --exclude .git --exclude coverage --exclude .fallow \
    --exclude packages/pi-peers/gateway/target /src/ /sandbox/repo/
  cd /sandbox/repo
  if ! cmp -s package-lock.json node_modules/.sandbox-lock; then
    npm ci --no-audit --no-fund >&2
    cp package-lock.json node_modules/.sandbox-lock
  fi
  if [[ " $* " == *pi-peers* || " $* " == *" --all "* ]]; then
    (cd packages/pi-peers/gateway && cargo build --locked >&2)
  fi
  # Fallow reads a saved report of at most 64 MiB. A kill matrix of a large package is bigger,
  # mostly because of each mutant's covering tests, which --compare does not read. Compare
  # against a copy without them.
  args=()
  slim() {
    node -e 'const fs = require("node:fs");
      const report = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      for (const mutant of report.mutants) delete mutant.covering_tests;
      fs.writeFileSync(process.argv[2], JSON.stringify(report));' "$1" /sandbox/compare.json
  }
  while (($# > 0)); do
    case "$1" in
      --compare) slim "$2"; args+=(--compare /sandbox/compare.json); shift 2 ;;
      --compare=*) slim "${1#--compare=}"; args+=(--compare=/sandbox/compare.json); shift ;;
      *) args+=("$1"); shift ;;
    esac
  done
  # Fallow needs a clean Git worktree; this one exists only inside the container.
  rm -rf .git
  git init -q && git add -A && git commit -qm sandbox
  # The container is the sandbox, so mutants near file, process and network calls run too.
  exec node_modules/.bin/fallow mutation -c config/fallow-mutation.jsonc --allow-side-effects "${args[@]}"
fi

root=$(git rev-parse --show-toplevel)
mkdir -p "$root/.fallow/reports"
docker build -q -t "$image" -f "$root/config/mutation-sandbox.Dockerfile" "$root/config" >/dev/null
# --init reaps the runner processes that exit while Fallow runs; without it they pile up as zombies.
exec docker run --rm --init -v "$root:/src:ro" -v "$volume:/sandbox" -v "$root/.fallow/reports:/reports" \
  "$image" bash /src/scripts/mutation-sandbox.sh --inside "$@"
