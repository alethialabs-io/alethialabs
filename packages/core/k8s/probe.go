// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package k8s

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/utils"
)

// WaitClusterReady blocks until a freshly-provisioned cluster's API server answers and
// (optionally) at least one node reaches Ready, or the timeout elapses. It shells kubectl
// against the KUBECONFIG the provider's ConfigureKubeconfig just set (every provider does
// os.Setenv("KUBECONFIG", …)), reusing the same exec path as the ArgoCD install.
//
// The caller treats a returned error as FATAL: a cluster that never becomes reachable is
// not a working cluster, and reporting SUCCESS on `tofu apply` alone hides broken clusters
// from the user. `requireNode` waits for >=1 Ready node (node-group clusters); pass false
// when nodes are provisioned on-demand (e.g. Karpenter-only) so API-reachability is the bar.
func WaitClusterReady(ctx context.Context, timeout time.Duration, requireNode bool, stdout io.Writer) error {
	deadline := time.Now().Add(timeout)
	fmt.Fprintf(stdout, "Waiting for the cluster to become reachable (timeout %s)...\n", timeout)

	// 1. API server reachable.
	if err := pollUntil(ctx, deadline, 10*time.Second, func() bool {
		_, err := utils.ExecuteCommandWithOutput("kubectl get --raw=/readyz", ".", nil)
		return err == nil
	}); err != nil {
		return fmt.Errorf("cluster API server did not become reachable within %s: %w", timeout, err)
	}
	fmt.Fprintln(stdout, "Cluster API server is reachable.")

	if !requireNode {
		return nil
	}

	// 2. At least one node Ready.
	var lastReady, lastTotal int
	if err := pollUntil(ctx, deadline, 15*time.Second, func() bool {
		raw, err := utils.ExecuteCommandWithOutput("kubectl get nodes -o json", ".", nil)
		if err != nil {
			return false
		}
		ready, total, perr := CountReadyNodes([]byte(raw))
		if perr != nil {
			return false
		}
		lastReady, lastTotal = ready, total
		return ready > 0
	}); err != nil {
		return fmt.Errorf("no cluster node reached Ready within %s (%d/%d ready): %w", timeout, lastReady, lastTotal, err)
	}
	fmt.Fprintf(stdout, "%d/%d nodes Ready.\n", lastReady, lastTotal)
	return nil
}

// pollUntil calls check every interval until it returns true, the deadline passes, or the
// context is cancelled. It returns nil on success and an error on timeout/cancel.
func pollUntil(ctx context.Context, deadline time.Time, interval time.Duration, check func() bool) error {
	for {
		if check() {
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("timed out")
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(interval):
		}
	}
}

// CountReadyNodes parses `kubectl get nodes -o json` output and returns the number of
// nodes whose Ready condition is "True" and the total node count. Pure (unit-testable).
func CountReadyNodes(raw []byte) (ready, total int, err error) {
	var list struct {
		Items []struct {
			Status struct {
				Conditions []struct {
					Type   string `json:"type"`
					Status string `json:"status"`
				} `json:"conditions"`
			} `json:"status"`
		} `json:"items"`
	}
	if err := json.Unmarshal(raw, &list); err != nil {
		return 0, 0, fmt.Errorf("parse nodes json: %w", err)
	}
	total = len(list.Items)
	for _, item := range list.Items {
		for _, c := range item.Status.Conditions {
			if c.Type == "Ready" && c.Status == "True" {
				ready++
				break
			}
		}
	}
	return ready, total, nil
}
