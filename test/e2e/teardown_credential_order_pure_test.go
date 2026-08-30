// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The teardown credential must be exported BEFORE the post-deploy assertions, not after them.
//
// This is an ORDER property, and order is exactly what no runtime test can observe: the failure it
// guards against needs a real cloud, a successful deploy, and then one of ten specific assertions
// to fail. Every one of those assertions is green on a healthy run, so the defect is invisible to
// the suite that would notice it. #3419 exported the credential at step (5); the ten fatal exits
// above it are metadata, receipt and log-shipping claims that say nothing about cluster
// reachability, so a run could hold a live cluster with load balancers up and still enter teardown
// with no KUBECONFIG — which is how an NLB survives and `tofu destroy` dies on its subnets (#3395).
//
// UNTAGGED: this reads source text, so it runs under a bare `go test ./...` with no cluster.
package e2e

import (
	"os"
	"strings"
	"testing"
)

// The assertions that must NOT be able to precede the export. Each is a fatal exit between the
// job-SUCCESS check and the reachability proof, and each can fire on a perfectly healthy cluster.
var t2GatesAfterExport = []string{
	`t.Fatalf("read job metadata: %v", err)`,
	`t.Fatal("job execution_metadata is empty`,
	`t.Fatalf("decode execution_metadata: %v`,
	`t.Fatalf("cluster_name assertion: %v", err)`,
	`t.Fatal("cluster_ready is not true`,
	`t.Fatal("verify_result is absent`,
	`t.Fatalf("signed receipt assertion: %v", err)`,
	`t.Fatalf("read job logs: %v", err)`,
	`t.Fatal("no job_logs rows`,
	`t.Fatalf("shipped logs missing the claim banner`,
}

func TestTeardownCredentialIsExportedBeforeThePostDeployGates(t *testing.T) {
	raw, err := os.ReadFile("t2_provision_test.go")
	if err != nil {
		t.Fatalf("read t2_provision_test.go: %v", err)
	}
	src := string(raw)

	call := strings.Index(src, "\texportT2KubeconfigForTeardown(t)\n")
	if call < 0 {
		t.Fatal("no call to exportT2KubeconfigForTeardown — the teardown can enter with no credential")
	}

	// It must come AFTER the job is known to have succeeded: exporting a kubeconfig for a deploy
	// that never finished would point the destroy at a half-built cluster. This is the other
	// direction of the same property, and without it "as early as possible" would pass by moving
	// the call to the top of the function.
	success := strings.Index(src, `t.Fatalf("job terminal status = %q, want SUCCESS`)
	if success < 0 {
		t.Fatal("could not find the job-SUCCESS assertion — this test can no longer place the export")
	}
	if call < success {
		t.Fatal("the teardown credential is exported BEFORE the deploy is known to have succeeded")
	}

	for _, gate := range t2GatesAfterExport {
		at := strings.Index(src, gate)
		if at < 0 {
			// A renamed or deleted gate must not silently shrink this test's coverage into
			// nothing. Absence is reported, never skipped.
			t.Errorf("gate no longer present, so this test stopped covering it: %s", gate)
			continue
		}
		if at < call {
			t.Errorf("this assertion can fail before the teardown credential is exported, "+
				"stranding the destroy with no kubeconfig on a live cluster: %s", gate)
		}
	}
}
