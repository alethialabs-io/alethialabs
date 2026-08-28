// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"context"
	"io"
	"os"
	"regexp"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/argocd"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// argoValuesFileRe pulls the shell-quoted `-f <path>` arguments back off the helm command line, in
// order. The paths are ShellQuote'd (utils.ShellQuote wraps in single quotes) and live under
// os.MkdirTemp, so they never contain a quote to escape.
//
// This exists because the install now carries MORE THAN ONE values file. Every test here used to
// find "the" one with `strings.Index(command, " -f ")` and take the rest of the string, which
// silently swallowed the second file's flag into the first file's PATH the moment a second
// appeared. The helpers below are the disambiguator, and they live in this file because this is the
// change that introduced the ambiguity.
var argoValuesFileRe = regexp.MustCompile(`-f '([^']+)'`)

// argoValuesFiles returns the contents of every `-f`'d values file on a helm command, in the order
// helm would merge them.
//
// Read INSIDE the executeCommand stub, always: installArgoCD defers os.RemoveAll on its scratch
// dir, so after it returns there is nothing on disk. A test that read the files afterwards would
// see "no such file" and could only assert on the command string — which is how a values file that
// is referenced but empty slips through.
func argoValuesFiles(t *testing.T, command string) []string {
	t.Helper()
	var out []string
	for _, m := range argoValuesFileRe.FindAllStringSubmatch(command, -1) {
		b, err := os.ReadFile(m[1])
		if err != nil {
			t.Errorf("values file %s named on the helm command line could not be read: %v", m[1], err)
			continue
		}
		out = append(out, string(b))
	}
	return out
}

// argoIngressValues returns the PER-CLOUD INGRESS values file, or "" when the install rendered
// none. Identified by content — everything that is not the unconditional probe values — rather
// than by filename or position, so it cannot drift if either changes.
func argoIngressValues(t *testing.T, command string) string {
	t.Helper()
	probes := argocd.InstallProbeValues()
	for _, c := range argoValuesFiles(t, command) {
		if c != probes {
			return c
		}
	}
	return ""
}

// captureArgoInstall runs installArgoCD with the command seam stubbed and returns the helm install
// command plus the CONTENTS of every `-f` values file it named.
//
// Reading the files INSIDE the stub is load-bearing: installArgoCD defers os.RemoveAll on its
// scratch dir, so by the time it returns there is nothing left on disk to read. A test that read
// them afterwards would see "file not found" and could only ever assert on the command string,
// which is how a values file that is referenced but empty would slip through.
func captureArgoInstall(t *testing.T, vc *types.ProjectConfig, outputs map[string]interface{}) (string, []string) {
	t.Helper()
	resetDeploySeams(t)

	executeCommandWithOutput = func(string, string, []string) (string, error) {
		return "existing-auth", nil
	}
	var install string
	var contents []string
	executeCommand = func(command, _ string, _ []string, _, _ io.Writer) error {
		if !strings.Contains(command, "helm upgrade --install argo-cd") {
			return nil
		}
		install = command
		contents = argoValuesFiles(t, command)
		return nil
	}

	if err := installArgoCD(context.Background(), vc, outputs, &PlanResult{}, io.Discard, io.Discard); err != nil {
		t.Fatalf("installArgoCD: %v", err)
	}
	if install == "" {
		t.Fatal("installArgoCD never issued a `helm upgrade --install argo-cd` command")
	}
	return install, contents
}

// TestInstallArgoCDAlwaysCarriesTheProbeValues is the wiring guard, and the case that matters is
// the FIRST one: a project with no DNS at all.
//
// The chart's default probes restart-loop argocd-server and argocd-repo-server on a small burstable
// node — a property of the NODE, not of DNS, of a certificate or of a cloud. The natural place to
// have put these values was next to the per-cloud ingress values, and that would have shipped the
// fix to only the subset of projects that configure a domain, while the e2e floor runs that
// measured the defect are exactly the ones that do. Hence a case per shape.
func TestInstallArgoCDAlwaysCarriesTheProbeValues(t *testing.T) {
	want := argocd.InstallProbeValues()

	for _, tc := range []struct {
		name    string
		vc      *types.ProjectConfig
		outputs map[string]interface{}
	}{
		{
			name: "no DNS, no ingress — the bare install every other cloud takes",
			vc:   &types.ProjectConfig{},
		},
		{
			name: "DNS enabled but no certificate output — ingress skipped, probes still needed",
			vc:   &types.ProjectConfig{DNS: types.ProjectDNSConfig{Enabled: true, DomainName: "example.com"}},
		},
		{
			name:    "aws ALB ingress (--set flags, no values file of its own)",
			vc:      &types.ProjectConfig{DNS: types.ProjectDNSConfig{Enabled: true, DomainName: "example.com"}},
			outputs: map[string]interface{}{"acm_certificate_arn": "arn:aws:acm:region:acct:certificate/123"},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, contents := captureArgoInstall(t, tc.vc, tc.outputs)
			found := false
			for _, c := range contents {
				if c == want {
					found = true
				}
			}
			if !found {
				t.Fatalf("the helm install carried %d values file(s), none of them the probe values — the chart's 1-second liveness timeout would restart-loop argocd-server on a burstable node.\ngot: %#v", len(contents), contents)
			}
		})
	}
}

// TestInstallArgoCDOrdersProbeValuesBeforeTheIngressValues pins the merge order on the one path
// that ships a second values file. helm merges `-f` left to right, so a per-cloud file must be able
// to win on any key it also sets. Today nothing overlaps; this is what keeps that true.
func TestInstallArgoCDOrdersProbeValuesBeforeTheIngressValues(t *testing.T) {
	// The GKE branch is gated on a gcp-only output PLUS cert-manager's readiness, so the identity
	// outputs below are what make CertManagerEnabled() true — without them the switch falls through
	// and no ingress values file is rendered at all.
	install, contents := captureArgoInstall(t,
		&types.ProjectConfig{
			Provider: "gcp",
			DNS:      types.ProjectDNSConfig{Enabled: true, DomainName: "example.com", ManagedCertificate: true},
		},
		map[string]interface{}{
			"gke_cluster_name":             "gke-test",
			"external_dns_service_account": "edns@demo.iam.gserviceaccount.com",
			"gcp_project_id":               "demo",
			"cloud_dns_zone_name":          "demo-zone",
		})

	if len(contents) != 2 {
		t.Fatalf("GKE install carried %d values files, want 2 (probes then ingress):\n%s", len(contents), install)
	}
	if contents[0] != argocd.InstallProbeValues() {
		t.Errorf("the FIRST values file is not the probe values — a per-cloud file can no longer override a probe key:\n%s", contents[0])
	}
	if !strings.Contains(contents[1], "ingressClassName: gce") {
		t.Errorf("the SECOND values file is not the GKE ingress values:\n%s", contents[1])
	}
}
