// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package manifests

import (
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// renderOneWithIngress renders one hosted service under opts and returns its manifest.
func renderOneWithIngress(t *testing.T, opts Options) string {
	t.Helper()
	opts.Domain = "example.com"
	apps, skipped, _ := FromServices([]types.ProjectServiceConfig{{
		Name:          "api",
		Source:        types.ProjectServiceSource{Kind: "repo", RepoURL: "https://github.com/acme/api"},
		ResolvedImage: "123.dkr.ecr.us-east-1.amazonaws.com/api@sha256:abc123",
		Ports:         []types.ServicePort{{ContainerPort: 9000}},
	}}, opts)
	if len(skipped) != 0 || len(apps) != 1 {
		t.Fatalf("want 1 app, got %d (skipped %v)", len(apps), skipped)
	}
	out, err := RenderApp(apps[0])
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	if !strings.Contains(out, "kind: Ingress") {
		t.Fatalf("a hosted app must render an Ingress:\n%s", out)
	}
	return out
}

// TestIngressExposure_AWS checks that an AWS Ingress binds to the ALB controller as a public ALB,
// with HTTPS only when the deploy issued a valid ACM certificate.
func TestIngressExposure_AWS(t *testing.T) {
	const arn = "arn:aws:acm:us-east-1:556074788436:certificate/0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0"
	base := []string{
		"ingressClassName: alb",
		`alb.ingress.kubernetes.io/scheme: "internet-facing"`,
		`alb.ingress.kubernetes.io/target-type: "ip"`,
	}
	cases := []struct {
		name    string
		outputs map[string]string
		want    []string
		absent  []string
	}{
		{"no certificate: HTTP only", nil,
			append(base, `alb.ingress.kubernetes.io/listen-ports: "[{\"HTTP\":80}]"`),
			[]string{"certificate-arn", "ssl-redirect"}},
		{"ACM certificate: HTTPS + redirect", map[string]string{"acm_certificate_arn": arn},
			append(base, `alb.ingress.kubernetes.io/certificate-arn: "`+arn+`"`,
				`alb.ingress.kubernetes.io/listen-ports: "[{\"HTTP\":80},{\"HTTPS\":443}]"`,
				`alb.ingress.kubernetes.io/ssl-redirect: "443"`),
			nil},
		{"malformed ARN is ignored", map[string]string{"acm_certificate_arn": "arn:aws:acm:x\"\n  evil: 1"},
			append(base, `alb.ingress.kubernetes.io/listen-ports: "[{\"HTTP\":80}]"`),
			[]string{"certificate-arn", "evil"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			out := renderOneWithIngress(t, Options{Namespace: "default", Provider: providerAWS, Outputs: tc.outputs})
			for _, w := range tc.want {
				if !strings.Contains(out, w) {
					t.Errorf("missing %q in:\n%s", w, out)
				}
			}
			for _, a := range tc.absent {
				if strings.Contains(out, a) {
					t.Errorf("must not contain %q:\n%s", a, out)
				}
			}
		})
	}
}

// TestIngressExposure_OtherCloudsUnchanged checks that non-AWS clouds render no class or annotations.
func TestIngressExposure_OtherCloudsUnchanged(t *testing.T) {
	for _, p := range []string{"", "gcp", "azure", "hetzner", "alibaba"} {
		out := renderOneWithIngress(t, Options{Namespace: "default", Provider: p})
		if strings.Contains(out, "ingressClassName") || strings.Contains(out, "alb.ingress") {
			t.Errorf("provider %q must render no ingress class or ALB annotations:\n%s", p, out)
		}
	}
}
