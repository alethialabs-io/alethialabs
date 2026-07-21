// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package imagebuild

import (
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// TestRenderBuildJob_Overrides exercises the non-default (return-v) branches of
// orDefault / orDefaultInt: an explicit Namespace, KanikoImage, and positive
// BackoffLimit must all flow through verbatim instead of falling back to defaults.
func TestRenderBuildJob_Overrides(t *testing.T) {
	opts := fullOpts()
	opts.Namespace = "custom-build-ns"
	opts.KanikoImage = "gcr.io/kaniko-project/executor:v1.24.0"
	opts.BackoffLimit = 3

	y, err := RenderBuildJob(repoService(), opts)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"namespace: custom-build-ns",
		"image: gcr.io/kaniko-project/executor:v1.24.0",
		"backoffLimit: 3",
	} {
		if !strings.Contains(y, want) {
			t.Errorf("override missing %q:\n%s", want, y)
		}
	}
	// The defaults must NOT appear when overridden.
	if strings.Contains(y, "namespace: "+DefaultNamespace) {
		t.Errorf("default namespace leaked despite override:\n%s", y)
	}
	if strings.Contains(y, DefaultKanikoImage) {
		t.Errorf("default kaniko image leaked despite override:\n%s", y)
	}
}

// TestRenderBuildJob_WhitespaceOverrides confirms a whitespace-only override is
// treated as unset (orDefault/dns-trim), falling back to the pinned defaults.
func TestRenderBuildJob_WhitespaceOverrides(t *testing.T) {
	opts := fullOpts()
	opts.Namespace = "   "
	opts.KanikoImage = "  "
	opts.GitCredSecret = "  acme-git-creds  " // trimmed, still referenced
	opts.BackoffLimit = -5                    // <=0 → default

	y, err := RenderBuildJob(repoService(), opts)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(y, "namespace: "+DefaultNamespace) {
		t.Errorf("whitespace namespace should fall back to default:\n%s", y)
	}
	if !strings.Contains(y, "image: "+DefaultKanikoImage) {
		t.Errorf("whitespace kaniko image should fall back to default:\n%s", y)
	}
	if !strings.Contains(y, "backoffLimit: 1") {
		t.Errorf("negative backoff should fall back to DefaultBackoffLimit:\n%s", y)
	}
	// GitCredSecret is TrimSpace'd before rendering — the name must appear untrimmed-padded.
	if !strings.Contains(y, "name: acme-git-creds") {
		t.Errorf("trimmed git cred secret name missing:\n%s", y)
	}
	if strings.Contains(y, "  acme-git-creds  ") {
		t.Errorf("git cred secret name was not trimmed:\n%s", y)
	}
}

// TestRenderBuildJob_DestinationTrailingSlash verifies the Destination's trailing
// slashes are trimmed so "<dest>/:<tag>" never renders a double slash.
func TestRenderBuildJob_DestinationTrailingSlash(t *testing.T) {
	opts := fullOpts()
	opts.Destination = "111122223333.dkr.ecr.eu-central-1.amazonaws.com/acme-api///"
	y, err := RenderBuildJob(repoService(), opts)
	if err != nil {
		t.Fatal(err)
	}
	want := "--destination=111122223333.dkr.ecr.eu-central-1.amazonaws.com/acme-api:abc1234"
	if !strings.Contains(y, want) {
		t.Errorf("trailing slash not trimmed from destination:\n%s", y)
	}
	if strings.Contains(y, "acme-api/:abc1234") || strings.Contains(y, "acme-api//") {
		t.Errorf("destination rendered with a stray slash:\n%s", y)
	}
}

// TestRenderBuildJob_UnusableName covers the "no usable name" guard: a name made
// solely of characters dns1123 drops sanitizes to "" and must error, never render.
func TestRenderBuildJob_UnusableName(t *testing.T) {
	for _, name := range []string{"!!!", "///", "***", "   ", "----"} {
		svc := repoService()
		svc.Name = name
		if _, err := RenderBuildJob(svc, fullOpts()); err == nil {
			t.Errorf("name %q sanitizes to empty and should error", name)
		}
	}
}

// TestRenderBuildJob_NameSanitized checks the Job name is the dns1123-normalized
// form of the service name (lowercased, separators → '-', edges trimmed).
func TestRenderBuildJob_NameSanitized(t *testing.T) {
	svc := repoService()
	svc.Name = "My_Service.API"
	y, err := RenderBuildJob(svc, fullOpts())
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(y, "name: build-my-service-api") {
		t.Errorf("expected dns1123-normalized job name build-my-service-api:\n%s", y)
	}
	if !strings.Contains(y, "alethia.io/build-service: my-service-api") {
		t.Errorf("build-service label should carry the normalized name:\n%s", y)
	}
}

// TestDNS1123 pins the label-normalization rules the renderer relies on.
func TestDNS1123(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"api", "api"},
		{"API", "api"},                       // lowercased
		{"My_Service", "my-service"},         // underscore → dash
		{"a.b.c", "a-b-c"},                   // dots → dash
		{"path/to/svc", "path-to-svc"},       // slashes → dash
		{"has space", "has-space"},           // space → dash
		{"--trim--", "trim"},                 // leading/trailing dashes trimmed
		{"  padded  ", "padded"},             // outer whitespace stripped
		{"café", "caf"},                      // non-ascii letter dropped
		{"a!!!b", "ab"},                      // punctuation dropped
		{"123-svc", "123-svc"},               // digits kept
		{"", ""},                             // empty stays empty
		{"!!!", ""},                          // all-invalid → empty
		{"MixED_Case.9/x", "mixed-case-9-x"}, // combined
	}
	for _, c := range cases {
		if got := dns1123(c.in); got != c.want {
			t.Errorf("dns1123(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// TestDockerfileOf covers the Dockerfile resolution: explicit Build.Dockerfile
// (trimmed) wins, else kaniko's DefaultDockerfile.
func TestDockerfileOf(t *testing.T) {
	cases := []struct {
		name  string
		build *types.ProjectServiceBuild
		want  string
	}{
		{"nil build", nil, DefaultDockerfile},
		{"empty dockerfile", &types.ProjectServiceBuild{Dockerfile: ""}, DefaultDockerfile},
		{"whitespace dockerfile", &types.ProjectServiceBuild{Dockerfile: "   "}, DefaultDockerfile},
		{"explicit", &types.ProjectServiceBuild{Dockerfile: "Dockerfile.prod"}, "Dockerfile.prod"},
		{"trimmed", &types.ProjectServiceBuild{Dockerfile: "  Dockerfile.dev  "}, "Dockerfile.dev"},
	}
	for _, c := range cases {
		svc := types.ProjectServiceConfig{Build: c.build}
		if got := dockerfileOf(svc); got != c.want {
			t.Errorf("%s: dockerfileOf = %q, want %q", c.name, got, c.want)
		}
	}
}

// TestContextSubPathOf covers sub-path selection: explicit Build.Context wins,
// else Source.Path, else none — with surrounding slashes trimmed either way.
func TestContextSubPathOf(t *testing.T) {
	cases := []struct {
		name string
		svc  types.ProjectServiceConfig
		want string
	}{
		{
			name: "build context wins over source path",
			svc: types.ProjectServiceConfig{
				Source: types.ProjectServiceSource{Path: "src/from-source"},
				Build:  &types.ProjectServiceBuild{Context: "/src/from-build/"},
			},
			want: "src/from-build",
		},
		{
			name: "falls back to source path",
			svc: types.ProjectServiceConfig{
				Source: types.ProjectServiceSource{Path: "/services/api/"},
			},
			want: "services/api",
		},
		{
			name: "nothing set → empty",
			svc:  types.ProjectServiceConfig{},
			want: "",
		},
		{
			name: "root-slash context → empty",
			svc: types.ProjectServiceConfig{
				Build: &types.ProjectServiceBuild{Context: "/"},
			},
			want: "",
		},
	}
	for _, c := range cases {
		if got := contextSubPathOf(c.svc); got != c.want {
			t.Errorf("%s: contextSubPathOf = %q, want %q", c.name, got, c.want)
		}
	}
}

// TestRenderBuildJob_TrailingNewline asserts the rendered YAML is trimmed and ends
// in exactly one trailing newline (the renderer↔runner contract for concatenation).
func TestRenderBuildJob_TrailingNewline(t *testing.T) {
	y, err := RenderBuildJob(repoService(), fullOpts())
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(y, "\n") {
		t.Errorf("output must end with a newline")
	}
	if strings.HasSuffix(y, "\n\n") {
		t.Errorf("output must end with exactly one newline, not a blank line")
	}
	if strings.HasPrefix(y, "\n") || strings.HasPrefix(y, " ") {
		t.Errorf("output must not begin with whitespace")
	}
}

// TestRenderBuildJob_LongNameLabelBound asserts the DNS-1123 length bound the renderer now
// enforces (#1001): kubernetes caps resource names and label values at 63 chars, so an 80-char
// service name must be truncated so the rendered "build-<name>" (name + label values) still fits.
func TestRenderBuildJob_LongNameLabelBound(t *testing.T) {
	svc := repoService()
	svc.Name = strings.Repeat("a", 80)
	y, err := RenderBuildJob(svc, fullOpts())
	if err != nil {
		t.Fatal(err)
	}
	// The rendered metadata.name and every label value must be a valid DNS-1123 label (<=63 chars).
	for _, line := range strings.Split(y, "\n") {
		trimmed := strings.TrimSpace(line)
		for _, key := range []string{"name:", "app.kubernetes.io/name:", "alethia.io/build-service:"} {
			if strings.HasPrefix(trimmed, key) {
				val := strings.TrimSpace(strings.TrimPrefix(trimmed, key))
				if len(val) > 63 {
					t.Errorf("%s %q exceeds the 63-char DNS-1123 limit (%d)", key, val, len(val))
				}
			}
		}
	}
}
