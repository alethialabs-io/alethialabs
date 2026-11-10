// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"bytes"
	"context"
	"io"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/argocd"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// #6537: a GitOps-mode add-on is seed-once, so a catalogue chart bump never reaches the file in
// the customer's apps repo. The runner holds that file during the GitOps write; these tests pin
// that it READS the seeded version, names it on the Deploy tab when it is older than what this
// deploy would seed, and still never rewrites the file.

// ingressGitOps is the concrete case: the catalogue moved ingress-nginx to 4.15.1.
func ingressGitOps(version string) types.AddOnInstall {
	return types.AddOnInstall{
		ID: "ingress-nginx", Mode: "gitops",
		ChartRepo: "https://kubernetes.github.io/ingress-nginx",
		Chart:     "ingress-nginx", Version: version, Namespace: "ingress-nginx",
	}
}

// seededIngress is an `addons/ingress-nginx.yaml` as an earlier deploy seeded it, at `rev`.
func seededIngress(t *testing.T, rev string) string {
	t.Helper()
	m, err := renderSeedManifest(ingressGitOps(rev), nil)
	if err != nil {
		t.Fatalf("render the seeded manifest: %v", err)
	}
	return m
}

// mustReplace replaces old with new in s, failing the test when old is absent — so a case meant to
// be a range or a foreign chart cannot silently stay the plain seeded file and pass for that reason.
func mustReplace(t *testing.T, s, old, new string) string {
	t.Helper()
	if !strings.Contains(s, old) {
		t.Fatalf("fixture edit: %q is not in the seeded manifest:\n%s", old, s)
	}
	return strings.Replace(s, old, new, 1)
}

// TestGitopsAddOnDriftWarning_NamesTheAddOnAndBothVersions covers every arm of the rule: an older
// seeded chart is reported with the add-on, the file's version and the version Alethia would seed;
// everything the check cannot be sure of is silent.
func TestGitopsAddOnDriftWarning_NamesTheAddOnAndBothVersions(t *testing.T) {
	want := ingressGitOps("4.15.1")

	w := gitopsAddOnDriftWarning("ingress-nginx", []byte(seededIngress(t, "4.11.2")), want)
	for _, part := range []string{"ingress-nginx", "addons/ingress-nginx.yaml", "4.11.2", "4.15.1", "does not rewrite"} {
		if !strings.Contains(w, part) {
			t.Errorf("drift warning is missing %q:\n%s", part, w)
		}
	}

	for _, tc := range []struct {
		name string
		body string
	}{
		{"the same version", seededIngress(t, "4.15.1")},
		{"a newer version (the customer moved ahead)", seededIngress(t, "4.16.0")},
		{"a v-prefixed equal version", mustReplace(t, seededIngress(t, "4.15.1"), "targetRevision: 4.15.1", "targetRevision: v4.15.1")},
		{"a range the customer chose", mustReplace(t, seededIngress(t, "4.11.2"), "targetRevision: 4.11.2", "targetRevision: 4.*")},
		{"a shorthand version", mustReplace(t, seededIngress(t, "4.11.2"), "targetRevision: 4.11.2", "targetRevision: \"4.11\"")},
		{"a different chart (the customer replaced ours)", mustReplace(t, seededIngress(t, "4.11.2"), "chart: ingress-nginx", "chart: traefik")},
		{"not an Application", "kind: Deployment\nspec:\n  source:\n    chart: ingress-nginx\n    targetRevision: 4.11.2\n"},
		{"not YAML", "\t: : ["},
		{"empty", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := gitopsAddOnDriftWarning("ingress-nginx", []byte(tc.body), want); got != "" {
				t.Errorf("want no warning, got:\n%s", got)
			}
		})
	}

	// A v-prefixed OLDER version is still drift — the `v` spells the same version.
	vOld := mustReplace(t, seededIngress(t, "4.11.2"), "targetRevision: 4.11.2", "targetRevision: v4.11.2")
	if gitopsAddOnDriftWarning("ingress-nginx", []byte(vOld), want) == "" {
		t.Error("a v-prefixed older version was not reported")
	}
	// SemVer order, not string order: 4.9.0 is older than 4.15.1 though "4.9" > "4.1" as text.
	if gitopsAddOnDriftWarning("ingress-nginx", []byte(seededIngress(t, "4.9.0")), want) == "" {
		t.Error("4.9.0 was not reported as older than 4.15.1 — the comparison is lexical")
	}
}

// TestWriteAddOnGitOps_ReportsDriftAndNeverRewrites drives the real GitOps write against a repo
// whose seeded manifest is on the old chart: the warning comes back, the file is byte-identical,
// and no commit is made.
func TestWriteAddOnGitOps_ReportsDriftAndNeverRewrites(t *testing.T) {
	old := seededIngress(t, "4.11.2")
	bare := newBareAppsRepo(t, map[string]string{"addons/ingress-nginx.yaml": old})
	vc := &types.ProjectConfig{ProjectName: "acme"}
	vc.Repositories.AppsDestinationRepo = "file://" + bare
	vc.AddOns = []types.AddOnInstall{ingressGitOps("4.15.1")}

	var out, errb bytes.Buffer
	warnings, err := writeAddOnGitOps(t.Context(), vc, "tok", nil, &out, &errb)
	if err != nil {
		t.Fatalf("writeAddOnGitOps: %v", err)
	}
	if len(warnings) != 1 || !strings.Contains(warnings[0], "4.11.2") || !strings.Contains(warnings[0], "4.15.1") {
		t.Fatalf("want one drift warning naming 4.11.2 and 4.15.1, got %q", warnings)
	}
	if got := readBareRepo(t, bare)["addons/ingress-nginx.yaml"]; got != old {
		t.Errorf("the seeded manifest was rewritten:\n%s", got)
	}
	if got := commitCount(t, bare); got != 1 {
		t.Errorf("commit count = %d, want 1 — reporting drift must not commit", got)
	}

	// A current file says nothing.
	bare = newBareAppsRepo(t, map[string]string{"addons/ingress-nginx.yaml": seededIngress(t, "4.15.1")})
	vc.Repositories.AppsDestinationRepo = "file://" + bare
	warnings, err = writeAddOnGitOps(t.Context(), vc, "tok", nil, &out, &errb)
	if err != nil {
		t.Fatalf("writeAddOnGitOps: %v", err)
	}
	if len(warnings) != 0 {
		t.Errorf("a current manifest produced warnings: %q", warnings)
	}
}

// TestRunAddOnStage_GitOpsDriftReachesTheDeployTab: the warning is not only returned by the write,
// the add-on stage hands it to RunDeployV2 with the others, which is what the Deploy tab shows.
func TestRunAddOnStage_GitOpsDriftReachesTheDeployTab(t *testing.T) {
	newByoCluster(t, "")
	stubSweep(t)
	bare := newBareAppsRepo(t, map[string]string{"addons/ingress-nginx.yaml": seededIngress(t, "4.11.2")})
	vc := &types.ProjectConfig{ProjectName: "acme"}
	vc.Repositories.AppsDestinationRepo = "file://" + bare
	vc.AddOns = []types.AddOnInstall{ingressGitOps("4.15.1")}

	stage, err := runAddOnStage(context.Background(), addOnStageInput{
		VC:             vc,
		Facts:          &argocd.InfraFacts{},
		Provider:       "aws",
		GitAccessToken: "tok",
		Refresh:        func(context.Context, string) error { return nil },
	}, io.Discard, io.Discard)
	if err != nil {
		t.Fatalf("runAddOnStage: %v", err)
	}
	if !strings.Contains(strings.Join(stage.Warnings, "\n"), "GitOps add-on ingress-nginx") {
		t.Errorf("the GitOps drift warning did not reach the Deploy tab: %q", stage.Warnings)
	}
}
