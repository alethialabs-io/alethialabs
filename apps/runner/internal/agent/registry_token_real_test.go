// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

// Real-cloud integration tests for the cross-account keyless registry mint (PR B). These hit LIVE
// clouds and are SKIPPED unless the matching ALETHIA_E2E_* env is set + credentials are present, so CI
// never runs them. They prove the minted dockerconfig actually authenticates a pull, by writing it as a
// docker config.json and shelling `crane manifest` against the target image.
//
// Run (from apps/runner):
//   ALETHIA_E2E_ECR_ROLE=arn:aws:iam::<tgt>:role/... ALETHIA_E2E_ECR_HOST=<acct>.dkr.ecr.<r>.amazonaws.com \
//   ALETHIA_E2E_ECR_REGION=us-east-1 ALETHIA_E2E_ECR_IMAGE=<host>/alethia-xacct-test:latest \
//   go test ./internal/agent/ -run TestRealECRMint -v
//
//   ALETHIA_E2E_GAR_HOST=<region>-docker.pkg.dev ALETHIA_E2E_GAR_IMAGE=<host>/<proj>/<repo>/img:tag \
//   go test ./internal/agent/ -run TestRealGARMint -v

import (
	"context"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// assertPullable writes dockerConfigJSON as a docker config.json and runs `crane manifest image` against
// it — a green result proves the minted token authenticates a real pull.
func assertPullable(t *testing.T, dockerConfigJSON, image string) {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "config.json"), []byte(dockerConfigJSON), 0o600); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("crane", "manifest", image)
	cmd.Env = append(os.Environ(), "DOCKER_CONFIG="+dir)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("crane manifest %s failed with the minted token: %v\n%s", image, err, out)
	}
	if len(out) == 0 {
		t.Fatalf("crane returned an empty manifest for %s", image)
	}
	t.Logf("OK — minted token pulled %s (%d-byte manifest)", image, len(out))
}

func TestRealECRMint(t *testing.T) {
	role := os.Getenv("ALETHIA_E2E_ECR_ROLE")
	host := os.Getenv("ALETHIA_E2E_ECR_HOST")
	region := os.Getenv("ALETHIA_E2E_ECR_REGION")
	image := os.Getenv("ALETHIA_E2E_ECR_IMAGE")
	if role == "" || host == "" || region == "" || image == "" {
		t.Skip("set ALETHIA_E2E_ECR_ROLE/HOST/REGION/IMAGE to run the real cross-account ECR mint test")
	}
	dcj, exp, err := mintECRDockerConfig(context.Background(), region, role, host)
	if err != nil {
		t.Fatalf("mintECRDockerConfig: %v", err)
	}
	t.Logf("ECR token minted, expires %s", exp)
	assertPullable(t, dcj, image)
}

func TestRealGARMint(t *testing.T) {
	host := os.Getenv("ALETHIA_E2E_GAR_HOST")
	image := os.Getenv("ALETHIA_E2E_GAR_IMAGE")
	if host == "" || image == "" {
		t.Skip("set ALETHIA_E2E_GAR_HOST/IMAGE (+ ambient GCP ADC granted reader on the target project) to run the real GAR mint test")
	}
	dcj, exp, err := mintGARDockerConfig(context.Background(), host)
	if err != nil {
		t.Fatalf("mintGARDockerConfig: %v", err)
	}
	t.Logf("GAR token minted, expires %s", exp)
	assertPullable(t, dcj, image)
}

// TestRealACRExchange validates the ACR token-exchange half of mintACRDockerConfig against a live ACR:
// it takes an AAD token (from `az account get-access-token --resource <scope>`, passed in env — the same
// token the in-cluster Workload Identity yields), exchanges it for an ACR refresh token, and proves the
// refresh token pulls. This is the concrete test that confirms the acrAADScope guess.
func TestRealACRExchange(t *testing.T) {
	host := os.Getenv("ALETHIA_E2E_ACR_HOST")
	image := os.Getenv("ALETHIA_E2E_ACR_IMAGE")
	aad := os.Getenv("ALETHIA_E2E_ACR_AAD_TOKEN")
	if host == "" || image == "" || aad == "" {
		t.Skip("set ALETHIA_E2E_ACR_HOST/IMAGE/AAD_TOKEN to run the real ACR exchange test")
	}
	if !isACRHost(host) {
		t.Fatalf("host %q is not a valid ACR host", host)
	}
	refresh, err := exchangeACRRefreshToken(context.Background(), http.DefaultClient, host, aad)
	if err != nil {
		t.Fatalf("exchangeACRRefreshToken: %v", err)
	}
	t.Logf("ACR refresh token obtained (%d chars)", len(refresh))
	assertPullable(t, dockerConfigJSON(host, acrTokenUser, refresh), image)
}
