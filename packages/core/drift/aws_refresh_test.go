// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package drift

import (
	"encoding/json"
	"strings"
	"testing"

	tfjson "github.com/hashicorp/terraform-json"
)

// testdata/aws_fabric_refresh.json is the refresh-only plan of a freshly provisioned aws Fabric,
// rebuilt from #845 run 36717544116 (aws, dimension=floor, fabric_demo=true, job "Provision +
// verify + teardown (real cloud) (aws)"), whose drift re-prove read in_sync=false drifted=18
// normalized=17.
//
// CAPTURED from that run's t2-runner.log: every one of the 35 drifted addresses and every attribute
// delta with its before/after as the "Objects have changed outside of OpenTofu" render printed them
// (the policy ARNs, the security-group rules with their descriptions, ports and peers, the routes,
// the EIP association, the NACL subnets and ICMP fields); every sibling the tiers read, with its id,
// from the "Refreshing state... [id=...]" lines (21 policy attachments, 13 security-group rules, 2
// routes, 9 subnets, the NAT gateway); and the rule definitions from terraform-aws-eks v20.31.6 and
// the template's own additional rules, which those ids belong to.
//
// SCRUBBED: the AWS account id (-> 123456789012). PLACEHOLDERS, because the run never printed them:
// the VPC id, the EIP's public IP, the policy documents, and the "(N unchanged attributes hidden)"
// values, which are filled with plausible equal values on both sides.
//
// MASKS are computed with OpenTofu's algorithm (jsonstate.SensitiveAsBool over values plus the
// provider schema's marks) from testdata/aws_provider_schemas.json — `tofu providers schema -json`
// for hashicorp/aws 5.100.0, the run's lock (infra/templates/project/aws/.terraform.lock.hcl),
// trimmed to the 16 types used here. Only aws_acm_certificate.private_key is sensitive among them.
//
// The check that this is the real shape: against this fixture and those schemas, the analyzer as it
// stood before this change reports EXACTLY run 36717544116's posture line — drifted=18 and
// normalized=17, the same addresses, the same attribute lists, the same reasons.

const (
	awsFixture = "aws_fabric_refresh.json"
	awsSchemas = "aws_provider_schemas.json"
	awsProv    = "registry.opentofu.org/hashicorp/aws"

	roleBedrock    = "module.irsa_ai_bedrock[0].aws_iam_role.this[0]"
	attBedrockAWS  = `module.irsa_ai_bedrock[0].aws_iam_role_policy_attachment.this["aws_managed_policy"]`
	sgCluster      = "module.eks[0].module.eks.aws_security_group.cluster[0]"
	sgNode         = "module.eks[0].module.eks.aws_security_group.node[0]"
	ruleCluster443 = `module.eks[0].module.eks.aws_security_group_rule.cluster["ingress_nodes_443"]`
	rtPublic       = "module.common_vpc[0].aws_route_table.public[0]"
	routePublic    = "module.common_vpc[0].aws_route.public_internet_gateway[0]"
	eipNAT         = "module.common_vpc[0].aws_eip.nat[0]"
	natGW          = "module.common_vpc[0].aws_nat_gateway.this[0]"
	defaultNACL    = "module.common_vpc[0].aws_default_network_acl.this[0]"
	subnetDB0      = "module.common_vpc[0].aws_subnet.database[0]"

	sgClusterID = "sg-017634f593e0dc573"
	sgNodeID    = "sg-0a98d5504b800c3f1"
	lbBackendSG = "sg-05c00a67233505738"
)

// withAWSSchemas analyzes plan the way the runner does once the schema-free pass drifted.
func withAWSSchemas(t *testing.T) func(*tfjson.Plan) *Posture {
	t.Helper()
	doc := loadSchemas(t, awsSchemas)
	return func(p *tfjson.Plan) *Posture { return AnalyzeWithSchemas(p, doc) }
}

// statePrior returns the fixture's prior_state resource at addr in any module, failing if absent.
func statePrior(t *testing.T, plan *tfjson.Plan, addr string) *tfjson.StateResource {
	t.Helper()
	var find func(m *tfjson.StateModule) *tfjson.StateResource
	find = func(m *tfjson.StateModule) *tfjson.StateResource {
		for _, r := range m.Resources {
			if r.Address == addr {
				return r
			}
		}
		for _, c := range m.ChildModules {
			if r := find(c); r != nil {
				return r
			}
		}
		return nil
	}
	if r := find(plan.PriorState.Values.RootModule); r != nil {
		return r
	}
	t.Fatalf("fixture has no prior_state resource %s", addr)
	return nil
}

// addState appends a managed resource to the prior_state module at module ("" is the root),
// creating that module when the fixture has none.
func addState(plan *tfjson.Plan, module string, r *tfjson.StateResource) {
	root := plan.PriorState.Values.RootModule
	if module == "" {
		root.Resources = append(root.Resources, r)
		return
	}
	var find func(m *tfjson.StateModule) *tfjson.StateModule
	find = func(m *tfjson.StateModule) *tfjson.StateModule {
		if m.Address == module {
			return m
		}
		for _, c := range m.ChildModules {
			if f := find(c); f != nil {
				return f
			}
		}
		return nil
	}
	if m := find(root); m != nil {
		m.Resources = append(m.Resources, r)
		return
	}
	root.ChildModules = append(root.ChildModules, &tfjson.StateModule{Address: module, Resources: []*tfjson.StateResource{r}})
}

// before and after return the fixture drift entry's before/after objects at addr.
func before(t *testing.T, plan *tfjson.Plan, addr string) map[string]any {
	t.Helper()
	return driftEntry(t, plan, addr).Change.Before.(map[string]any)
}

func after(t *testing.T, plan *tfjson.Plan, addr string) map[string]any {
	t.Helper()
	return driftEntry(t, plan, addr).Change.After.(map[string]any)
}

// TestAWSFabricRefreshKeepsOnlyThePlacementsLoadBalancerRule is #845 run 36717544116 stated as
// the fixed verdict. Of the 18 drifted resources, 17 were the template's own attachments reported
// back on their containers and are now dismissed, each naming its attributes and its reason. ONE
// stays: the node security group's ingress, because it holds a rule no resource in state declares —
// tcp 8080-31762 from sg-05c00a67233505738, description "elbv2.k8s.aws/targetGroupBinding=shared".
// That is the AWS Load Balancer Controller opening the nodes to its shared backend security group
// for a LoadBalancer Service (Online Boutique's frontend-external, placed by the fabric demo). It
// is a real change to a managed security group, made outside OpenTofu, and nothing in state can
// prove it benign — so it is reported.
func TestAWSFabricRefreshKeepsOnlyThePlacementsLoadBalancerRule(t *testing.T) {
	p := withAWSSchemas(t)(loadPlan(t, awsFixture))
	if p.Drifted != 1 || p.Details[0].Address != sgNode {
		t.Fatalf("want exactly %s drifted, got drifted=%d %+v", sgNode, p.Drifted, p.Details)
	}
	if got := strings.Join(p.Details[0].Attributes, ","); got != "egress,ingress" {
		t.Errorf("%s: Attributes = %s, want egress,ingress", sgNode, got)
	}
	if p.Normalized != 34 {
		t.Fatalf("Normalized = %d, want 34 (%+v)", p.Normalized, p.NormalizedDetails)
	}
	const (
		mpa  = "managed_policy_arns"
		mpaT = "managed_policy_arns,tags"
		ac   = "attachment_count"
		acT  = "attachment_count,tags"
	)
	nacl := "egress[0].icmp_code,egress[0].icmp_type,egress[1].icmp_code,egress[1].icmp_type," +
		"ingress[0].icmp_code,ingress[0].icmp_type,ingress[1].icmp_code,ingress[1].icmp_type,subnet_ids"
	want := map[string]struct {
		reason NormalizedReason
		attrs  string
	}{
		// The tiers this change adds.
		roleBedrock: {ReasonAssignmentBackReference, mpaT},
		"module.irsa_alethia_agent[0].aws_iam_role.this[0]":                                               {ReasonAssignmentBackReference, mpaT},
		"module.irsa_fluentbit_cloudwatch[0].aws_iam_role.this[0]":                                        {ReasonAssignmentBackReference, mpaT},
		"module.irsa_karpenter[0].aws_iam_role.this[0]":                                                   {ReasonAssignmentBackReference, mpaT},
		"module.s3_bucket_irsa_role[0].aws_iam_role.this[0]":                                              {ReasonAssignmentBackReference, mpaT},
		"module.eks[0].module.eks.aws_iam_role.this[0]":                                                   {ReasonAssignmentBackReference, mpa},
		"module.eks[0].module.iam_assumable_role_admin_aws_load_balancer_controller.aws_iam_role.this[0]": {ReasonAssignmentBackReference, mpaT},
		"module.eks[0].module.iam_assumable_role_admin_secrets_operator.aws_iam_role.this[0]":             {ReasonAssignmentBackReference, mpaT},
		"module.eks[0].module.iam_assumable_role_external_dns.aws_iam_role.this[0]":                       {ReasonAssignmentBackReference, mpaT},
		"module.eks[0].module.irsa-ebs-csi.aws_iam_role.this[0]":                                          {ReasonAssignmentBackReference, mpaT},
		"module.eks[0].module.vpc_cni_irsa.aws_iam_role.this[0]":                                          {ReasonAssignmentBackReference, mpaT},
		`module.eks[0].module.eks.module.eks_managed_node_group["eks_workers"].aws_iam_role.this[0]`:      {ReasonAssignmentBackReference, mpa},
		sgCluster: {ReasonAssignmentBackReference, "egress,ingress"},
		rtPublic:  {ReasonAssignmentBackReference, "route"},
		"module.common_vpc[0].aws_route_table.private[0]": {ReasonAssignmentBackReference, "route"},
		eipNAT:      {ReasonAssignmentBackReference, "association_id,network_interface,private_dns,private_ip"},
		defaultNACL: {ReasonInapplicableField, nacl},
		// What the run already dismissed, unchanged.
		"aws_iam_policy.irsa_ai_bedrock_custom[0]":                {ReasonComputedAttribute, acT},
		"aws_iam_policy.irsa_ai_bedrock_s3[0]":                    {ReasonComputedAttribute, acT},
		"aws_iam_policy.irsa_alethia_agent[0]":                    {ReasonComputedAttribute, acT},
		"aws_iam_policy.irsa_karpenter[0]":                        {ReasonComputedAttribute, acT},
		"module.acm[0].aws_acm_certificate.cf_alias":              {ReasonComputedAttribute, "not_after,not_before,renewal_eligibility,status,tags"},
		"module.common_vpc[0].aws_default_route_table.default[0]": {ReasonEmptyCollection, "propagating_vgws"},
		natGW: {ReasonEmptyCollection, "secondary_allocation_ids"},
		"module.eks[0].aws_iam_policy.aws_load_balancer_controller":                                         {ReasonComputedAttribute, acT},
		"module.eks[0].aws_iam_policy.external_dns":                                                         {ReasonComputedAttribute, acT},
		"module.eks[0].aws_iam_policy.secrets_operator":                                                     {ReasonComputedAttribute, acT},
		"module.eks[0].aws_iam_policy.vpc_cni_subnet_discovery":                                             {ReasonComputedAttribute, ac},
		`module.eks[0].module.eks.aws_eks_access_policy_association.this["cluster_creator_admin"]`:          {ReasonEmptyCollection, "access_scope[0].namespaces"},
		"module.eks[0].module.eks.aws_iam_policy.cluster_encryption[0]":                                     {ReasonComputedAttribute, ac},
		"module.eks[0].module.eks.aws_iam_policy.custom[0]":                                                 {ReasonComputedAttribute, ac},
		"module.eks[0].module.vpc_cni_irsa.aws_iam_policy.vpc_cni[0]":                                       {ReasonComputedAttribute, acT},
		`module.eks[0].module.eks.module.eks_managed_node_group["eks_workers"].aws_eks_node_group.this[0]`:  {ReasonEmptyCollection, "labels"},
		`module.eks[0].module.eks.module.eks_managed_node_group["eks_workers"].aws_launch_template.this[0]`: {ReasonEmptyCollection, "security_group_names"},
	}
	for _, n := range p.NormalizedDetails {
		w, ok := want[n.Address]
		if !ok {
			t.Errorf("unexpected dismissal %s", n.Address)
			continue
		}
		if n.Reason != w.reason {
			t.Errorf("%s: Reason = %q, want %q", n.Address, n.Reason, w.reason)
		}
		if got := strings.Join(n.Attributes, ","); got != w.attrs {
			t.Errorf("%s: Attributes = %s, want exactly %s", n.Address, got, w.attrs)
		}
	}
}

// TestAWSNodeGroupSecurityGroupIsInSyncWithoutTheLoadBalancerRule is the counterfactual that
// proves the node security group stays drift for the Load Balancer Controller's rule and for
// nothing else: remove that one element and the whole Fabric reads in sync.
func TestAWSNodeGroupSecurityGroupIsInSyncWithoutTheLoadBalancerRule(t *testing.T) {
	plan := loadPlan(t, awsFixture)
	a := after(t, plan, sgNode)
	var kept []any
	for _, e := range a["ingress"].([]any) {
		if !strings.HasPrefix(e.(map[string]any)["description"].(string), "elbv2.k8s.aws/") {
			kept = append(kept, e)
		}
	}
	if len(kept) != len(a["ingress"].([]any))-1 {
		t.Fatalf("expected exactly one load-balancer-controller rule in the fixture")
	}
	a["ingress"] = kept
	p := withAWSSchemas(t)(plan)
	if !p.InSync || p.Normalized != 35 {
		t.Fatalf("want in sync with 35 dismissed, got drifted=%d normalized=%d %+v", p.Drifted, p.Normalized, p.Details)
	}
}

// TestAWSWithoutSchemasFailsClosed pins the schema-free first pass: the back-references need no
// schema, but the EIP's private_dns is only dismissible as a computed-only attribute, so without
// the schema the EIP stays drift alongside the server-set policy counters and certificate fields.
// That pass drifting is what makes the runner fetch the schemas at all.
func TestAWSWithoutSchemasFailsClosed(t *testing.T) {
	p := Analyze(loadPlan(t, awsFixture))
	if p.Drifted != 14 || p.Normalized != 21 {
		t.Fatalf("drifted=%d normalized=%d, want 14 and 21: %+v", p.Drifted, p.Normalized, p.Details)
	}
	for _, d := range p.Details {
		switch {
		case d.Address == eipNAT, d.Address == sgNode, d.Type == "aws_iam_policy", d.Type == "aws_acm_certificate":
		default:
			t.Errorf("unexpected drift without schemas: %s %v", d.Address, d.Attributes)
		}
	}
}

// TestAWSDismissalsCarryNoValues extends Table F to the aws dismissals: the posture carries paths,
// never values — no ARN, id, address, CIDR or rule description from the fixture may appear in it.
func TestAWSDismissalsCarryNoValues(t *testing.T) {
	p := withAWSSchemas(t)(loadPlan(t, awsFixture))
	if p.Normalized != 34 {
		t.Fatalf("Normalized = %d, want 34 — a value check over fewer dismissals proves less", p.Normalized)
	}
	b, err := json.Marshal(p)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	for _, v := range []string{
		"arn:aws", "123456789012", "AmazonBedrockFullAccess", "subnet-", "sg-0", "eni-", "eipassoc-", "eipalloc-",
		"nat-0", "igw-", "rtb-", "acl-", "0.0.0.0/0", "10.0.3.10", "ec2.internal", "Node groups to cluster API",
		"elbv2.k8s.aws",
	} {
		if strings.Contains(string(b), v) {
			t.Errorf("posture leaks value %q", v)
		}
	}
}

// awsNarrowings runs one resource's adversarial table: the unmodified fixture must dismiss target
// under reason (the control — without it every row below could pass for the wrong reason), and each
// row changes ONE thing, after which target must be neither dismissed nor lost.
func awsNarrowings(t *testing.T, target string, reason NormalizedReason, cases map[string]func(t *testing.T, plan *tfjson.Plan)) {
	t.Helper()
	analyze := withAWSSchemas(t)
	t.Run("control: the fixture resource is dismissed", func(t *testing.T) {
		p := analyze(loadPlan(t, awsFixture))
		for _, d := range p.NormalizedDetails {
			if d.Address == target {
				if d.Reason != reason {
					t.Fatalf("%s dismissed as %s, want %s", target, d.Reason, reason)
				}
				return
			}
		}
		t.Fatalf("%s was not dismissed", target)
	})
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			plan := loadPlan(t, awsFixture)
			mutate(t, plan)
			p := analyze(plan)
			for _, d := range p.NormalizedDetails {
				if d.Address == target {
					t.Fatalf("%s was dismissed (%s) — this narrowing must keep it as drift", target, d.Reason)
				}
			}
			for _, d := range p.Details {
				if d.Address == target {
					return
				}
			}
			t.Fatalf("%s is neither dismissed nor drifted", target)
		})
	}
}

// ── Table M — the aws back-reference tier: each narrowing alone keeps the delta as drift ──────

func TestTableM_RolePolicyAttachmentNarrowings(t *testing.T) {
	gain := func(t *testing.T, plan *tfjson.Plan, arn string) {
		a := after(t, plan, roleBedrock)
		a["managed_policy_arns"] = append(a["managed_policy_arns"].([]any), arn)
	}
	awsNarrowings(t, roleBedrock, ReasonAssignmentBackReference, map[string]func(*testing.T, *tfjson.Plan){
		"no prior_state — no evidence of any attachment": func(_ *testing.T, plan *tfjson.Plan) {
			plan.PriorState = nil
		},
		"a policy attached OUT-OF-BAND — AdministratorAccess, attached by no resource in state": func(t *testing.T, plan *tfjson.Plan) {
			gain(t, plan, "arn:aws:iam::aws:policy/AdministratorAccess")
		},
		"a recorded policy was DETACHED": func(t *testing.T, plan *tfjson.Plan) {
			before(t, plan, roleBedrock)["managed_policy_arns"] = []any{"arn:aws:iam::aws:policy/ReadOnlyAccess"}
		},
		"the attachment names a DIFFERENT role": func(t *testing.T, plan *tfjson.Plan) {
			statePrior(t, plan, attBedrockAWS).AttributeValues["role"] = "some-other-role"
		},
		"the attachment lives in a DIFFERENT module instance": func(t *testing.T, plan *tfjson.Plan) {
			att := statePrior(t, plan, attBedrockAWS)
			moved := *att
			moved.Address = `module.other.aws_iam_role_policy_attachment.x`
			att.AttributeValues = map[string]any{"role": "unrelated", "policy_arn": "arn:aws:iam::aws:policy/Unrelated"}
			addState(plan, "module.other", &moved)
		},
		"the attachment is served by a DIFFERENT provider address": func(t *testing.T, plan *tfjson.Plan) {
			statePrior(t, plan, attBedrockAWS).ProviderName = "registry.opentofu.org/somefork/aws"
		},
		"the attachment is a data source, not a managed resource": func(t *testing.T, plan *tfjson.Plan) {
			statePrior(t, plan, attBedrockAWS).Mode = tfjson.DataResourceMode
		},
		"the attachment holds the ARN LIVE but RECORDED another": func(t *testing.T, plan *tfjson.Plan) {
			live := statePrior(t, plan, attBedrockAWS).AttributeValues
			rec := map[string]any{"id": live["id"], "role": live["role"], "policy_arn": "arn:aws:iam::aws:policy/ReadOnlyAccess"}
			plan.ResourceDrift = append(plan.ResourceDrift, &tfjson.ResourceChange{
				Address: attBedrockAWS, ModuleAddress: "module.irsa_ai_bedrock[0]", Mode: tfjson.ManagedResourceMode,
				Type: "aws_iam_role_policy_attachment", ProviderName: awsProv,
				Change: &tfjson.Change{Actions: tfjson.Actions{tfjson.ActionUpdate}, Before: rec, After: live},
			})
		},
		"the role's name changed": func(t *testing.T, plan *tfjson.Plan) {
			after(t, plan, roleBedrock)["name"] = "renamed"
		},
		"a real tag change rides along": func(t *testing.T, plan *tfjson.Plan) {
			after(t, plan, roleBedrock)["tags"] = map[string]any{"owner": "someone-else"}
		},
		"the plan marks managed_policy_arns sensitive": func(t *testing.T, plan *tfjson.Plan) {
			driftEntry(t, plan, roleBedrock).Change.AfterSensitive = map[string]any{"managed_policy_arns": []any{true}}
		},
		"managed_policy_arns gained an EMPTY entry": func(t *testing.T, plan *tfjson.Plan) {
			gain(t, plan, "")
		},
	})
}

func TestTableM_SecurityGroupRuleNarrowings(t *testing.T) {
	elem := func(t *testing.T, plan *tfjson.Plan, dir string) map[string]any {
		return after(t, plan, sgCluster)[dir].([]any)[0].(map[string]any)
	}
	awsNarrowings(t, sgCluster, ReasonAssignmentBackReference, map[string]func(*testing.T, *tfjson.Plan){
		"a rule opened OUT-OF-BAND — ssh from anywhere": func(t *testing.T, plan *tfjson.Plan) {
			a := after(t, plan, sgCluster)
			a["ingress"] = append(a["ingress"].([]any), map[string]any{
				"cidr_blocks": []any{"0.0.0.0/0"}, "description": "", "from_port": 22.0, "ipv6_cidr_blocks": []any{},
				"prefix_list_ids": []any{}, "protocol": "tcp", "security_groups": []any{}, "self": false, "to_port": 22.0,
			})
		},
		"a declared rule WIDENED — its port range": func(t *testing.T, plan *tfjson.Plan) {
			elem(t, plan, "ingress")["to_port"] = 65535.0
		},
		"a declared rule's PROTOCOL changed to all traffic": func(t *testing.T, plan *tfjson.Plan) {
			elem(t, plan, "ingress")["protocol"] = "-1"
		},
		"a declared rule's DESCRIPTION changed": func(t *testing.T, plan *tfjson.Plan) {
			elem(t, plan, "ingress")["description"] = "edited"
		},
		"a CIDR added to a declared rule": func(t *testing.T, plan *tfjson.Plan) {
			elem(t, plan, "ingress")["cidr_blocks"] = []any{"0.0.0.0/0"}
		},
		"the peer group swapped for one not in state": func(t *testing.T, plan *tfjson.Plan) {
			elem(t, plan, "ingress")["security_groups"] = []any{lbBackendSG}
		},
		"the rule resource is for the OTHER direction": func(t *testing.T, plan *tfjson.Plan) {
			statePrior(t, plan, ruleCluster443).AttributeValues["type"] = "egress"
		},
		"the rule resource is for a DIFFERENT security group": func(t *testing.T, plan *tfjson.Plan) {
			statePrior(t, plan, ruleCluster443).AttributeValues["security_group_id"] = sgNodeID
		},
		"a recorded rule was REVOKED": func(t *testing.T, plan *tfjson.Plan) {
			before(t, plan, sgCluster)["egress"] = []any{map[string]any{
				"cidr_blocks": []any{"10.0.0.0/8"}, "description": "", "from_port": 0.0, "ipv6_cidr_blocks": []any{},
				"prefix_list_ids": []any{}, "protocol": "-1", "security_groups": []any{}, "self": false, "to_port": 0.0,
			}}
		},
		"an element carrying a field this tier does not know": func(t *testing.T, plan *tfjson.Plan) {
			elem(t, plan, "ingress")["extra"] = "x"
		},
		"a fractional port": func(t *testing.T, plan *tfjson.Plan) {
			elem(t, plan, "egress")["from_port"] = 1025.5
		},
	})
	// The one POSITIVE row the fixture cannot express: the provider's Read merges every permission
	// sharing (protocol, ports, description) into ONE element, so two rule resources can surface
	// as a single element. Comparing atoms, not elements, is what keeps that dismissible.
	t.Run("two rule resources merged into one element by the Read are still dismissed", func(t *testing.T) {
		plan := loadPlan(t, awsFixture)
		elem(t, plan, "ingress")["cidr_blocks"] = []any{"10.0.0.0/16"}
		addState(plan, "module.eks[0].module.eks", &tfjson.StateResource{
			Address: `module.eks[0].module.eks.aws_security_group_rule.cluster["vpc_443"]`, Mode: tfjson.ManagedResourceMode,
			Type: "aws_security_group_rule", ProviderName: awsProv, AttributeValues: map[string]any{
				"cidr_blocks": []any{"10.0.0.0/16"}, "description": "Node groups to cluster API", "from_port": 443.0,
				"protocol": "6", "security_group_id": sgClusterID, "self": false, "to_port": 443.0, "type": "ingress",
			},
		})
		assertDrift(t, withAWSSchemas(t)(onlyDrift(t, plan, sgCluster)), false, ReasonAssignmentBackReference)
	})
}

func TestTableM_RouteNarrowings(t *testing.T) {
	route := func(t *testing.T, plan *tfjson.Plan) map[string]any {
		return after(t, plan, rtPublic)["route"].([]any)[0].(map[string]any)
	}
	awsNarrowings(t, rtPublic, ReasonAssignmentBackReference, map[string]func(*testing.T, *tfjson.Plan){
		"a route to a target NO aws_route states": func(t *testing.T, plan *tfjson.Plan) {
			route(t, plan)["gateway_id"] = "igw-0attacker0000000"
		},
		"the default route REDIRECTED through an ENI": func(t *testing.T, plan *tfjson.Plan) {
			route(t, plan)["network_interface_id"] = "eni-0attacker0000000"
		},
		"a different destination": func(t *testing.T, plan *tfjson.Plan) {
			route(t, plan)["cidr_block"] = "10.99.0.0/16"
		},
		"the aws_route is for ANOTHER table": func(t *testing.T, plan *tfjson.Plan) {
			statePrior(t, plan, routePublic).AttributeValues["route_table_id"] = "rtb-0another0000000"
		},
		"a recorded route was REMOVED": func(t *testing.T, plan *tfjson.Plan) {
			before(t, plan, rtPublic)["route"] = []any{map[string]any{"cidr_block": "10.1.0.0/16", "vpc_peering_connection_id": "pcx-1"}}
		},
		"a route element carrying a field this tier does not know": func(t *testing.T, plan *tfjson.Plan) {
			route(t, plan)["extra"] = "x"
		},
		"a route with no destination": func(t *testing.T, plan *tfjson.Plan) {
			route(t, plan)["cidr_block"] = ""
		},
	})
}

func TestTableM_EIPNarrowings(t *testing.T) {
	awsNarrowings(t, eipNAT, ReasonAssignmentBackReference, map[string]func(*testing.T, *tfjson.Plan){
		"associated with an ENI that is NOT the NAT gateway's": func(t *testing.T, plan *tfjson.Plan) {
			after(t, plan, eipNAT)["network_interface"] = "eni-0attacker0000000"
		},
		"RE-associated: the recorded EIP was already associated": func(t *testing.T, plan *tfjson.Plan) {
			before(t, plan, eipNAT)["association_id"] = "eipassoc-0previous00000"
		},
		"associated with an INSTANCE": func(t *testing.T, plan *tfjson.Plan) {
			after(t, plan, eipNAT)["instance"] = "i-0attacker0000000"
		},
		"a private IP other than the NAT gateway's": func(t *testing.T, plan *tfjson.Plan) {
			after(t, plan, eipNAT)["private_ip"] = "10.0.3.99"
		},
		"the NAT gateway was created on ANOTHER allocation": func(t *testing.T, plan *tfjson.Plan) {
			before(t, plan, natGW)["allocation_id"] = "eipalloc-0another000000"
			after(t, plan, natGW)["allocation_id"] = "eipalloc-0another000000"
			statePrior(t, plan, natGW).AttributeValues["allocation_id"] = "eipalloc-0another000000"
		},
		"the NAT gateway RECORDED a different association than it holds live": func(t *testing.T, plan *tfjson.Plan) {
			before(t, plan, natGW)["association_id"] = "eipassoc-0previous00000"
		},
		"the EIP's allocation_id disagrees with its id": func(t *testing.T, plan *tfjson.Plan) {
			after(t, plan, eipNAT)["allocation_id"] = "eipalloc-0another000000"
		},
		"association_id is not a string": func(t *testing.T, plan *tfjson.Plan) {
			after(t, plan, eipNAT)["association_id"] = 1.0
		},
	})
}

func TestTableM_DefaultNACLNarrowings(t *testing.T) {
	gain := func(t *testing.T, plan *tfjson.Plan, id string) {
		a := after(t, plan, defaultNACL)
		a["subnet_ids"] = append(a["subnet_ids"].([]any), id)
	}
	awsNarrowings(t, defaultNACL, ReasonInapplicableField, map[string]func(*testing.T, *tfjson.Plan){
		"a gained subnet NOT in state": func(t *testing.T, plan *tfjson.Plan) {
			gain(t, plan, "subnet-0attacker0000000")
		},
		"a gained subnet in ANOTHER VPC": func(t *testing.T, plan *tfjson.Plan) {
			statePrior(t, plan, subnetDB0).AttributeValues["vpc_id"] = "vpc-0another000000"
		},
		"a gained subnet CLAIMED by a managed network ACL, in any module": func(t *testing.T, plan *tfjson.Plan) {
			addState(plan, "module.elsewhere", &tfjson.StateResource{
				Address: "module.elsewhere.aws_network_acl.db", Mode: tfjson.ManagedResourceMode, Type: "aws_network_acl",
				ProviderName: awsProv, AttributeValues: map[string]any{"subnet_ids": []any{"subnet-0142206ce8d21d122"}},
			})
		},
		"a gained subnet CLAIMED by a NACL association": func(t *testing.T, plan *tfjson.Plan) {
			addState(plan, "", &tfjson.StateResource{
				Address: "aws_network_acl_association.db", Mode: tfjson.ManagedResourceMode, Type: "aws_network_acl_association",
				ProviderName: awsProv, AttributeValues: map[string]any{"subnet_id": "subnet-0142206ce8d21d122"},
			})
		},
		"a recorded subnet MOVED OFF the default NACL": func(t *testing.T, plan *tfjson.Plan) {
			b := before(t, plan, defaultNACL)
			b["subnet_ids"] = append(b["subnet_ids"].([]any), "subnet-0movedaway000000")
		},
		"the NACL's VPC changed": func(t *testing.T, plan *tfjson.Plan) {
			after(t, plan, defaultNACL)["vpc_id"] = "vpc-0another000000"
		},
		"an ICMP rule's type moved null -> 0": func(t *testing.T, plan *tfjson.Plan) {
			for _, side := range []map[string]any{before(t, plan, defaultNACL), after(t, plan, defaultNACL)} {
				side["egress"].([]any)[0].(map[string]any)["protocol"] = "1"
			}
		},
		"an icmp field moved 0 -> null (the reverse direction)": func(t *testing.T, plan *tfjson.Plan) {
			b, a := before(t, plan, defaultNACL), after(t, plan, defaultNACL)
			b["egress"], a["egress"] = a["egress"], b["egress"]
		},
		"an icmp field moved null -> 8": func(t *testing.T, plan *tfjson.Plan) {
			after(t, plan, defaultNACL)["ingress"].([]any)[1].(map[string]any)["icmp_type"] = 8.0
		},
		"a rule's action changed alongside": func(t *testing.T, plan *tfjson.Plan) {
			after(t, plan, defaultNACL)["ingress"].([]any)[1].(map[string]any)["action"] = "deny"
		},
		"a rule ADDED": func(t *testing.T, plan *tfjson.Plan) {
			a := after(t, plan, defaultNACL)
			a["ingress"] = append(a["ingress"].([]any), map[string]any{"action": "allow", "protocol": "6", "rule_no": 99.0})
		},
		"a rule element that is not an object": func(t *testing.T, plan *tfjson.Plan) {
			before(t, plan, defaultNACL)["ingress"].([]any)[0] = "x"
		},
		"a different provider (a fork publishing the same type)": func(t *testing.T, plan *tfjson.Plan) {
			driftEntry(t, plan, defaultNACL).ProviderName = "registry.opentofu.org/somefork/aws"
		},
	})
	// A custom (non-default) network ACL gets the icmp dismissal too, and ONLY that one: its
	// subnet_ids are never a back-reference.
	t.Run("aws_network_acl: the icmp delta alone is dismissed", func(t *testing.T) {
		plan := onlyDrift(t, loadPlan(t, awsFixture), defaultNACL)
		rc := plan.ResourceDrift[0]
		rc.Type = "aws_network_acl"
		rc.Change.After.(map[string]any)["subnet_ids"] = rc.Change.Before.(map[string]any)["subnet_ids"]
		assertDrift(t, withAWSSchemas(t)(plan), false, ReasonInapplicableField)
	})
	t.Run("aws_network_acl: gained subnets stay drift", func(t *testing.T) {
		plan := onlyDrift(t, loadPlan(t, awsFixture), defaultNACL)
		plan.ResourceDrift[0].Type = "aws_network_acl"
		assertDrift(t, withAWSSchemas(t)(plan), true, "")
	})
}

// ── Table N — the fail-closed edges of the aws tiers, called directly ─────────────────────────
//
// Table M drives the tiers through Analyze from the captured fixture. These rows reach the shapes
// that fixture cannot express — a malformed element, a missing view, a non-string where a string
// belongs — so every refusal branch is exercised, and the positive rows that are not in the
// fixture (a peer group naming the group itself, a recorded entry that survives) prove those
// branches are not blanket refusals.

// awsObj is a managed hashicorp/aws state object of type typ in module mod.
func awsObj(typ, mod string, values map[string]any) stateObject {
	return stateObject{mode: tfjson.ManagedResourceMode, typ: typ, provider: awsProv, module: mod, values: values}
}

func TestTableN_SiblingScopeNeedsBothViews(t *testing.T) {
	st := &stateIndex{
		refreshed: map[string]stateObject{"a.x": awsObj("t", "m", map[string]any{"k": "v"})},
		recorded:  map[string]stateObject{},
	}
	sib := siblingScope{st: st, provider: awsProv, module: "m"}
	if got := sib.declared("t", func(v map[string]any) []string { return []string{v["k"].(string)} }); len(got) != 0 {
		t.Fatalf("a sibling absent from the RECORDED view declared %v", got)
	}
}

func TestTableN_SecurityGroupEdges(t *testing.T) {
	rule := func(extra map[string]any) map[string]any {
		r := map[string]any{"security_group_id": "sg-1", "type": "ingress", "protocol": "tcp", "from_port": 1.0, "to_port": 2.0}
		for k, v := range extra {
			r[k] = v
		}
		return r
	}
	st := sameViews(map[string]stateObject{
		"r.self": awsObj("aws_security_group_rule", "m", rule(map[string]any{"source_security_group_id": "sg-1"})),
		"r.cidr": awsObj("aws_security_group_rule", "m", rule(map[string]any{"cidr_blocks": []any{"10.0.0.0/8"}})),
	})
	sib := siblingScope{st: st, provider: awsProv, module: "m"}
	elem := func(extra map[string]any) map[string]any {
		e := map[string]any{"protocol": "tcp", "from_port": 1.0, "to_port": 2.0}
		for k, v := range extra {
			e[k] = v
		}
		return e
	}
	t.Run("control: a peer group naming the group ITSELF is self, and a recorded rule survives", func(t *testing.T) {
		b := map[string]any{"id": "sg-1", "ingress": []any{elem(map[string]any{"cidr_blocks": []any{"10.0.0.0/8"}})}, "egress": nil}
		a := map[string]any{"id": "sg-1", "ingress": []any{elem(map[string]any{"cidr_blocks": []any{"10.0.0.0/8"}, "security_groups": []any{"sg-1"}})}, "egress": nil}
		if got := awsSecurityGroupRules(b, a, sib); strings.Join(got, ",") != "ingress" {
			t.Fatalf("got %v, want [ingress]", got)
		}
	})
	if got := awsSecurityGroupRules(map[string]any{"id": "sg-1"}, map[string]any{"id": "sg-2"}, sib); got != nil {
		t.Errorf("a changed group id: got %v", got)
	}
	for name, v := range map[string]any{
		"not a list":                   "x",
		"an element that is no map":    []any{"x"},
		"a CIDR list holding a bool":   []any{elem(map[string]any{"cidr_blocks": []any{true}})},
		"self is not a bool":           []any{elem(map[string]any{"self": "yes"})},
		"a protocol that is no string": []any{map[string]any{"protocol": 6.0, "from_port": 1.0, "to_port": 2.0}},
	} {
		if _, ok := sgElementAtoms(v, "sg-1"); ok {
			t.Errorf("sgElementAtoms accepted %s", name)
		}
	}
	if got, ok := sgElementAtoms([]any{elem(nil)}, "sg-1"); !ok || len(got) != 1 {
		t.Fatalf("a sourceless element: got (%v, %t), want one undeclarable atom", got, ok)
	}
	b := map[string]any{"id": "sg-1", "ingress": nil}
	if got := awsSecurityGroupRules(b, map[string]any{"id": "sg-1", "ingress": []any{elem(nil)}}, sib); got != nil {
		t.Errorf("a sourceless permission was dismissed: %v", got)
	}
	for name, r := range map[string]map[string]any{
		"another direction":        rule(map[string]any{"type": "egress"}),
		"a CIDR list holding junk": rule(map[string]any{"cidr_blocks": "10.0.0.0/8"}),
		"no protocol":              rule(map[string]any{"protocol": nil}),
	} {
		if got := sgRuleAtoms(r, "sg-1", "ingress"); got != nil {
			t.Errorf("sgRuleAtoms(%s) = %v, want nil", name, got)
		}
	}
}

func TestTableN_RouteEdges(t *testing.T) {
	st := sameViews(map[string]stateObject{
		"r.junk": awsObj("aws_route", "m", map[string]any{"route_table_id": "rtb-1", "gateway_id": 1.0}),
	})
	sib := siblingScope{st: st, provider: awsProv, module: "m"}
	route := map[string]any{"cidr_block": "0.0.0.0/0", "gateway_id": "igw-1"}
	if got := awsRouteTableRoutes(map[string]any{"id": "rtb-1", "route": nil}, map[string]any{"id": "rtb-1", "route": []any{route}}, sib); got != nil {
		t.Errorf("an unreadable aws_route vouched for a route: %v", got)
	}
	if got := awsRouteTableRoutes(map[string]any{"id": "rtb-1"}, map[string]any{"id": "rtb-2"}, sib); got != nil {
		t.Errorf("a changed table id: got %v", got)
	}
	for name, v := range map[string]any{"not a list": "x", "an element that is no map": []any{"x"}} {
		if _, ok := routeElementKeys(v); ok {
			t.Errorf("routeElementKeys accepted %s", name)
		}
	}
	if got, ok := routeElementKeys(nil); !ok || len(got) != 0 {
		t.Errorf("routeElementKeys(nil) = (%v, %t), want the empty set", got, ok)
	}
	if got := awsRouteTableRoutes(map[string]any{"id": "rtb-1", "route": "x"}, map[string]any{"id": "rtb-1", "route": nil}, sib); got != nil {
		t.Errorf("an unreadable recorded route set: got %v", got)
	}
}

func TestTableN_EIPAndNACLEdges(t *testing.T) {
	sib := siblingScope{st: sameViews(nil), provider: awsProv}
	if got := awsEIPNATAssociation(map[string]any{"id": "eipalloc-1"}, map[string]any{"id": "eipalloc-2"}, sib); got != nil {
		t.Errorf("a changed allocation id: got %v", got)
	}
	// Through Analyze an instance appearing is already a differing leaf no tier dismisses; the
	// function refuses it on its own too, so its contract does not lean on that.
	nat := sameViews(map[string]stateObject{"n": awsObj("aws_nat_gateway", "", map[string]any{
		"allocation_id": "eipalloc-1", "association_id": "eipassoc-1", "network_interface_id": "eni-1", "private_ip": "10.0.0.1",
	})})
	eipB := map[string]any{"id": "eipalloc-1", "instance": ""}
	eipA := map[string]any{"id": "eipalloc-1", "instance": "", "association_id": "eipassoc-1", "network_interface": "eni-1", "private_ip": "10.0.0.1"}
	if got := awsEIPNATAssociation(eipB, eipA, siblingScope{st: nat, provider: awsProv}); len(got) != 3 {
		t.Fatalf("control: got %v, want the three NAT-proven attributes", got)
	}
	eipA["instance"] = "i-1"
	if got := awsEIPNATAssociation(eipB, eipA, siblingScope{st: nat, provider: awsProv}); got != nil {
		t.Errorf("an EIP now on an instance: got %v", got)
	}
	if got := awsDefaultNACLSubnets(map[string]any{"vpc_id": "vpc-1", "subnet_ids": "x"}, map[string]any{"vpc_id": "vpc-1"}, sib); got != nil {
		t.Errorf("unreadable subnet_ids: got %v", got)
	}
	rc := &tfjson.ResourceChange{ProviderName: awsProv, Type: "aws_default_network_acl"}
	rule := func(icmp any) map[string]any {
		return map[string]any{"protocol": "-1", "rule_no": 100.0, "icmp_code": icmp, "icmp_type": icmp}
	}
	b := map[string]any{"egress": []any{rule(0.0)}, "ingress": []any{rule(nil)}}
	a := map[string]any{"egress": []any{rule(0.0)}, "ingress": []any{rule(0.0)}}
	if got := awsInapplicableRoots(rc, b, a); len(got) != 1 {
		t.Fatalf("an unchanged egress beside a changed ingress: got %v, want only ingress", got)
	}
	if !icmpProtocol("") || icmpProtocol("-1") || !icmpProtocol("ICMPv6") {
		t.Error("icmpProtocol: an empty protocol must count as ICMP, -1 must not, and names must match case-insensitively")
	}
}

func TestTableN_ValueShapes(t *testing.T) {
	if _, ok := stringOrNull(1.0); ok {
		t.Error("stringOrNull accepted a number")
	}
	if _, ok := stringList(map[string]any{}); ok {
		t.Error("stringList accepted a map")
	}
	for _, v := range []any{1.5, "1", float64(maxExactInt)} {
		if _, ok := integral(v); ok {
			t.Errorf("integral accepted %#v", v)
		}
	}
	if s, ok := integral(-1.0); !ok || s != "-1" {
		t.Errorf("integral(-1) = (%q, %t), want (\"-1\", true) — ICMP \"any\" is a real port value", s, ok)
	}
	if _, ok := routeKey(func(string) any { return true }); ok {
		t.Error("routeKey accepted a bool field")
	}
	if _, ok := gainedStrings(nil, "x"); ok {
		t.Error("gainedStrings accepted a non-list after")
	}
	if gainedOnly(map[string]struct{}{"a": {}}, map[string]struct{}{"a": {}}, nil) {
		t.Error("gainedOnly accepted a delta that gained nothing")
	}
	if !gainedOnly(map[string]struct{}{"a": {}}, map[string]struct{}{"a": {}, "b": {}}, map[string]struct{}{"b": {}}) {
		t.Error("gainedOnly refused a declared gain beside a surviving entry")
	}
}
