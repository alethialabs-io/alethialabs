<!--
SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
SPDX-License-Identifier: AGPL-3.0-only
-->

# github (repo-as-code)

Repo governance as OpenTofu (provider `integrations/github`): the `dev` branch, the
`main`/`dev` protection **rulesets**, and the deployer-role **Actions variables**.
This is the source of truth — the `gh api` snippets in `deploy/prod/README.md` are a
manual fallback only.

- **`main`**: PR required, **0 approvals** (solo repo — CI is the gate), all CI checks
  green, no force-push/deletion, admins included. **Merge commits allowed** (NOT linear
  history) — a promotion (`release/<sha>` → main, opened by `promote.yml`) lands as a merge so main
  stays convergent with dev; requiring linear history forced squash promotions that diverged the
  graph and made the next promotion falsely conflict.
- **`staging`**: no longer protected here. The staging hop is retired (2026-11-22) and its
  `protect-staging` ruleset was removed from this stack; the `staging` git branch itself is left in
  place. `github_branch.dev` still names it as `source_branch` (via `rc_branch`), which only matters
  when `dev` is created — `lifecycle.ignore_changes = [source_branch]` keeps any plan from replacing
  `dev` over it.
- **`dev`** (`protect-dev`): originally created off `staging`; feature PRs target it. **PR + green CI, 0 approvals,
  MERGIFY QUEUE.** No force-push/deletion. Mergify builds speculative branches on the projected `dev`
  tip, reruns the required checks, and squash-merges in FIFO order. It does **not** emit GitHub's native
  `merge_group` event: a queue build is a `pull_request` CI run on the draft PR Mergify opens from a
  `mergify/merge-queue/*` branch. The `provision-e2e` (T1) job runs on those builds, and
  `scripts/merge-signal-health.sh` grades the observe-only signals over them (#2759). The required
  CI is ONE context, `CI required` — ci.yml's aggregator job, whose `needs:` list decides which CI
  jobs gate a merge — plus `contribution-legal` (cla.yml, a separate workflow the aggregator cannot
  reach). Making another ci.yml job required is an edit to that `needs:` list, not to this stack
  or `.mergify.yml`. Promotions (`release/<sha>` → main) are merged by agents once green — every
  check and every release-gate leg passed — through `.claude/hooks/guard-merge.sh` (maintainer
  ruling 2026-11-06).
  - **Repo settings prerequisite** (not TF-managed — the repo resource isn't in this stack): the queue
    needs `allow_auto_merge` **on** so `--auto` can enqueue. It is set once, by the maintainer: add a
    `github_repository` resource carrying `allow_auto_merge` and `allow_update_branch` to this stack
    and apply it with tofu. An agent may do it when instructed; `.claude/hooks/guard-destroy.sh`
    records the repository's settings (a GET) to `~/.alethia/backups/` before any API write to it.

`github_owner`/`repository` are variables → switching to an org repo is a var change.

## `require_extra_approval_for_unattributed_changes` — false, re-asserted after every apply

**Decision (maintainer, 2026-11-25, #7654):** this `pull_request` rule parameter is **false** on
`protect-dev` (18583159) and `protect-main` (18465988). It was set live that day.

The provider cannot hold it. `integrations/github` 6.12.1 and 6.13.0 have no attribute for it, so
every create or update the provider makes PUTs a `pull_request` rule without the field, and GitHub
then sets it **true**. `main.tf` therefore has one `terraform_data` per ruleset
(`dev_ruleset_unattributed_changes_false`, `main_ruleset_unattributed_changes_false`). Each has
`lifecycle.replace_triggered_by = [<that ruleset>]`, so any plan that updates or replaces the ruleset
also replaces it. The replacement runs a `local-exec` after the ruleset write. That script:

1. GETs `repos/<owner>/<repo>/rulesets/<numeric id>`. It refuses an id that is not a number.
2. Stops without writing if every `pull_request` rule already reads `false`.
3. Otherwise PUTs `{"rules": [...]}`: the rules it just read, with only that field set to `false`.
   Name, target, enforcement, conditions and bypass actors are not in the body, so they cannot change.
4. GETs the ruleset again and fails the apply unless the field now reads `false`.

What that means for an apply:

- **First apply after #7654:** the plan adds the two `terraform_data` resources. Both scripts find
  `false` already and write nothing.
- **An apply that writes a ruleset:** the plan shows that ruleset updated **and** its `terraform_data`
  replaced. The replacement is the re-assertion, not a change to read past.
- **A clean plan stays clean.** The provider cannot see the field and `etag` is computed, so the
  script's own PUT leaves nothing for the next plan to show.
- **Requirements:** `gh` and `jq` on the PATH of the machine that runs `tofu apply`. The script uses
  `var.github_token`, the provider's own token.

**What no apply covers:** a hand edit that sets the flag back to `true` and changes nothing else gives
the provider nothing to plan, so nothing re-asserts it. The drift check covers that case.
`node scripts/ci/check-required-checks.mjs --live` runs from `workflow-health.yml` and reads
`rules/branches/<branch>`. It exits 2 and opens the drift issue if either branch reads `true`. If the
field is missing from the response, that counts as no measurement, not as `false`. The PR-time run
(`pnpm check:required-checks`) fails if a ruleset with a `pull_request` block has no such
`terraform_data` wired to it.

To fix it by hand (the same edit the script makes; read before you write):

```bash
path=repos/alethialabs-io/alethialabs/rulesets/18465988   # or 18583159 for protect-dev
gh api "$path" \
  | jq -c '{rules: [.rules[] | if .type == "pull_request" then .parameters.require_extra_approval_for_unattributed_changes = false else . end]}' \
  | gh api -X PUT "$path" --input -
```

## Auth (your own `gh` token — no App)

Applied **locally, once** as part of the admin bootstrap. The provider needs a token with
**Administration** (rulesets), **Contents** (create `dev`), and **Actions variables** write
— as the repo owner/admin, `gh auth token` already has this. Pass it as
`-var github_token=$(gh auth token)`. (No GitHub App: all runtime secrets live in AWS
Secrets Manager, so nothing in CI needs to write GitHub secrets.)

## Apply

> **The three role ARNs are now COMMITTED in `terraform.tfvars`** (tracked via the
> `!terraform.tfvars` negation in this stack's `.gitignore`), so a checkout carries them and
> an apply no longer depends on remembering `-var`. Every value in that file is a public repo
> Actions variable, read from the live repository rather than typed.
>
> That warning had been here since the stack was written, and it was the whole defect: the three
> deployer-role Actions vars are `count`-gated on variables defaulting to `""` (`main.tf:161`,
> `:168`, `:175`), so a bare `tofu apply` from any checkout planned their **destroy** — taking
> `infra-cp-hetzner.yml`'s federation, the runner release's OIDC, and deploy-console's Secrets
> Manager read with them. A comment is not a control (#3108, following #3105).
>
> **Still true:** apply from an up-to-date `main`. If the checkout predates a resource here, a
> plan can still propose destroying the `production` environment (`environments.tf`), which is
> the OIDC deploy control. And `github_token` has no default — pass it at apply time.
> (`plan -destroy`/`apply` from an agent is forbidden — see root `CLAUDE.md`.)

Normally run by `bootstrap.yml`. Locally:

```bash
cp backend.hcl.example backend.hcl
tofu init -backend-config=backend.hcl
tofu apply \
  -var "github_token=$(gh auth token)" \
  -var "cp_deployer_role_arn=$(cd ../aws-oidc && tofu output -raw cp_deployer_role_arn)" \
  -var "runner_release_deployer_role_arn=$(cd ../aws-oidc && tofu output -raw runner_release_deployer_role_arn)" \
  -var "deploy_reader_role_arn=$(cd ../aws-oidc && tofu output -raw deploy_reader_role_arn)"
```

> If `dev` or a ruleset already exists, import it first (`tofu import
> github_branch.dev <repo>:dev`, `tofu import github_repository_ruleset.main
> <repo>:<ruleset_id>`) so apply adopts rather than fails.
