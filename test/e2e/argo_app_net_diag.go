// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package e2e

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

// WHY A POD THAT WAS SCHEDULED NEVER FINISHED ITS INIT — THE NETWORK HALF.
//
// gcp fabric-demo run 36706460832 failed its staging tier with ONE pod not Ready:
//
//	loadgenerator-… phase=Pending node=gke-…; container main waiting PodInitializing
//
// on nodes with ~2 vCPU free each. The scheduler placed it; its init container (online-boutique's
// `frontend-check`, a busybox loop that wgets http://frontend:80 twelve times, ten seconds apart, and
// exits 1 if it never gets a 200) never completed. The staging overlay is the ONLY tier that runs
// the load generator — dev-1 and prod scale it to 0 — so it is the only tier whose convergence
// depends on one pod reaching another over the network, through the namespace guardrail bundle's
// default-deny NetworkPolicy. The same overlay converged on hetzner (Cilium) at the same commit; GKE
// enforces the same policies with Calico.
//
// The dump could not tell "frontend unreachable" (DNS / policy / connect) from "frontend answered
// 500" (a backend it calls failed) from "the init image never pulled", because it printed neither the
// init container's state nor its log, nor what policy the namespace carried, nor whether the DNS peer
// the policy admits exists on that cluster. So it now also prints:
//
//   - each not-completed init container's state and its last log lines (renderInitContainerLogs);
//   - the NetworkPolicies in the namespace — name, policy types, and every peer selector
//     (renderNetworkPolicies). Selectors are labels, never values;
//   - what the guardrail's DNS allow actually admits on THIS cluster: the kube-system pods labelled
//     k8s-app=kube-dns, the kube-dns Service's selector, and whether a node-local DNS cache is
//     running, which resolves on a link-local node address that no podSelector can match
//     (renderDNSPeer);
//   - whether the policy agents themselves are Ready (renderPolicyEngine) — a Calico Felix that has not
//     synced a new Pod's IP enforces a stale "same namespace" set and drops what the policy allows.
//
// Pure over already-read JSON / text; the kubectl reads live in dumpArgoAppDiagnosis.

const (
	maxInitLogContainers = 3
	initLogTailLines     = 8
	maxPolicyLines       = 12
)

// initLogRead is one stuck init container's log read, as dumpArgoAppDiagnosis performed it.
type initLogRead struct {
	stuckInit
	Log []byte
	Err error
}

// renderInitContainerLogs prints each stuck init container's last lines, or why they could not be
// read. An empty successful read is said as such — it is not the same finding as a failed one.
func renderInitContainerLogs(reads []initLogRead) string {
	if len(reads) == 0 {
		return ""
	}
	var b strings.Builder
	fmt.Fprintf(&b, "    last %d log line(s) of each init container that has not completed:\n", initLogTailLines)
	for _, r := range reads {
		which := "current run"
		if r.Previous {
			which = "PREVIOUS run (--previous; it is restarting)"
		}
		fmt.Fprintf(&b, "      %s / %s (%s):\n", r.Pod, r.Container, which)
		text := strings.TrimRight(string(r.Log), "\n")
		switch {
		case strings.TrimSpace(text) != "":
			for _, ln := range strings.Split(text, "\n") {
				fmt.Fprintf(&b, "        | %s\n", capDiag(ln))
			}
			if r.Err != nil {
				fmt.Fprintf(&b, "        (PARTIAL — the read stopped: %v)\n", r.Err)
			}
		case r.Err != nil:
			fmt.Fprintf(&b, "        could not read the log (%v) — this says nothing about what it logged\n", r.Err)
		default:
			b.WriteString("        (the read succeeded and returned NOTHING — it has not written a line yet)\n")
		}
	}
	return b.String()
}

// labelSelectorView is a LabelSelector's matchLabels + matchExpressions.
type labelSelectorView struct {
	MatchLabels      map[string]string `json:"matchLabels"`
	MatchExpressions []struct {
		Key      string   `json:"key"`
		Operator string   `json:"operator"`
		Values   []string `json:"values"`
	} `json:"matchExpressions"`
}

// String renders the selector as `{}` (all) or `k=v,k2 In (a,b)`, keys sorted.
func (s *labelSelectorView) String() string {
	if s == nil {
		return "(none)"
	}
	var parts []string
	keys := make([]string, 0, len(s.MatchLabels))
	for k := range s.MatchLabels {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		parts = append(parts, k+"="+s.MatchLabels[k])
	}
	for _, e := range s.MatchExpressions {
		parts = append(parts, fmt.Sprintf("%s %s (%s)", e.Key, e.Operator, strings.Join(e.Values, ",")))
	}
	if len(parts) == 0 {
		return "{}"
	}
	return strings.Join(parts, ",")
}

// policyPeerView is one NetworkPolicy peer.
type policyPeerView struct {
	PodSelector       *labelSelectorView `json:"podSelector"`
	NamespaceSelector *labelSelectorView `json:"namespaceSelector"`
	IPBlock           *struct {
		CIDR string `json:"cidr"`
	} `json:"ipBlock"`
}

// String renders a peer. A peer with only a podSelector means the policy's OWN namespace.
func (p policyPeerView) String() string {
	switch {
	case p.IPBlock != nil:
		return "ipBlock " + p.IPBlock.CIDR
	case p.NamespaceSelector != nil && p.PodSelector != nil:
		return "ns[" + p.NamespaceSelector.String() + "] pods[" + p.PodSelector.String() + "]"
	case p.NamespaceSelector != nil:
		return "ns[" + p.NamespaceSelector.String() + "] all pods"
	case p.PodSelector != nil:
		return "same-ns pods[" + p.PodSelector.String() + "]"
	default:
		return "(empty peer)"
	}
}

// policyRuleView is one ingress (from) or egress (to) rule.
type policyRuleView struct {
	From  []policyPeerView `json:"from"`
	To    []policyPeerView `json:"to"`
	Ports []struct {
		Protocol string          `json:"protocol"`
		Port     json.RawMessage `json:"port"`
	} `json:"ports"`
}

// describe renders one rule's peers and ports; `peers` is From or To.
func (r policyRuleView) describe(peers []policyPeerView) string {
	ps := "any peer"
	if len(peers) > 0 {
		var s []string
		for _, p := range peers {
			s = append(s, p.String())
		}
		ps = strings.Join(s, " | ")
	}
	if len(r.Ports) == 0 {
		return ps + " on any port"
	}
	var ports []string
	for _, p := range r.Ports {
		proto := p.Protocol
		if proto == "" {
			proto = "TCP"
		}
		port := strings.Trim(string(p.Port), `"`)
		if port == "" {
			port = "*"
		}
		ports = append(ports, port+"/"+proto)
	}
	return ps + " on " + strings.Join(ports, ",")
}

// renderNetworkPolicies lists the namespace's NetworkPolicies: name, which pods they select, their
// policy types, and each rule's peers and ports. A policy type with no rules is a DENY for that
// direction and is said so.
func renderNetworkPolicies(ns string, raw []byte, readErr error) string {
	var b strings.Builder
	fmt.Fprintf(&b, "    NetworkPolicies in %s (a policy type with no rules DENIES that direction):\n", ns)
	if readErr != nil {
		fmt.Fprintf(&b, "      could not list NetworkPolicies (%v) — this says nothing about whether any apply\n", readErr)
		return b.String()
	}
	var list struct {
		Items []struct {
			Metadata struct {
				Name string `json:"name"`
			} `json:"metadata"`
			Spec struct {
				PodSelector labelSelectorView `json:"podSelector"`
				PolicyTypes []string          `json:"policyTypes"`
				Ingress     []policyRuleView  `json:"ingress"`
				Egress      []policyRuleView  `json:"egress"`
			} `json:"spec"`
		} `json:"items"`
	}
	if err := json.Unmarshal(raw, &list); err != nil {
		fmt.Fprintf(&b, "      could not decode the NetworkPolicy list (%v)\n", err)
		return b.String()
	}
	if len(list.Items) == 0 {
		b.WriteString("      none — every pod here is non-isolated (all traffic allowed)\n")
		return b.String()
	}
	var lines []string
	for _, np := range list.Items {
		sel := np.Spec.PodSelector
		lines = append(lines, fmt.Sprintf("%s: pods[%s] types=%s", np.Metadata.Name, sel.String(), strings.Join(np.Spec.PolicyTypes, ",")))
		for _, typ := range np.Spec.PolicyTypes {
			switch typ {
			case "Ingress":
				if len(np.Spec.Ingress) == 0 {
					lines = append(lines, "  ingress: DENY all")
				}
				for _, r := range np.Spec.Ingress {
					lines = append(lines, "  ingress from "+r.describe(r.From))
				}
			case "Egress":
				if len(np.Spec.Egress) == 0 {
					lines = append(lines, "  egress: DENY all")
				}
				for _, r := range np.Spec.Egress {
					lines = append(lines, "  egress to "+r.describe(r.To))
				}
			}
		}
	}
	for i, l := range lines {
		if i == maxPolicyLines {
			fmt.Fprintf(&b, "      … %d more line(s)\n", len(lines)-i)
			break
		}
		fmt.Fprintf(&b, "      %s\n", l)
	}
	return b.String()
}

// countPods returns (total, Ready) for a `kubectl get pods -o json` List.
func countPods(raw []byte) (int, int, error) {
	pods, err := decodePodList(raw)
	if err != nil {
		return 0, 0, err
	}
	ready := 0
	for _, p := range pods {
		if st, _, _ := p.condition("Ready"); st == "True" {
			ready++
		}
	}
	return len(pods), ready, nil
}

// renderDNSPeer says what the guardrail bundle's DNS allow (egress to kube-system pods labelled
// k8s-app=kube-dns, 53/UDP+TCP) admits on THIS cluster: how many such pods exist and are Ready, the
// kube-dns Service's own selector and ClusterIP, and whether a node-local DNS cache is running — in
// which case pods resolve on a node-local address that the allow cannot select, and every lookup
// from a default-deny namespace is dropped.
func renderDNSPeer(kubeDNSPods []byte, kubeDNSPodsErr error, kubeDNSSvc []byte, kubeDNSSvcErr error, nodeLocal []byte, nodeLocalErr error) string {
	var b strings.Builder
	b.WriteString("    cluster DNS — what the guardrail's DNS allow (kube-system pods k8s-app=kube-dns, 53/UDP+TCP) admits here:\n")
	switch total, ready, err := countPodsOrErr(kubeDNSPods, kubeDNSPodsErr); {
	case err != nil:
		fmt.Fprintf(&b, "      kube-system pods k8s-app=kube-dns: UNKNOWN (%v)\n", err)
	case total == 0:
		b.WriteString("      kube-system pods k8s-app=kube-dns: NONE — the DNS allow selects nothing on this cluster, so a default-deny namespace cannot resolve any name\n")
	default:
		fmt.Fprintf(&b, "      kube-system pods k8s-app=kube-dns: %d (%d Ready)\n", total, ready)
	}
	if kubeDNSSvcErr != nil {
		fmt.Fprintf(&b, "      Service kube-system/kube-dns: unreadable (%v)\n", kubeDNSSvcErr)
	} else {
		var svc struct {
			Spec struct {
				ClusterIP string            `json:"clusterIP"`
				Selector  map[string]string `json:"selector"`
			} `json:"spec"`
		}
		if err := json.Unmarshal(kubeDNSSvc, &svc); err != nil {
			fmt.Fprintf(&b, "      Service kube-system/kube-dns: undecodable (%v)\n", err)
		} else {
			sel := labelSelectorView{MatchLabels: svc.Spec.Selector}
			fmt.Fprintf(&b, "      Service kube-system/kube-dns: clusterIP=%s selector=%s\n", orNone(svc.Spec.ClusterIP), sel.String())
		}
	}
	switch total, ready, err := countPodsOrErr(nodeLocal, nodeLocalErr); {
	case err != nil:
		fmt.Fprintf(&b, "      node-local DNS cache (pods k8s-app=node-local-dns, any ns): UNKNOWN (%v)\n", err)
	case total == 0:
		b.WriteString("      node-local DNS cache (pods k8s-app=node-local-dns, any ns): none\n")
	default:
		fmt.Fprintf(&b, "      node-local DNS cache (pods k8s-app=node-local-dns, any ns): %d (%d Ready) — pods resolve on the node, which the kube-dns podSelector does NOT admit\n", total, ready)
	}
	return b.String()
}

// countPodsOrErr is countPods with a prior read error passed through, so a failed read can never be
// rendered as zero pods.
func countPodsOrErr(raw []byte, readErr error) (int, int, error) {
	if readErr != nil {
		return 0, 0, readErr
	}
	return countPods(raw)
}

// policyEngineSelector names the network-policy agents whose health decides whether a policy is
// enforced AS WRITTEN: Calico's per-node Felix (calico-node) and its fan-out (calico-typha) on GKE
// Standard and AKS, Cilium's agent on hetzner. A Felix that has not synced a new Pod's IP into the
// "pods in this namespace" set on the peer's node drops traffic an intra-namespace allow permits.
const policyEngineSelector = "k8s-app in (calico-node,calico-typha,cilium)"

// renderPolicyEngine renders, per agent label, how many agent pods exist and how many are Ready.
func renderPolicyEngine(raw []byte, readErr error) string {
	var b strings.Builder
	fmt.Fprintf(&b, "    network-policy agents (pods %s, any ns):\n", policyEngineSelector)
	if readErr != nil {
		fmt.Fprintf(&b, "      UNKNOWN (%v)\n", readErr)
		return b.String()
	}
	var list struct {
		Items []struct {
			Metadata struct {
				Labels map[string]string `json:"labels"`
			} `json:"metadata"`
			Status struct {
				Conditions []struct {
					Type   string `json:"type"`
					Status string `json:"status"`
				} `json:"conditions"`
			} `json:"status"`
		} `json:"items"`
	}
	if err := json.Unmarshal(raw, &list); err != nil {
		fmt.Fprintf(&b, "      could not decode the pod list (%v)\n", err)
		return b.String()
	}
	if len(list.Items) == 0 {
		b.WriteString("      none — no Calico or Cilium agent runs here, so NetworkPolicy may not be enforced at all\n")
		return b.String()
	}
	total := map[string]int{}
	ready := map[string]int{}
	for _, p := range list.Items {
		app := p.Metadata.Labels["k8s-app"]
		total[app]++
		for _, c := range p.Status.Conditions {
			if c.Type == "Ready" && c.Status == "True" {
				ready[app]++
			}
		}
	}
	apps := make([]string, 0, len(total))
	for a := range total {
		apps = append(apps, a)
	}
	sort.Strings(apps)
	for _, a := range apps {
		line := fmt.Sprintf("%s: %d/%d Ready", a, ready[a], total[a])
		if ready[a] < total[a] {
			line += " — NOT ALL READY: policy on the affected nodes may not reflect current pod IPs"
		}
		fmt.Fprintf(&b, "      %s\n", line)
	}
	return b.String()
}
