// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Package runners holds the facts about DEPLOYED runners (operator=self, provisioning=deployed)
// that the Go binaries need — today, the one fact the CLI's deploy picker cannot work without:
// which clouds a DEPLOY_RUNNER job can actually build a runner in.
//
// # Where the truth lives
//
// The SINGLE source of truth is the set of directory names under `infra/templates/runner/`.
// `apps/runner/internal/agent/deploy_runner.go` stats that directory and fails closed on a miss
// ("no templates for provider %s"), so the filesystem is not a description of the rule — it IS
// the rule. Everything else is a derivation whose only job is to move that refusal earlier.
//
// There are two derivations, one per language, and NEITHER is a copy of the other:
//
//   - `apps/console/lib/runners/deploy-providers.ts`, pinned to the directory by
//     `apps/console/tests/lib/runners/deploy-providers.test.ts` (a readdir).
//   - this file, pinned to the same directory by `deploy_providers_test.go` (the same readdir).
//
// # Why this is not generated
//
// The repo's rule is that a fact one language needs from the other is GENERATED with a CI
// diff-gate, never hand-copied (enums_gen.go, catalog.ts, keyless-cells.ts). That rule is about
// a fact one side OWNS. Here neither side owns it: the console list is itself a derivation, so
// generating Go from TypeScript would enshrine a derivation as a source and add a second failure
// mode (a stale generated file) on top of the one that matters.
//
// Reading `infra/templates/runner/` at runtime — the other option — is not available to this
// package: the CLI ships as a standalone binary on a user's laptop with no repo checkout, and
// `go:embed` cannot reach outside the module directory. So the fact is derived at TEST time
// instead, which gives the same guarantee at the same place (CI) for both languages: adding a
// template directory reds a test in each, and each names the one-line list it wants widened.
package runners

import (
	"fmt"
	"strings"

	"github.com/alethialabs-io/alethialabs/packages/core/api"
)

// deployProviders is the list `deploy_providers_test.go` pins to `infra/templates/runner/`.
// Unexported so callers go through DeployProviders() and cannot mutate the backing array.
var deployProviders = []string{"aws"}

// DeployProviders returns the clouds a DEPLOY_RUNNER job can build a runner in, as a copy the
// caller may sort or filter without corrupting the package's own list.
func DeployProviders() []string {
	out := make([]string, len(deployProviders))
	copy(out, deployProviders)
	return out
}

// IsDeployProvider reports whether a runner can actually be deployed into this cloud.
func IsDeployProvider(provider string) bool {
	for _, p := range deployProviders {
		if p == provider {
			return true
		}
	}
	return false
}

// DeployProvidersLabel renders the deployable clouds as user-facing prose — "AWS",
// "AWS or GCP", "AWS, GCP or AZURE" — derived from the list rather than hand-written, so a
// widened list rewrites every message that embeds it. Mirrors RUNNER_DEPLOY_PROVIDERS_LABEL in
// apps/console/lib/runners/deploy-providers.ts.
func DeployProvidersLabel() string {
	names := make([]string, len(deployProviders))
	for i, p := range deployProviders {
		names[i] = strings.ToUpper(p)
	}
	if len(names) < 2 {
		return strings.Join(names, "")
	}
	return fmt.Sprintf("%s or %s", strings.Join(names[:len(names)-1], ", "), names[len(names)-1])
}

// UnsupportedMessage is the refusal for a deploy asked for a cloud with no runner template.
// Deliberately word-for-word with runnerDeployUnsupportedMessage() in the console module, so a
// user who hits the wall in the CLI and the same wall in the UI reads one sentence, not two.
func UnsupportedMessage(provider string) string {
	return fmt.Sprintf(
		"Deploying a runner into %s is not supported — deployed runners are %s only. Register a self-hosted runner instead; it runs on any cloud.",
		provider, DeployProvidersLabel(),
	)
}

// FilterDeployable keeps only the cloud identities a runner can actually be deployed into.
// Returns a non-nil empty slice when nothing matches, so callers can branch on len() alone.
func FilterDeployable(identities []api.CloudIdentity) []api.CloudIdentity {
	out := make([]api.CloudIdentity, 0, len(identities))
	for _, id := range identities {
		if IsDeployProvider(id.Provider) {
			out = append(out, id)
		}
	}
	return out
}
