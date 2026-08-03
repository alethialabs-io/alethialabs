// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package runners

import (
	"os"
	"sort"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/api"
)

// templatesDir is the runner-template root, relative to this package (packages/core/runners).
const templatesDir = "../../../infra/templates/runner"

// TestDeployProvidersMatchTemplateDirectories is the drift guard: this package's list must be
// exactly the directory names the runner stats at deploy time. It is the Go half of the pair —
// apps/console/tests/lib/runners/deploy-providers.test.ts asserts the same thing about the
// console's list — so adding a template directory reds here AND there, and nobody has to
// remember that a second list exists.
func TestDeployProvidersMatchTemplateDirectories(t *testing.T) {
	entries, err := os.ReadDir(templatesDir)
	if err != nil {
		t.Fatalf("read %s: %v", templatesDir, err)
	}

	var dirs []string
	for _, e := range entries {
		if e.IsDir() {
			dirs = append(dirs, e.Name())
		}
	}
	sort.Strings(dirs)

	got := DeployProviders()
	sort.Strings(got)

	if len(dirs) != len(got) {
		t.Fatalf("deployProviders %v != %s directories %v — widen deployProviders (and the console's RUNNER_DEPLOY_PROVIDERS)", got, templatesDir, dirs)
	}
	for i := range dirs {
		if dirs[i] != got[i] {
			t.Fatalf("deployProviders %v != %s directories %v", got, templatesDir, dirs)
		}
	}
}

// TestDeployProvidersIsACopy proves a caller cannot mutate the package's own list through the
// slice it is handed — the gate is only worth having if it cannot be widened by accident.
func TestDeployProvidersIsACopy(t *testing.T) {
	got := DeployProviders()
	if len(got) == 0 {
		t.Fatal("DeployProviders() is empty")
	}
	got[0] = "tampered"
	if IsDeployProvider("tampered") {
		t.Fatal("mutating the returned slice widened the gate")
	}
	if !IsDeployProvider("aws") {
		t.Fatal("mutating the returned slice narrowed the gate")
	}
}

// TestIsDeployProvider covers the narrow: exactly the templated clouds, nothing else.
func TestIsDeployProvider(t *testing.T) {
	if !IsDeployProvider("aws") {
		t.Fatal("aws must be deployable — infra/templates/runner/aws exists")
	}
	for _, other := range []string{"gcp", "azure", "alibaba", "hetzner", "digitalocean", "civo", "", "AWS"} {
		if IsDeployProvider(other) {
			t.Fatalf("IsDeployProvider(%q) = true, want false", other)
		}
	}
}

// TestDeployProvidersLabel checks the prose renderer against the list it is derived from, and
// against the shapes a widened list would take (the joiner is the part that silently breaks).
func TestDeployProvidersLabel(t *testing.T) {
	if got := DeployProvidersLabel(); got != "AWS" {
		t.Fatalf("DeployProvidersLabel() = %q, want %q", got, "AWS")
	}

	original := deployProviders
	t.Cleanup(func() { deployProviders = original })

	for _, tc := range []struct {
		name  string
		given []string
		want  string
	}{
		{name: "two", given: []string{"aws", "gcp"}, want: "AWS or GCP"},
		{name: "three", given: []string{"aws", "gcp", "azure"}, want: "AWS, GCP or AZURE"},
		{name: "one", given: []string{"aws"}, want: "AWS"},
		{name: "none", given: []string{}, want: ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			deployProviders = tc.given
			if got := DeployProvidersLabel(); got != tc.want {
				t.Fatalf("DeployProvidersLabel() = %q, want %q", got, tc.want)
			}
		})
	}
}

// TestUnsupportedMessage checks the refusal names both the cloud that was asked for and the
// way out — the two things a user needs and the reason this string is shared, not per-surface.
func TestUnsupportedMessage(t *testing.T) {
	msg := UnsupportedMessage("gcp")
	for _, want := range []string{"gcp", DeployProvidersLabel(), "self-hosted runner"} {
		if !strings.Contains(msg, want) {
			t.Fatalf("UnsupportedMessage(\"gcp\") = %q, missing %q", msg, want)
		}
	}
}

// TestFilterDeployable proves the picker's input is narrowed to buildable clouds, order kept,
// and that an all-rejected list comes back empty rather than nil.
func TestFilterDeployable(t *testing.T) {
	in := []api.CloudIdentity{
		{ID: "1", Provider: "gcp", Label: "prod-gcp"},
		{ID: "2", Provider: "aws", Label: "prod-aws"},
		{ID: "3", Provider: "azure", Label: "prod-azure"},
		{ID: "4", Provider: "aws", Label: "dev-aws"},
	}
	got := FilterDeployable(in)
	if len(got) != 2 || got[0].ID != "2" || got[1].ID != "4" {
		t.Fatalf("FilterDeployable() = %v, want the two aws identities in order", got)
	}

	none := FilterDeployable([]api.CloudIdentity{{ID: "1", Provider: "gcp"}})
	if none == nil {
		t.Fatal("FilterDeployable() returned nil, want an empty slice")
	}
	if len(none) != 0 {
		t.Fatalf("FilterDeployable() = %v, want empty", none)
	}
}
