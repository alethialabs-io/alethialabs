// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package manifests

import (
	"fmt"
	"os"
	"regexp"
	"strings"
	"testing"
)

// TestRunnerImageUIDMatchesDockerfile pins RunnerImageUID to the UID the runner image creates.
// If the Dockerfile changes the UID, every runner-image container would run as a user the image
// does not have.
func TestRunnerImageUIDMatchesDockerfile(t *testing.T) {
	raw, err := os.ReadFile("../../../apps/runner/Dockerfile.base")
	if err != nil {
		t.Fatalf("read the runner Dockerfile: %v", err)
	}
	m := regexp.MustCompile(`adduser -D -u (\d+) runner`).FindStringSubmatch(string(raw))
	if m == nil {
		t.Fatal("apps/runner/Dockerfile.base no longer creates `runner` with `adduser -D -u <uid> runner`; re-derive RunnerImageUID")
	}
	if m[1] != fmt.Sprint(RunnerImageUID) {
		t.Fatalf("Dockerfile creates runner as UID %s, RunnerImageUID is %d", m[1], RunnerImageUID)
	}
}

// TestRunnerImageContainersRenderNumericUser checks that every container rendered from the runner
// image carries a numeric runAsUser next to runAsNonRoot. Without it the kubelet refuses to start
// the container ("image has non-numeric user (runner), cannot verify user is non-root").
func TestRunnerImageContainersRenderNumericUser(t *testing.T) {
	const img = "ghcr.io/alethialabs-io/runner@sha256:abc"
	want := fmt.Sprintf("runAsUser: %d", RunnerImageUID)

	t.Run("db-authproxy sidecar", func(t *testing.T) {
		sc := authProxySidecar(providerAWS, "postgres", "db.example:5432", "us-east-1", img)
		if sc.RunAsUser != RunnerImageUID {
			t.Fatalf("db-authproxy RunAsUser = %d, want %d", sc.RunAsUser, RunnerImageUID)
		}
		out, err := RenderApp(App{Name: "svc", Image: "nginx@sha256:def", Port: 8080, Sidecars: []Sidecar{sc}})
		if err != nil {
			t.Fatalf("render: %v", err)
		}
		i := strings.Index(out, "- name: db-authproxy")
		if i < 0 || !strings.Contains(out[i:], want) {
			t.Fatalf("rendered db-authproxy container lacks %q:\n%s", want, out)
		}
	})
	t.Run("sidecar without a UID renders none", func(t *testing.T) {
		out, err := RenderApp(App{Name: "svc", Image: "nginx@sha256:def", Port: 8080, Sidecars: []Sidecar{{Name: "other", Image: "x@sha256:1"}}})
		if err != nil {
			t.Fatalf("render: %v", err)
		}
		if strings.Contains(out, "runAsUser:") {
			t.Fatalf("a sidecar with RunAsUser 0 must not render runAsUser:\n%s", out)
		}
	})
	t.Run("helm repo refresher", func(t *testing.T) {
		out, err := RenderHelmRepoRefreshers([]HelmRepoRefresher{{SecretName: "repo-helm-x", RepoURL: "oci://public.ecr.aws", Public: true}}, "arn:aws:iam::1:role/r", img)
		if err != nil {
			t.Fatalf("render: %v", err)
		}
		if !strings.Contains(out, want) {
			t.Fatalf("helm repo refresher lacks %q:\n%s", want, out)
		}
	})
	t.Run("registry pull-token refresher", func(t *testing.T) {
		out, err := RenderRegistryRefresher(RegistryRefresher{
			Provider: "aws", Namespace: "default", SecretName: "acme-pull",
			RegistryHost: "123.dkr.ecr.us-east-1.amazonaws.com", Region: "us-east-1",
			TargetRoleArn: "arn:aws:iam::456:role/pull", RunnerImage: img,
		})
		if err != nil {
			t.Fatalf("render: %v", err)
		}
		if !strings.Contains(out, want) {
			t.Fatalf("registry refresher lacks %q:\n%s", want, out)
		}
	})
}
