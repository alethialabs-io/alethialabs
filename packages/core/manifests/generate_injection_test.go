// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package manifests

import (
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

// hostileImage is #2028's payload: a newline plus the container-map indentation, which appends
// arbitrary keys to the container the renderer is supposed to be hardening.
const hostileImage = "reg.example.com/api:v1\n          command: [\"/bin/sh\",\"-c\",\"cat /var/run/secrets/kubernetes.io/serviceaccount/token\"]\n          securityContext:\n            privileged: true"

// TestRenderApp_RefusesYAMLInjectionViaImage is #2028's repro, kept.
//
// App.Image comes from the canvas (Source.Image, validated console-side by `z.string().min(1)` —
// no charset, no length) or from ResolvedImage, and was rendered UNQUOTED into a Deployment the
// runner commits to the GitOps repo and ArgoCD syncs. A tenant could therefore inject pod-spec
// content that defeats the hardened securityContext this renderer exists to impose — and on
// namespace/vcluster placement the cluster is shared, so the blast radius is not their own project.
func TestRenderApp_RefusesYAMLInjectionViaImage(t *testing.T) {
	_, err := RenderApp(App{Name: "api", Image: hostileImage})
	if err == nil {
		t.Fatal("RenderApp accepted an image carrying a YAML break; want a refusal")
	}
	if !strings.Contains(err.Error(), "not a valid image reference") {
		t.Fatalf("refused, but not for the reason under test: %v", err)
	}
}

// TestRenderApp_QuotingAloneContainsTheInjection proves the SECOND layer independently.
//
// The validator refuses the payload above, so it alone would keep this suite green even if the
// template quoting were dropped. This drives the template directly with a value the validator would
// reject, and parses the result as YAML: the injected keys must land inside the image STRING rather
// than becoming container fields.
func TestRenderApp_QuotingAloneContainsTheInjection(t *testing.T) {
	a := App{Name: "api", Image: "placeholder"}.normalize()
	a.Image = hostileImage

	var buf strings.Builder
	if err := tmpl.Execute(&buf, a); err != nil {
		t.Fatalf("render: %v", err)
	}

	// The Deployment is the first document.
	var doc struct {
		Spec struct {
			Template struct {
				Spec struct {
					Containers []map[string]any `yaml:"containers"`
				} `yaml:"spec"`
			} `yaml:"template"`
		} `yaml:"spec"`
	}
	first := strings.SplitN(buf.String(), "\n---", 2)[0]
	if err := yaml.Unmarshal([]byte(first), &doc); err != nil {
		t.Fatalf("rendered Deployment is not valid YAML — the injection broke the document: %v\n%s", err, first)
	}
	if len(doc.Spec.Template.Spec.Containers) == 0 {
		t.Fatalf("no containers parsed:\n%s", first)
	}
	c := doc.Spec.Template.Spec.Containers[0]

	if _, injected := c["command"]; injected {
		t.Error("YAML INJECTION: the image value introduced a `command` key into the container")
	}
	if sc, ok := c["securityContext"].(map[string]any); ok {
		if priv, _ := sc["privileged"].(bool); priv {
			t.Error("YAML INJECTION: the image value set privileged:true, defeating the hardened securityContext")
		}
	}
	if got, _ := c["image"].(string); got != hostileImage {
		t.Errorf("the image did not round-trip as a single scalar:\ngot  %q\nwant %q", got, hostileImage)
	}
}

// TestRenderApp_RefusesYAMLInjectionViaHostAndSidecar covers the other two interpolation sites the
// issue names. They are separate template lines, so a fix applied to one proves nothing about them.
func TestRenderApp_RefusesYAMLInjectionViaHostAndSidecar(t *testing.T) {
	t.Run("ingress host", func(t *testing.T) {
		_, err := RenderApp(App{
			Name: "api", Image: "reg.example.com/api:v1",
			Host: "web.example.com\n      http:\n        paths: []",
		})
		if err == nil || !strings.Contains(err.Error(), "not a valid hostname") {
			t.Fatalf("hostile ingress host was not refused: %v", err)
		}
	})

	t.Run("sidecar image", func(t *testing.T) {
		_, err := RenderApp(App{
			Name: "api", Image: "reg.example.com/api:v1",
			Sidecars: []Sidecar{{Name: "proxy", Image: hostileImage}},
		})
		if err == nil || !strings.Contains(err.Error(), "not a valid image reference") {
			t.Fatalf("hostile sidecar image was not refused: %v", err)
		}
	})
}

func TestIsValidImageRef(t *testing.T) {
	valid := []string{
		"reg.example.com/api:v1",
		"reg.example.com:5000/team/api:v1.2.3",
		"registry.k8s.io/pause:3.9",
		"123456789012.dkr.ecr.eu-central-1.amazonaws.com/app@sha256:" + strings.Repeat("a", 64),
		"europe-west3-docker.pkg.dev/proj/repo/img@sha256:" + strings.Repeat("b", 64),
		"alpine",
		"library/alpine:3.20",
	}
	for _, s := range valid {
		if !isValidImageRef(s) {
			t.Errorf("isValidImageRef rejected the real image ref %q", s)
		}
	}

	invalid := []string{
		"",
		hostileImage,
		"reg.example.com/api:v1 # trailing comment",
		"reg.example.com/api:v1\ncommand: id",
		"reg.example.com/api:v1\tx",
		":v1",             // no leading component
		"-leading-hyphen", // must start alphanumeric
		`reg.example.com/api:"v1"`,
		"reg.example.com/api:v1{}",
		strings.Repeat("a", 513),
	}
	for _, s := range invalid {
		if isValidImageRef(s) {
			t.Errorf("isValidImageRef(%q) = true, want false (must fail closed)", s)
		}
	}
}

func TestIsValidIngressHost(t *testing.T) {
	valid := []string{"web.example.com", "example.com", "*.example.com", "a-b.c-d.example.io", "localhost"}
	for _, s := range valid {
		if !isValidIngressHost(s) {
			t.Errorf("isValidIngressHost rejected the real host %q", s)
		}
	}
	invalid := []string{
		"",
		"web.example.com\n      http: {}",
		"Web.Example.com", // k8s hosts are lowercase
		"-web.example.com",
		"web.example.com.", // trailing dot leaves an empty label
		"web..example.com",
		"web.example.com:8080", // a port is not part of an Ingress host
		"*web.example.com",     // the wildcard must be its own label
		strings.Repeat("a.", 130) + "com",
	}
	for _, s := range invalid {
		if isValidIngressHost(s) {
			t.Errorf("isValidIngressHost(%q) = true, want false (must fail closed)", s)
		}
	}
}
