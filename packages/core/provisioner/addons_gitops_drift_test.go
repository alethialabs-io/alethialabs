// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"slices"
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

// driftWarning is the drift sentence for body, or "" when gitopsAddOnDrift reports nothing. It also
// pins that a reported entry always carries its sentence, which is what the console pairs on.
func driftWarning(t *testing.T, body string, want types.AddOnInstall) string {
	t.Helper()
	d, ok := gitopsAddOnDrift("ingress-nginx", []byte(body), want)
	if !ok {
		if d != (argocd.AddonDriftStatus{}) {
			t.Errorf("no drift reported, but the entry is not empty: %+v", d)
		}
		return ""
	}
	if d.Warning == "" {
		t.Errorf("a drift entry carries no Deploy-tab sentence: %+v", d)
	}
	return d.Warning
}

// TestGitopsAddOnDriftWarning_NamesTheAddOnAndBothVersions covers every arm of the rule: an older
// seeded chart is reported with the add-on, the file's version and the version Alethia would seed;
// everything the check cannot be sure of is silent.
func TestGitopsAddOnDriftWarning_NamesTheAddOnAndBothVersions(t *testing.T) {
	want := ingressGitOps("4.15.1")

	w := driftWarning(t, seededIngress(t, "4.11.2"), want)
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
			if got := driftWarning(t, tc.body, want); got != "" {
				t.Errorf("want no warning, got:\n%s", got)
			}
		})
	}

	// A v-prefixed OLDER version is still drift — the `v` spells the same version.
	vOld := mustReplace(t, seededIngress(t, "4.11.2"), "targetRevision: 4.11.2", "targetRevision: v4.11.2")
	if driftWarning(t, vOld, want) == "" {
		t.Error("a v-prefixed older version was not reported")
	}
	// SemVer order, not string order: 4.9.0 is older than 4.15.1 though "4.9" > "4.1" as text.
	if driftWarning(t, seededIngress(t, "4.9.0"), want) == "" {
		t.Error("4.9.0 was not reported as older than 4.15.1 — the comparison is lexical")
	}
}

// TestGitopsAddOnDrift_StructuredFields (#6549): the structured entry names the add-on, the
// repo-relative file, the chart and both versions exactly as written, so the console can act on the
// add-on without parsing the sentence. The file's version keeps its spelling (`v4.11.2` stays
// `v4.11.2`), because the console edits that exact text.
func TestGitopsAddOnDrift_StructuredFields(t *testing.T) {
	body := mustReplace(t, seededIngress(t, "4.11.2"), "targetRevision: 4.11.2", "targetRevision: v4.11.2")
	d, ok := gitopsAddOnDrift("ingress-nginx", []byte(body), ingressGitOps("4.15.1"))
	if !ok {
		t.Fatal("drift was not reported")
	}
	want := argocd.AddonDriftStatus{
		AddonID:        "ingress-nginx",
		File:           "addons/ingress-nginx.yaml",
		Chart:          "ingress-nginx",
		SeededVersion:  "v4.11.2",
		DesiredVersion: "4.15.1",
	}
	want.Warning = gitopsAddOnDriftWarning(want)
	if d != want {
		t.Errorf("drift entry\n got %+v\nwant %+v", d, want)
	}
	if !strings.Contains(d.Warning, "v4.11.2") || !strings.Contains(d.Warning, "4.15.1") {
		t.Errorf("the sentence does not name both versions: %s", d.Warning)
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
	if len(warnings) != 1 || warnings[0].AddonID != "ingress-nginx" ||
		warnings[0].SeededVersion != "4.11.2" || warnings[0].DesiredVersion != "4.15.1" {
		t.Fatalf("want one drift entry for ingress-nginx 4.11.2 -> 4.15.1, got %+v", warnings)
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
		t.Errorf("a current manifest produced drift: %+v", warnings)
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
	// #6549: the structured entry rides alongside, and its Warning is the very string in Warnings,
	// which is how a console that reads both pairs them and shows the add-on once.
	if len(stage.AddonDrift) != 1 || stage.AddonDrift[0].AddonID != "ingress-nginx" {
		t.Fatalf("want one structured drift entry for ingress-nginx, got %+v", stage.AddonDrift)
	}
	if !slices.Contains(stage.Warnings, stage.AddonDrift[0].Warning) {
		t.Errorf("the structured entry's Warning %q is not one of the stage warnings %q",
			stage.AddonDrift[0].Warning, stage.Warnings)
	}
}

// TestAttachDeployReport (#6549): the deploy attaches the warnings, the BYO admission modes and the
// add-on drift to the GitOps snapshot the console reads, and leaves a nil snapshot nil.
func TestAttachDeployReport(t *testing.T) {
	attachDeployReport(nil, []string{"w"}, nil, nil) // must not panic

	drift := []argocd.AddonDriftStatus{{AddonID: "ingress-nginx", Warning: "w"}}
	byo := []argocd.ByoAdmissionNamespaceStatus{{Namespace: "payments"}}
	st := &argocd.GitopsStatus{Mode: "gitops"}
	attachDeployReport(st, []string{"w"}, byo, drift)
	if !slices.Equal(st.ManifestWarnings, []string{"w"}) {
		t.Errorf("ManifestWarnings = %q", st.ManifestWarnings)
	}
	if len(st.ByoAdmission) != 1 || st.ByoAdmission[0].Namespace != "payments" {
		t.Errorf("ByoAdmission = %+v", st.ByoAdmission)
	}
	if !slices.Equal(st.AddonDrift, drift) {
		t.Errorf("AddonDrift = %+v, want %+v", st.AddonDrift, drift)
	}
}

// TestAddonDriftStatus_WireNames pins the JSON names the console's zod schema reads
// (apps/console/lib/gitops/deploy-status.ts). Renaming one in Go alone would make the console drop
// every entry silently, so the names are stated here as data.
func TestAddonDriftStatus_WireNames(t *testing.T) {
	st := argocd.GitopsStatus{Mode: "gitops", AddonDrift: []argocd.AddonDriftStatus{{
		AddonID: "a", File: "addons/a.yaml", Chart: "c", SeededVersion: "1.0.0", DesiredVersion: "2.0.0", Warning: "w",
	}}}
	raw, err := json.Marshal(st)
	if err != nil {
		t.Fatal(err)
	}
	want := `"addon_drift":[{"addon_id":"a","file":"addons/a.yaml","chart":"c","seeded_version":"1.0.0","desired_version":"2.0.0","warning":"w"}]`
	if !strings.Contains(string(raw), want) {
		t.Errorf("wire form\n got %s\nwant it to contain %s", raw, want)
	}
	// And absent, not null, when nothing drifted — an older console's schema treats it as optional.
	raw, _ = json.Marshal(argocd.GitopsStatus{Mode: "gitops"})
	if strings.Contains(string(raw), "addon_drift") {
		t.Errorf("an empty drift list is on the wire: %s", raw)
	}
}
