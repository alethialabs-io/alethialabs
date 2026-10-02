// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// The canary test (#5283 §6): drive EVERY mint path — each cloud and tier that succeeds, and each
// classified failure — through the real dispatcher (executeJob), with a canary as the cloud token,
// the ServiceAccount token, inside the talosconfig, and inside every error a cloud or the cluster
// returns. Then assert the canary appears in none of: the job's log chunks, its status posts (error
// message AND execution_metadata), the posted mint result's reason, the returned error, or the
// runner's operational log. On the success paths the canary must be INSIDE the sealed credential —
// otherwise the test proves nothing about a credential that never contained it.

// mintCanary is the planted value. It is distinctive so a substring hit cannot be a coincidence.
const mintCanary = "CANARY-7f3a9c2e-do-not-leak"

// syncBuffer is a goroutine-safe bytes.Buffer for the operational logger.
type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

// Write implements io.Writer.
func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

// String returns everything written.
func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

// captureOperationalLog points the runner's operational loggers — the per-job LogWith base and the
// process-wide Log() — at a buffer for the test.
func captureOperationalLog(t *testing.T) *syncBuffer {
	t.Helper()
	buf := &syncBuffer{}
	prevBase, prevAgent := baseLogger, agentLogger
	baseLogger = newAgentLogger(buf, slog.LevelDebug)
	agentLogger = baseLogger
	t.Cleanup(func() { baseLogger, agentLogger = prevBase, prevAgent })
	return buf
}

// runMintJob runs the fixture's mint through the full dispatcher and returns everything observable.
func runMintJob(t *testing.T, f *mintFixture, snapshot map[string]any) (observed string, err error) {
	t.Helper()
	logs := captureOperationalLog(t)
	f.use(t)
	w := NewWithAPI(Config{Operator: "managed", RunnerID: "r-canary"}, f.api)
	err = w.executeJob(t.Context(), &ClaimResponse{
		Job: &Job{ID: "job-canary", JobType: string(types.JobTypeMintKubeconfig), ConfigSnapshot: snapshot},
	})

	var sb strings.Builder
	for _, c := range f.api.getLogChunks() {
		sb.WriteString(c.chunk)
		sb.WriteByte('\n')
	}
	for _, u := range f.api.getStatusUpdates() {
		sb.WriteString(u.errMsg)
		meta, _ := json.Marshal(u.metadata)
		sb.Write(meta)
		sb.WriteByte('\n')
	}
	for _, r := range f.api.results() {
		sb.WriteString(r.Reason)
		sb.WriteString(r.MintID)
		sb.WriteByte('\n')
	}
	if err != nil {
		sb.WriteString(err.Error())
		fmt.Fprintf(&sb, "%+v", err)
	}
	sb.WriteString(logs.String())
	return sb.String(), err
}

// TestMintKubeconfig_CanaryNeverLeaks is the test the file comment describes.
func TestMintKubeconfig_CanaryNeverLeaks(t *testing.T) {
	t.Run("success", func(t *testing.T) {
		for _, provider := range []string{"aws", "gcp", "azure", "alibaba", "hetzner"} {
			for _, tier := range []types.KubeconfigMintTier{types.KubeconfigMintTierReadonly, types.KubeconfigMintTierAdmin} {
				if tier == types.KubeconfigMintTierAdmin && (provider == "alibaba" || provider == "hetzner") {
					// The admin certificate is real PKI the fixture generates; it cannot carry a text
					// canary, so this path is checked against the certificate's own key material.
					f := newMintFixture(t, tier, types.KubeconfigMintShapeStatic, mintCanary)
					observed, err := runMintJob(t, f, mintSnapshot(provider))
					if err != nil {
						t.Fatalf("%s/%s: %v", provider, tier, err)
					}
					cred := f.open(t, f.api.results()[0])
					if !strings.Contains(cred.Kubeconfig, f.pki.keyData) {
						t.Fatalf("%s/%s: the sealed kubeconfig does not carry the key — the check below is vacuous", provider, tier)
					}
					if strings.Contains(observed, f.pki.keyData) || strings.Contains(observed, f.pki.certData) {
						t.Fatalf("%s/%s: certificate material leaked", provider, tier)
					}
					if provider == "hetzner" && strings.Contains(observed, mintCanary) {
						t.Fatalf("%s/%s: the talosconfig leaked", provider, tier)
					}
					continue
				}
				shape := types.KubeconfigMintShapeStatic
				if provider != "alibaba" && provider != "hetzner" {
					shape = types.KubeconfigMintShapeExec
				}
				f := newMintFixture(t, tier, shape, mintCanary)
				observed, err := runMintJob(t, f, mintSnapshot(provider))
				if err != nil {
					t.Fatalf("%s/%s: %v", provider, tier, err)
				}
				plain, oerr := f.key.Open(f.api.results()[0].Sealed, testMintID, testClusterID)
				if oerr != nil || !strings.Contains(string(plain), mintCanary) {
					t.Fatalf("%s/%s: the canary is not inside the sealed credential — the check below is vacuous", provider, tier)
				}
				if strings.Contains(observed, mintCanary) {
					t.Fatalf("%s/%s: the canary leaked:\n%s", provider, tier, observed)
				}
			}
		}
	})

	t.Run("failure", func(t *testing.T) {
		for _, tc := range mintFailureCases() {
			f := newMintFixture(t, tc.tier, tc.shape, mintCanary)
			if tc.setup != nil {
				tc.setup(f, mintCanary)
			}
			snap := mintSnapshot(tc.provider)
			if tc.snapshot != nil {
				tc.snapshot(snap)
			}
			observed, err := runMintJob(t, f, snap)
			if err == nil || err.Error() != tc.reason {
				t.Fatalf("%s: returned %v, want %q", tc.name, err, tc.reason)
			}
			if strings.Contains(observed, mintCanary) {
				t.Fatalf("%s: the canary leaked:\n%s", tc.name, observed)
			}
		}
	})
}
