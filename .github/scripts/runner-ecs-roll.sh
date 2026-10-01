#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Roll the managed runner fleet onto the image just pushed to ECR, if that fleet exists.
#
# The maintainer ruled on 2026-09-24 that there is NO Fargate runner fleet and none is planned
# (#3438). `alethia-runner-dev-eu-west-1-cluster` does not exist. The roll failed every release
# with ClusterNotFoundException (run 35991136678), which turned a release red even though its
# images had published. So a fleet that is ABSENT now skips with a `::notice::` and the step
# passes. A fleet that EXISTS still gets rolled, and every other error still fails the step. The
# one thing this skips over is "there is nothing here to roll".
#
# ONE implementation, two callers:
#   .github/workflows/release-runner.yml     the automatic path, on a runner release
#   .github/workflows/deploy-fleet-aws.yml   the manual dev dispatch
#
# The existence probe is `ecs describe-services`, NOT `describe-clusters`. The deployer role
# (infra/aws-oidc/roles.tf, sid EcsRoll) holds ecs:UpdateService + ecs:DescribeServices on this
# one service ARN and nothing else. `describe-clusters` would return AccessDenied, which would be
# read either as "absent", hiding a real permission fault, or as a failure, reddening every
# release again. Granting the permission would take an admin apply of infra/aws-oidc. We don't
# need it: DescribeServices is authorised against the service ARN, which is built from the names
# we pass, so a missing cluster answers ClusterNotFoundException and not AccessDenied. That is what
# run 35991136678 got from UpdateService, which the role scopes to the same ARN.
#
# Reads:   ECS_CLUSTER, ECS_SERVICE, AWS_REGION     (empty cluster/service = no fleet configured)
# Writes:  `fleet=rolled|absent` to $GITHUB_OUTPUT when set, for the release report.
#
#   bash .github/scripts/runner-ecs-roll.sh               run it (needs AWS credentials)
#   bash .github/scripts/runner-ecs-roll.sh --self-test   exercise every branch against a stub `aws`

set -euo pipefail

# Prints a GitHub `::notice::` that the fleet is absent, records it, and exits 0.
skip_absent() {
  echo "::notice title=No runner fleet — ECS roll skipped::$1 By ruling on #3438 (2026-09-24) there is no Fargate runner fleet, so there is nothing to roll. The images published above are unaffected."
  if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "fleet=absent" >> "$GITHUB_OUTPUT"; fi
  exit 0
}

# Probes for the fleet and rolls it if it exists. Any error except "absent" fails.
roll() {
  local cluster="${ECS_CLUSTER:-}" service="${ECS_SERVICE:-}" region="${AWS_REGION:?AWS_REGION is required}"

  if [ -z "$cluster" ] || [ -z "$service" ]; then
    skip_absent "ECS_CLUSTER/ECS_SERVICE is not configured."
  fi

  # stdout and stderr are kept apart: stdout is parsed as JSON, and the CLI can print a warning
  # to stderr on a call that SUCCEEDED.
  local out err rc=0
  out="$(mktemp)"; err="$(mktemp)"
  aws ecs describe-services --cluster "$cluster" --services "$service" \
    --region "$region" --output json >"$out" 2>"$err" || rc=$?

  if [ "$rc" -ne 0 ]; then
    if grep -q 'ClusterNotFoundException' "$err"; then
      skip_absent "Cluster \`$cluster\` does not exist in $region."
    fi
    # AccessDenied, throttling, a bad region, an expired session: all real, all loud.
    cat "$err" >&2
    echo "::error title=ECS probe failed::aws ecs describe-services exited $rc for $cluster/$service. This is not the absent-fleet case, so the step fails."
    exit "$rc"
  fi

  # A missing service comes back as exit 0 with a `failures[]` entry, not as an error. An INACTIVE
  # cluster behaves the same way. A deleted service can also be listed with status INACTIVE.
  local failure status
  failure="$(jq -r '.failures[0].reason // empty' "$out")"
  status="$(jq -r '.services[0].status // empty' "$out")"
  case "$failure" in
    '') ;;
    MISSING|INACTIVE) skip_absent "Service \`$service\` in \`$cluster\` is $failure." ;;
    *)
      jq . "$out" >&2
      echo "::error title=ECS probe failed::describe-services reported failure '$failure' for $cluster/$service."
      exit 1 ;;
  esac
  case "$status" in
    INACTIVE) skip_absent "Service \`$service\` in \`$cluster\` is INACTIVE." ;;
    ACTIVE) ;;
    *)
      jq . "$out" >&2
      echo "::error title=ECS probe failed::service $cluster/$service has status '${status:-<none>}', which is neither ACTIVE nor absent."
      exit 1 ;;
  esac

  # The fleet exists. The roll runs under `set -e`, so a failure here fails the step as it
  # always did.
  aws ecs update-service --cluster "$cluster" --service "$service" \
    --force-new-deployment --region "$region" >/dev/null
  echo "Deployment triggered on $cluster/$service${VERSION:+ for runner v$VERSION}."
  if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "fleet=rolled" >> "$GITHUB_OUTPUT"; fi
}

# Runs roll() against a stub `aws` in every shape the probe can answer, and asserts both the exit
# code and the recorded verdict. It runs every case and exits non-zero if any mismatched: the exit
# code is the test, the printed lines are a report.
self_test() {
  local dir; dir="$(mktemp -d)"
  trap 'rm -rf "$dir"' RETURN
  mkdir -p "$dir/bin"
  # The stub reads its behaviour from the environment. It logs every call so the test can assert
  # whether update-service was reached.
  cat >"$dir/bin/aws" <<'STUB'
#!/usr/bin/env bash
echo "$*" >> "$STUB_LOG"
case "$2" in
  describe-services)
    [ -n "${STUB_DESCRIBE_ERR:-}" ] && { echo "$STUB_DESCRIBE_ERR" >&2; exit 254; }
    printf '%s\n' "$STUB_DESCRIBE_OUT" ;;
  update-service)
    [ -n "${STUB_UPDATE_ERR:-}" ] && { echo "$STUB_UPDATE_ERR" >&2; exit 254; }
    echo '{}' ;;
esac
STUB
  chmod +x "$dir/bin/aws"

  local fails=0 n=0
  # check <name> <want-exit> <want-fleet> <want-update-called:yes|no> [VAR=value ...]
  check() {
    local name="$1" want_rc="$2" want_fleet="$3" want_update="$4"; shift 4
    n=$((n + 1))
    : >"$dir/log"; : >"$dir/out"
    local rc=0
    env -i PATH="$dir/bin:$PATH" HOME="$HOME" STUB_LOG="$dir/log" GITHUB_OUTPUT="$dir/out" \
      AWS_REGION=eu-west-1 ECS_CLUSTER=c ECS_SERVICE=s "$@" \
      bash "$0" >/dev/null 2>&1 || rc=$?
    local fleet updated=no
    fleet="$(sed -n 's/^fleet=//p' "$dir/out")"
    grep -q '^ecs update-service' "$dir/log" && updated=yes
    if [ "$rc" != "$want_rc" ] || [ "$fleet" != "$want_fleet" ] || [ "$updated" != "$want_update" ]; then
      echo "FAIL  $name: exit=$rc fleet='$fleet' update=$updated (want exit=$want_rc fleet='$want_fleet' update=$want_update)"
      fails=$((fails + 1))
    else
      echo "ok    $name"
    fi
  }

  local active='{"services":[{"status":"ACTIVE"}],"failures":[]}'
  check 'cluster unset skips'            0 absent no  ECS_CLUSTER=
  check 'ClusterNotFound skips'          0 absent no  STUB_DESCRIBE_ERR='An error occurred (ClusterNotFoundException) when calling the DescribeServices operation: Cluster not found.'
  check 'service MISSING skips'          0 absent no  STUB_DESCRIBE_OUT='{"services":[],"failures":[{"reason":"MISSING"}]}'
  check 'service INACTIVE skips'         0 absent no  STUB_DESCRIBE_OUT='{"services":[{"status":"INACTIVE"}],"failures":[]}'
  check 'AccessDenied fails loudly'    254 ''     no  STUB_DESCRIBE_ERR='An error occurred (AccessDeniedException) when calling the DescribeServices operation'
  check 'unknown failure reason fails'   1 ''     no  STUB_DESCRIBE_OUT='{"services":[],"failures":[{"reason":"SOMETHING"}]}'
  check 'DRAINING status fails'          1 ''     no  STUB_DESCRIBE_OUT='{"services":[{"status":"DRAINING"}],"failures":[]}'
  check 'ACTIVE fleet is rolled'         0 rolled yes STUB_DESCRIBE_OUT="$active"
  check 'ACTIVE fleet, roll error fails' 254 ''   yes STUB_DESCRIBE_OUT="$active" STUB_UPDATE_ERR='An error occurred (ServiceNotActiveException)'

  echo "$((n - fails))/$n passed"
  [ "$fails" -eq 0 ]
}

if [ "${1:-}" = "--self-test" ]; then
  self_test
else
  roll
fi
