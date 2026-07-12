// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package k8s

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/utils"
)

// probeImage is the tiny image the in-cluster reachability probe runs (needs a shell + nc;
// busybox has both). Overridable for air-gapped/mirror registries.
func probeImage() string {
	if v := strings.TrimSpace(os.Getenv("ALETHIA_CLUSTER_PROBE_IMAGE")); v != "" {
		return v
	}
	return "busybox:1.36"
}

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

// WaitPodToAPIServer proves that an ORDINARY POD can reach the Kubernetes API server across
// the cluster network — the one thing `WaitClusterReady` cannot see. WaitClusterReady probes
// the API from the RUNNER (via the node's public IP) and only counts Ready nodes; a cluster
// can pass that yet have a broken pod datapath, so pod->apiserver-ClusterIP times out for every
// real workload (ArgoCD controllers, admission webhooks, in-cluster clients). This exact bug
// shipped on multi-node Hetzner/Talos and was invisible to the runner-side probe (E1 finding).
//
// It runs a throwaway Job whose pod TCP-connects to the kubernetes Service ClusterIP:443. The
// pod tolerates all taints but PREFERS a non-control-plane node, so on a multi-node cluster it
// lands on a worker and genuinely exercises the cross-node datapath; on a single-node cluster it
// runs on the control plane (still a valid pod->apiserver check). Fatal on failure — SUCCESS must
// mean pods can reach the API. Opt out with ALETHIA_CLUSTER_SKIP_INCLUSTER_PROBE=1.
func WaitPodToAPIServer(ctx context.Context, timeout time.Duration, stdout io.Writer) error {
	if v := strings.ToLower(strings.TrimSpace(os.Getenv("ALETHIA_CLUSTER_SKIP_INCLUSTER_PROBE"))); v == "1" || v == "true" {
		fmt.Fprintln(stdout, "In-cluster pod->apiserver probe skipped (ALETHIA_CLUSTER_SKIP_INCLUSTER_PROBE).")
		return nil
	}

	// The kubernetes Service ClusterIP (server-picked, first host of the service CIDR). We test
	// the raw IP rather than the DNS name so this isolates the pod->apiserver DATAPATH from CoreDNS.
	clusterIP, err := utils.ExecuteCommandWithOutput(
		"kubectl get svc kubernetes -n default -o jsonpath={.spec.clusterIP}", ".", nil)
	if err != nil || strings.TrimSpace(clusterIP) == "" {
		return fmt.Errorf("could not resolve the kubernetes Service ClusterIP for the in-cluster probe: %w", err)
	}
	clusterIP = strings.TrimSpace(clusterIP)

	const jobName = "alethia-apiserver-probe"
	// Best-effort clean any leftover from a previous run, then always clean up on exit.
	_, _ = utils.ExecuteCommandWithOutput("kubectl delete job "+jobName+" -n default --ignore-not-found", ".", nil)
	defer func() {
		_, _ = utils.ExecuteCommandWithOutput("kubectl delete job "+jobName+" -n default --ignore-not-found --wait=false", ".", nil)
	}()

	dir, err := os.MkdirTemp("", "alethia-probe-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	manifestPath := filepath.Join(dir, "probe-job.yaml")
	if err := os.WriteFile(manifestPath, []byte(podToAPIServerJob(jobName, clusterIP, probeImage())), 0o600); err != nil {
		return err
	}
	if _, err := utils.ExecuteCommandWithOutput("kubectl apply -f "+manifestPath, ".", nil); err != nil {
		return fmt.Errorf("failed to create the in-cluster pod->apiserver probe Job: %w", err)
	}
	fmt.Fprintf(stdout, "Verifying a pod can reach the API server (ClusterIP %s:443) across the cluster network...\n", clusterIP)

	deadline := time.Now().Add(timeout)
	var lastState string
	err = pollUntil(ctx, deadline, 8*time.Second, func() bool {
		succeeded, _ := utils.ExecuteCommandWithOutput(
			"kubectl get job "+jobName+" -n default -o jsonpath={.status.succeeded}", ".", nil)
		if strings.TrimSpace(succeeded) == "1" {
			return true
		}
		lastState, _ = utils.ExecuteCommandWithOutput(
			"kubectl get pods -n default -l job-name="+jobName+" -o jsonpath={.items[*].status.phase}", ".", nil)
		return false
	})
	if err != nil {
		return fmt.Errorf("a pod could not reach the API server (ClusterIP %s:443) within %s (pod phase: %q) — "+
			"the cluster pod network is broken (cross-node pod->apiserver). This is fatal: pods that cannot reach "+
			"the API server cannot run any real workload: %w", clusterIP, timeout, strings.TrimSpace(lastState), err)
	}
	fmt.Fprintln(stdout, "A pod reached the API server across the cluster network — pod datapath is healthy.")
	return nil
}

// podToAPIServerJob renders the throwaway reachability-probe Job. The pod retries an nc TCP
// connect to clusterIP:443 for ~2 min (self-contained against transient warm-up), is
// restricted-PSA compliant (runs as nobody, no caps, seccomp RuntimeDefault), tolerates all
// taints, and prefers a non-control-plane node so multi-node clusters test the cross-node path.
func podToAPIServerJob(name, clusterIP, image string) string {
	cmd := fmt.Sprintf("for i in $(seq 1 40); do nc -w 3 %s 443 </dev/null && echo REACHABLE && exit 0; sleep 3; done; echo UNREACHABLE; exit 1", clusterIP)
	return fmt.Sprintf(`apiVersion: batch/v1
kind: Job
metadata:
  name: %s
  namespace: default
  labels:
    app.kubernetes.io/managed-by: alethia
spec:
  backoffLimit: 3
  ttlSecondsAfterFinished: 120
  template:
    metadata:
      labels:
        app.kubernetes.io/managed-by: alethia
    spec:
      restartPolicy: Never
      tolerations:
        - operator: Exists
      affinity:
        nodeAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 100
              preference:
                matchExpressions:
                  - key: node-role.kubernetes.io/control-plane
                    operator: DoesNotExist
      securityContext:
        runAsNonRoot: true
        runAsUser: 65534
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: probe
          image: %s
          command: ["sh", "-c", %q]
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: ["ALL"]
`, name, image, cmd)
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
