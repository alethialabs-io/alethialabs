// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package drift

import (
	"math"
	"reflect"
	"sort"
	"strconv"
	"strings"

	tfjson "github.com/hashicorp/terraform-json"
)

// This file is the hashicorp/aws half of the ASSIGNMENT BACK-REFERENCE tier
// (ReasonAssignmentBackReference), plus the aws-only INAPPLICABLE FIELD tier
// (ReasonInapplicableField).
//
// The shape it exists for, measured on #845 run 36717544116 (aws, dimension=floor,
// fabric_demo=true — every placement converged and the vcluster tier proved, then the drift
// re-prove read in_sync=false drifted=18), and on the plain aws floor soak of 2026-08-28
// (demos/proofs/aws/20260828T190408Z, drift_baseline) with the same set:
//
//	aws_iam_role.*                  managed_policy_arns  null/[] -> [the attached policy ARNs]
//	aws_security_group.cluster|node ingress, egress      []      -> [the aws_security_group_rule rules]
//	aws_route_table.private|public  route                []      -> [the aws_route routes]
//	aws_eip.nat                     association_id, network_interface, private_ip  null -> the NAT's
//	aws_default_network_acl.this    subnet_ids           [5]     -> [9]: the subnets created after it
//	                                ingress/egress[*].icmp_code|icmp_type  null -> 0, protocol "-1"
//
// Every one is the same mechanism as hetzner's, with a different owner. The template (and every
// terraform-aws-modules module it calls) writes the relationship from a SEPARATE resource —
// aws_iam_role_policy_attachment, aws_security_group_rule, aws_route, aws_nat_gateway, and for the
// default NACL, AWS itself, which associates every subnet no NACL claims with its VPC's default one.
// OpenTofu creates the container first and records it empty, then creates the attachment; nothing
// re-reads the container in that apply. Its Read reports the attachment back on every later
// refresh, and a refresh-only plan never writes state, so every AWS environment reads out of sync
// on day zero, permanently.
//
// ignore_changes cannot fix it (it governs planned changes, not the refresh deltas resource_drift is
// made of — the vpc module already sets `ignore_changes = [subnet_ids]` on the default NACL, and the
// delta is there anyway). Declaring the relationship inline instead (managed_policy_arns, inline
// ingress/egress, inline route) is the pattern the provider documents as CONFLICTING with the
// attachment resources, and would have to be done inside third-party modules.
//
// WHY THIS CANNOT HIDE A REAL CHANGE. As for hcloud, the dismissal is not "these attribute names
// are noisy". Each rule proves the gained entries are EXACTLY what attachment resources in the SAME
// state declare, and proves it against both views of state:
//
//   - Nothing recorded may be lost or altered: every before entry survives into after. A detached
//     policy, a revoked rule, a removed route, a re-associated EIP, a subnet moved off the default
//     NACL all fail here.
//   - Every GAINED entry must be declared by a managed attachment of the same provider, in the SAME
//     module instance, whose recorded value (the last apply) AND refreshed value (live) both declare
//     it. A policy attached out-of-band, a rule opened out-of-band (any source, port, protocol or
//     description that no aws_security_group_rule states), a route to a target no aws_route states,
//     an EIP associated with an ENI that is not the NAT gateway's — none is declared, so each stays
//     drift. An attachment added out-of-band to state cannot happen (state is ours); one whose live
//     value no longer declares the entry cannot vouch for it.
//   - At least one entry must be gained, so an unchanged-but-reported attribute is never dismissed
//     vacuously.
//
// The SAME-MODULE requirement is the aws-specific narrowing. hcloud ids are globally unique numbers;
// an IAM role NAME is chosen by a person and is only unique per account, so a template holding two
// aws provider aliases (two accounts) could otherwise let an attachment in one account vouch for a
// same-named role in the other. Every attachment the run measured sits in the module instance of the
// resource it attaches to (the terraform-aws-modules layout), so this costs nothing measured.
// Evidence that VETOES a dismissal (a NACL claiming a subnet) is read from every module and either
// view, because there more evidence can only mean less dismissed.
//
// What is recognised is a CLOSED list of (type, attribute, attachment type) triples; everything else
// on aws falls through to the other tiers exactly as before. In particular aws_vpc_security_group_
// ingress_rule/egress_rule are NOT recognised as rule sources: nothing measured uses them, and their
// field mapping onto an inline rule (null ports for protocol -1, one CIDR per rule) is unverified — so
// a security group they populate stays drift until a run shows the real shape.

// awsProviderSuffix identifies the AWS provider under either registry host.
const awsProviderSuffix = "/hashicorp/aws"

// awsBackReferenceRoots dispatches an aws resource to the one rule that knows its type, and returns
// the top-level attributes whose whole delta that rule verified, or nil.
func awsBackReferenceRoots(rc *tfjson.ResourceChange, before, after map[string]any, st *stateIndex) []string {
	sib := siblingScope{st: st, provider: rc.ProviderName, module: rc.ModuleAddress}
	switch rc.Type {
	case "aws_iam_role":
		return awsRolePolicyAttachments(before, after, sib)
	case "aws_security_group":
		return awsSecurityGroupRules(before, after, sib)
	case "aws_route_table":
		return awsRouteTableRoutes(before, after, sib)
	case "aws_eip":
		return awsEIPNATAssociation(before, after, sib)
	case "aws_default_network_acl":
		return awsDefaultNACLSubnets(before, after, sib)
	}
	return nil
}

// siblingScope is where an aws back-reference may look for the attachment that vouches for it: the
// same state, the same provider address, the same module instance.
type siblingScope struct {
	st       *stateIndex
	provider string
	module   string
}

// holds reports whether obj is a managed resource of type typ inside this scope.
func (s siblingScope) holds(obj stateObject, typ string) bool {
	return obj.mode == tfjson.ManagedResourceMode && obj.typ == typ && obj.provider == s.provider &&
		obj.module == s.module && obj.values != nil
}

// declared returns every key that keys yields for an in-scope resource of type typ in BOTH views: a
// key counts only when that resource's recorded value and its refreshed value each yield it. A
// resource missing from either view declares nothing.
func (s siblingScope) declared(typ string, keys func(map[string]any) []string) map[string]struct{} {
	out := map[string]struct{}{}
	for addr, live := range s.st.refreshed {
		if !s.holds(live, typ) {
			continue
		}
		rec, ok := s.st.recorded[addr]
		if !ok || !s.holds(rec, typ) {
			continue
		}
		recorded := map[string]struct{}{}
		for _, k := range keys(rec.values) {
			recorded[k] = struct{}{}
		}
		for _, k := range keys(live.values) {
			if _, ok := recorded[k]; ok {
				out[k] = struct{}{}
			}
		}
	}
	return out
}

// claimedAnywhere returns every key that keys yields for a managed resource of type typ in ANY
// module, under ANY provider, in EITHER view. It is only ever used to VETO a dismissal, where
// reading wider can only keep more as drift.
func (s siblingScope) claimedAnywhere(typ string, keys func(map[string]any) []string) map[string]struct{} {
	out := map[string]struct{}{}
	for _, view := range []map[string]stateObject{s.st.recorded, s.st.refreshed} {
		for _, obj := range view {
			if obj.mode != tfjson.ManagedResourceMode || obj.typ != typ || obj.values == nil {
				continue
			}
			for _, k := range keys(obj.values) {
				out[k] = struct{}{}
			}
		}
	}
	return out
}

// awsRolePolicyAttachments verifies that a role's managed_policy_arns only GAINED ARNs, each one
// the policy_arn of an aws_iam_role_policy_attachment in scope whose role is this role's name.
//
// managed_policy_arns is Optional+Computed and deprecated; the role's Read fills it from
// ListAttachedRolePolicies (provider v5.100.0, internal/service/iam/role.go), which is why every
// role the template attaches policies to reports them on the first refresh after create.
func awsRolePolicyAttachments(before, after map[string]any, sib siblingScope) []string {
	name, ok := sameNonEmpty(before, after, "name")
	if !ok {
		return nil
	}
	gained, ok := gainedStrings(before["managed_policy_arns"], after["managed_policy_arns"])
	if !ok {
		return nil
	}
	declared := sib.declared("aws_iam_role_policy_attachment", func(v map[string]any) []string {
		role, _ := v["role"].(string)
		arn, _ := v["policy_arn"].(string)
		if role != name || arn == "" {
			return nil
		}
		return []string{arn}
	})
	if !allIn(gained, declared) {
		return nil
	}
	return []string{"managed_policy_arns"}
}

// awsSecurityGroupRules verifies, per direction, that a security group's inline ingress/egress only
// GAINED permissions, each one stated by an aws_security_group_rule in scope for this group and
// direction.
//
// The comparison is on PERMISSION ATOMS, not on the inline elements, because the provider's Read
// regroups permissions: it merges every permission sharing (protocol, from, to, description) into
// one element (securityGroupIPPermGather, internal/service/ec2/vpc_security_group.go), so one
// element can hold what two rule resources declared. An atom is one (protocol, from, to,
// description, source) — a source being one CIDR, one IPv6 CIDR, one prefix list, one peer group,
// or self — so the regrouping cannot make a declared rule and a live one look different, and any
// change to any part of a permission is a new atom nothing declares.
func awsSecurityGroupRules(before, after map[string]any, sib siblingScope) []string {
	sgID, ok := sameNonEmpty(before, after, "id")
	if !ok {
		return nil
	}
	var roots []string
	for _, dir := range []string{"egress", "ingress"} {
		if reflect.DeepEqual(before[dir], after[dir]) {
			continue
		}
		prior, okB := sgElementAtoms(before[dir], sgID)
		now, okA := sgElementAtoms(after[dir], sgID)
		if !okB || !okA {
			continue
		}
		declared := sib.declared("aws_security_group_rule", func(v map[string]any) []string {
			return sgRuleAtoms(v, sgID, dir)
		})
		if gainedOnly(prior, now, declared) {
			roots = append(roots, dir)
		}
	}
	return roots
}

// sgElementKeys is the closed field set of one inline ingress/egress element (provider v5.100.0).
// An element carrying any other field is a shape this tier does not know, so it fails closed.
var sgElementKeys = map[string]bool{
	"cidr_blocks": true, "description": true, "from_port": true, "ipv6_cidr_blocks": true,
	"prefix_list_ids": true, "protocol": true, "security_groups": true, "self": true, "to_port": true,
}

// sgElementAtoms decomposes a security group's inline ingress or egress list into permission atoms.
// null is the empty list. A peer group equal to sgID is the group itself, i.e. self.
func sgElementAtoms(v any, sgID string) (map[string]struct{}, bool) {
	out := map[string]struct{}{}
	if v == nil {
		return out, true
	}
	list, ok := v.([]any)
	if !ok {
		return nil, false
	}
	for _, e := range list {
		m, ok := e.(map[string]any)
		if !ok {
			return nil, false
		}
		for k := range m {
			if !sgElementKeys[k] {
				return nil, false
			}
		}
		head, ok := permissionHead(m["protocol"], m["from_port"], m["to_port"], m["description"])
		if !ok {
			return nil, false
		}
		n := len(out)
		for _, src := range []struct{ kind, key string }{
			{"cidr4", "cidr_blocks"}, {"cidr6", "ipv6_cidr_blocks"}, {"pl", "prefix_list_ids"}, {"sg", "security_groups"},
		} {
			vals, ok := stringList(m[src.key])
			if !ok {
				return nil, false
			}
			for _, s := range vals {
				if src.kind == "sg" && s == sgID {
					out[head+"self"] = struct{}{}
					continue
				}
				out[head+src.kind+"\x00"+s] = struct{}{}
			}
		}
		switch m["self"] {
		case true:
			out[head+"self"] = struct{}{}
		case false, nil:
		default:
			return nil, false
		}
		if len(out) == n {
			// A permission with no source at all is not something any rule resource states; give
			// it an atom nothing can declare, so it can only ever stay drift.
			out[head+"none"] = struct{}{}
		}
	}
	return out, true
}

// sgRuleAtoms returns the permission atoms one aws_security_group_rule declares for security group
// sgID in direction dir, or nil when it is for another group or direction or is unreadable.
func sgRuleAtoms(v map[string]any, sgID, dir string) []string {
	if g, _ := v["security_group_id"].(string); g != sgID {
		return nil
	}
	if t, _ := v["type"].(string); t != dir {
		return nil
	}
	head, ok := permissionHead(v["protocol"], v["from_port"], v["to_port"], v["description"])
	if !ok {
		return nil
	}
	var out []string
	for _, src := range []struct{ kind, key string }{
		{"cidr4", "cidr_blocks"}, {"cidr6", "ipv6_cidr_blocks"}, {"pl", "prefix_list_ids"},
	} {
		vals, ok := stringList(v[src.key])
		if !ok {
			return nil
		}
		for _, s := range vals {
			out = append(out, head+src.kind+"\x00"+s)
		}
	}
	switch src, _ := v["source_security_group_id"].(string); {
	case src == sgID:
		out = append(out, head+"self")
	case src != "":
		out = append(out, head+"sg\x00"+src)
	}
	if self, _ := v["self"].(bool); self {
		out = append(out, head+"self")
	}
	return out
}

// sgProtocolAliases maps the protocol spellings the provider can hold for one IANA protocol onto a
// single one. Its protocolForValue (vpc_security_group.go) stores "all" as "-1" and the numbers of
// the named protocols by name; the raw API value is either. Only IDENTICAL protocols are merged.
var sgProtocolAliases = map[string]string{
	"all": "-1", "6": "tcp", "17": "udp", "1": "icmp", "58": "icmpv6",
}

// permissionHead renders the (protocol, from, to, description) part of an atom, or false when any
// part is not a shape a security-group permission holds. A null description is the empty one.
func permissionHead(protocol, from, to, description any) (string, bool) {
	p, ok := protocol.(string)
	if !ok || p == "" {
		return "", false
	}
	p = strings.ToLower(p)
	if alias, ok := sgProtocolAliases[p]; ok {
		p = alias
	}
	f, okF := integral(from)
	t, okT := integral(to)
	d, okD := stringOrNull(description)
	if !okF || !okT || !okD {
		return "", false
	}
	return p + "\x00" + f + "\x00" + t + "\x00" + d + "\x00", true
}

// awsRouteTableRoutes verifies that a route table's inline route set only GAINED routes, each one an
// aws_route in scope for this table with the same destination and the same target.
func awsRouteTableRoutes(before, after map[string]any, sib siblingScope) []string {
	rtID, ok := sameNonEmpty(before, after, "id")
	if !ok {
		return nil
	}
	prior, okB := routeElementKeys(before["route"])
	now, okA := routeElementKeys(after["route"])
	if !okB || !okA {
		return nil
	}
	declared := sib.declared("aws_route", func(v map[string]any) []string {
		if id, _ := v["route_table_id"].(string); id != rtID {
			return nil
		}
		k, ok := routeKey(func(field string) any {
			switch field {
			case "cidr_block":
				return v["destination_cidr_block"]
			case "ipv6_cidr_block":
				return v["destination_ipv6_cidr_block"]
			default:
				return v[field]
			}
		})
		if !ok {
			return nil
		}
		return []string{k}
	})
	if !gainedOnly(prior, now, declared) {
		return nil
	}
	return []string{"route"}
}

// routeDestinations and routeTargets are the inline route element's fields (provider v5.100.0,
// aws_route_table.route), split by role. The element has exactly these; an aws_route names the
// first two destinations destination_cidr_block and destination_ipv6_cidr_block.
var (
	routeDestinations = []string{"cidr_block", "destination_prefix_list_id", "ipv6_cidr_block"}
	routeTargets      = []string{
		"carrier_gateway_id", "core_network_arn", "egress_only_gateway_id", "gateway_id", "local_gateway_id",
		"nat_gateway_id", "network_interface_id", "transit_gateway_id", "vpc_endpoint_id", "vpc_peering_connection_id",
	}
)

// routeElementKeys renders each inline route element as a routeKey. null is the empty set.
func routeElementKeys(v any) (map[string]struct{}, bool) {
	out := map[string]struct{}{}
	if v == nil {
		return out, true
	}
	list, ok := v.([]any)
	if !ok {
		return nil, false
	}
	known := map[string]bool{}
	for _, f := range append(append([]string{}, routeDestinations...), routeTargets...) {
		known[f] = true
	}
	for _, e := range list {
		m, ok := e.(map[string]any)
		if !ok {
			return nil, false
		}
		for k := range m {
			if !known[k] {
				return nil, false
			}
		}
		k, ok := routeKey(func(field string) any { return m[field] })
		if !ok {
			return nil, false
		}
		out[k] = struct{}{}
	}
	return out, true
}

// routeKey renders a route as every destination and target field in a fixed order, null read as "".
// A route must name a destination and a target; one that names neither is not a route this tier
// will compare.
func routeKey(get func(field string) any) (string, bool) {
	var b strings.Builder
	dest, target := false, false
	for i, fields := range [][]string{routeDestinations, routeTargets} {
		for _, f := range fields {
			s, ok := stringOrNull(get(f))
			if !ok {
				return "", false
			}
			if s != "" {
				if i == 0 {
					dest = true
				} else {
					target = true
				}
			}
			b.WriteString(f + "=" + s + "\x00")
		}
	}
	return b.String(), dest && target
}

// awsEIPNATAssociation verifies that an EIP went from unassociated to associated with EXACTLY the
// ENI, private IP and association of an aws_nat_gateway in scope that was created on this EIP's
// allocation. Returns the three attributes that proves, or nil.
//
// private_dns is deliberately not among them: nothing in the NAT gateway's state states it. It is
// Computed-only in the provider schema, so the computed_attribute tier dismisses it when the schema
// is supplied, and without the schema the EIP stays drift.
func awsEIPNATAssociation(before, after map[string]any, sib siblingScope) []string {
	alloc, ok := sameNonEmpty(before, after, "id")
	if !ok {
		return nil
	}
	if a, _ := stringOrNull(after["allocation_id"]); a != "" && a != alloc {
		return nil
	}
	// Before: associated with nothing. An EIP moved from one ENI to another is not this shape.
	for _, k := range []string{"association_id", "instance", "network_interface", "private_ip"} {
		if s, ok := stringOrNull(before[k]); !ok || s != "" {
			return nil
		}
	}
	// After: associated with an ENI, not an instance.
	if s, ok := stringOrNull(after["instance"]); !ok || s != "" {
		return nil
	}
	tuple := make([]string, 0, 3)
	for _, k := range []string{"association_id", "network_interface", "private_ip"} {
		s, ok := after[k].(string)
		if !ok || s == "" {
			return nil
		}
		tuple = append(tuple, s)
	}
	want := alloc + "\x00" + strings.Join(tuple, "\x00")
	declared := sib.declared("aws_nat_gateway", func(v map[string]any) []string {
		parts := make([]string, 0, 4)
		for _, k := range []string{"allocation_id", "association_id", "network_interface_id", "private_ip"} {
			s, _ := v[k].(string)
			parts = append(parts, s)
		}
		return []string{strings.Join(parts, "\x00")}
	})
	if _, ok := declared[want]; !ok {
		return nil
	}
	return []string{"association_id", "network_interface", "private_ip"}
}

// awsDefaultNACLSubnets verifies that a VPC's default network ACL only GAINED subnets, each one a
// subnet in scope in the SAME VPC that no network ACL and no NACL association anywhere in state
// claims. AWS associates exactly those subnets with the VPC's default NACL ("each subnet ... is
// automatically associated with the default network ACL" unless associated with another), which is
// the configured intent: the template declares no NACL for them. The default NACL resource is
// created with the VPC, before most subnets exist, so its recorded subnet_ids is a prefix of the
// eventual set.
func awsDefaultNACLSubnets(before, after map[string]any, sib siblingScope) []string {
	vpc, ok := sameNonEmpty(before, after, "vpc_id")
	if !ok {
		return nil
	}
	gained, ok := gainedStrings(before["subnet_ids"], after["subnet_ids"])
	if !ok {
		return nil
	}
	subnets := sib.declared("aws_subnet", func(v map[string]any) []string {
		id, _ := v["id"].(string)
		if in, _ := v["vpc_id"].(string); in != vpc || id == "" {
			return nil
		}
		return []string{id}
	})
	claimed := sib.claimedAnywhere("aws_network_acl", func(v map[string]any) []string {
		ids, _ := stringList(v["subnet_ids"])
		return ids
	})
	for k := range sib.claimedAnywhere("aws_network_acl_association", func(v map[string]any) []string {
		id, _ := v["subnet_id"].(string)
		return []string{id}
	}) {
		claimed[k] = struct{}{}
	}
	for _, id := range gained {
		if _, ok := subnets[id]; !ok {
			return nil
		}
		if _, ok := claimed[id]; ok {
			return nil
		}
	}
	return []string{"subnet_ids"}
}

// awsInapplicableRoots is the INAPPLICABLE FIELD tier (ReasonInapplicableField): it returns the
// ingress/egress roots of an aws network ACL whose ENTIRE delta is icmp_code/icmp_type going from
// null to 0 on rules whose protocol is not ICMP.
//
// Measured on #845 run 36717544116: the vpc module's default NACL rules are protocol "-1" (all
// traffic) with no icmp fields in config, so state records null; the provider's Read sets icmp_code
// and icmp_type from the API's IcmpTypeCode whenever it is present (flattenNetworkACLEntry,
// internal/service/ec2/vpc_network_acl.go), and it reads 0/0. The fields are ignored by AWS for
// every protocol except ICMP (1) and ICMPv6 (58) — IcmpTypeCode is "required if specifying protocol
// 1 (ICMP) or protocol 58 (ICMPv6)" and has no meaning otherwise — so no traffic decision differs.
//
// Narrowings: the provider is hashicorp/aws and the type a network ACL; the list lengths are equal;
// each after element must be matched one-to-one by a before element that is IDENTICAL once only its
// null icmp fields are read as 0, and only for a non-ICMP protocol. So an ICMP rule's type or code
// changing, any other field changing, a rule added or removed, or 0 -> null all stay drift.
func awsInapplicableRoots(rc *tfjson.ResourceChange, before, after map[string]any) map[string]struct{} {
	if !strings.HasSuffix(rc.ProviderName, awsProviderSuffix) {
		return nil
	}
	if rc.Type != "aws_default_network_acl" && rc.Type != "aws_network_acl" {
		return nil
	}
	var out map[string]struct{}
	for _, dir := range []string{"egress", "ingress"} {
		if reflect.DeepEqual(before[dir], after[dir]) {
			continue
		}
		prior, okB := before[dir].([]any)
		now, okA := after[dir].([]any)
		if !okB || !okA || len(prior) != len(now) || !icmpNullToZeroOnly(prior, now) {
			continue
		}
		if out == nil {
			out = map[string]struct{}{}
		}
		out[dir] = struct{}{}
	}
	return out
}

// icmpNullToZeroOnly reports whether now is prior with, at most, null icmp fields of non-ICMP rules
// read as 0 — matched one-to-one, in any order, since both are sets.
func icmpNullToZeroOnly(prior, now []any) bool {
	used := make([]bool, len(now))
	for _, p := range prior {
		m, ok := p.(map[string]any)
		if !ok {
			return false
		}
		want := map[string]any{}
		for k, v := range m {
			want[k] = v
		}
		proto, _ := m["protocol"].(string)
		if !icmpProtocol(proto) {
			for _, k := range []string{"icmp_code", "icmp_type"} {
				if v, present := m[k]; present && v == nil {
					want[k] = 0.0
				}
			}
		}
		matched := false
		for i, n := range now {
			if !used[i] && reflect.DeepEqual(want, n) {
				used[i], matched = true, true
				break
			}
		}
		if !matched {
			return false
		}
	}
	return true
}

// icmpProtocol reports whether a network ACL protocol is one for which icmp_type/icmp_code apply.
// An empty or unreadable protocol is treated as ICMP, so it can never be dismissed.
func icmpProtocol(p string) bool {
	switch strings.ToLower(p) {
	case "1", "icmp", "58", "icmpv6", "":
		return true
	}
	return false
}

// sameNonEmpty returns the string at key when it is non-empty and identical on both sides.
func sameNonEmpty(before, after map[string]any, key string) (string, bool) {
	b, okB := before[key].(string)
	a, okA := after[key].(string)
	if !okB || !okA || a == "" || a != b {
		return "", false
	}
	return a, true
}

// stringOrNull reads a string attribute, with null as "". Anything else is not a string.
func stringOrNull(v any) (string, bool) {
	switch t := v.(type) {
	case nil:
		return "", true
	case string:
		return t, true
	}
	return "", false
}

// stringList reads a list or set of non-empty strings, with null as the empty list.
func stringList(v any) ([]string, bool) {
	if v == nil {
		return nil, true
	}
	list, ok := v.([]any)
	if !ok {
		return nil, false
	}
	out := make([]string, 0, len(list))
	for _, e := range list {
		s, ok := e.(string)
		if !ok || s == "" {
			return nil, false
		}
		out = append(out, s)
	}
	return out, true
}

// gainedStrings returns the entries of the string set after that before lacks, when before lost
// nothing and after gained at least one. Sorted, for a deterministic walk.
func gainedStrings(before, after any) ([]string, bool) {
	b, okB := stringList(before)
	a, okA := stringList(after)
	if !okB || !okA {
		return nil, false
	}
	now := map[string]struct{}{}
	for _, s := range a {
		now[s] = struct{}{}
	}
	prior := map[string]struct{}{}
	for _, s := range b {
		if _, ok := now[s]; !ok {
			return nil, false
		}
		prior[s] = struct{}{}
	}
	var out []string
	for s := range now {
		if _, ok := prior[s]; !ok {
			out = append(out, s)
		}
	}
	sort.Strings(out)
	return out, len(out) > 0
}

// gainedOnly reports whether now kept every key of prior, added at least one, and every added key
// is declared.
func gainedOnly(prior, now, declared map[string]struct{}) bool {
	for k := range prior {
		if _, ok := now[k]; !ok {
			return false
		}
	}
	added := 0
	for k := range now {
		if _, ok := prior[k]; ok {
			continue
		}
		if _, ok := declared[k]; !ok {
			return false
		}
		added++
	}
	return added > 0
}

// allIn reports whether every entry of list is in set.
func allIn(list []string, set map[string]struct{}) bool {
	for _, s := range list {
		if _, ok := set[s]; !ok {
			return false
		}
	}
	return true
}

// integral renders a port number, decoded from plan JSON as float64, as its decimal string. A
// fractional or out-of-range value is not a port and reports false.
func integral(v any) (string, bool) {
	f, ok := v.(float64)
	if !ok || f != math.Trunc(f) || math.Abs(f) >= maxExactInt {
		return "", false
	}
	return strconv.FormatInt(int64(f), 10), true
}
