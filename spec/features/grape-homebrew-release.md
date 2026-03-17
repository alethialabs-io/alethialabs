# Homebrew Release Plan for Grape CLI

**Goal:** Automate the release of the Grape CLI and provide a Homebrew tap utilizing the existing monorepo (`bobikenobi12/bb-thesis-2026`).

## Phase 1: GoReleaser Configuration Update
- [x] Update `apps/grape/.goreleaser.yml` to output the Homebrew formula into a `Formula` directory at the root of the monorepo (`bobikenobi12/bb-thesis-2026`).
- [x] Configure `apps/grape/.goreleaser.yml` to filter tags so that it only triggers for monorepo-specific tags (handled via GitHub Action trigger).
- [x] Ensure that the resulting formula works well with `brew tap bobikenobi12/bb-thesis-2026`.

## Phase 2: GitHub Actions CI/CD Setup
- [x] Create `.github/workflows/release-grape.yml`.
- [x] Configure the workflow to trigger only on pushes to tags matching `grape-v*`.
- [x] Add the `goreleaser/goreleaser-action` step.
- [x] Ensure `GITHUB_TOKEN` and `HOMEBREW_TAP_GITHUB_TOKEN` are passed to the GoReleaser action.

## Phase 3: Setup Dependencies (User Action Required)
- [ ] Instruct the user to create a GitHub Personal Access Token (PAT) with `repo` scope.
- [ ] Instruct the user to add this PAT as a repository secret named `HOMEBREW_TAP_GITHUB_TOKEN`.
- [x] Create the `Formula` directory in the root of the repository.

## Phase 4: Tagging and Releasing
- [ ] Commit all configuration and workflow changes.
- [ ] Trigger the first release by tagging the repository: `git tag grape-v0.1.0` followed by `git push origin grape-v0.1.0`.
- [ ] Monitor the GitHub Actions run for success.

## Phase 5: Verification
- [ ] Run `brew tap bobikenobi12/bb-thesis-2026`.
- [ ] Run `brew install grape`.
- [ ] Verify the installation via `grape --help`.
