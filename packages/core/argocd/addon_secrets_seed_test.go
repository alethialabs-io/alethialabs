// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"bytes"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// TestEnsureAddOnSecrets covers the seeding loop: which add-ons are skipped, which are refused
// fail-closed, how a missing fetched value is reported, and — the #640 rule — that no plaintext
// secret value ever reaches stdout or stderr.
func TestEnsureAddOnSecrets(t *testing.T) {
	const plaintext = "sup3r-s3cret-value"

	tests := []struct {
		name       string
		addons     []types.AddOnInstall
		fetched    map[string]map[string]string
		wantApply  bool
		wantStderr string
		wantStdout string
	}{
		{
			name:      "an add-on with no SecretRef is skipped",
			addons:    []types.AddOnInstall{{ID: "grafana"}},
			wantApply: false,
		},
		{
			name: "a half-formed SecretRef (no namespace) is skipped",
			addons: []types.AddOnInstall{{
				ID:        "grafana",
				SecretRef: &types.AddOnSecretRef{SecretName: "grafana-creds", Keys: []string{"adminPassword"}},
			}},
			wantApply: false,
		},
		{
			name: "an out-of-charset SecretRef is REFUSED, never rendered",
			addons: []types.AddOnInstall{{
				ID: "grafana",
				SecretRef: &types.AddOnSecretRef{
					SecretName: "grafana-creds", Namespace: "obs; rm -rf /", Keys: []string{"adminPassword"},
				},
			}},
			fetched:    map[string]map[string]string{"grafana": {"adminPassword": plaintext}},
			wantApply:  false,
			wantStderr: "carries an invalid secret ref",
		},
		{
			name: "a missing fetched value is reported and the add-on is skipped when nothing is left",
			addons: []types.AddOnInstall{{
				ID: "grafana",
				SecretRef: &types.AddOnSecretRef{
					SecretName: "grafana-creds", Namespace: "obs", Keys: []string{"adminPassword"},
				},
			}},
			fetched:    map[string]map[string]string{},
			wantApply:  false,
			wantStderr: "missing value(s) for key(s) adminPassword",
		},
		{
			name: "static data still seeds the Secret when a fetched value is missing",
			addons: []types.AddOnInstall{{
				ID: "grafana",
				SecretRef: &types.AddOnSecretRef{
					SecretName: "grafana-creds", Namespace: "obs",
					Keys:       []string{"adminPassword"},
					StaticData: map[string]string{"adminUser": "admin"},
				},
			}},
			wantApply:  true,
			wantStderr: "missing value(s) for key(s) adminPassword",
			wantStdout: "Seeding add-on secret obs/grafana-creds (1 key(s))",
		},
		{
			name: "a complete SecretRef is seeded",
			addons: []types.AddOnInstall{{
				ID: "grafana",
				SecretRef: &types.AddOnSecretRef{
					SecretName: "grafana-creds", Namespace: "obs",
					Keys:       []string{"adminPassword"},
					StaticData: map[string]string{"adminUser": "admin"},
				},
			}},
			fetched:    map[string]map[string]string{"grafana": {"adminPassword": plaintext}},
			wantApply:  true,
			wantStdout: "Seeding add-on secret obs/grafana-creds (2 key(s))",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			stub := newKubectlStub(t, 0)
			var stdout, stderr bytes.Buffer
			EnsureAddOnSecrets(tc.addons, tc.fetched, &stdout, &stderr)

			if applied := stub.calledWith("apply -f"); applied != tc.wantApply {
				t.Errorf("kubectl apply = %v, want %v (calls: %v)", applied, tc.wantApply, stub.calls())
			}
			if tc.wantStderr != "" && !strings.Contains(stderr.String(), tc.wantStderr) {
				t.Errorf("stderr = %q, want it to contain %q", stderr.String(), tc.wantStderr)
			}
			if tc.wantStdout != "" && !strings.Contains(stdout.String(), tc.wantStdout) {
				t.Errorf("stdout = %q, want it to contain %q", stdout.String(), tc.wantStdout)
			}
			if strings.Contains(stdout.String(), plaintext) || strings.Contains(stderr.String(), plaintext) {
				t.Errorf("a plaintext secret value leaked into the job log:\nstdout=%q\nstderr=%q", &stdout, &stderr)
			}
		})
	}
}

// TestEnsureAddOnSecretsReportsApplyFailure locks the best-effort contract: a kubectl apply that
// fails warns and moves on — one bad add-on never fails an otherwise-healthy cluster.
func TestEnsureAddOnSecretsReportsApplyFailure(t *testing.T) {
	newKubectlStub(t, 1)
	var stdout, stderr bytes.Buffer
	EnsureAddOnSecrets([]types.AddOnInstall{{
		ID: "grafana",
		SecretRef: &types.AddOnSecretRef{
			SecretName: "grafana-creds", Namespace: "obs", Keys: []string{"adminPassword"},
		},
	}}, map[string]map[string]string{"grafana": {"adminPassword": "pw"}}, &stdout, &stderr)

	if !strings.Contains(stderr.String(), "failed to seed add-on secret obs/grafana-creds") {
		t.Errorf("stderr = %q, want the seed failure reported", stderr.String())
	}
}
