// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package sandbox

import (
	"context"
	"strings"
	"testing"
)

// Pure-Go (docker-free) security regression tests for the container sandbox. The
// docker canaries in container_docker_test.go PROVE the isolation end-to-end, but they
// skip whenever docker is absent — so a regression that silently dropped `--cap-drop
// ALL` or `--network none` from the argv would sail through every PR that ran without
// docker. These tests assert the hardening flags and fail-closed refusals directly on
// the argv/decision, so a dropped flag fails CI unconditionally. See
// docs/compliance/security-e2e-matrix.md (CC6.1 / CC7 / CC8).

// hasFlagPair reports whether args contains the consecutive pair [flag, value].
func hasFlagPair(args []string, flag, value string) bool {
	for i := 0; i+1 < len(args); i++ {
		if args[i] == flag && args[i+1] == value {
			return true
		}
	}
	return false
}

// TestSandboxHardeningArgs_NoEgress asserts the exact isolation flags the container
// backend emits for a no-egress stage. Dropping any one of these is a sandbox escape
// (privilege escalation, network to the metadata service, or a writable host mount), so
// each is pinned. NON-VACUOUS: remove a flag from buildArgs → this fails.
func TestSandboxHardeningArgs_NoEgress(t *testing.T) {
	c := Container{Runtime: "docker", Image: "alethia/runner:test", Operator: "managed", PidsLimit: 512, MemLimit: "2g"}
	workDir := t.TempDir()
	spec := Spec{Kind: "chart_scan", JobID: "sec-1", WorkDir: workDir, NoEgress: true}
	childEnv := buildChildEnv([]string{"PATH=/usr/bin"}, workDir)

	args := c.buildArgs(spec, childEnv)

	// Privilege-drop + no-new-privileges: block cap-based and setuid escalation.
	if !hasFlagPair(args, "--cap-drop", "ALL") {
		t.Errorf("missing --cap-drop ALL (privilege drop) in argv: %v", args)
	}
	if !hasFlagPair(args, "--security-opt", "no-new-privileges") {
		t.Errorf("missing --security-opt no-new-privileges in argv: %v", args)
	}
	// No-egress ⇒ --network none (no route to 169.254.169.254 IMDS or anything else).
	if !hasFlagPair(args, "--network", "none") {
		t.Errorf("NoEgress stage MUST get --network none, got argv: %v", args)
	}
	// Resource caps (fork-bomb / memory-exhaustion containment).
	if !hasFlagPair(args, "--pids-limit", "512") {
		t.Errorf("missing --pids-limit 512 in argv: %v", args)
	}
	if !hasFlagPair(args, "--memory", "2g") {
		t.Errorf("missing --memory limit in argv: %v", args)
	}
	// Ephemeral: --rm --init (reaps zombies, no persistence across jobs).
	joined := strings.Join(args, " ")
	if !strings.Contains(joined, "--rm") || !strings.Contains(joined, "--init") {
		t.Errorf("expected --rm --init in argv: %v", args)
	}
	// The ONLY writable bind is the per-job workdir (mounted rw at its identical path).
	if !hasFlagPair(args, "-v", workDir+":"+workDir+":rw") {
		t.Errorf("expected the per-job workdir as the rw bind, got argv: %v", args)
	}
	// The image is the final token; no positional command overrides the entrypoint.
	if args[len(args)-1] != c.Image {
		t.Errorf("expected image %q as the last argv token, got %q", c.Image, args[len(args)-1])
	}
}

// TestSandboxHardeningArgs_EgressUsesConfiguredNetNotHost asserts that an egress-permitted
// stage is pinned to the configured (default-deny, IMDS-blocking) fleet network — NEVER the
// host network, which would expose the metadata service. NON-VACUOUS: if buildArgs stopped
// emitting --network for the configured net (falling back to the runtime default/host), the
// pair assertion fails.
func TestSandboxHardeningArgs_EgressUsesConfiguredNetNotHost(t *testing.T) {
	c := Container{Runtime: "docker", Image: "alethia/runner:test", Operator: "managed", EgressEnforced: true, Network: "alethia-egress"}
	workDir := t.TempDir()
	spec := Spec{Kind: "deploy", JobID: "sec-2", WorkDir: workDir}
	args := c.buildArgs(spec, buildChildEnv([]string{"PATH=/usr/bin"}, workDir))

	if !hasFlagPair(args, "--network", "alethia-egress") {
		t.Errorf("expected the egress-filtered fleet net, got argv: %v", args)
	}
	if hasFlagPair(args, "--network", "host") {
		t.Fatalf("SANDBOX ESCAPE: --network host would expose the metadata service: %v", args)
	}
}

// TestSandboxHardeningArgs_CredDirsMountedReadOnly asserts that parent-activated credential
// directories cross into the child as READ-ONLY binds (so untrusted code cannot tamper with
// or exfiltrate-via-write the mounted cloud creds). NON-VACUOUS: an `:rw` cred mount fails.
func TestSandboxHardeningArgs_CredDirsMountedReadOnly(t *testing.T) {
	credDir := t.TempDir()
	workDir := t.TempDir()
	c := Container{Runtime: "docker", Image: "alethia/runner:test", Operator: "self"}
	// AWS_CONFIG_FILE points at a file under credDir → the backend RO-mounts its parent dir.
	childEnv := buildChildEnv([]string{"PATH=/usr/bin", "AWS_CONFIG_FILE=" + credDir + "/config"}, workDir)
	args := c.buildArgs(Spec{Kind: "deploy", JobID: "sec-3", WorkDir: workDir}, childEnv)

	if !hasFlagPair(args, "-v", credDir+":"+credDir+":ro") {
		t.Errorf("expected cred dir %q mounted READ-ONLY, got argv: %v", credDir, args)
	}
	// It must NOT be writable.
	if hasFlagPair(args, "-v", credDir+":"+credDir+":rw") {
		t.Fatalf("cred dir mounted rw (tamperable): %v", args)
	}
}

// TestFailClosed_ManagedSandboxRefusesAmbiguousOperator pins the deny-on-AMBIGUITY property
// of the managed passthrough gate: with EnforceManaged set, ONLY an explicit "self" operator
// runs unsandboxed; every other operator string — including empty, mis-cased, and unknown
// values — REFUSES rather than silently downgrading to no isolation. This is the fail-closed
// (not fail-open) contract: a typo or unset ALETHIA_RUNNER_OPERATOR must not open the gate.
// NON-VACUOUS: flipping the check to fail-open (allowing on !=managed) makes the ambiguous
// cases run → these error assertions fail.
func TestFailClosed_ManagedSandboxRefusesAmbiguousOperator(t *testing.T) {
	spec := Spec{Kind: "deploy", JobID: "sec-4", WorkDir: t.TempDir()}
	run := func(operator string) error {
		return Passthrough{Operator: operator, EnforceManaged: true}.Run(context.Background(), spec, func(context.Context) error { return nil })
	}

	// Ambiguous / non-self operators MUST refuse (fail-closed).
	for _, operator := range []string{"", "managed", "Managed", "MANAGED", "self ", "sElF", "typo"} {
		if err := run(operator); err == nil {
			t.Errorf("EnforceManaged operator=%q ran unsandboxed — must fail closed", operator)
		}
	}
	// Only the exact "self" operator is lenient (customer's own cloud = their risk boundary).
	if err := run("self"); err != nil {
		t.Errorf("EnforceManaged operator=self should run (self is the trusted boundary): %v", err)
	}
	// And with EnforceManaged OFF, nothing refuses (today's trusted-managed default is unaffected).
	if err := (Passthrough{Operator: "managed"}).Run(context.Background(), spec, func(context.Context) error { return nil }); err != nil {
		t.Errorf("EnforceManaged=false should never refuse, got: %v", err)
	}
}

// TestFailClosed_ManagedContainerRefusesWithoutEgressEnforcement pins the container backend's
// fail-closed egress gate: a managed runner will NOT run an egress-permitted stage unless
// egress control is confirmed (EgressEnforced). Otherwise untrusted code could reach the
// metadata service and recover the fleet's storage key + bootstrap token. NON-VACUOUS:
// dropping the gate lets the deploy proceed → this error assertion fails.
func TestFailClosed_ManagedContainerRefusesWithoutEgressEnforcement(t *testing.T) {
	c := Container{Runtime: "docker", Image: "alethia/runner:test", Operator: "managed", EgressEnforced: false}
	spec := Spec{Kind: "deploy", JobID: "sec-5", WorkDir: t.TempDir(), Stage: &Stage{Kind: StageDeploy, Payload: []byte("{}")}}

	err := c.Run(context.Background(), spec, func(context.Context) error {
		t.Fatal("job body must not execute — the egress gate should refuse first")
		return nil
	})
	if err == nil {
		t.Fatal("managed container without egress enforcement ran — must fail closed")
	}
	if !strings.Contains(err.Error(), "egress enforcement") {
		t.Errorf("expected an egress-enforcement refusal, got: %v", err)
	}
}
