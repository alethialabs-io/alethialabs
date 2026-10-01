// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"errors"
	"io"
	"os"
	"sort"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

// guardrailNetworkPolicyPath is the bundle file the runner applies into every namespace placement
// (provisioner.applyNamespaceGuardrailBundle) and the preview guardrails ApplicationSet syncs.
const guardrailNetworkPolicyPath = "../../../infra/templates/argocd/preview-guardrails/networkpolicy.yaml"

// nodeLocalDNSAddrs are the ONLY ipBlocks the bundle may admit, each a single node-owned link-local
// address: 169.254.20.10 (GKE / upstream nodelocaldns) and 169.254.25.10 (Kubespray's default).
var nodeLocalDNSAddrs = map[string]bool{"169.254.20.10/32": true, "169.254.25.10/32": true}

// npSelector is a label selector; a present-but-empty one ({}) decodes to a non-nil zero value.
type npSelector struct {
	MatchLabels      map[string]string `yaml:"matchLabels"`
	MatchExpressions []any             `yaml:"matchExpressions"`
}

type npPeer struct {
	PodSelector       *npSelector `yaml:"podSelector"`
	NamespaceSelector *npSelector `yaml:"namespaceSelector"`
	IPBlock           *struct {
		CIDR   string   `yaml:"cidr"`
		Except []string `yaml:"except"`
	} `yaml:"ipBlock"`
}

type npPort struct {
	Protocol string `yaml:"protocol"`
	Port     any    `yaml:"port"`
	EndPort  any    `yaml:"endPort"`
}

type npRule struct {
	To    []npPeer `yaml:"to"`
	From  []npPeer `yaml:"from"`
	Ports []npPort `yaml:"ports"`
}

type networkPolicyDoc struct {
	Kind     string `yaml:"kind"`
	Metadata struct {
		Name      string `yaml:"name"`
		Namespace string `yaml:"namespace"`
	} `yaml:"metadata"`
	Spec struct {
		PodSelector map[string]any `yaml:"podSelector"`
		PolicyTypes []string       `yaml:"policyTypes"`
		Ingress     []npRule       `yaml:"ingress"`
		Egress      []npRule       `yaml:"egress"`
	} `yaml:"spec"`
}

// loadGuardrailNetworkPolicies decodes every document of the real bundle file, keyed by name.
func loadGuardrailNetworkPolicies(t *testing.T) map[string]networkPolicyDoc {
	t.Helper()
	f, err := os.Open(guardrailNetworkPolicyPath)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	dec := yaml.NewDecoder(f)
	out := map[string]networkPolicyDoc{}
	for {
		var d networkPolicyDoc
		err := dec.Decode(&d)
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			t.Fatalf("decode %s: %v", guardrailNetworkPolicyPath, err)
		}
		if d.Kind != "NetworkPolicy" {
			t.Fatalf("unexpected kind %q in the NetworkPolicy file", d.Kind)
		}
		if d.Metadata.Namespace != "" {
			t.Errorf("%s pins metadata.namespace %q — the bundle must stay namespace-agnostic", d.Metadata.Name, d.Metadata.Namespace)
		}
		out[d.Metadata.Name] = d
	}
	return out
}

// isEmptySelector reports whether a selector is present and selects everything ({}).
func isEmptySelector(s *npSelector) bool {
	return s != nil && len(s.MatchLabels) == 0 && len(s.MatchExpressions) == 0
}

// dnsOnlyPorts reports whether ports is exactly {53/UDP, 53/TCP} with no range.
func dnsOnlyPorts(ports []npPort) bool {
	if len(ports) != 2 {
		return false
	}
	var got []string
	for _, p := range ports {
		if p.EndPort != nil {
			return false
		}
		n, ok := p.Port.(int)
		if !ok || n != 53 {
			return false
		}
		got = append(got, p.Protocol)
	}
	sort.Strings(got)
	return strings.Join(got, ",") == "TCP,UDP"
}

// isKubeDNSPeer reports whether a peer is exactly kube-system's k8s-app=kube-dns pods.
func isKubeDNSPeer(p npPeer) bool {
	if p.IPBlock != nil || p.NamespaceSelector == nil || p.PodSelector == nil {
		return false
	}
	ns, pod := p.NamespaceSelector, p.PodSelector
	return len(ns.MatchExpressions) == 0 && len(pod.MatchExpressions) == 0 &&
		len(ns.MatchLabels) == 1 && ns.MatchLabels["kubernetes.io/metadata.name"] == "kube-system" &&
		len(pod.MatchLabels) == 1 && pod.MatchLabels["k8s-app"] == "kube-dns"
}

// isNodeLocalDNSPeer reports whether a peer is one of the allowed link-local /32s, with no except.
func isNodeLocalDNSPeer(p npPeer) bool {
	return p.IPBlock != nil && p.PodSelector == nil && p.NamespaceSelector == nil &&
		len(p.IPBlock.Except) == 0 && nodeLocalDNSAddrs[p.IPBlock.CIDR]
}

// isSameNamespacePeer reports whether a peer is podSelector {} with no namespace or ipBlock widening.
func isSameNamespacePeer(p npPeer) bool {
	return p.IPBlock == nil && p.NamespaceSelector == nil && isEmptySelector(p.PodSelector)
}

// TestGuardrailBundleEgressIsDNSOrSameNamespaceOnly is the bundle's egress contract, read from the
// real file: every egress rule in every policy is EITHER exactly 53/UDP+TCP to kube-dns pods or to a
// node-local DNS cache's link-local /32, OR same-namespace pods on any port. Nothing reaches the
// internet, another tenant, or cloud metadata (169.254.169.254) — a rule with no `to` (every
// destination), a wider ipBlock, or a second port fails here.
func TestGuardrailBundleEgressIsDNSOrSameNamespaceOnly(t *testing.T) {
	pols := loadGuardrailNetworkPolicies(t)
	for _, name := range []string{"preview-default-deny", "preview-allow-dns", "preview-allow-intra-namespace"} {
		if _, ok := pols[name]; !ok {
			t.Fatalf("the bundle no longer ships %q", name)
		}
	}
	for name, p := range pols {
		for i, r := range p.Spec.Egress {
			if len(r.To) == 0 {
				t.Errorf("%s egress[%d] has no `to` — that admits EVERY destination", name, i)
				continue
			}
			allSameNS, allDNS := true, true
			for _, peer := range r.To {
				allSameNS = allSameNS && isSameNamespacePeer(peer)
				allDNS = allDNS && (isKubeDNSPeer(peer) || isNodeLocalDNSPeer(peer))
			}
			switch {
			case allSameNS:
				// same-namespace, any port: the intra-namespace allow.
			case allDNS && dnsOnlyPorts(r.Ports):
				// DNS, and only DNS.
			default:
				t.Errorf("%s egress[%d] is neither DNS-only (53/UDP+TCP to kube-dns or a node-local /32) nor same-namespace: %+v", name, i, r)
			}
		}
	}

	deny := pols["preview-default-deny"]
	if !isEmptyMap(deny.Spec.PodSelector) || strings.Join(deny.Spec.PolicyTypes, ",") != "Ingress,Egress" ||
		len(deny.Spec.Ingress) != 0 || len(deny.Spec.Egress) != 0 {
		t.Errorf("preview-default-deny is no longer a whole-namespace Ingress+Egress deny: %+v", deny.Spec)
	}
	if dns := pols["preview-allow-dns"]; len(dns.Spec.Ingress) != 0 || strings.Join(dns.Spec.PolicyTypes, ",") != "Egress" {
		t.Errorf("preview-allow-dns must be egress-only: %+v", dns.Spec)
	}
}

// isEmptyMap reports whether a decoded selector is the empty map {}.
func isEmptyMap(m map[string]any) bool { return m != nil && len(m) == 0 }

// TestGuardrailBundleAdmitsNodeLocalDNSCache pins the #845 gcp-leg fix: with NodeLocal DNSCache a
// pod's query is answered by a hostNetwork cache on the node, which the kube-dns podSelector does not
// admit. The bundle must keep the kube-dns pod peer AND carry the link-local cache addresses.
func TestGuardrailBundleAdmitsNodeLocalDNSCache(t *testing.T) {
	dns := loadGuardrailNetworkPolicies(t)["preview-allow-dns"]
	var kubeDNS bool
	cidrs := map[string]bool{}
	for _, r := range dns.Spec.Egress {
		if !dnsOnlyPorts(r.Ports) {
			continue
		}
		for _, peer := range r.To {
			if isKubeDNSPeer(peer) {
				kubeDNS = true
			}
			if isNodeLocalDNSPeer(peer) {
				cidrs[peer.IPBlock.CIDR] = true
			}
		}
	}
	if !kubeDNS {
		t.Error("preview-allow-dns lost its kube-system k8s-app=kube-dns peer — clusters without a node-local cache cannot resolve")
	}
	for cidr := range nodeLocalDNSAddrs {
		if !cidrs[cidr] {
			t.Errorf("preview-allow-dns does not admit the node-local DNS cache at %s on 53/UDP+TCP", cidr)
		}
	}
}

// TestGuardrailBundleEgressContractRejectsWidening proves the contract above can fail: each widening
// a future edit might make is fed through the same predicates and must be refused.
func TestGuardrailBundleEgressContractRejectsWidening(t *testing.T) {
	dns53 := []npPort{{Protocol: "UDP", Port: 53}, {Protocol: "TCP", Port: 53}}
	block := func(cidr string) npPeer {
		p := npPeer{}
		p.IPBlock = &struct {
			CIDR   string   `yaml:"cidr"`
			Except []string `yaml:"except"`
		}{CIDR: cidr}
		return p
	}
	if isNodeLocalDNSPeer(block("169.254.0.0/16")) {
		t.Error("the whole link-local /16 (which contains cloud metadata) was accepted")
	}
	if isNodeLocalDNSPeer(block("0.0.0.0/0")) {
		t.Error("0.0.0.0/0 was accepted as a DNS peer")
	}
	if isNodeLocalDNSPeer(block("169.254.169.254/32")) {
		t.Error("the cloud metadata address was accepted as a DNS peer")
	}
	if dnsOnlyPorts([]npPort{{Protocol: "UDP", Port: 53}, {Protocol: "TCP", Port: 443}}) {
		t.Error("443 was accepted as a DNS port")
	}
	if dnsOnlyPorts(append(dns53, npPort{Protocol: "TCP", Port: 80})) {
		t.Error("a third port was accepted")
	}
	if dnsOnlyPorts([]npPort{{Protocol: "UDP", Port: 53, EndPort: 65535}, {Protocol: "TCP", Port: 53}}) {
		t.Error("a port range starting at 53 was accepted")
	}
	if isSameNamespacePeer(npPeer{PodSelector: &npSelector{}, NamespaceSelector: &npSelector{}}) {
		t.Error("podSelector {} + namespaceSelector {} (every pod in every namespace) was accepted as same-namespace")
	}
	if isSameNamespacePeer(npPeer{PodSelector: &npSelector{}, IPBlock: block("0.0.0.0/0").IPBlock}) {
		t.Error("a same-namespace peer carrying an ipBlock was accepted")
	}
	if isKubeDNSPeer(npPeer{PodSelector: &npSelector{MatchLabels: map[string]string{"k8s-app": "kube-dns"}}, NamespaceSelector: &npSelector{}}) {
		t.Error("kube-dns pods in EVERY namespace (namespaceSelector {}) were accepted as the cluster DNS")
	}
	if !isSameNamespacePeer(npPeer{PodSelector: &npSelector{}}) {
		t.Error("the plain same-namespace peer was refused — the predicate is broken, not strict")
	}
}
