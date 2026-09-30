// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package e2e

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

// WHAT A PLACEMENT'S APPLICATION WAS TOLD TO DO, AND WHY IT DID NOT.
//
// #845's vcluster tier failed on hetzner run 36634781502 with one line —
// `health="Missing" sync="OutOfSync"` — and nothing else. Whether ArgoCD had no automated policy,
// could not reach the registered cluster, rendered an empty path, or tried and was refused was not
// in the log, because the wait loop only ever read two status strings. The cause had to be
// reconstructed from code afterwards.
//
// So the failure branch of every placement wait now prints, per Application: its routing (source
// repo/path/revision, destination name/server/namespace), its sync policy (automated? prune?
// selfHeal? options, retry), its own account of the last sync (parseArgoAppFailure — phase,
// message, conditions, per-resource errors) and, for a vcluster, the registered cluster Secret's
// SERVER URL. Never the Secret's `config` — that holds the bearer token and CA — which is why the
// Secret is read with a jsonpath naming `.data.server` alone rather than fetched whole and filtered.

// argoAppSpecView is the part of an Application's spec the failure dump prints.
type argoAppSpecView struct {
	RepoURL, Path, Revision        string
	DestName, DestServer, DestNS   string
	Automated                      bool
	Prune, SelfHeal                bool
	SyncOptions                    []string
	RetryLimit                     int
	HasRetry                       bool
	HealthStatus, SyncStatus       string
	SyncRevision, ReconciledAtTime string
}

// parseArgoAppSpecView extracts routing, sync policy and top-level status from an Application's JSON.
// Pure, so the shape it depends on is pinned by a test rather than by a paid run.
func parseArgoAppSpecView(appJSON []byte) (argoAppSpecView, error) {
	var app struct {
		Spec struct {
			Source struct {
				RepoURL        string `json:"repoURL"`
				Path           string `json:"path"`
				TargetRevision string `json:"targetRevision"`
			} `json:"source"`
			Destination struct {
				Name      string `json:"name"`
				Server    string `json:"server"`
				Namespace string `json:"namespace"`
			} `json:"destination"`
			SyncPolicy *struct {
				Automated *struct {
					Prune    bool `json:"prune"`
					SelfHeal bool `json:"selfHeal"`
				} `json:"automated"`
				SyncOptions []string `json:"syncOptions"`
				Retry       *struct {
					Limit int `json:"limit"`
				} `json:"retry"`
			} `json:"syncPolicy"`
		} `json:"spec"`
		Status struct {
			Health struct {
				Status string `json:"status"`
			} `json:"health"`
			Sync struct {
				Status   string `json:"status"`
				Revision string `json:"revision"`
			} `json:"sync"`
			ReconciledAt string `json:"reconciledAt"`
		} `json:"status"`
	}
	if err := json.Unmarshal(appJSON, &app); err != nil {
		return argoAppSpecView{}, err
	}
	v := argoAppSpecView{
		RepoURL:          app.Spec.Source.RepoURL,
		Path:             app.Spec.Source.Path,
		Revision:         app.Spec.Source.TargetRevision,
		DestName:         app.Spec.Destination.Name,
		DestServer:       app.Spec.Destination.Server,
		DestNS:           app.Spec.Destination.Namespace,
		HealthStatus:     app.Status.Health.Status,
		SyncStatus:       app.Status.Sync.Status,
		SyncRevision:     app.Status.Sync.Revision,
		ReconciledAtTime: app.Status.ReconciledAt,
	}
	if sp := app.Spec.SyncPolicy; sp != nil {
		v.SyncOptions = sp.SyncOptions
		if sp.Automated != nil {
			v.Automated = true
			v.Prune = sp.Automated.Prune
			v.SelfHeal = sp.Automated.SelfHeal
		}
		if sp.Retry != nil {
			v.HasRetry = true
			v.RetryLimit = sp.Retry.Limit
		}
	}
	return v, nil
}

// diagLineCap bounds any single free-text field in the dump. ArgoCD messages can carry a whole
// rendered manifest; one line per field is enough to name a cause.
const diagLineCap = 600

// capDiag trims s to diagLineCap runes, marking the cut.
func capDiag(s string) string {
	s = strings.TrimSpace(s)
	r := []rune(s)
	if len(r) <= diagLineCap {
		return s
	}
	return string(r[:diagLineCap]) + "…(truncated)"
}

// renderArgoAppSpecView formats the routing + policy block. An Application with no automated policy
// is called out in words, because "nothing ever triggers a sync" is a cause, not a detail.
func renderArgoAppSpecView(v argoAppSpecView) string {
	var b strings.Builder
	fmt.Fprintf(&b, "    status: health=%s sync=%s revision=%s reconciledAt=%s\n",
		orNone(v.HealthStatus), orNone(v.SyncStatus), orNone(v.SyncRevision), orNone(v.ReconciledAtTime))
	fmt.Fprintf(&b, "    source: repo=%s path=%q revision=%s\n", orNone(capDiag(v.RepoURL)), v.Path, orNone(v.Revision))
	fmt.Fprintf(&b, "    destination: name=%s server=%s namespace=%s\n", orNone(v.DestName), orNone(v.DestServer), orNone(v.DestNS))
	if v.Automated {
		fmt.Fprintf(&b, "    syncPolicy: automated (prune=%t selfHeal=%t)", v.Prune, v.SelfHeal)
	} else {
		b.WriteString("    syncPolicy: NOT automated — nothing will sync this Application unless something asks")
	}
	if len(v.SyncOptions) > 0 {
		fmt.Fprintf(&b, " options=%s", capDiag(strings.Join(v.SyncOptions, ",")))
	}
	if v.HasRetry {
		fmt.Fprintf(&b, " retry.limit=%d", v.RetryLimit)
	} else {
		b.WriteString(" retry=none (a failed automated sync is NOT re-attempted on the same revision)")
	}
	b.WriteString("\n")
	return b.String()
}

// decodeClusterSecretServer decodes the base64 `.data.server` of an ArgoCD cluster Secret. The input
// is ONLY that one field (read by jsonpath) — this function never sees the Secret's credentials.
func decodeClusterSecretServer(b64 string) (string, error) {
	b64 = strings.TrimSpace(b64)
	if b64 == "" {
		return "", fmt.Errorf("the Secret has no data.server")
	}
	raw, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return "", fmt.Errorf("data.server is not base64: %w", err)
	}
	return strings.TrimSpace(string(raw)), nil
}

// renderArgoAppDiagnosis assembles one Application's whole failure account from already-read JSON.
// Pure; the kubectl reads live in dumpArgoAppDiagnosis.
func renderArgoAppDiagnosis(appName string, appJSON []byte, appErr error, clusterName, clusterServer string, clusterErr error) string {
	var b strings.Builder
	fmt.Fprintf(&b, "\n──── Application %s: routing, sync policy, and its own account of the last sync ────\n", appName)
	if appErr != nil {
		fmt.Fprintf(&b, "    could not read the Application (%v) — this says nothing about the sync\n", appErr)
	} else if v, err := parseArgoAppSpecView(appJSON); err != nil {
		fmt.Fprintf(&b, "    could not decode the Application (%v)\n", err)
	} else {
		b.WriteString(renderArgoAppSpecView(v))
		b.WriteString(renderArgoUnhealthyResources(appJSON))
		f, ferr := parseArgoAppFailure(appJSON)
		if ferr == nil {
			f.Message = capDiag(f.Message)
			for i := range f.Conditions {
				f.Conditions[i] = capDiag(f.Conditions[i])
			}
			for i := range f.SyncErrors {
				f.SyncErrors[i] = capDiag(f.SyncErrors[i])
			}
		}
		b.WriteString(renderArgoAppFailure(appName, f, ferr))
	}
	if clusterName != "" {
		if clusterErr != nil {
			fmt.Fprintf(&b, "    registered cluster Secret argocd/%s: server unreadable (%v)\n", clusterName, clusterErr)
		} else {
			fmt.Fprintf(&b, "    registered cluster Secret argocd/%s: server=%s (credentials deliberately not read)\n", clusterName, capDiag(clusterServer))
		}
	}
	return b.String()
}

// dumpArgoAppDiagnosis reads one Application (and, when clusterName is set, ONLY the `server` field
// of the ArgoCD cluster Secret of that name) and renders the failure account. When podNS is set it
// also renders the scheduling half (argo_app_sched_diag.go): the not-Ready Pods in podNS, and per
// node the allocatable CPU against what is already requested — and, only when a Pod there is stuck
// in init, the network half (argo_app_net_diag.go): the stuck init containers' last log lines, the
// namespace's NetworkPolicies and what the DNS allow admits. BOUNDED: every read is 5s, at most five
// without a stuck init and at most thirteen with one (up to 3 logs + 5 network reads), because this
// runs on a failing path inside the T2 context after the wait budget is spent, and a cancelled ctx would kill the process before t.Cleanup tears the cluster down.
func dumpArgoAppDiagnosis(ctx context.Context, kubeconfigPath, appName, clusterName, podNS string) string {
	const perRead = 5 * time.Second
	read := func(args ...string) ([]byte, error) {
		cctx, cancel := context.WithTimeout(ctx, perRead)
		defer cancel()
		full := append([]string{"--kubeconfig", kubeconfigPath}, args...)
		// Output(), not CombinedOutput(): kubectl warnings on stderr must not poison the value read.
		return exec.CommandContext(cctx, "kubectl", full...).Output()
	}

	var appJSON []byte
	var appErr error
	if strings.TrimSpace(appName) == "" {
		appErr = fmt.Errorf("no Application was matched, so there is none to read")
	} else {
		appJSON, appErr = read("get", "applications.argoproj.io", "-n", "argocd", appName, "-o", "json")
	}

	var server string
	var clusterErr error
	if clusterName != "" {
		// jsonpath names `.data.server` ALONE, so the bearer token and CA in `.data.config` never
		// leave the API server — not into memory, not into a log.
		out, err := read("get", "secret", "-n", "argocd", clusterName, "-o", "jsonpath={.data.server}")
		if err != nil {
			clusterErr = err
		} else {
			server, clusterErr = decodeClusterSecretServer(string(out))
		}
	}
	out := renderArgoAppDiagnosis(appName, appJSON, appErr, clusterName, server, clusterErr)
	if strings.TrimSpace(podNS) == "" {
		return out
	}
	pods, podsErr := read("get", "pods", "-n", podNS, "-o", "json")
	nodes, nodesErr := read("get", "nodes", "-o", "json")
	var allPods []byte
	var allPodsErr error
	if nodesErr == nil {
		allPods, allPodsErr = read("get", "pods", "-A", "-o", "json")
	}
	out += renderSchedulingDiagnosis(podNS, pods, podsErr, nodes, nodesErr, allPods, allPodsErr)

	// The network half (argo_app_net_diag.go). Only when a Pod is stuck in init: that is the shape
	// whose cause lives in a log and a policy rather than in the scheduler, and it keeps a plain
	// scheduling failure's dump as short as it was.
	if podsErr != nil {
		return out
	}
	stuck := stuckInitContainers(pods, maxInitLogContainers)
	if len(stuck) == 0 {
		return out
	}
	var logs []initLogRead
	for _, si := range stuck {
		args := []string{"logs", "-n", podNS, si.Pod, "-c", si.Container, fmt.Sprintf("--tail=%d", initLogTailLines)}
		if si.Previous {
			args = append(args, "--previous")
		}
		l, err := read(args...)
		logs = append(logs, initLogRead{stuckInit: si, Log: l, Err: err})
	}
	out += renderInitContainerLogs(logs)
	nps, npsErr := read("get", "networkpolicies.networking.k8s.io", "-n", podNS, "-o", "json")
	out += renderNetworkPolicies(podNS, nps, npsErr)
	dnsPods, dnsPodsErr := read("get", "pods", "-n", "kube-system", "-l", "k8s-app=kube-dns", "-o", "json")
	dnsSvc, dnsSvcErr := read("get", "service", "-n", "kube-system", "kube-dns", "-o", "json")
	nodeLocal, nodeLocalErr := read("get", "pods", "-A", "-l", "k8s-app=node-local-dns", "-o", "json")
	out += renderDNSPeer(dnsPods, dnsPodsErr, dnsSvc, dnsSvcErr, nodeLocal, nodeLocalErr)
	agents, agentsErr := read("get", "pods", "-A", "-l", policyEngineSelector, "-o", "json")
	return out + renderPolicyEngine(agents, agentsErr)
}
