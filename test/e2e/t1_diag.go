// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package e2e

import (
	"fmt"
	"os"
	"strings"
	"time"
)

// T1's ArgoCD budget and its failure-time diagnosis (#5947).
//
// This file is UNTAGGED on purpose: the T1 test itself is behind `e2e_t1`, so anything it holds is
// invisible to the bare `go test ./...` that runs the pure tests. The budget arithmetic, the argv
// builders and the pod selection live here so t1_diag_pure_test.go can pin them without docker,
// kind or a cluster; the dump that RUNS them (dumpT1ArgoDiagnosis) needs a live kind cluster and so
// sits beside its only caller in t1_provision_test.go.
//
// The defect this exists for: the runner's `helm --wait` for the argo-cd chart defaults to 20m
// (packages/core/argocd/versions.go DefaultArgoInstallTimeout), while T1 waits 8m for the job to go
// terminal. A hung install could therefore never reach helm's own timeout error — the one that
// names the resources it was waiting on — and T1 failed as "did not reach a terminal status within
// 8m0s (last status PROCESSING)" with the runner output ending at "Installing it now." (run
// 38432860825). The teardown cleanup then destroyed the cluster, so nothing was left to look at.

const (
	// t1WaitEnv overrides t1WaitDefault (a Go duration).
	t1WaitEnv = "ALETHIA_E2E_T1_WAIT"
	// t1WaitDefault bounds how long T1 waits for the job to go terminal (kind image pull + apply +
	// spine + argo). Generous but finite.
	t1WaitDefault = 8 * time.Minute

	// t1ArgoInstallTimeoutEnv overrides t1ArgoInstallDefault (a Go duration). It is the RUNNER's own
	// override of its helm --wait (packages/core/argocd/versions.go ArgoInstallTimeoutEnv), read here
	// so one variable means one thing: T1 resolves it against its own smaller default, checks it with
	// t1ArgoBudgetFits, and passes the result to the runner process under the same name.
	t1ArgoInstallTimeoutEnv = "ALETHIA_ARGOCD_INSTALL_TIMEOUT"
	// t1ArgoInstallDefault is the helm --wait T1 gives the argo-cd chart. Two passing T1 runs on
	// 2026-10-13 took 163s and 210s for the WHOLE test (provision, ArgoCD, app health and teardown),
	// so the install itself sits well inside this.
	t1ArgoInstallDefault = 4 * time.Minute

	// t1PreArgoBudget is the part of the T1 wait reserved for everything the runner does BEFORE the
	// ArgoCD install starts: the claim, kind create, tofu apply and the cluster-ready gate. It is an
	// allowance, not a measurement and not derived from ALETHIA_CLUSTER_READY_TIMEOUT; its job is to
	// keep helm's timeout firing — and the job going FAILED with helm's error — inside the T1 wait.
	t1PreArgoBudget = 3 * time.Minute

	// t1ArgoNamespace is where the runner installs the argo-cd chart.
	t1ArgoNamespace = "argocd"
)

// t1WaitTimeout returns ALETHIA_E2E_T1_WAIT when it parses as a positive Go duration, else
// t1WaitDefault.
func t1WaitTimeout() time.Duration {
	return positiveDurationEnv(t1WaitEnv, t1WaitDefault)
}

// t1ArgoInstallTimeout returns ALETHIA_ARGOCD_INSTALL_TIMEOUT when it parses as a positive Go
// duration, else t1ArgoInstallDefault.
func t1ArgoInstallTimeout() time.Duration {
	return positiveDurationEnv(t1ArgoInstallTimeoutEnv, t1ArgoInstallDefault)
}

// positiveDurationEnv reads env as a Go duration, falling back to def when it is unset, malformed
// or not positive.
func positiveDurationEnv(env string, def time.Duration) time.Duration {
	if v := strings.TrimSpace(os.Getenv(env)); v != "" {
		if d, err := time.ParseDuration(v); err == nil && d > 0 {
			return d
		}
	}
	return def
}

// t1ArgoBudgetFits returns nil when an ArgoCD helm --wait of argo can expire INSIDE a T1 wait of
// wait — strictly below wait minus t1PreArgoBudget — and an error naming both values otherwise.
// T1 fails fast on the error rather than run a configuration that can only time out undiagnosed.
func t1ArgoBudgetFits(argo, wait time.Duration) error {
	if limit := wait - t1PreArgoBudget; argo >= limit {
		return fmt.Errorf("ArgoCD install timeout %s (%s) must be strictly below the T1 wait %s (%s) minus the %s pre-ArgoCD budget (= %s): otherwise a hung install times T1 out as PROCESSING before helm reports what it was waiting on",
			argo, t1ArgoInstallTimeoutEnv, wait, t1WaitEnv, t1PreArgoBudget, limit)
	}
	return nil
}

// t1ArgoGetArgv is the kubectl argv (after --kubeconfig) listing the argocd namespace's pods and
// events, wide.
func t1ArgoGetArgv() []string {
	return []string{"get", "pods,events", "-n", t1ArgoNamespace, "-o", "wide"}
}

// t1ArgoPodsJSONArgv is the kubectl argv (after --kubeconfig) reading the argocd namespace's pods as
// JSON, from which the non-Ready ones are picked.
func t1ArgoPodsJSONArgv() []string {
	return []string{"get", "pods", "-n", t1ArgoNamespace, "-o", "json"}
}

// t1ArgoDescribeArgv is the kubectl argv (after --kubeconfig) describing one pod in the argocd
// namespace.
func t1ArgoDescribeArgv(pod string) []string {
	return []string{"describe", "pod", pod, "-n", t1ArgoNamespace}
}

// notReadyPodNames returns the names of the non-terminal pods in a `kubectl get pods -o json` List
// whose Ready condition is not True — the same selection parseNotReadyPods renders.
func notReadyPodNames(podsJSON []byte) ([]string, error) {
	pods, err := decodePodList(podsJSON)
	if err != nil {
		return nil, err
	}
	var names []string
	for _, p := range pods {
		if p.terminal() {
			continue
		}
		if ready, _, _ := p.condition("Ready"); ready == "True" {
			continue
		}
		names = append(names, p.Metadata.Name)
	}
	return names, nil
}
