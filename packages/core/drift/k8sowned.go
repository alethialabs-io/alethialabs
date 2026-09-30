// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package drift

import (
	"encoding/json"
	"errors"
	"math"
	"strconv"
	"strings"

	tfjson "github.com/hashicorp/terraform-json"
)

// This file is the KUBERNETES-OWNED tier (ReasonKubernetesOwned).
//
// The shape it exists for, measured on #845 run 36717544116 (aws, dimension=floor,
// fabric_demo=true): once #5220's back-reference tier dismissed the template's own attachments,
// the ONE remaining drift was the EKS node security group's ingress, which had gained
//
//	tcp 8080-31762 from sg-05c00a67233505738, description "elbv2.k8s.aws/targetGroupBinding=shared"
//
// That is the AWS Load Balancer Controller (LBC) opening the nodes to its shared backend security
// group for a LoadBalancer Service the fabric demo placed (Online Boutique's frontend-external).
// Maintainer ruling 2026-09-30: such a rule is KUBERNETES-OWNED, not drift — reported under its own
// reason, still visible in the posture — but ONLY when it traces to a TargetGroupBinding that
// actually exists in the cluster. A rule that does not trace stays drift.
//
// WHAT THE LBC WRITES (aws-load-balancer-controller v3.5.0, pkg/networking/networking_manager.go):
//
//   - For every TargetGroupBinding with spec.networking, each ingress rule's peer × port becomes a
//     permission on the ENDPOINT security group of each target's ENI (computePermissionsForPeerPort).
//     A securityGroup peer gives a UserIdGroupPair from that group; the protocol is tcp unless the
//     port says UDP; a numeric port p gives p-p; a nil port gives 0-65535. A NAMED port is resolved
//     against pod container ports, which a TGB alone does not state.
//   - Every permission carries the label elbv2.k8s.aws/targetGroupBinding=shared, which is rendered
//     into the rule's description verbatim (buildIPPermissionDescriptionForLabels, one label, so
//     "key=value").
//   - In the default RESTRICTED mode (computeRestrictedIngressPermissionsPerSG) every permission
//     for one endpoint group that shares a protocol and a source group — across ALL bindings — is
//     merged into ONE rule from the minimum from-port to the maximum to-port, and a 0-0 permission
//     widens the merge to 0-65535. In UNRESTRICTED mode (--disable-restricted-sg-rules) each
//     permission is written as it is. Either way, a rule's from-port is some binding's from-port
//     and its to-port is some binding's to-port — which is exactly what owns() checks. It cannot
//     know which bindings reach which endpoint group, so it accepts any from/to pair the bindings
//     declare: never wider than [lowest declared, highest declared], which is what the controller
//     renders when every binding reaches the group.
//   - The endpoint group is the ENI's single group, or else the one tagged
//     kubernetes.io/cluster/<cluster> (resolveEndpointSGForENI). This tier requires that tag, with
//     this cluster's name, on the group in both views of state — so a rule on a group that is not
//     this cluster's endpoint group (an RDS group, a bastion's) is never dismissed, even if its
//     source and ports match a binding. The untagged single-group ENI is a stated miss: it stays
//     drift.
//
// WHY THIS CANNOT HIDE A REAL CHANGE. The description is REQUIRED and is NEVER sufficient: anyone
// holding ec2:AuthorizeSecurityGroupIngress can write that string. What makes a gained rule
// kubernetes-owned is that the cluster, read at scan time, holds a live TargetGroupBinding
// (not being deleted, whose serviceRef names a Service that exists and is not being deleted)
// whose networking names the rule's SOURCE group, protocol and port bounds. So:
//
//   - a rule from a group no binding names, a port outside what the bindings declare, a UDP rule
//     for a TCP binding, a binding that has been deleted (or is being deleted, or whose Service is
//     gone), or the description alone — each stays drift;
//   - a CIDR or prefix-list source is never kubernetes-owned here (the LBC writes CIDR rules for
//     ipBlock peers, but no run has shown one — a stated boundary, fail-closed);
//   - every RECORDED entry must survive and every other gained entry must still be declared by an
//     aws_security_group_rule exactly as the back-reference tier requires, so this tier widens
//     nothing that tier checks;
//   - without the evidence — no cluster access, a read error, an unparseable list — the tier does
//     not fire. A read error is an ERROR, never "no bindings": ParseClusterEvidence refuses a
//     document that is not a list rather than returning an empty set.
//
// What remains trusted is the cluster: someone who can create a TargetGroupBinding can make the LBC
// open a node port range, and this tier then reports that rule as kubernetes-owned — which is what
// it is. The rule is still named in the posture, under its own reason, so it is never silent.

// lbcSharedDescription is the description the LBC writes on every rule it manages:
// tgbNetworkingIPPermissionLabelKey "=" tgbNetworkingIPPermissionLabelValue.
const lbcSharedDescription = "elbv2.k8s.aws/targetGroupBinding=shared"

// clusterTagPrefix is the tag key prefix the LBC reads to pick an ENI's endpoint security group.
const clusterTagPrefix = "kubernetes.io/cluster/"

// maxPort is the top of the port space; the LBC renders "all ports" as 0-65535.
const maxPort = 65535

// ClusterEvidence is what the cluster says about the security-group rules its controllers own,
// read at scan time. It is built only by ParseClusterEvidence and consumed only by
// AnalyzeWithEvidence; its contents never reach a Posture (security-group ids and ports are not
// paths, and a Posture carries paths only).
//
// A nil *ClusterEvidence is the absence of evidence, and the kubernetes-owned tier then never fires.
type ClusterEvidence struct {
	// cluster is the Kubernetes cluster name the endpoint group's kubernetes.io/cluster/<name> tag
	// must carry.
	cluster string
	// ports maps "<protocol>\x00<source group id>" to the port bounds live bindings declare for it.
	ports map[string]portBounds
	// bindings counts the live bindings that declared at least one permission.
	bindings int
}

// portBounds are the from-ports and to-ports the bindings declare for one (protocol, source).
type portBounds struct {
	from map[int]struct{}
	to   map[int]struct{}
}

// Bindings reports how many live TargetGroupBindings contributed evidence — a count, safe to log.
func (e *ClusterEvidence) Bindings() int {
	if e == nil {
		return 0
	}
	return e.bindings
}

// owns reports whether a live binding accounts for an ingress rule of protocol proto from source
// group src over from-to, as the LBC renders its permissions.
func (e *ClusterEvidence) owns(proto, src string, from, to int) bool {
	b, ok := e.ports[proto+"\x00"+src]
	if !ok || from > to {
		return false
	}
	_, okF := b.from[from]
	_, okT := b.to[to]
	return okF && okT
}

// k8sList is the shape of `kubectl get <kind> -A -o json`. Items is a pointer so a document with
// no items key at all — not a list — is told apart from an empty list.
type k8sList[T any] struct {
	Items *[]T `json:"items"`
}

// k8sMeta is the object metadata this tier reads.
type k8sMeta struct {
	Namespace         string  `json:"namespace"`
	Name              string  `json:"name"`
	DeletionTimestamp *string `json:"deletionTimestamp"`
}

// live reports whether the object exists and is not being deleted.
func (m k8sMeta) live() bool {
	return m.Name != "" && m.DeletionTimestamp == nil
}

// k8sService is a Service as far as this tier reads it.
type k8sService struct {
	Metadata k8sMeta `json:"metadata"`
}

// k8sTGB is an elbv2.k8s.aws TargetGroupBinding as far as this tier reads it.
type k8sTGB struct {
	Metadata k8sMeta `json:"metadata"`
	Spec     struct {
		ServiceRef struct {
			Name string `json:"name"`
		} `json:"serviceRef"`
		Networking *struct {
			Ingress []struct {
				From []struct {
					SecurityGroup *struct {
						GroupID string `json:"groupID"`
					} `json:"securityGroup"`
				} `json:"from"`
				Ports []struct {
					Protocol *string          `json:"protocol"`
					Port     *json.RawMessage `json:"port"`
				} `json:"ports"`
			} `json:"ingress"`
		} `json:"networking"`
	} `json:"spec"`
}

// ParseClusterEvidence builds the kubernetes-owned tier's evidence from two cluster reads:
// `kubectl get targetgroupbindings.elbv2.k8s.aws -A -o json` and `kubectl get services -A -o json`.
// cluster is the Kubernetes cluster name (the EKS cluster name), which the endpoint security group's
// kubernetes.io/cluster/<name> tag must carry.
//
// It fails rather than guessing: an empty cluster name, or a document that does not decode as a
// list, is an error — so a failed or truncated read can never read as "the cluster has no
// bindings". A binding that is being deleted, whose Service does not exist, or whose networking
// this does not understand (a named port, an unknown protocol, an ipBlock peer) simply declares
// nothing for that part; it only ever keeps more as drift.
func ParseClusterEvidence(cluster string, tgbJSON, servicesJSON []byte) (*ClusterEvidence, error) {
	if strings.TrimSpace(cluster) == "" {
		return nil, errors.New("cluster evidence: no cluster name")
	}
	var svcs k8sList[k8sService]
	if err := json.Unmarshal(servicesJSON, &svcs); err != nil || svcs.Items == nil {
		return nil, errors.New("cluster evidence: the services read is not a list")
	}
	var tgbs k8sList[k8sTGB]
	if err := json.Unmarshal(tgbJSON, &tgbs); err != nil || tgbs.Items == nil {
		return nil, errors.New("cluster evidence: the targetgroupbindings read is not a list")
	}
	services := map[string]struct{}{}
	for _, s := range *svcs.Items {
		if s.Metadata.live() {
			services[s.Metadata.Namespace+"/"+s.Metadata.Name] = struct{}{}
		}
	}
	ev := &ClusterEvidence{cluster: cluster, ports: map[string]portBounds{}}
	for _, tgb := range *tgbs.Items {
		if !tgb.Metadata.live() || tgb.Spec.Networking == nil {
			continue
		}
		if _, ok := services[tgb.Metadata.Namespace+"/"+tgb.Spec.ServiceRef.Name]; !ok {
			continue
		}
		declared := false
		for _, rule := range tgb.Spec.Networking.Ingress {
			for _, peer := range rule.From {
				if peer.SecurityGroup == nil || peer.SecurityGroup.GroupID == "" {
					continue
				}
				// An ingress rule with NO ports declares nothing: in v3.5.0 the all-TCP permission
				// computePermissionsForTGBNetworking builds for it is assigned to a shadowed variable
				// and dropped, so the controller writes no rule for it either.
				for _, port := range rule.Ports {
					proto, from, tos, ok := lbcPermission(port.Protocol, port.Port)
					if !ok {
						continue
					}
					ev.add(proto, peer.SecurityGroup.GroupID, from, tos)
					declared = true
				}
			}
		}
		if declared {
			ev.bindings++
		}
	}
	return ev, nil
}

// add records one permission's bounds.
func (e *ClusterEvidence) add(proto, src string, from int, tos []int) {
	k := proto + "\x00" + src
	b, ok := e.ports[k]
	if !ok {
		b = portBounds{from: map[int]struct{}{}, to: map[int]struct{}{}}
		e.ports[k] = b
	}
	b.from[from] = struct{}{}
	for _, t := range tos {
		b.to[t] = struct{}{}
	}
}

// lbcPermission renders one NetworkingPort as the LBC does (computePermissionsForPeerPort): the
// protocol (nil or TCP is tcp, UDP is udp; anything else is refused rather than defaulted), the
// from-port, and the to-ports a rule built from it may end on. A nil port is 0-65535. A numeric
// port p is p-p, and p = 0 may also end on 65535, because the restricted merge widens a 0-0
// permission to all ports. A named port, or any other shape, is refused.
func lbcPermission(protocol *string, port *json.RawMessage) (proto string, from int, tos []int, ok bool) {
	switch {
	case protocol == nil, *protocol == "TCP":
		proto = "tcp"
	case *protocol == "UDP":
		proto = "udp"
	default:
		return "", 0, nil, false
	}
	if port == nil || string(*port) == "null" {
		return proto, 0, []int{maxPort}, true
	}
	var f float64
	if err := json.Unmarshal(*port, &f); err != nil || f != math.Trunc(f) || f < 0 || f > maxPort {
		return "", 0, nil, false
	}
	p := int(f)
	if p == 0 {
		return proto, 0, []int{0, maxPort}, true
	}
	return proto, p, []int{p}, true
}

// awsKubernetesOwnedRoots returns {"ingress"} when an aws security group's ingress only GAINED
// permissions, at least one of which a live TargetGroupBinding accounts for and every other of
// which an aws_security_group_rule in scope declares — or nil. See the file comment.
func awsKubernetesOwnedRoots(rc *tfjson.ResourceChange, before, after map[string]any, st *stateIndex, cluster *ClusterEvidence) map[string]struct{} {
	if cluster == nil || st == nil || !strings.HasSuffix(rc.ProviderName, awsProviderSuffix) || rc.Type != "aws_security_group" {
		return nil
	}
	sgID, ok := sameNonEmpty(before, after, "id")
	if !ok || !cluster.endpointGroup(before) || !cluster.endpointGroup(after) {
		return nil
	}
	prior, okB := sgElementAtoms(before["ingress"], sgID)
	now, okA := sgElementAtoms(after["ingress"], sgID)
	if !okB || !okA {
		return nil
	}
	sib := siblingScope{st: st, provider: rc.ProviderName, module: rc.ModuleAddress}
	declared := sib.declared("aws_security_group_rule", func(v map[string]any) []string {
		return sgRuleAtoms(v, sgID, "ingress")
	})
	for k := range prior {
		if _, ok := now[k]; !ok {
			return nil
		}
	}
	owned := 0
	for k := range now {
		if _, ok := prior[k]; ok {
			continue
		}
		if _, ok := declared[k]; ok {
			continue
		}
		if !cluster.ownsAtom(k) {
			return nil
		}
		owned++
	}
	if owned == 0 {
		return nil
	}
	return map[string]struct{}{"ingress": {}}
}

// endpointGroup reports whether a security group's tags name it this cluster's endpoint group:
// kubernetes.io/cluster/<cluster> = owned | shared, the filter the LBC itself applies.
func (e *ClusterEvidence) endpointGroup(values map[string]any) bool {
	tags, ok := values["tags"].(map[string]any)
	if !ok {
		return false
	}
	switch tags[clusterTagPrefix+e.cluster] {
	case "owned", "shared":
		return true
	}
	return false
}

// ownsAtom reports whether one permission atom (sgElementAtoms' rendering: protocol, from, to,
// description, source kind, source) is a rule a live binding accounts for.
func (e *ClusterEvidence) ownsAtom(atom string) bool {
	parts := strings.Split(atom, "\x00")
	if len(parts) != 6 || parts[3] != lbcSharedDescription || parts[4] != "sg" {
		return false
	}
	from, errF := strconv.Atoi(parts[1])
	to, errT := strconv.Atoi(parts[2])
	if errF != nil || errT != nil {
		return false
	}
	return e.owns(parts[0], parts[5], from, to)
}
