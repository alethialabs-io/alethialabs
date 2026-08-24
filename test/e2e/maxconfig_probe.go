// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package e2e

// The SECOND assertion for in-cluster max-config cells whose ArgoCD Application converging does not
// actually prove the kind was delivered.
//
// For four of hetzner's five in-cluster kinds it does: `addon-db-appdb` Healthy+Synced means a CNPG
// Cluster is running, and a running Postgres is the kind. `secrets` is the exception, and it is the
// exception in the most dangerous direction — a SEALED Vault's Helm release is Healthy AND Synced,
// because the StatefulSet is running exactly as the chart declared. Every observable ArgoCD reports
// is green while the Vault answers nothing at all. Promoting the cell on that evidence would be the
// "never promote a cell by asserting it" failure the table exists to prevent.
//
// So a cell may name a MaxConfigClusterProbe: one live object whose `Ready` condition is True only
// when the capability is genuinely delivered. It is read through the same `Ready`-condition parser
// the cross-account secrets lane uses (parseReadyCondition in t2_secrets_xacct.go) — ESO states
// readiness the same way wherever it appears, and a second parser would be a second thing to keep
// correct.
//
// Fail-closed throughout: an unreadable object, an absent condition and a False condition are all
// failures. "No status yet" is retried, never treated as a pass.

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

// maxConfigProbeInterval is how often a not-yet-Ready probe is retried.
const maxConfigProbeInterval = 10 * time.Second

// maxConfigProbeGetTimeout bounds one kubectl call, well under the overall deadline.
const maxConfigProbeGetTimeout = 30 * time.Second

// AssertMaxConfigClusterProbes runs every ClusterProbe this cloud's in-cluster cells declare, and
// reports the first one that never became Ready.
//
// Called AFTER AssertMaxConfigKindsInState, never instead of it: the probe is additive evidence, and
// a cell whose Application never converged has already failed. A no-op for a cloud whose cells
// declare no probes, so the four managed clouds pay nothing for it.
func AssertMaxConfigClusterProbes(ctx context.Context, kubeconfigPath, provider string, timeout time.Duration) error {
	for _, k := range MaxConfigKinds {
		cell, ok := k.Cell(provider)
		if !ok || cell.Carriage != CarriedInCluster || cell.ClusterProbe == nil {
			continue
		}
		if err := awaitClusterProbeReady(ctx, kubeconfigPath, *cell.ClusterProbe, timeout); err != nil {
			return fmt.Errorf("max-config kind %q on %s: %w\n  the ArgoCD Application %s converged, but that is not the proof: %s",
				k.Kind, provider, err, cell.ArgoApp, cell.ClusterProbe.Why)
		}
	}
	return nil
}

// awaitClusterProbeReady polls one object until its `Ready` condition is True, or the deadline
// passes. The last observed condition is carried into the timeout error — a store that is Ready=False
// with reason `ValidationFailed` and a message naming a sealed Vault is the whole diagnosis, and a
// bare "timed out" would throw it away.
func awaitClusterProbeReady(ctx context.Context, kubeconfigPath string, p MaxConfigClusterProbe, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	var lastErr error
	var lastCond esCondition
	var sawCond bool

	for {
		raw, err := kubectlGetObject(ctx, kubeconfigPath, p)
		if err != nil {
			lastErr = err
		} else {
			cond, ok, perr := parseReadyCondition(raw)
			switch {
			case perr != nil:
				lastErr = perr
			case isReady(cond, ok):
				return nil
			default:
				lastCond, sawCond, lastErr = cond, ok, nil
			}
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("%s%s did not report Ready=True within %s: %s",
				p.Resource+"/"+p.Name, namespaceSuffix(p.Namespace), timeout, probeDiagnosis(lastCond, sawCond, lastErr))
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(maxConfigProbeInterval):
		}
	}
}

// probeDiagnosis renders whatever the last poll actually saw, in the order of usefulness to whoever
// reads the nightly's log: the controller's own reason first, then a read failure, then the honest
// "it never wrote a status at all".
func probeDiagnosis(cond esCondition, sawCond bool, err error) string {
	if sawCond {
		return fmt.Sprintf("last Ready condition was %q (reason %q): %s", cond.Status, cond.Reason, cond.Message)
	}
	if err != nil {
		return fmt.Sprintf("last read failed: %v", err)
	}
	return "the object never reported a Ready condition — its controller has not reconciled it"
}

// namespaceSuffix renders " in namespace x" for a namespaced object and nothing for a cluster-scoped one.
func namespaceSuffix(ns string) string {
	if ns == "" {
		return ""
	}
	return " in namespace " + ns
}

// kubectlGetObject reads one object as JSON through an explicit kubeconfig — this tier's own path to
// the cluster, never the runner's side-effect environment.
func kubectlGetObject(ctx context.Context, kubeconfigPath string, p MaxConfigClusterProbe) ([]byte, error) {
	cctx, cancel := context.WithTimeout(ctx, maxConfigProbeGetTimeout)
	defer cancel()
	args := []string{"--kubeconfig", kubeconfigPath, "get", p.Resource, p.Name, "-o", "json"}
	if p.Namespace != "" {
		args = append(args, "-n", p.Namespace)
	}
	out, err := exec.CommandContext(cctx, "kubectl", args...).Output()
	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) && len(ee.Stderr) > 0 {
			return nil, fmt.Errorf("%w: %s", err, strings.TrimSpace(string(ee.Stderr)))
		}
		return nil, err
	}
	return out, nil
}
