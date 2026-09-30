// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package drift

import (
	"encoding/json"
	"strings"
	"testing"

	tfjson "github.com/hashicorp/terraform-json"
)

// The cluster side of these tests is COMPOSED, not captured: run 36717544116 did not read the
// cluster's TargetGroupBindings, so there is no kubectl output from it to replay. It is composed from
// two things that ARE real — the rule the run captured on the node security group (tcp 8080-31762
// from lbBackendSG, description "elbv2.k8s.aws/targetGroupBinding=shared") and the shapes
// aws-load-balancer-controller v3.5.0 writes (apis/elbv2/v1beta1/targetgroupbinding_types.go for the
// CR, pkg/service/model_build_target_group.go buildTargetGroupBindingNetworking for the networking
// block: an instance-mode TCP binding declares its traffic NodePort and, when the health-check port is
// a different number, that port too). The two ports below are the ones whose restricted-mode merge
// renders exactly the captured range. The first real run with this change will print the evidence
// count, which is what confirms the composition (the runner logs it — no values).
//
// The plan side is the captured aws fixture, unchanged.

const (
	eksCluster = "eks-ue1-36717544116-1-alethia-nl"
	obNS       = "online-boutique"
	obSvc      = "frontend-external"
)

// tgbPort is one spec.networking.ingress[].ports[] entry.
type tgbPort struct {
	Protocol *string `json:"protocol,omitempty"`
	Port     any     `json:"port,omitempty"`
}

// tgbSpec composes one TargetGroupBinding with a single securityGroup peer.
type tgbSpec struct {
	ns, name, service, sourceSG string
	ports                       []tgbPort
	deleting                    bool
	ipBlock                     bool
}

// item renders the binding as `kubectl get targetgroupbindings -o json` lists it.
func (s tgbSpec) item() map[string]any {
	meta := map[string]any{"namespace": s.ns, "name": s.name}
	if s.deleting {
		meta["deletionTimestamp"] = "2026-09-30T00:00:00Z"
	}
	peer := map[string]any{"securityGroup": map[string]any{"groupID": s.sourceSG}}
	if s.ipBlock {
		peer = map[string]any{"ipBlock": map[string]any{"cidr": "10.0.0.0/16"}}
	}
	return map[string]any{
		"apiVersion": "elbv2.k8s.aws/v1beta1", "kind": "TargetGroupBinding", "metadata": meta,
		"spec": map[string]any{
			"serviceRef": map[string]any{"name": s.service, "port": 80},
			"targetType": "instance",
			"networking": map[string]any{"ingress": []any{map[string]any{
				"from": []any{peer}, "ports": s.ports,
			}}},
		},
	}
}

// strp is a pointer to s.
func strp(s string) *string { return &s }

// frontendTGB is the binding the LBC creates for Online Boutique's frontend-external.
func frontendTGB() tgbSpec {
	return tgbSpec{
		ns: obNS, name: "k8s-onlinebo-frontend-0123456789", service: obSvc, sourceSG: lbBackendSG,
		ports: []tgbPort{{Protocol: strp("TCP"), Port: 31762}, {Protocol: strp("TCP"), Port: 8080}},
	}
}

// clusterReads is one pair of cluster reads, before it is parsed.
type clusterReads struct {
	tgbs     []tgbSpec
	services []map[string]any
	cluster  string
}

// defaultReads is the cluster the fabric demo leaves behind: the binding and its Service.
func defaultReads() *clusterReads {
	return &clusterReads{
		tgbs:     []tgbSpec{frontendTGB()},
		services: []map[string]any{{"metadata": map[string]any{"namespace": obNS, "name": obSvc}}},
		cluster:  eksCluster,
	}
}

// evidence parses the reads, failing the test on a parse error.
func (r *clusterReads) evidence(t *testing.T) *ClusterEvidence {
	t.Helper()
	items := make([]any, 0, len(r.tgbs))
	for _, s := range r.tgbs {
		items = append(items, s.item())
	}
	services := append([]map[string]any{}, r.services...)
	tgbJSON, _ := json.Marshal(map[string]any{"apiVersion": "v1", "kind": "List", "items": items})
	svcJSON, _ := json.Marshal(map[string]any{"apiVersion": "v1", "kind": "List", "items": services})
	ev, err := ParseClusterEvidence(r.cluster, tgbJSON, svcJSON)
	if err != nil {
		t.Fatalf("ParseClusterEvidence: %v", err)
	}
	return ev
}

// withEvidence analyzes plan the way the runner does once schemas and the cluster reads are in.
func withEvidence(t *testing.T, ev *ClusterEvidence) func(*tfjson.Plan) *Posture {
	t.Helper()
	doc := loadSchemas(t, awsSchemas)
	return func(p *tfjson.Plan) *Posture { return AnalyzeWithEvidence(p, doc, ev) }
}

// lbcRule returns the captured Load Balancer Controller element on the node group's ingress.
func lbcRule(t *testing.T, plan *tfjson.Plan) map[string]any {
	t.Helper()
	for _, e := range after(t, plan, sgNode)["ingress"].([]any) {
		m := e.(map[string]any)
		if m["description"] == lbcSharedDescription {
			return m
		}
	}
	t.Fatal("fixture has no load-balancer-controller rule")
	return nil
}

// TestAWSFabricRefreshIsInSyncWithTheBindingEvidence is the ruling of 2026-09-30 stated against the
// captured run: with the cluster's TargetGroupBinding in hand, the node security group's LBC rule is
// kubernetes-owned — the Fabric reads in sync, and the node group is still NAMED, under its own
// reason, next to the 34 dismissals #5220 made (which are unchanged).
func TestAWSFabricRefreshIsInSyncWithTheBindingEvidence(t *testing.T) {
	plan := loadPlan(t, awsFixture)
	base := withAWSSchemas(t)(plan)
	p := withEvidence(t, defaultReads().evidence(t))(loadPlan(t, awsFixture))
	if !p.InSync || p.Drifted != 0 || p.Normalized != 35 {
		t.Fatalf("want in sync with 35 dismissed, got drifted=%d normalized=%d %+v", p.Drifted, p.Normalized, p.Details)
	}
	prior := map[string]NormalizedResource{}
	for _, n := range base.NormalizedDetails {
		prior[n.Address] = n
	}
	for _, n := range p.NormalizedDetails {
		if n.Address == sgNode {
			if n.Reason != ReasonKubernetesOwned || strings.Join(n.Attributes, ",") != "egress,ingress" {
				t.Errorf("%s: %s %v, want kubernetes_owned [egress ingress]", sgNode, n.Reason, n.Attributes)
			}
			continue
		}
		was, ok := prior[n.Address]
		if !ok || was.Reason != n.Reason || strings.Join(was.Attributes, ",") != strings.Join(n.Attributes, ",") {
			t.Errorf("%s: %s %v changed under cluster evidence (was %+v)", n.Address, n.Reason, n.Attributes, was)
		}
	}
}

// TestKubernetesOwnedCarriesNoValues: the evidence holds security-group ids and ports; none of them,
// nor the rule's description, nor any binding or Service name, may reach the posture.
func TestKubernetesOwnedCarriesNoValues(t *testing.T) {
	p := withEvidence(t, defaultReads().evidence(t))(loadPlan(t, awsFixture))
	if p.Normalized != 35 {
		t.Fatalf("Normalized = %d, want 35 — a value check over fewer dismissals proves less", p.Normalized)
	}
	b, _ := json.Marshal(p)
	for _, v := range []string{"sg-0", "elbv2.k8s.aws", "8080", "31762", obNS, obSvc, "k8s-onlinebo", eksCluster} {
		if strings.Contains(string(b), v) {
			t.Errorf("posture leaks value %q", v)
		}
	}
}

// ── Table K — the kubernetes-owned tier: each narrowing alone keeps the node group as drift ────
//
// Every row changes ONE thing about the cluster or the plan. The control row dismisses the node
// group as kubernetes_owned under the unmodified reads, so a row cannot pass for the wrong reason.

func TestTableK_KubernetesOwnedNarrowings(t *testing.T) {
	type row struct {
		reads func(r *clusterReads)
		plan  func(t *testing.T, plan *tfjson.Plan)
	}
	rows := map[string]row{
		"control-free: NO cluster evidence at all (no access)": {},
		"the rule's source group is named by NO binding": {reads: func(r *clusterReads) {
			r.tgbs[0].sourceSG = "sg-0ffffffffffffffff"
		}},
		"the binding was DELETED":       {reads: func(r *clusterReads) { r.tgbs = nil }},
		"the binding is BEING deleted":  {reads: func(r *clusterReads) { r.tgbs[0].deleting = true }},
		"the binding's Service is GONE": {reads: func(r *clusterReads) { r.services = nil }},
		"the binding's Service is BEING deleted": {reads: func(r *clusterReads) {
			r.services[0]["metadata"].(map[string]any)["deletionTimestamp"] = "2026-09-30T00:00:00Z"
		}},
		"the binding's Service is in ANOTHER namespace": {reads: func(r *clusterReads) {
			r.services[0]["metadata"].(map[string]any)["namespace"] = "default"
		}},
		"the binding names NO Service": {reads: func(r *clusterReads) {
			r.tgbs[0].service = ""
			r.services = append(r.services, map[string]any{"metadata": map[string]any{"namespace": obNS, "name": ""}})
		}},
		"the rule's from-port is OUTSIDE what the bindings declare": {reads: func(r *clusterReads) {
			r.tgbs[0].ports = r.tgbs[0].ports[:1]
		}},
		"the rule WIDENED to all ports": {plan: func(t *testing.T, plan *tfjson.Plan) {
			lbcRule(t, plan)["to_port"] = 65535.0
		}},
		"the rule's from-port LOWERED": {plan: func(t *testing.T, plan *tfjson.Plan) {
			lbcRule(t, plan)["from_port"] = 22.0
		}},
		"a UDP binding does not own a TCP rule": {reads: func(r *clusterReads) {
			for i := range r.tgbs[0].ports {
				r.tgbs[0].ports[i].Protocol = strp("UDP")
			}
		}},
		"an unknown binding protocol is refused, not defaulted to tcp": {reads: func(r *clusterReads) {
			for i := range r.tgbs[0].ports {
				r.tgbs[0].ports[i].Protocol = strp("SCTP")
			}
		}},
		"a NAMED port declares nothing": {reads: func(r *clusterReads) {
			r.tgbs[0].ports[1].Port = "http"
		}},
		"an ipBlock peer declares nothing": {reads: func(r *clusterReads) { r.tgbs[0].ipBlock = true }},
		"an ingress rule with NO ports declares nothing (as the controller writes nothing)": {reads: func(r *clusterReads) {
			r.tgbs[0].ports = nil
		}},
		"DESCRIPTION-ONLY forgery: the string, and no binding in the cluster": {reads: func(r *clusterReads) {
			r.tgbs = nil
			r.services = nil
		}},
		"the rule matches a binding but carries ANOTHER description": {plan: func(t *testing.T, plan *tfjson.Plan) {
			lbcRule(t, plan)["description"] = "opened by hand"
		}},
		"the rule's source is a CIDR, not the binding's group": {plan: func(t *testing.T, plan *tfjson.Plan) {
			r := lbcRule(t, plan)
			r["security_groups"] = []any{}
			r["cidr_blocks"] = []any{"0.0.0.0/0"}
		}},
		"a CIDR added next to the binding's group": {plan: func(t *testing.T, plan *tfjson.Plan) {
			lbcRule(t, plan)["cidr_blocks"] = []any{"0.0.0.0/0"}
		}},
		"an out-of-band rule rides along — ssh from anywhere": {plan: func(t *testing.T, plan *tfjson.Plan) {
			a := after(t, plan, sgNode)
			a["ingress"] = append(a["ingress"].([]any), map[string]any{
				"cidr_blocks": []any{"0.0.0.0/0"}, "description": "", "from_port": 22.0, "ipv6_cidr_blocks": []any{},
				"prefix_list_ids": []any{}, "protocol": "tcp", "security_groups": []any{}, "self": false, "to_port": 22.0,
			})
		}},
		"a forged LBC-described rule from ANOTHER group rides along": {plan: func(t *testing.T, plan *tfjson.Plan) {
			a := after(t, plan, sgNode)
			a["ingress"] = append(a["ingress"].([]any), map[string]any{
				"cidr_blocks": []any{}, "description": lbcSharedDescription, "from_port": 8080.0, "ipv6_cidr_blocks": []any{},
				"prefix_list_ids": []any{}, "protocol": "tcp", "security_groups": []any{"sg-0badbadbadbadbad0"}, "self": false, "to_port": 31762.0,
			})
		}},
		"a recorded rule was REVOKED": {plan: func(t *testing.T, plan *tfjson.Plan) {
			before(t, plan, sgNode)["ingress"] = []any{map[string]any{
				"cidr_blocks": []any{"10.9.0.0/16"}, "description": "", "from_port": 1.0, "ipv6_cidr_blocks": []any{},
				"prefix_list_ids": []any{}, "protocol": "tcp", "security_groups": []any{}, "self": false, "to_port": 1.0,
			}}
		}},
		"the group is NOT this cluster's endpoint group (no cluster tag)": {plan: func(t *testing.T, plan *tfjson.Plan) {
			delete(after(t, plan, sgNode)["tags"].(map[string]any), "kubernetes.io/cluster/"+eksCluster)
		}},
		"the cluster tag was only added LIVE (not recorded)": {plan: func(t *testing.T, plan *tfjson.Plan) {
			delete(before(t, plan, sgNode)["tags"].(map[string]any), "kubernetes.io/cluster/"+eksCluster)
		}},
		"the group is tagged for ANOTHER cluster": {reads: func(r *clusterReads) { r.cluster = "some-other-cluster" }},
		"the group's cluster tag has a value the controller does not read": {plan: func(t *testing.T, plan *tfjson.Plan) {
			for _, side := range []map[string]any{before(t, plan, sgNode), after(t, plan, sgNode)} {
				side["tags"].(map[string]any)["kubernetes.io/cluster/"+eksCluster] = "yes"
			}
		}},
		"the group's id changed": {plan: func(t *testing.T, plan *tfjson.Plan) {
			after(t, plan, sgNode)["id"] = "sg-0000000000000000a"
		}},
		"an ingress element this tier cannot read": {plan: func(t *testing.T, plan *tfjson.Plan) {
			lbcRule(t, plan)["extra"] = "x"
		}},
		"a different provider (a fork publishing aws_security_group)": {plan: func(t *testing.T, plan *tfjson.Plan) {
			driftEntry(t, plan, sgNode).ProviderName = "registry.opentofu.org/someone/aws"
		}},
		"the plan carries no prior_state": {plan: func(t *testing.T, plan *tfjson.Plan) { plan.PriorState = nil }},
	}

	t.Run("control: the node group is kubernetes_owned under the real reads", func(t *testing.T) {
		p := withEvidence(t, defaultReads().evidence(t))(onlyDrift(t, loadPlan(t, awsFixture), sgNode))
		assertDrift(t, p, false, ReasonKubernetesOwned)
	})
	for name, r := range rows {
		t.Run(name, func(t *testing.T) {
			var ev *ClusterEvidence
			if r.reads != nil || r.plan != nil {
				reads := defaultReads()
				if r.reads != nil {
					r.reads(reads)
				}
				ev = reads.evidence(t)
			}
			plan := loadPlan(t, awsFixture)
			if r.plan != nil {
				r.plan(t, plan)
			}
			p := withEvidence(t, ev)(onlyDrift(t, plan, sgNode))
			assertDrift(t, p, true, "")
		})
	}
}

// TestTableK_KubernetesOwnedPositives are the renderings the fixture's single rule cannot show,
// each checked against the controller's source: every one must be dismissed as kubernetes_owned.
func TestTableK_KubernetesOwnedPositives(t *testing.T) {
	setRule := func(from, to float64, proto string) func(t *testing.T, plan *tfjson.Plan) {
		return func(t *testing.T, plan *tfjson.Plan) {
			r := lbcRule(t, plan)
			r["from_port"], r["to_port"], r["protocol"] = from, to, proto
		}
	}
	rows := map[string]struct {
		reads func(r *clusterReads)
		plan  func(t *testing.T, plan *tfjson.Plan)
	}{
		"UNRESTRICTED mode: one rule per port, not a merged range": {plan: setRule(31762, 31762, "tcp")},
		"a nil port is all ports (0-65535)": {
			reads: func(r *clusterReads) { r.tgbs[0].ports = []tgbPort{{Protocol: strp("TCP")}} },
			plan:  setRule(0, 65535, "tcp"),
		},
		"a nil protocol is tcp": {
			reads: func(r *clusterReads) {
				for i := range r.tgbs[0].ports {
					r.tgbs[0].ports[i].Protocol = nil
				}
			},
		},
		"port 0 in restricted mode widens to all ports": {
			reads: func(r *clusterReads) { r.tgbs[0].ports = []tgbPort{{Port: 0}} },
			plan:  setRule(0, 65535, "tcp"),
		},
		"port 0 in unrestricted mode stays 0-0": {
			reads: func(r *clusterReads) { r.tgbs[0].ports = []tgbPort{{Port: 0}} },
			plan:  setRule(0, 0, "tcp"),
		},
		"a UDP binding owns a UDP rule": {
			reads: func(r *clusterReads) {
				for i := range r.tgbs[0].ports {
					r.tgbs[0].ports[i].Protocol = strp("UDP")
				}
			},
			plan: setRule(8080, 31762, "udp"),
		},
		"the merge spans TWO bindings sharing the backend group": {
			reads: func(r *clusterReads) {
				other := frontendTGB()
				other.name, other.ports = "k8s-onlinebo-other", []tgbPort{{Protocol: strp("TCP"), Port: 8080}}
				r.tgbs[0].ports = r.tgbs[0].ports[:1]
				r.tgbs = append(r.tgbs, other)
			},
		},
		"the recorded view already held the declared rules (a later apply), and only the LBC rule is new": {
			plan: func(t *testing.T, plan *tfjson.Plan) {
				var recorded []any
				for _, e := range after(t, plan, sgNode)["ingress"].([]any) {
					if e.(map[string]any)["description"] != lbcSharedDescription {
						recorded = append(recorded, e)
					}
				}
				before(t, plan, sgNode)["ingress"] = recorded
			},
		},
		"the cluster tag says shared": {
			plan: func(t *testing.T, plan *tfjson.Plan) {
				for _, side := range []map[string]any{before(t, plan, sgNode), after(t, plan, sgNode)} {
					side["tags"].(map[string]any)["kubernetes.io/cluster/"+eksCluster] = "shared"
				}
			},
		},
		"a binding that is irrelevant (ipBlock, being deleted) sits next to the real one": {
			reads: func(r *clusterReads) {
				a, b := frontendTGB(), frontendTGB()
				a.name, a.ipBlock = "ipblock", true
				b.name, b.deleting = "going", true
				r.tgbs = append(r.tgbs, a, b)
			},
		},
	}
	for name, r := range rows {
		t.Run(name, func(t *testing.T) {
			reads := defaultReads()
			if r.reads != nil {
				r.reads(reads)
			}
			plan := loadPlan(t, awsFixture)
			if r.plan != nil {
				r.plan(t, plan)
			}
			assertDrift(t, withEvidence(t, reads.evidence(t))(onlyDrift(t, plan, sgNode)), false, ReasonKubernetesOwned)
		})
	}
}

// TestParseClusterEvidenceRefusesWhatIsNotAList pins the fail-closed half of the read: a failed,
// truncated or wrong-kind read is an ERROR, and so can never be mistaken for "no bindings".
func TestParseClusterEvidenceRefusesWhatIsNotAList(t *testing.T) {
	list := []byte(`{"kind":"List","items":[]}`)
	for name, c := range map[string]struct {
		cluster   string
		tgb, svcs []byte
	}{
		"no cluster name":                 {"  ", list, list},
		"services read failed (empty)":    {eksCluster, list, nil},
		"services read is an error body":  {eksCluster, list, []byte(`error: the server doesn't have a resource type`)},
		"services read has no items key":  {eksCluster, list, []byte(`{"kind":"Status","status":"Failure"}`)},
		"bindings read failed (empty)":    {eksCluster, nil, list},
		"bindings read has no items key":  {eksCluster, []byte(`{"kind":"Status"}`), list},
		"bindings read items is not list": {eksCluster, []byte(`{"items":{}}`), list},
		"bindings read truncated":         {eksCluster, []byte(`{"items":[{"metadata":`), list},
	} {
		t.Run(name, func(t *testing.T) {
			ev, err := ParseClusterEvidence(c.cluster, c.tgb, c.svcs)
			if err == nil || ev != nil {
				t.Fatalf("want an error and no evidence, got %v, %+v", err, ev)
			}
		})
	}
	t.Run("control: an EMPTY list is valid evidence of no bindings", func(t *testing.T) {
		ev, err := ParseClusterEvidence(eksCluster, list, list)
		if err != nil || ev == nil || ev.Bindings() != 0 {
			t.Fatalf("got %v, %+v", err, ev)
		}
	})
}

// TestClusterEvidenceBindingsCount: only a live binding that declared a permission is counted, and
// nil evidence counts zero — the number the runner logs.
func TestClusterEvidenceBindingsCount(t *testing.T) {
	var none *ClusterEvidence
	if none.Bindings() != 0 {
		t.Fatal("nil evidence must count zero")
	}
	r := defaultReads()
	named := frontendTGB()
	named.name, named.ports = "named", []tgbPort{{Port: "http"}}
	noNet := frontendTGB()
	noNet.name = "no-networking"
	r.tgbs = append(r.tgbs, named, noNet)
	items := []any{r.tgbs[0].item(), r.tgbs[1].item()}
	nn := noNet.item()
	delete(nn["spec"].(map[string]any), "networking")
	items = append(items, nn, map[string]any{"metadata": map[string]any{"namespace": obNS}})
	tgbJSON, _ := json.Marshal(map[string]any{"items": items})
	svcJSON, _ := json.Marshal(map[string]any{"items": r.services})
	ev, err := ParseClusterEvidence(eksCluster, tgbJSON, svcJSON)
	if err != nil || ev.Bindings() != 1 {
		t.Fatalf("Bindings = %d (%v), want 1", ev.Bindings(), err)
	}
}

// TestTableK_Edges covers the fail-closed edges by calling the functions directly.
func TestTableK_Edges(t *testing.T) {
	ev := defaultReads().evidence(t)
	for name, c := range map[string]struct {
		atom string
		want bool
	}{
		"control":                  {"tcp\x008080\x0031762\x00" + lbcSharedDescription + "\x00sg\x00" + lbBackendSG, true},
		"self source":              {"tcp\x008080\x0031762\x00" + lbcSharedDescription + "\x00self", false},
		"cidr source":              {"tcp\x008080\x0031762\x00" + lbcSharedDescription + "\x00cidr4\x0010.0.0.0/8", false},
		"non-numeric from":         {"tcp\x00x\x0031762\x00" + lbcSharedDescription + "\x00sg\x00" + lbBackendSG, false},
		"non-numeric to":           {"tcp\x008080\x00y\x00" + lbcSharedDescription + "\x00sg\x00" + lbBackendSG, false},
		"inverted range":           {"tcp\x0031762\x008080\x00" + lbcSharedDescription + "\x00sg\x00" + lbBackendSG, false},
		"all traffic protocol":     {"-1\x008080\x0031762\x00" + lbcSharedDescription + "\x00sg\x00" + lbBackendSG, false},
		"description with a NUL":   {"tcp\x008080\x0031762\x00x\x00" + lbcSharedDescription + "\x00sg\x00" + lbBackendSG, false},
		"other description":        {"tcp\x008080\x0031762\x00\x00sg\x00" + lbBackendSG, false},
		"to-port never declared":   {"tcp\x008080\x009000\x00" + lbcSharedDescription + "\x00sg\x00" + lbBackendSG, false},
		"from-port never declared": {"tcp\x0031000\x0031762\x00" + lbcSharedDescription + "\x00sg\x00" + lbBackendSG, false},
	} {
		if got := ev.ownsAtom(c.atom); got != c.want {
			t.Errorf("%s: ownsAtom = %t, want %t", name, got, c.want)
		}
	}
	if ev.endpointGroup(map[string]any{"tags": nil}) {
		t.Error("a group with no tags is no cluster's endpoint group")
	}
	for name, c := range map[string]struct {
		port string
		ok   bool
	}{
		"fractional": {"80.5", false}, "negative": {"-1", false}, "too large": {"65536", false},
		"named": {`"http"`, false}, "json null": {"null", true}, "max": {"65535", true},
	} {
		raw := json.RawMessage(c.port)
		if _, _, _, ok := lbcPermission(nil, &raw); ok != c.ok {
			t.Errorf("port %s: ok = %t, want %t", name, ok, c.ok)
		}
	}
	// No state, and a resource type the tier does not know.
	rc := &tfjson.ResourceChange{ProviderName: awsProv, Type: "aws_security_group"}
	if awsKubernetesOwnedRoots(rc, nil, nil, nil, ev) != nil {
		t.Error("no state index: must not fire")
	}
	rc.Type = "aws_instance"
	if awsKubernetesOwnedRoots(rc, nil, nil, &stateIndex{}, ev) != nil {
		t.Error("an unrecognised type: must not fire")
	}
	// The ingress side unreadable in the RECORDED view.
	plan := loadPlan(t, awsFixture)
	before(t, plan, sgNode)["ingress"] = "junk"
	assertDrift(t, withEvidence(t, ev)(onlyDrift(t, plan, sgNode)), true, "")
	// Nothing gained that needs the cluster: the tier leaves it to the back-reference tier.
	plan = loadPlan(t, awsFixture)
	a := after(t, plan, sgNode)
	var kept []any
	for _, e := range a["ingress"].([]any) {
		if e.(map[string]any)["description"] != lbcSharedDescription {
			kept = append(kept, e)
		}
	}
	a["ingress"] = kept
	assertDrift(t, withEvidence(t, ev)(onlyDrift(t, plan, sgNode)), false, ReasonAssignmentBackReference)
}

// TestKubernetesOwnedIsTheWeakestReason: a resource dismissed partly on cluster evidence is always
// LABELLED kubernetes_owned, never hidden under a firmer reason — the ruling requires it visible.
func TestKubernetesOwnedIsTheWeakestReason(t *testing.T) {
	for _, r := range []NormalizedReason{ReasonEmptyCollection, ReasonUndeclaredCollection, ReasonComputedAttribute,
		ReasonSensitivityOnly, ReasonAssignmentBackReference, ReasonInapplicableField} {
		if reasonStrength(ReasonKubernetesOwned) >= reasonStrength(r) {
			t.Errorf("kubernetes_owned must rank below %s", r)
		}
	}
}

// TestClusterEvidenceNeverIncreasesDrift pins the property packages/core/provisioner/drift.go relies
// on to read the cluster only when the schema-aware pass still drifted: evidence can only dismiss.
// It is checked against every fixture with the most permissive evidence this tier can be given.
func TestClusterEvidenceNeverIncreasesDrift(t *testing.T) {
	permissive := defaultReads()
	permissive.tgbs[0].ports = []tgbPort{{Port: 0}, {Protocol: strp("UDP")}, {}}
	ev := permissive.evidence(t)
	for name, file := range map[string]string{
		"azure fixture": "azure_refresh_noise.json", "drifted golden": "drifted.json", "in sync golden": "in_sync.json",
		"hetzner fabric": "hetzner_fabric_refresh.json", "aws fabric": awsFixture,
	} {
		t.Run(name, func(t *testing.T) {
			for _, schemas := range []*tfjson.ProviderSchemas{nil, loadSchemas(t, awsSchemas), loadSchemas(t, hetznerSchemas)} {
				base := AnalyzeWithSchemas(loadPlan(t, file), schemas)
				got := AnalyzeWithEvidence(loadPlan(t, file), schemas, ev)
				if got.Drifted > base.Drifted || got.Drifted+got.Normalized != base.Drifted+base.Normalized {
					t.Fatalf("drifted %d -> %d, examined %d -> %d", base.Drifted, got.Drifted,
						base.Drifted+base.Normalized, got.Drifted+got.Normalized)
				}
				nilEv := AnalyzeWithEvidence(loadPlan(t, file), schemas, nil)
				a, _ := json.Marshal(base)
				b, _ := json.Marshal(nilEv)
				if string(a) != string(b) {
					t.Fatalf("nil evidence changed the posture:\n%s\n%s", a, b)
				}
			}
		})
	}
}
