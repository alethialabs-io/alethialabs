// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package imagebuild

import (
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// repoService is a representative repo-sourced service with a pinned Dockerfile + context.
func repoService() types.ProjectServiceConfig {
	return types.ProjectServiceConfig{
		Name:   "API",
		Type:   "deployment",
		Source: types.ProjectServiceSource{Kind: "repo", RepoURL: "https://github.com/acme/app", Path: "services/api"},
		Build:  &types.ProjectServiceBuild{Dockerfile: "Dockerfile.prod", Context: "services/api"},
	}
}

func fullOpts() Options {
	return Options{
		Destination:    "111122223333.dkr.ecr.eu-central-1.amazonaws.com/acme-api",
		Tag:            "abc1234",
		GitContext:     "git://github.com/acme/app.git#refs/heads/main#abc1234def",
		ServiceAccount: "alethia-build-sa",
		GitCredSecret:  "acme-git-creds",
	}
}

func TestRenderBuildJob_RepoSource(t *testing.T) {
	y, err := RenderBuildJob(repoService(), fullOpts())
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"kind: Job",
		"name: build-api", // dns1123-lowercased
		"namespace: alethia-build",
		"image: gcr.io/kaniko-project/executor:v1.23.2",
		"--context=git://github.com/acme/app.git#refs/heads/main#abc1234def",
		"--dockerfile=Dockerfile.prod",
		"--context-sub-path=services/api",
		"--destination=111122223333.dkr.ecr.eu-central-1.amazonaws.com/acme-api:abc1234",
		"--image-name-with-digest-file=/dev/termination-log",
		"serviceAccountName: alethia-build-sa",
		"restartPolicy: Never",
		"terminationMessagePath: /dev/termination-log",
		"name: AWS_SDK_LOAD_CONFIG",
		"name: GIT_TOKEN",
		"name: acme-git-creds", // secret referenced by name only
		"key: token",
	} {
		if !strings.Contains(y, want) {
			t.Errorf("build Job missing %q:\n%s", want, y)
		}
	}
	// The kaniko image must be pinned, never ":latest".
	if strings.Contains(y, "executor:latest") {
		t.Errorf("kaniko image must be pinned, not :latest:\n%s", y)
	}
}

// The rendered manifest must reference the git secret by name only — never inline any
// credential material (the token value lives in the k8s Secret the runner creates).
func TestRenderBuildJob_NoSecretMaterial(t *testing.T) {
	opts := fullOpts()
	// A value that would only appear if we (wrongly) inlined the token itself.
	const tokenValue = "ghp_SUPERSECRETVALUE"
	opts.GitCredSecret = "acme-git-creds" // a NAME, not the value
	y, err := RenderBuildJob(repoService(), opts)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(y, tokenValue) {
		t.Errorf("rendered manifest leaked a token value:\n%s", y)
	}
	// It must reference a secret, not carry a literal "value:" for GIT_TOKEN.
	if !strings.Contains(y, "secretKeyRef") {
		t.Errorf("GIT_TOKEN should be a secretKeyRef, not an inline value:\n%s", y)
	}
}

func TestRenderBuildJob_Defaults(t *testing.T) {
	svc := types.ProjectServiceConfig{
		Name:   "worker",
		Source: types.ProjectServiceSource{Kind: "repo", RepoURL: "https://github.com/acme/app", Path: "worker"},
		// No Build → default Dockerfile; context-sub-path falls back to Source.Path.
	}
	opts := fullOpts()
	opts.Namespace = ""     // → DefaultNamespace
	opts.KanikoImage = ""   // → DefaultKanikoImage
	opts.GitCredSecret = "" // public repo → no GIT_TOKEN
	opts.BackoffLimit = 0   // → DefaultBackoffLimit
	y, err := RenderBuildJob(svc, opts)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"--dockerfile=Dockerfile",   // kaniko default
		"--context-sub-path=worker", // from Source.Path
		"namespace: alethia-build",  // default
		"image: gcr.io/kaniko-project/executor:v1.23.2",
		"backoffLimit: 1",
	} {
		if !strings.Contains(y, want) {
			t.Errorf("default missing %q:\n%s", want, y)
		}
	}
	// No git secret → no GIT_TOKEN env / no secretKeyRef at all.
	if strings.Contains(y, "GIT_TOKEN") || strings.Contains(y, "secretKeyRef") {
		t.Errorf("public repo build should not reference a git secret:\n%s", y)
	}
}

func TestRenderBuildJob_ImageSourceErrors(t *testing.T) {
	svc := types.ProjectServiceConfig{
		Name:   "prebuilt",
		Source: types.ProjectServiceSource{Kind: "image", Image: "nginx:1.27"},
	}
	if _, err := RenderBuildJob(svc, fullOpts()); err == nil {
		t.Error("a prebuilt-image service is not buildable and should error")
	}
}

func TestRenderBuildJob_MissingInputs(t *testing.T) {
	cases := map[string]func(o *Options){
		"no destination":     func(o *Options) { o.Destination = "" },
		"no tag":             func(o *Options) { o.Tag = "" },
		"no git context":     func(o *Options) { o.GitContext = "" },
		"no service account": func(o *Options) { o.ServiceAccount = "" },
	}
	for name, mutate := range cases {
		opts := fullOpts()
		mutate(&opts)
		if _, err := RenderBuildJob(repoService(), opts); err == nil {
			t.Errorf("%s: expected an error", name)
		}
	}
}

// No build context-sub-path is emitted when neither Build.Context nor Source.Path is set.
func TestRenderBuildJob_NoSubPath(t *testing.T) {
	svc := types.ProjectServiceConfig{
		Name:   "root",
		Source: types.ProjectServiceSource{Kind: "repo", RepoURL: "https://github.com/acme/app"},
	}
	y, err := RenderBuildJob(svc, fullOpts())
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(y, "--context-sub-path") {
		t.Errorf("no sub-path should be emitted when none is configured:\n%s", y)
	}
}
