// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package sandbox

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// These run a REAL container and are gated behind ALETHIA_SANDBOX_DOCKER_TEST=1 (they need
// docker). They prove the security-critical properties of the backend end-to-end: the
// child gets ONLY the allowlisted env (no parent theft-targets), it lives in its own PID
// namespace (cannot read the parent's /proc), the RO cred-dir mount resolves, and a
// no-egress stage has no network to reach the metadata service.

func dockerGate(t *testing.T) {
	t.Helper()
	if os.Getenv("ALETHIA_SANDBOX_DOCKER_TEST") != "1" {
		t.Skip("set ALETHIA_SANDBOX_DOCKER_TEST=1 (needs docker) to run the container canary")
	}
	if _, err := exec.LookPath("docker"); err != nil {
		t.Skip("docker not on PATH")
	}
}

// runCanary builds the backend's real argv (env allowlist + mounts) and appends a shell
// canary as the container command, returning its combined output.
func runCanary(t *testing.T, spec Spec, canary string) string {
	t.Helper()
	c := Container{Runtime: "docker", Image: "alpine:3.20", Operator: "self"}
	childEnv := buildChildEnv(os.Environ(), spec.WorkDir)
	if err := assertNoSecrets(childEnv); err != nil {
		t.Fatalf("guard rejected the child env before exec: %v", err)
	}
	args := append(c.buildArgs(spec, childEnv), "sh", "-c", canary)

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "docker", args...).CombinedOutput()
	if err != nil {
		t.Fatalf("docker run failed: %v\nargs: docker %s\noutput:\n%s", err, strings.Join(args, " "), out)
	}
	return string(out)
}

func TestContainerCanary_EnvAllowlistAndProcIsolation(t *testing.T) {
	dockerGate(t)

	// Poison the parent env with theft-targets + allowlisted creds.
	credDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(credDir, "config"), []byte("CANARY-CRED-FILE"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ALETHIA_RUNNER_TOKEN", "PARENT-SECRET-TOKEN")
	t.Setenv("ALETHIA_STORAGE_SECRET_ACCESS_KEY", "PARENT-STORAGE-KEY")
	t.Setenv("ALETHIA_RECEIPT_SIGNING_KEY", "PARENT-SIGNING-KEY")
	t.Setenv("AWS_CONFIG_FILE", filepath.Join(credDir, "config"))
	t.Setenv("AWS_PROFILE", "alethia-customer")
	t.Setenv("TF_HTTP_PASSWORD", "state-token-xyz")

	spec := Spec{Kind: "canary", JobID: "canary-1", WorkDir: t.TempDir(), Stage: &Stage{Kind: StageDeploy, Payload: []byte("{}")}}

	canary := `
printf 'TOKEN=%s\n' "${ALETHIA_RUNNER_TOKEN:-ABSENT}"
printf 'STORAGE=%s\n' "${ALETHIA_STORAGE_SECRET_ACCESS_KEY:-ABSENT}"
printf 'SIGNING=%s\n' "${ALETHIA_RECEIPT_SIGNING_KEY:-ABSENT}"
printf 'AWSCFG=%s\n' "${AWS_CONFIG_FILE:-ABSENT}"
printf 'STATE=%s\n' "${TF_HTTP_PASSWORD:-ABSENT}"
printf 'PROC1_HITS=%s\n' "$(tr '\0' '\n' < /proc/1/environ | grep -c 'PARENT-SECRET' || true)"
printf 'MOUNT=%s\n' "$(cat '` + filepath.Join(credDir, "config") + `' 2>/dev/null || echo MISSING)"
`
	out := runCanary(t, spec, canary)
	t.Logf("canary output:\n%s", out)

	assertLine(t, out, "TOKEN=ABSENT")                             // runner token stripped
	assertLine(t, out, "STORAGE=ABSENT")                           // storage key stripped
	assertLine(t, out, "SIGNING=ABSENT")                           // signing key stripped
	assertLine(t, out, "AWSCFG="+filepath.Join(credDir, "config")) // allowlisted cred present
	assertLine(t, out, "STATE=state-token-xyz")                    // scoped state token present
	assertLine(t, out, "PROC1_HITS=0")                             // separate PID ns → parent secret not reachable via /proc
	assertLine(t, out, "MOUNT=CANARY-CRED-FILE")                   // RO cred-dir mount resolved
}

func TestContainerCanary_NoEgressHasNoNetwork(t *testing.T) {
	dockerGate(t)

	spec := Spec{
		Kind: "chart_scan", JobID: "canary-2", WorkDir: t.TempDir(),
		Stage: &Stage{Kind: StageChartScan, Payload: []byte("{}")}, NoEgress: true,
	}
	// With --network none the container cannot reach the metadata service (or anything).
	canary := `
if wget -T 2 -q -O- http://169.254.169.254/ >/dev/null 2>&1; then
  echo 'IMDS=REACHED'
else
  echo 'IMDS=BLOCKED'
fi
`
	out := runCanary(t, spec, canary)
	t.Logf("no-egress canary output:\n%s", out)
	assertLine(t, out, "IMDS=BLOCKED")
}

func assertLine(t *testing.T, out, want string) {
	t.Helper()
	for _, line := range strings.Split(out, "\n") {
		if strings.TrimSpace(line) == want {
			return
		}
	}
	t.Errorf("expected a line %q in canary output:\n%s", want, out)
}
