// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package e2e

import (
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// WHICH RESOURCE WAS DEGRADED, AND WHETHER IT EVER GOT A NODE.
//
// gcp fabric-demo run 36648775773 failed its staging tier with
//
//	Application "app-alethia-nl-boutique-staging" is health="Degraded" sync="Synced"
//	phase=Succeeded successfully synced (all tasks run)
//
// — which rules OUT every sync-side cause and names no other. A Degraded-after-a-good-sync
// Application is almost always a workload that was accepted by the API server and then never became
// Ready: a Pod the scheduler could not place, or one that crashes. Which of the two it was is exactly
// the hypothesis (#845: the demo floor compared NOMINAL vCPU, and GKE's reservation plus its system
// DaemonSets leave far less than nominal schedulable) and the log could not answer it.
//
// So a tier that misses its deadline now also prints:
//
//   - the Application's own `.status.resources[]` whose health is not Healthy (kind/name/health/
//     message) — ArgoCD's per-resource verdict, which names the Degraded Deployment;
//   - every Pending / not-Ready Pod in the tier's namespace, with its PodScheduled condition — whose
//     message IS the scheduler's last FailedScheduling message ("0/2 nodes are available: 2
//     Insufficient cpu") — and each waiting container's reason;
//   - per node: instance type, capacity, allocatable and the CPU already REQUESTED on it. That line
//     is the one that proves or refutes the hypothesis, because allocatable is not free.
//
// Everything here is pure over already-read JSON so the shapes are pinned by tests; the kubectl
// reads live in dumpArgoAppDiagnosis. Nothing prints a Pod's env, args or volumes — the pod JSON is
// read whole only because kubectl has no projection for "conditions and container states", and only
// the named fields below ever reach a log.

const (
	maxUnhealthyResourceLines = 15
	maxPodLines               = 20
	maxNodeLines              = 10
)

// parseArgoUnhealthyResources lists an Application's `.status.resources[]` whose health is reported
// and is not Healthy. Resources with no health at all (ConfigMaps, Services) carry no verdict and are
// skipped — printing them would bury the one Deployment that is the answer.
func parseArgoUnhealthyResources(appJSON []byte) ([]string, error) {
	var app struct {
		Status struct {
			Resources []struct {
				Kind      string `json:"kind"`
				Namespace string `json:"namespace"`
				Name      string `json:"name"`
				Health    *struct {
					Status  string `json:"status"`
					Message string `json:"message"`
				} `json:"health"`
			} `json:"resources"`
		} `json:"status"`
	}
	if err := json.Unmarshal(appJSON, &app); err != nil {
		return nil, err
	}
	var out []string
	for _, r := range app.Status.Resources {
		if r.Health == nil || r.Health.Status == "" || r.Health.Status == "Healthy" {
			continue
		}
		line := fmt.Sprintf("%s/%s in %s: health=%s", r.Kind, r.Name, orNone(r.Namespace), r.Health.Status)
		if m := strings.TrimSpace(r.Health.Message); m != "" {
			line += " — " + capDiag(m)
		}
		out = append(out, line)
	}
	return out, nil
}

// renderArgoUnhealthyResources formats parseArgoUnhealthyResources' result, capped.
func renderArgoUnhealthyResources(appJSON []byte) string {
	lines, err := parseArgoUnhealthyResources(appJSON)
	var b strings.Builder
	b.WriteString("    resources ArgoCD reports as not Healthy:\n")
	switch {
	case err != nil:
		fmt.Fprintf(&b, "      could not decode .status.resources (%v)\n", err)
	case len(lines) == 0:
		b.WriteString("      none — every resource with a health verdict is Healthy (or none carries one)\n")
	default:
		for i, l := range lines {
			if i == maxUnhealthyResourceLines {
				fmt.Fprintf(&b, "      … %d more\n", len(lines)-i)
				break
			}
			fmt.Fprintf(&b, "      %s\n", l)
		}
	}
	return b.String()
}

// podDiagView is the subset of a Pod the scheduling dump reads. Deliberately no env/args/volumes.
type podDiagView struct {
	Metadata struct {
		Name      string `json:"name"`
		Namespace string `json:"namespace"`
	} `json:"metadata"`
	Spec struct {
		NodeName   string `json:"nodeName"`
		Containers []struct {
			Resources struct {
				Requests map[string]string `json:"requests"`
			} `json:"resources"`
		} `json:"containers"`
	} `json:"spec"`
	Status struct {
		Phase      string `json:"phase"`
		Conditions []struct {
			Type    string `json:"type"`
			Status  string `json:"status"`
			Reason  string `json:"reason"`
			Message string `json:"message"`
		} `json:"conditions"`
		ContainerStatuses []struct {
			Name         string `json:"name"`
			Ready        bool   `json:"ready"`
			RestartCount int    `json:"restartCount"`
			State        struct {
				Waiting *struct {
					Reason  string `json:"reason"`
					Message string `json:"message"`
				} `json:"waiting"`
			} `json:"state"`
			LastState struct {
				Terminated *struct {
					Reason   string `json:"reason"`
					ExitCode int    `json:"exitCode"`
				} `json:"terminated"`
			} `json:"lastState"`
		} `json:"containerStatuses"`
	} `json:"status"`
}

// terminal reports whether the Pod has finished and so holds no node resources.
func (p podDiagView) terminal() bool {
	return p.Status.Phase == "Succeeded" || p.Status.Phase == "Failed"
}

// condition returns the named condition's (status, reason, message), or empty strings.
func (p podDiagView) condition(typ string) (status, reason, message string) {
	for _, c := range p.Status.Conditions {
		if c.Type == typ {
			return c.Status, c.Reason, c.Message
		}
	}
	return "", "", ""
}

// decodePodList decodes a `kubectl get pods -o json` List.
func decodePodList(raw []byte) ([]podDiagView, error) {
	var list struct {
		Items []podDiagView `json:"items"`
	}
	if err := json.Unmarshal(raw, &list); err != nil {
		return nil, err
	}
	return list.Items, nil
}

// parseNotReadyPods renders one line per non-terminal Pod that is not Ready, naming its phase, node,
// the PodScheduled condition (whose message is the scheduler's last FailedScheduling message) and
// every waiting container's reason. Returns the lines and the total Pod count read.
func parseNotReadyPods(podsJSON []byte) ([]string, int, error) {
	pods, err := decodePodList(podsJSON)
	if err != nil {
		return nil, 0, err
	}
	var out []string
	for _, p := range pods {
		if p.terminal() {
			continue
		}
		if ready, _, _ := p.condition("Ready"); ready == "True" {
			continue
		}
		line := fmt.Sprintf("%s phase=%s node=%s", p.Metadata.Name, orNone(p.Status.Phase), orNone(p.Spec.NodeName))
		if st, reason, msg := p.condition("PodScheduled"); st != "" && st != "True" {
			line += fmt.Sprintf(" — NOT SCHEDULED (%s): %s", orNone(reason), capDiag(msg))
		}
		for _, cs := range p.Status.ContainerStatuses {
			if cs.Ready {
				continue
			}
			part := fmt.Sprintf("; container %s", cs.Name)
			if w := cs.State.Waiting; w != nil {
				part += " waiting " + orNone(w.Reason)
				if m := strings.TrimSpace(w.Message); m != "" {
					part += ": " + capDiag(m)
				}
			} else {
				part += " not ready"
			}
			if cs.RestartCount > 0 {
				part += fmt.Sprintf(" (restarts=%d", cs.RestartCount)
				if t := cs.LastState.Terminated; t != nil {
					part += fmt.Sprintf(", last exit %s/%d", orNone(t.Reason), t.ExitCode)
				}
				part += ")"
			}
			line += part
		}
		out = append(out, line)
	}
	return out, len(pods), nil
}

// parseCPUMilli parses a Kubernetes CPU quantity ("250m", "2", "0.5") into millicores. Only the two
// forms kubelet and manifests actually use for CPU are accepted; anything else is an error rather
// than a silent zero, so a sum it feeds cannot under-report.
func parseCPUMilli(q string) (int64, error) {
	q = strings.TrimSpace(q)
	if q == "" {
		return 0, fmt.Errorf("empty cpu quantity")
	}
	if strings.HasSuffix(q, "m") {
		return strconv.ParseInt(strings.TrimSuffix(q, "m"), 10, 64)
	}
	f, err := strconv.ParseFloat(q, 64)
	if err != nil {
		return 0, err
	}
	return int64(f*1000 + 0.5), nil
}

// parseNodeCPUPressure renders, per node, instance type, capacity and allocatable CPU, allocatable
// memory, and the CPU REQUESTED by every non-terminal Pod bound to it (containers only — init
// containers are not running once the Pod is, and a Pending init container is already named by
// parseNotReadyPods). allPodsJSON is `kubectl get pods -A -o json`; when allPodsErr is set (or the
// list does not decode) every node says its requested CPU is UNKNOWN rather than zero.
func parseNodeCPUPressure(nodesJSON, allPodsJSON []byte, allPodsErr error) ([]string, error) {
	var nodes struct {
		Items []struct {
			Metadata struct {
				Name   string            `json:"name"`
				Labels map[string]string `json:"labels"`
			} `json:"metadata"`
			Status struct {
				Capacity    map[string]string `json:"capacity"`
				Allocatable map[string]string `json:"allocatable"`
			} `json:"status"`
		} `json:"items"`
	}
	if err := json.Unmarshal(nodesJSON, &nodes); err != nil {
		return nil, fmt.Errorf("decode nodes: %w", err)
	}
	requested := map[string]int64{}
	unparsed := map[string]int{}
	podErr := allPodsErr
	var pods []podDiagView
	if podErr == nil {
		pods, podErr = decodePodList(allPodsJSON)
	}
	for _, p := range pods {
		if p.terminal() || p.Spec.NodeName == "" {
			continue
		}
		for _, c := range p.Spec.Containers {
			q, ok := c.Resources.Requests["cpu"]
			if !ok {
				continue
			}
			m, err := parseCPUMilli(q)
			if err != nil {
				unparsed[p.Spec.NodeName]++
				continue
			}
			requested[p.Spec.NodeName] += m
		}
	}
	sort.Slice(nodes.Items, func(i, j int) bool { return nodes.Items[i].Metadata.Name < nodes.Items[j].Metadata.Name })
	var out []string
	for _, n := range nodes.Items {
		name := n.Metadata.Name
		itype := n.Metadata.Labels["node.kubernetes.io/instance-type"]
		line := fmt.Sprintf("%s (%s): capacity cpu=%s, allocatable cpu=%s memory=%s",
			name, orNone(itype), orNone(n.Status.Capacity["cpu"]), orNone(n.Status.Allocatable["cpu"]), orNone(n.Status.Allocatable["memory"]))
		switch alloc, err := parseCPUMilli(n.Status.Allocatable["cpu"]); {
		case podErr != nil:
			line += fmt.Sprintf(", requested cpu UNKNOWN (pods unreadable: %v)", podErr)
		case err != nil:
			line += fmt.Sprintf(", requested cpu=%dm (allocatable unparseable)", requested[name])
		default:
			line += fmt.Sprintf(", requested cpu=%dm, FREE cpu=%dm", requested[name], alloc-requested[name])
		}
		if k := unparsed[name]; k > 0 {
			line += fmt.Sprintf(" (%d request(s) unparseable and NOT counted)", k)
		}
		out = append(out, line)
	}
	return out, nil
}

// renderSchedulingDiagnosis assembles the Pod and node half of a failing tier's dump. podNS is the
// namespace whose Pods belong to the tier (for a vcluster, the host namespace its syncer writes
// into). Each read's error is rendered as such, never as "nothing found".
func renderSchedulingDiagnosis(podNS string, podsJSON []byte, podsErr error, nodesJSON []byte, nodesErr error, allPodsJSON []byte, allPodsErr error) string {
	var b strings.Builder
	fmt.Fprintf(&b, "    pods in %s that are not Ready (PodScheduled's message is the scheduler's last FailedScheduling):\n", podNS)
	if podsErr != nil {
		fmt.Fprintf(&b, "      could not list pods (%v) — this says nothing about scheduling\n", podsErr)
	} else if lines, total, err := parseNotReadyPods(podsJSON); err != nil {
		fmt.Fprintf(&b, "      could not decode the pod list (%v)\n", err)
	} else if len(lines) == 0 {
		fmt.Fprintf(&b, "      none — all %d pod(s) are Ready or finished\n", total)
	} else {
		fmt.Fprintf(&b, "      %d of %d pod(s) not Ready:\n", len(lines), total)
		for i, l := range lines {
			if i == maxPodLines {
				fmt.Fprintf(&b, "      … %d more\n", len(lines)-i)
				break
			}
			fmt.Fprintf(&b, "      %s\n", l)
		}
	}
	b.WriteString("    nodes — allocatable is NOT free; FREE is allocatable minus what running pods already request:\n")
	if nodesErr != nil {
		fmt.Fprintf(&b, "      could not list nodes (%v)\n", nodesErr)
		return b.String()
	}
	lines, err := parseNodeCPUPressure(nodesJSON, allPodsJSON, allPodsErr)
	if err != nil {
		fmt.Fprintf(&b, "      %v\n", err)
		return b.String()
	}
	for i, l := range lines {
		if i == maxNodeLines {
			fmt.Fprintf(&b, "      … %d more node(s)\n", len(lines)-i)
			break
		}
		fmt.Fprintf(&b, "      %s\n", l)
	}
	return b.String()
}
