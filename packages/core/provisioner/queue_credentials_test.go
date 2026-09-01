// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"io"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// Every cloud but Hetzner provisions a REAL queue service (SQS, Pub/Sub, Service Bus, MNS) whose
// credentials are the cloud's own. Seeding a Secret there would write something nothing reads.
func TestCredentialInClusterQueuesIsAHetznerOnlyNoOp(t *testing.T) {
	for _, provider := range []string{"aws", "gcp", "azure", "alibaba"} {
		vc := &types.ProjectConfig{
			Provider: types.CloudProvider(provider),
			Queues:   []types.ProjectQueueConfig{{Name: "jobs"}},
		}
		var out, errOut strings.Builder
		credentialInClusterQueues(vc, &out, &errOut)
		if out.Len() != 0 || errOut.Len() != 0 {
			t.Errorf("%s attempted in-cluster queue credentials: out=%q err=%q", provider, out.String(), errOut.String())
		}
	}
}

// A queue that cannot be credentialled must not fail an otherwise-healthy cluster: its Application
// reports the missing Secret, and the next deploy re-runs this — a no-op once the credentials
// exist. The function has no error return by design, so the report is the whole contract.
func TestCredentialInClusterQueuesIsNonFatal(t *testing.T) {
	vc := &types.ProjectConfig{
		Provider: "hetzner",
		Queues:   []types.ProjectQueueConfig{{Name: "jobs"}},
	}
	// No kubectl on PATH → every call fails, including the apply. The function must report and
	// return, never panic or propagate.
	t.Setenv("PATH", t.TempDir())
	var errOut strings.Builder
	credentialInClusterQueues(vc, io.Discard, &errOut)
	if !strings.Contains(errOut.String(), "jobs") {
		t.Errorf("a failure was not reported: %q", errOut.String())
	}
}

// A Hetzner project with no `queue` node touches nothing at all — the loop is empty, not merely
// quiet about a queue it invented.
func TestCredentialInClusterQueuesIsSilentWithNoQueues(t *testing.T) {
	vc := &types.ProjectConfig{Provider: "hetzner"}
	t.Setenv("PATH", t.TempDir())
	var out, errOut strings.Builder
	credentialInClusterQueues(vc, &out, &errOut)
	if out.Len() != 0 || errOut.Len() != 0 {
		t.Errorf("a project with no queue produced output: out=%q err=%q", out.String(), errOut.String())
	}
}
