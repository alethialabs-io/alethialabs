// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"strconv"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/catalog"
	"github.com/alethialabs-io/alethialabs/packages/core/cloud"
	"github.com/alethialabs-io/alethialabs/packages/core/compat"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// managedK8sTfvar is the tfvar each managed cloud's ProviderTfvars writes the cluster version into.
// Hetzner is absent on purpose: it does not forward the config version (Talos needs a concrete
// patch), and TestCompatGate_HetznerUnsetVersionSharesTheDeployedMinor covers it separately.
var managedK8sTfvar = map[string]string{
	"aws":     "eks_cluster_version",
	"gcp":     "gke_cluster_version",
	"azure":   "aks_cluster_version",
	"alibaba": "ack_cluster_version",
}

// unsetClusterConfig is a project whose cluster pins no Kubernetes version — the CLI-created and
// blank-project shape (#5268) that the gate used to skip as not_evaluable (#5314).
func unsetClusterConfig(addons ...string) *types.ProjectConfig {
	vc := &types.ProjectConfig{ProjectName: "unset", Region: "r",
		DNS: types.ProjectDNSConfig{ProviderConfig: map[string]any{}}}
	for _, id := range addons {
		vc.AddOns = append(vc.AddOns, types.AddOnInstall{ID: id})
	}
	return vc
}

// TestCompatGate_UnsetVersionIsJudgedAsTheCatalogDefault pins #5314 on the real matrix: an unset
// cluster_version reaches the gate as the catalog default for that cloud, so the K8s-on-cloud
// control is actually evaluated (pass) instead of skipped (not_evaluable).
func TestCompatGate_UnsetVersionIsJudgedAsTheCatalogDefault(t *testing.T) {
	cat := catalog.MustLoad()
	for _, provider := range []string{"aws", "gcp", "azure", "alibaba", "hetzner"} {
		t.Run(provider, func(t *testing.T) {
			want, ok := cat.DefaultK8sVersion(provider)
			if !ok {
				t.Fatalf("catalog has no default_k8s_version for %s", provider)
			}
			subj := compatSubjectFor(false, provider, unsetClusterConfig())
			if subj.K8sVersion != want {
				t.Fatalf("gate judges %q, want the catalog default %q", subj.K8sVersion, want)
			}
			rep := compat.Evaluate(subj)
			id := "COMPAT-K8S-CLOUD-" + strings.ToUpper(provider)
			for _, c := range rep.Controls {
				if c.ID == id && c.Status != compat.StatusPass {
					t.Fatalf("%s = %s (%s), want pass: the unset version was not evaluated", id, c.Status, c.Coverage)
				}
			}
		})
	}
}

// TestCompatGate_RefusesAnAddOnIncompatibleWithTheCatalogDefault is the case #5314 exists for. The
// shipped matrix records no add-on window that excludes today's default, so it uses an explicit
// matrix: an add-on capped one minor BELOW the catalog default. On an unset cluster that add-on
// must FAIL and be unwaived (the apply is refused). Before the fix the gate judged "" and the same
// add-on came back not_evaluable — which Unwaived does not count, so the apply went ahead.
func TestCompatGate_RefusesAnAddOnIncompatibleWithTheCatalogDefault(t *testing.T) {
	def, ok := catalog.MustLoad().DefaultK8sVersion("aws")
	if !ok {
		t.Fatal("catalog has no aws default")
	}
	m := &compat.Matrix{
		CatalogVersion: "test",
		AddOnK8s:       map[string]compat.K8sRange{"too-old": {K8sMin: "1.20", K8sMax: oneMinorBelow(t, def)}},
	}
	subj := compatSubjectFor(false, "aws", unsetClusterConfig("too-old"))

	rep := compat.EvaluateMatrix(m, subj)
	if got := controlStatus(rep, "COMPAT-ADDON-TOO-OLD"); got != compat.StatusFail {
		t.Fatalf("add-on capped below the catalog default on an unset cluster = %s, want fail", got)
	}
	if unresolved := rep.Unwaived(nil); len(unresolved) == 0 {
		t.Fatal("the gate would let this apply through: no unwaived failing control")
	}

	// The pre-fix subject, for contrast: the raw "" is not_evaluable and blocks nothing.
	raw := subj
	raw.K8sVersion = ""
	if got := controlStatus(compat.EvaluateMatrix(m, raw), "COMPAT-ADDON-TOO-OLD"); got != compat.StatusNotEvaluable {
		t.Fatalf("raw unset version = %s, want not_evaluable (the defect this test guards)", got)
	}
}

// TestCompatGate_ExplicitVersionIsUnchanged pins that a pinned version reaches the gate verbatim on
// every cloud — the resolution only fills an unset one.
func TestCompatGate_ExplicitVersionIsUnchanged(t *testing.T) {
	for _, provider := range []string{"aws", "gcp", "azure", "alibaba", "hetzner"} {
		vc := unsetClusterConfig()
		vc.Cluster.ClusterVersion = "1.30"
		if got := compatSubjectFor(false, provider, vc).K8sVersion; got != "1.30" {
			t.Errorf("%s: explicit 1.30 reached the gate as %q", provider, got)
		}
	}
}

// TestCompatGate_ByoIacKeepsTheRawVersion pins that a BYO-IaC deploy is NOT given the catalog
// default: the customer's module decides the version, so a default would be a version nobody
// deploys. An unset version there stays honestly not_evaluable.
func TestCompatGate_ByoIacKeepsTheRawVersion(t *testing.T) {
	if got := compatSubjectFor(true, "aws", unsetClusterConfig()).K8sVersion; got != "" {
		t.Fatalf("BYO-IaC gate judges %q, want the raw \"\"", got)
	}
}

// TestCompatGate_TofuReceivesTheVersionTheGateChecked is the "cannot disagree" half of #5314: for
// every managed cloud, the version tfvar ProviderTfvars hands tofu is exactly the version the gate
// judged — for an unset version and for a pinned one.
func TestCompatGate_TofuReceivesTheVersionTheGateChecked(t *testing.T) {
	for provider, key := range managedK8sTfvar {
		for _, pinned := range []string{"", "1.34"} {
			vc := unsetClusterConfig()
			vc.Cluster.ClusterVersion = pinned
			p, err := cloud.NewCloudProvider(provider)
			if err != nil {
				t.Fatalf("NewCloudProvider(%s): %v", provider, err)
			}
			tfv := p.ProviderTfvars(vc)[key]
			gate := compatSubjectFor(false, provider, vc).K8sVersion
			if tfv != gate {
				t.Errorf("%s (cluster_version %q): tofu receives %s=%v, the gate checked %q", provider, pinned, key, tfv, gate)
			}
			if gate == "" {
				t.Errorf("%s (cluster_version %q): the gate judged an empty version", provider, pinned)
			}
		}
	}
}

// TestCompatGate_HetznerUnsetVersionSharesTheDeployedMinor covers the one cloud whose tfvars do not
// forward the config version: Talos is pinned to a concrete patch in hetzner_provider.go. For an
// unset version the gate's catalog default and that pin must share a minor — the only part the
// gate reads — or the gate would be judging a version Hetzner does not install.
func TestCompatGate_HetznerUnsetVersionSharesTheDeployedMinor(t *testing.T) {
	p, err := cloud.NewCloudProvider("hetzner")
	if err != nil {
		t.Fatal(err)
	}
	vc := unsetClusterConfig()
	deployed, _ := p.ProviderTfvars(vc)["kubernetes_version"].(string)
	gate := compatSubjectFor(false, "hetzner", vc).K8sVersion
	if minorOf(deployed) != minorOf(gate) || gate == "" {
		t.Fatalf("hetzner deploys %q but the gate judges %q — different minors", deployed, gate)
	}
}

// controlStatus returns one control's status from a report, or "" when it is absent.
func controlStatus(rep *compat.Report, id string) compat.Status {
	for _, c := range rep.Controls {
		if c.ID == id {
			return c.Status
		}
	}
	return ""
}

// minorOf trims a Kubernetes version to "MAJOR.MINOR" ("1.35.6" → "1.35").
func minorOf(v string) string {
	parts := strings.SplitN(strings.TrimPrefix(v, "v"), ".", 3)
	if len(parts) < 2 {
		return v
	}
	return parts[0] + "." + parts[1]
}

// oneMinorBelow returns the minor just under v ("1.35" → "1.34").
func oneMinorBelow(t *testing.T, v string) string {
	t.Helper()
	parts := strings.Split(minorOf(v), ".")
	n, err := strconv.Atoi(parts[len(parts)-1])
	if len(parts) != 2 || err != nil || n == 0 {
		t.Fatalf("cannot step below %q", v)
	}
	return parts[0] + "." + strconv.Itoa(n-1)
}
