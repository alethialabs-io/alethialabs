#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"

usage() {
	echo "Usage: pnpm codex:doctor | pnpm codex:self-test" >&2
	exit 1
}

doctor() {
	local required path
	for required in .codex/config.toml .codex/hooks.json .codex/rules/default.rules .codex/README.md \
		.agents/skills/README.md \
		.claude/hooks/guard-spend.sh .claude/hooks/guard-destroy.sh .claude/hooks/guard-secrets.sh .claude/hooks/lib/cmdline.sh \
		.codex/hooks/common.sh .codex/hooks/pre-tool-use.sh .codex/hooks/guard-git-flow.sh \
		.codex/hooks/pre-apply-patch.sh \
		.codex/hooks/post-apply-patch.sh .codex/hooks/session-start.sh; do
		path="$ROOT/$required"
		[ -f "$path" ] || { echo "✗ missing $required" >&2; return 1; }
	done
	local dir name link target
	for dir in "$ROOT"/.claude/skills/*; do
		[ -d "$dir" ] || continue
		[ -f "$dir/SKILL.md" ] || continue
		name="${dir##*/}"
		link="$ROOT/.agents/skills/$name"
		[ -L "$link" ] || { echo "✗ missing skill link .agents/skills/$name" >&2; return 1; }
		target="$(readlink "$link")"
		[ "$target" = "../../.claude/skills/$name" ] || {
			echo "✗ incorrect skill link .agents/skills/$name -> $target" >&2
			return 1
		}
	done
	jq empty "$ROOT/.codex/hooks.json"
	grep -Fq 'approval_policy = "on-request"' "$ROOT/.codex/config.toml"
	grep -Fq 'approvals_reviewer = "auto_review"' "$ROOT/.codex/config.toml"
	grep -Fq 'prefix_rule(pattern=["git", "pull"], decision="allow")' "$ROOT/.codex/rules/default.rules"
	git -C "$ROOT" diff --check
	echo "✓ Codex project configuration is present and valid"
	echo "  project  $ROOT"
	echo "  branch   $(git -C "$ROOT" branch --show-current)"
	echo "  hooks    review once with /hooks after restarting Codex"
}

expect_hook() {
	local want="$1" command="$2" payload result
	payload="$(jq -n --arg command "$command" '{tool_name:"Bash",cwd:env.PWD,tool_input:{command:$command}}')"
	result="$(printf '%s' "$payload" | CODEX_SESSION_ID=self-test CODEX_PID="$$" bash "$ROOT/.codex/hooks/pre-tool-use.sh")"
	if [ "$want" = "deny" ]; then
		jq -e '.hookSpecificOutput.permissionDecision == "deny"' >/dev/null <<<"$result" || {
			echo "✗ expected denial for: $command" >&2
			return 1
		}
	else
		[ -z "$result" ] || { echo "✗ expected allow for: $command" >&2; return 1; }
	fi
}

self_test() {
	local guard
	for guard in guard-worktree.sh guard-compose.sh guard-runtime.sh guard-merge.sh guard-spend.sh guard-destroy.sh guard-secrets.sh; do
		bash "$ROOT/.claude/hooks/$guard" --self-test
	done
	bash "$ROOT/scripts/lib/wt-lease.sh" --self-test
	expect_hook allow "git status --short"
	expect_hook allow "pnpm check-types"
	expect_hook deny "pnpm dev:up"
	expect_hook deny "pnpm db:reset"
	# Instructed infrastructure and production work is ALLOWED (maintainer, 2026-11-22): the
	# harness keeps secrets out of the transcript, keeps deletions recoverable and meters spend.
	expect_hook allow "tofu -chdir=infra/cp-aws apply"
	expect_hook allow "gh workflow run deploy-console.yml"
	# Still refused: pushes to protected branches and repo/release deletion (guard-destroy, until
	# its backup-then-allow mechanism lands), the default hcloud context (another company's
	# production), and printing a secret.
	expect_hook deny "git push origin main"
	expect_hook deny "gh repo delete alethialabs-io/app --yes"
	expect_hook deny "gh -R alethialabs-io/app release delete v1 --yes"
	expect_hook deny "hcloud server create --name x"
	expect_hook deny "printenv"
	expect_hook deny "aws secretsmanager get-secret-value --secret-id alethia/prod/env"
	echo "✓ Codex hook adapter self-tests passed"
}

case "${1:-}" in
	doctor) doctor ;;
	self-test) self_test ;;
	*) usage ;;
esac
