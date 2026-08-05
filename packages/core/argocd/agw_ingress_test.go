// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"strings"
	"testing"
)

// TestAGWArgoServerValues locks the Application Gateway ArgoCD ingress values: both fail-closed
// refusals (no host, no issuer) and the exact TLS contract with the argo-cd chart — `tls: true`
// plus the cert-manager issuer annotation, and NO `appgw.ssl-certificate` (two sources for one
// listener is how a certificate flaps).
func TestAGWArgoServerValues(t *testing.T) {
	tests := []struct {
		name    string
		host    string
		issuer  string
		wantErr string
		want    []string
		notWant []string
	}{
		{name: "no host is refused", host: "   ", issuer: CertManagerIssuerName, wantErr: "no host"},
		{name: "no issuer is refused", host: "argocd.example.com", issuer: " ", wantErr: "no cert-manager issuer"},
		{
			name: "the rendered values ask for a certificate rather than naming one",
			host: "argocd.example.com", issuer: CertManagerIssuerName,
			want: []string{
				"server.insecure: \"true\"",
				"ingressClassName: " + AGWIngressClassName,
				"hostname: argocd.example.com",
				"tls: true",
				"cert-manager.io/cluster-issuer: \"" + CertManagerIssuerName + "\"",
				"appgw.ingress.kubernetes.io/ssl-redirect: \"true\"",
			},
			notWant: []string{"appgw.ssl-certificate", "tlsSecret"},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := AGWArgoServerValues(tc.host, tc.issuer)
			if tc.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
					t.Fatalf("AGWArgoServerValues() error = %v, want it to contain %q", err, tc.wantErr)
				}
				if got != "" {
					t.Errorf("a refused render returned values: %q", got)
				}
				return
			}
			if err != nil {
				t.Fatalf("AGWArgoServerValues() error = %v, want nil", err)
			}
			for _, want := range tc.want {
				if !strings.Contains(got, want) {
					t.Errorf("values missing %q:\n%s", want, got)
				}
			}
			for _, unwanted := range tc.notWant {
				if strings.Contains(got, unwanted) {
					t.Errorf("values must not contain %q:\n%s", unwanted, got)
				}
			}
		})
	}
}
