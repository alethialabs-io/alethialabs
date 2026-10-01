// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"errors"
	"io"
	"os"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

// renderedDNSPolicy is the subset of a NetworkPolicy the ClusterIP-allow tests read back.
type renderedDNSPolicy struct {
	Kind     string `yaml:"kind"`
	Metadata struct {
		Name      string `yaml:"name"`
		Namespace string `yaml:"namespace"`
	} `yaml:"metadata"`
	Spec struct {
		PodSelector map[string]any `yaml:"podSelector"`
		PolicyTypes []string       `yaml:"policyTypes"`
		Ingress     []any          `yaml:"ingress"`
		Egress      []struct {
			To    []map[string]map[string]any `yaml:"to"`
			Ports []struct {
				Protocol string `yaml:"protocol"`
				Port     int    `yaml:"port"`
				EndPort  *int   `yaml:"endPort"`
			} `yaml:"ports"`
		} `yaml:"egress"`
	} `yaml:"spec"`
}

// TestRenderNodeLocalDNSAllow pins that the per-cluster DNS allow admits exactly one address on
// 53/UDP+TCP and nothing else, for the ClusterIP shapes a kube-dns Service can carry.
func TestRenderNodeLocalDNSAllow(t *testing.T) {
	for _, tc := range []struct{ raw, wantCIDR string }{
		{"10.2.0.10", "10.2.0.10/32"}, // run 36716444473's GKE kube-dns ClusterIP
		{" 10.96.0.10\n", "10.96.0.10/32"},
		{"fd00:10:96::a", "fd00:10:96::a/128"},
		{"::ffff:10.0.0.10", "10.0.0.10/32"},
	} {
		manifest, ok, err := renderNodeLocalDNSAllow("team-web", tc.raw)
		if err != nil || !ok {
			t.Fatalf("%q: ok=%v err=%v", tc.raw, ok, err)
		}
		var p renderedDNSPolicy
		if err := yaml.Unmarshal([]byte(manifest), &p); err != nil {
			t.Fatalf("%q: rendered manifest is not YAML: %v\n%s", tc.raw, err, manifest)
		}
		if p.Kind != "NetworkPolicy" || p.Metadata.Name != nodeLocalDNSPolicyName || p.Metadata.Namespace != "team-web" {
			t.Errorf("%q: identity = %s %s/%s", tc.raw, p.Kind, p.Metadata.Namespace, p.Metadata.Name)
		}
		if p.Spec.PodSelector == nil || len(p.Spec.PodSelector) != 0 || strings.Join(p.Spec.PolicyTypes, ",") != "Egress" || len(p.Spec.Ingress) != 0 {
			t.Errorf("%q: want an egress-only policy over every pod, got %+v", tc.raw, p.Spec)
		}
		if len(p.Spec.Egress) != 1 {
			t.Fatalf("%q: want exactly one egress rule, got %d", tc.raw, len(p.Spec.Egress))
		}
		r := p.Spec.Egress[0]
		if len(r.To) != 1 || len(r.To[0]) != 1 || r.To[0]["ipBlock"] == nil {
			t.Fatalf("%q: want exactly one ipBlock peer, got %+v", tc.raw, r.To)
		}
		if got := r.To[0]["ipBlock"]["cidr"]; got != tc.wantCIDR || len(r.To[0]["ipBlock"]) != 1 {
			t.Errorf("%q: ipBlock = %v, want only cidr %s", tc.raw, r.To[0]["ipBlock"], tc.wantCIDR)
		}
		var protos []string
		for _, port := range r.Ports {
			if port.Port != 53 || port.EndPort != nil {
				t.Errorf("%q: port %+v is not exactly 53", tc.raw, port)
			}
			protos = append(protos, port.Protocol)
		}
		if strings.Join(protos, ",") != "UDP,TCP" {
			t.Errorf("%q: protocols = %v, want UDP,TCP", tc.raw, protos)
		}
	}

	for _, raw := range []string{"", "  ", "None"} {
		if m, ok, err := renderNodeLocalDNSAllow("team-web", raw); ok || err != nil || m != "" {
			t.Errorf("%q: want no rule and no error, got ok=%v err=%v", raw, ok, err)
		}
	}
	// Never interpolated raw: anything that is not one address is refused, including a CIDR that
	// would widen the rule and text that would restructure the YAML.
	for _, raw := range []string{"0.0.0.0/0", "10.2.0.0/16", "10.2.0.10\n  - ipBlock: {cidr: 0.0.0.0/0}", "kube-dns"} {
		if _, ok, err := renderNodeLocalDNSAllow("team-web", raw); err == nil || ok {
			t.Errorf("%q: want a refusal, got ok=%v err=%v", raw, ok, err)
		}
	}
}

// TestApplyNodeLocalDNSAllow covers the three answers the kube-dns read can give: a ClusterIP (apply
// the rule), no Service (apply nothing, say so), and a failed read (an error, never an absence).
func TestApplyNodeLocalDNSAllow(t *testing.T) {
	t.Run("applies the ClusterIP rule", func(t *testing.T) {
		resetDeploySeams(t)
		var readCmd string
		executeCommandWithOutput = func(cmd, _ string, _ []string) (string, error) {
			readCmd = cmd
			return "10.2.0.10", nil
		}
		var applied string
		executeCommand = func(cmd, _ string, _ []string, _, _ io.Writer) error {
			path := strings.TrimPrefix(cmd, "kubectl apply -f ")
			b, err := os.ReadFile(path)
			if err != nil {
				t.Fatalf("read staged manifest %q: %v", path, err)
			}
			applied = string(b)
			return nil
		}
		if err := applyNodeLocalDNSAllow("team-web", io.Discard, io.Discard); err != nil {
			t.Fatal(err)
		}
		if readCmd != readKubeDNSClusterIPCmd {
			t.Errorf("read = %q", readCmd)
		}
		if !strings.Contains(applied, "cidr: 10.2.0.10/32") || !strings.Contains(applied, "namespace: team-web") {
			t.Errorf("applied manifest:\n%s", applied)
		}
	})

	t.Run("no kube-dns Service applies nothing", func(t *testing.T) {
		resetDeploySeams(t)
		executeCommandWithOutput = func(string, string, []string) (string, error) { return "", nil }
		executeCommand = func(cmd string, _ string, _ []string, _, _ io.Writer) error {
			t.Errorf("applied %q with no ClusterIP to admit", cmd)
			return nil
		}
		var out strings.Builder
		if err := applyNodeLocalDNSAllow("team-web", &out, io.Discard); err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(out.String(), "No kube-dns Service ClusterIP") {
			t.Errorf("the skip must be said, got %q", out.String())
		}
	})

	t.Run("a failed read is an error", func(t *testing.T) {
		resetDeploySeams(t)
		executeCommandWithOutput = func(string, string, []string) (string, error) {
			return "", errors.New("forbidden")
		}
		executeCommand = func(cmd string, _ string, _ []string, _, _ io.Writer) error {
			t.Errorf("applied %q after a failed read", cmd)
			return nil
		}
		err := applyNodeLocalDNSAllow("team-web", io.Discard, io.Discard)
		if err == nil || !strings.Contains(err.Error(), "forbidden") {
			t.Fatalf("err = %v, want the read failure", err)
		}
	})

	t.Run("an invalid namespace never reaches kubectl", func(t *testing.T) {
		resetDeploySeams(t)
		executeCommandWithOutput = func(cmd, _ string, _ []string) (string, error) {
			t.Errorf("read %q for an invalid namespace", cmd)
			return "", nil
		}
		if err := applyNodeLocalDNSAllow("bad ns; rm -rf /", io.Discard, io.Discard); err == nil {
			t.Fatal("want a refusal")
		}
	})
}
