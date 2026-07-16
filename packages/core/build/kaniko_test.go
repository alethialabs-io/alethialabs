// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package build

import (
	"flag"
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"sigs.k8s.io/yaml"
)

var update = flag.Bool("update", false, "update golden files")

// sampleParams is a fully-populated repo-sourced service build (Dockerfile + context sub-path).
func sampleParams() KanikoBuildParams {
	return KanikoBuildParams{
		Service: types.ProjectServiceConfig{
			Name:   "api",
			Type:   "deployment",
			Source: types.ProjectServiceSource{Kind: "repo", RepoURL: "https://github.com/acme/monorepo", Path: "apps/api"},
			Build:  &types.ProjectServiceBuild{Dockerfile: "apps/api/Dockerfile", Context: "apps/api"},
		},
		Namespace:           "alethia-build",
		ECRDestURL:          "111122223333.dkr.ecr.us-east-1.amazonaws.com/acme-api",
		BuildServiceAccount: "alethia-build-sa",
		GitContext:          "git://github.com/acme/monorepo.git#3f1a9c2b7e4d5061728394a5b6c7d8e9f0a1b2c3",
		GitSHA:              "3f1a9c2b7e4d5061728394a5b6c7d8e9f0a1b2c3",
	}
}

// TestRenderKanikoJob_Golden freezes the rendered Job YAML — the whole point of a pure renderer is
// that its output is exactly reviewable. Regenerate with `go test -run Golden -update`.
func TestRenderKanikoJob_Golden(t *testing.T) {
	got, err := yaml.Marshal(RenderKanikoJob(sampleParams()))
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	golden := filepath.Join("testdata", "kaniko-job.golden.yaml")
	if *update {
		if err := os.WriteFile(golden, got, 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(golden)
	if err != nil {
		t.Fatalf("read golden (regenerate with -update): %v", err)
	}
	if string(got) != string(want) {
		t.Errorf("rendered Job differs from golden:\n--- got ---\n%s\n--- want ---\n%s", got, want)
	}
}

// TestRenderKanikoJob_Args pins the kaniko argument contract, incl. the conditional context-sub-path
// and the default Dockerfile, without golden-file coupling.
func TestRenderKanikoJob_Args(t *testing.T) {
	full := RenderKanikoJob(sampleParams()).Spec.Template.Spec.Containers[0].Args
	wantFull := []string{
		"--context=git://github.com/acme/monorepo.git#3f1a9c2b7e4d5061728394a5b6c7d8e9f0a1b2c3",
		"--dockerfile=apps/api/Dockerfile",
		"--context-sub-path=apps/api",
		"--destination=111122223333.dkr.ecr.us-east-1.amazonaws.com/acme-api:3f1a9c2b7e4d5061728394a5b6c7d8e9f0a1b2c3",
		"--image-name-with-digest-file=/workspace/image-digest",
	}
	if !slices.Equal(full, wantFull) {
		t.Errorf("full args:\n got: %v\nwant: %v", full, wantFull)
	}

	// No build block → default Dockerfile, no context-sub-path.
	p := sampleParams()
	p.Service.Build = nil
	bare := RenderKanikoJob(p).Spec.Template.Spec.Containers[0].Args
	if slices.Contains(bare, "--context-sub-path=apps/api") || slices.Contains(bare, "--context-sub-path=") {
		t.Errorf("expected no --context-sub-path when Build is nil, got %v", bare)
	}
	if !slices.Contains(bare, "--dockerfile=Dockerfile") {
		t.Errorf("expected default --dockerfile=Dockerfile when Build is nil, got %v", bare)
	}

	// Build present but empty Context → still no context-sub-path.
	p2 := sampleParams()
	p2.Service.Build = &types.ProjectServiceBuild{Dockerfile: "Dockerfile", Context: ""}
	for _, a := range RenderKanikoJob(p2).Spec.Template.Spec.Containers[0].Args {
		if a == "--context-sub-path=" {
			t.Errorf("empty Context must not emit --context-sub-path=")
		}
	}
}

// TestRenderKanikoJob_Shape checks the safety-relevant Job invariants directly.
func TestRenderKanikoJob_Shape(t *testing.T) {
	j := RenderKanikoJob(sampleParams())
	if j.Namespace != "alethia-build" {
		t.Errorf("namespace = %q", j.Namespace)
	}
	if got := *j.Spec.BackoffLimit; got != 0 {
		t.Errorf("BackoffLimit = %d, want 0 (a failed build must not silently retry)", got)
	}
	pod := j.Spec.Template.Spec
	if pod.ServiceAccountName != "alethia-build-sa" {
		t.Errorf("ServiceAccountName = %q (IRSA → ECR)", pod.ServiceAccountName)
	}
	if pod.RestartPolicy != "Never" {
		t.Errorf("RestartPolicy = %q, want Never", pod.RestartPolicy)
	}
	if img := pod.Containers[0].Image; img == "" || img == "gcr.io/kaniko-project/executor:latest" {
		t.Errorf("kaniko image must be pinned, got %q", img)
	}
	if j.Labels["alethia.io/build-sha"] != sampleParams().GitSHA {
		t.Errorf("build-sha label = %q", j.Labels["alethia.io/build-sha"])
	}
}
