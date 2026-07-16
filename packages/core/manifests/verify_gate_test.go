// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The #589 "done when": manifests rendered from first-class vc.Services with a REAL
// digest pass the elench verify gate (packages/core/verify/k8s.go) — in particular
// IMAGE-001, which fails ":latest"/untagged images and is exactly why the old scanner
// path's "<name>:latest" scaffold could never deploy through a fail-closed apply.
package manifests

import (
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/alethialabs-io/alethialabs/packages/core/verify"
)

func TestRenderedServiceManifestsPassVerify(t *testing.T) {
	apps, skipped := FromServices([]types.ProjectServiceConfig{
		{
			Name:          "web",
			Type:          "deployment",
			Source:        types.ProjectServiceSource{Kind: "repo", RepoURL: "https://github.com/acme/web"},
			ResolvedImage: "123.dkr.ecr.eu-west-1.amazonaws.com/proj-web@sha256:0f3a1b",
			Env:           []types.ServiceEnvVar{{Name: "LOG_LEVEL", Value: "info"}},
			Ports:         []types.ServicePort{{ContainerPort: 8080, Protocol: "TCP"}},
			Replicas:      2,
			Probe:         &types.ServiceProbe{Type: "http", Path: "/healthz", Port: 8080},
		},
		{
			Name:   "worker",
			Type:   "deployment",
			Source: types.ProjectServiceSource{Kind: "image", Image: "ghcr.io/acme/worker:1.2.3"},
		},
	}, Options{Namespace: "apps", Domain: "example.com"})
	if len(skipped) != 0 {
		t.Fatalf("nothing should be skipped: %v", skipped)
	}

	files, err := GenerateManifests(apps)
	if err != nil {
		t.Fatal(err)
	}
	var all strings.Builder
	for _, y := range files {
		all.WriteString(y)
		all.WriteString("\n---\n")
	}

	rep, err := verify.EvaluateManifests([]byte(all.String()))
	if err != nil {
		t.Fatalf("verify.EvaluateManifests: %v", err)
	}
	for _, c := range rep.Controls {
		for _, f := range c.Findings {
			// IMAGE-001 (mutable tag) must NEVER fire on rendered output — that is the
			// retired-:latest contract. Other controls' findings would flag template
			// hardening regressions just as loudly.
			t.Errorf("verify finding on rendered manifests [%s]: %s — %s", c.ID, f.Address, f.Message)
		}
	}
}
