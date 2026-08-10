// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloud

import (
	"fmt"
	"net"
	"strings"

	"github.com/alethialabs-io/alethialabs/packages/core/manifests"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// The validation seam ProviderTfvars never had.
//
// ProviderTfvars returns map[string]interface{} and NO error, so no provider can refuse a
// value: `orDefault` only substitutes on an empty string, it never parses. Every out-of-range
// number the canvas or the CLI can express therefore rides straight into a tfvar, and the user
// discovers the problem either at plan (a template `validation` block) or — worse — mid-apply,
// from the cluster API, with half a stack standing.
//
// CloudProvider.ValidateConfig is that seam. It is deliberately a SIBLING of ProviderTfvars
// rather than a new return value on it: ProviderTfvars is called from destroy, drift and state
// import too, and those paths must keep working on a stack that was applied with a bad value
// (see the call-site comment in provisioner/deploy.go).
//
// Two hard rules govern everything in this file:
//
//  1. Every rule must be STRICTLY NARROWER than what the templates already accept. This gate is
//     fail-closed on the live provisioning path, so a rule that is even slightly wider than the
//     template starts refusing projects that deploy fine today.
//  2. No template literal is hand-copied. Each constant below is re-scraped out of the .tf it
//     came from by validate_drift_test.go on every run, the way packages/core/compat binds the
//     tofu version — a template bump that leaves the Go copy behind reds the build.

// configError describes why a project config can't be provisioned. It mirrors the shape of
// gateError (packages/core/provisioner/placement.go): one message form for every refusal,
// naming the field, the value it holds, the constraint it broke and the way out — because this
// error is what the user gets INSTEAD of a plan, and it is the whole explanation.
func configError(field string, got any, constraint string) error {
	return fmt.Errorf(
		"invalid project configuration: %s is %v, but %s — fix it on the canvas (or with "+
			"`alethia project component set`) and deploy again",
		field, got, constraint)
}

// validateNodeSizing enforces the node-pool sizing invariants that hold on every cloud.
//
// A zero is UNSET, not "zero nodes". Every ProviderTfvars guards its emission on `> 0`
// (aws_provider.go:282-290 and the four siblings), so a field left at 0 reaches no tfvar at all
// and the template's own default applies. Treating 0 as a real value here would refuse every
// project that simply omits the field — which is most of them.
//
// `node_desired_size` is the field this exists for: it is validated by NOTHING at any layer
// today. No cloud's HCL checks min <= desired <= max (all five only check max >= min), the
// column has no check constraint, and the canvas has no refinement. A desired outside the range
// plans clean and is rejected by the cluster API mid-apply.
func validateNodeSizing(config *types.ProjectConfig) error {
	minSize := config.Cluster.NodeMinSize
	maxSize := config.Cluster.NodeMaxSize
	desired := config.Cluster.NodeDesiredSize

	// A negative count is silently DROPPED by the emitters (the `> 0` guard), so today it
	// deploys the template default and the user never learns their input was discarded.
	for _, f := range []struct {
		name  string
		value int
	}{
		{"cluster.node_min_size", minSize},
		{"cluster.node_max_size", maxSize},
		{"cluster.node_desired_size", desired},
	} {
		if f.value < 0 {
			return configError(f.name, f.value, "a node count cannot be negative")
		}
	}

	if minSize > 0 && maxSize > 0 && maxSize < minSize {
		return configError("cluster.node_max_size", maxSize,
			fmt.Sprintf("it must be at least cluster.node_min_size (%d)", minSize))
	}

	// Only a SET desired is range-checked; 0 means "let the template default apply", and the
	// template's default is always inside its own default min/max.
	if desired > 0 {
		if minSize > 0 && desired < minSize {
			return configError("cluster.node_desired_size", desired,
				fmt.Sprintf("it must be at least cluster.node_min_size (%d)", minSize))
		}
		if maxSize > 0 && desired > maxSize {
			return configError("cluster.node_desired_size", desired,
				fmt.Sprintf("it must be at most cluster.node_max_size (%d)", maxSize))
		}
	}
	return nil
}

// Worker-node root-disk floors. Each is the `>= N` in that cloud's own disk-size variable
// validation block — the value the template would reject at plan time — so the rule can only
// ever refuse a config the template was going to refuse anyway.
//
// TestNodeDiskFloorsMatchTemplates re-derives all four from the .tf on every run.
const (
	// infra/templates/project/aws/variables.tf — `var.eks_disk_size >= 20`.
	awsNodeDiskFloorGB = 20
	// infra/templates/project/gcp/variables.tf — `var.gke_disk_size_gb >= 20`.
	gcpNodeDiskFloorGB = 20
	// infra/templates/project/azure/variables.tf — `var.aks_disk_size_gb >= 30`
	// (the Azure OS-disk minimum; the canvas's single cross-cloud `min: 20` undershoots it).
	azureNodeDiskFloorGB = 30
	// infra/templates/project/alibaba/variables.tf — `var.ack_disk_size_gb >= 20`.
	alibabaNodeDiskFloorGB = 20
)

// validateNodeDiskSize refuses a worker root-disk size below the floor the cloud's own template
// enforces. NodeDiskSizeGB is a POINTER and nil means unset — the per-cloud template default
// applies (EKS 50 / GKE 50 / AKS 100 / ACK 40) — so nil is never checked.
//
// Hetzner has no equivalent: its Talos nodes take the server type's own disk, and the template
// declares no disk-size variable at all. TestNodeDiskFloorsMatchTemplates asserts that absence,
// so the day Hetzner grows one, this list stops being silently incomplete.
func validateNodeDiskSize(config *types.ProjectConfig, tfvar string, floorGB int) error {
	if config.Cluster.NodeDiskSizeGB == nil {
		return nil
	}
	if got := *config.Cluster.NodeDiskSizeGB; got < floorGB {
		return configError("cluster.node_disk_size_gb", got,
			fmt.Sprintf("this cloud provisions it as %s, which must be at least %d GB", tfvar, floorGB))
	}
	return nil
}

// Network-CIDR floors: the LARGEST prefix length (the narrowest network) each template can
// still carve its subnets out of. Every one is derived from a `cidrsubnet()` newbits
// expression, because a cidrsubnet() whose newbits go negative — or whose result would run past
// /32 — is a hard tofu error, not a warning.
//
// TestNetworkCIDRFloorsMatchTemplates re-derives all three from the .tf on every run, and also
// pins the two clouds that deliberately have NO rule.
const (
	// infra/templates/project/azure/modules/vnet/main.tf:13-18 — four subnets at
	// `cidrsubnet(var.vnet_cidr, 20 - local.vnet_prefix_length, 0..3)`. cidrsubnet() also
	// requires netnum < 2^newbits, so carving netnum 3 needs newbits >= 2, i.e. prefix <= 18.
	// newbits >= 0 alone (prefix <= 20) admits /19 and /20, which die inside tofu with an
	// opaque "does not accommodate a subnet numbered N" error.
	azureMaxNetworkPrefix = 18
	// infra/templates/project/hetzner/network.tf — THREE carves share the network, and the
	// floor is the narrowest prefix that keeps all of them well-formed AND mutually disjoint
	// (checks_network.tf's `cidrs_distinct` precondition blocks the apply fail-closed
	// otherwise):
	//
	//   - node subnet (line 11): `cidrsubnet(local.network_ip_range, 24 - tonumber(…), 0)` —
	//     always the FIRST /24, and newbits >= 0 requires prefix <= 24;
	//   - pod_cidr (line 77): `cidrsubnet(local.network_ip_range, 1, 1)` — starts halfway in,
	//     at offset 2^(31-prefix), which stays clear of the node /24 (256 addresses) only
	//     while prefix <= 23;
	//   - service_cidr (line 78): `cidrsubnet(local.network_ip_range, 3, 3)` — starts at
	//     offset 3*2^(29-prefix): 96 for a /24 and 192 for a /23, both inside the node /24;
	//     384 for a /22, the first prefix that clears it.
	//
	// So the floor is the service carve's /22, not the node carve's /24 — a /23 or /24 parses,
	// carves, and then dies at plan on the disjointness precondition.
	// TestNetworkCIDRFloorsMatchTemplates re-derives this minimum from all three template
	// expressions on every run.
	hetznerMaxNetworkPrefix = 22
	// infra/templates/project/alibaba/modules/network/main.tf:35 — vswitches are
	// `cidrsubnet(var.network_cidr, 4, count.index)`, so prefix + 4 <= 32 requires prefix <= 28.
	//
	// Alibaba's own vSwitch minimum mask puts the FUNCTIONAL floor above this (a /28 VPC yields
	// /32 vswitches, which the API refuses long before /28). Only the structurally-certain
	// bound is encoded: rule 1 at the top of this file says a rule may never be wider than the
	// template, and the API's exact minimum is not derivable from the tree.
	alibabaMaxNetworkPrefix = 32 - 4
	// infra/templates/project/aws/networking.tf:86 — `local.vpc_cidr_is_carvable` is
	// `prefix >= 8 && prefix <= 18`, and 18 is the number this mirrors.
	//
	// NOT re-derived here, deliberately. The template owns it (#1936 computed it from the subnet
	// plan: public subnets are 1/1024 of the VPC and AWS's minimum subnet is /28, which binds the
	// constraint at 18), and TestNetworkCIDRFloorsMatchTemplates scrapes that bound out of the .tf
	// on every run. #1942 warned explicitly against hand-mirroring the number, so the value is
	// stated once and the drift test is what keeps the two honest — the same treatment the other
	// three carved clouds get.
	awsMaxNetworkPrefix = 18
)

// provisionsOwnNetwork mirrors — exactly — the greenfield/brownfield resolution every
// ProviderTfvars makes (aws_provider.go:83-86 and the four siblings): the user's switch, plus
// the "made no choice AND named no network" fallback that still provisions.
//
// It has to mirror every condition, not just the switch. A CIDR floor may only apply when the
// template actually CARVES that CIDR; on the brownfield path the CIDR is ignored (the attached
// network's own range is the supernet) and refusing there would block a deploy over a field the
// apply never reads. But the fallback runs the other way too — `provision_network = false` with
// no network id still provisions from the CIDR — so keying off the bare bool would leave a real
// failure unguarded.
func provisionsOwnNetwork(network types.ProjectNetworkConfig) bool {
	if network.ProvisionNetwork {
		return true
	}
	return network.NetworkID == ""
}

// validateNetworkCIDR refuses a network CIDR too narrow for the cloud's template to carve its
// subnets out of. It is skipped entirely when the CIDR is unset (the provider substitutes
// 10.0.0.0/16) or when the project attaches an existing network.
func validateNetworkCIDR(config *types.ProjectConfig, tfvar string, maxPrefix int) error {
	cidr := config.Network.CIDRBlock
	if cidr == "" || !provisionsOwnNetwork(config.Network) {
		return nil
	}

	_, ipnet, err := net.ParseCIDR(cidr)
	if err != nil || ipnet.IP.To4() == nil {
		return configError("network.cidr_block", cidr,
			fmt.Sprintf("%s must be a valid IPv4 CIDR, e.g. 10.0.0.0/16", tfvar))
	}

	ones, _ := ipnet.Mask.Size()
	if ones > maxPrefix {
		return configError("network.cidr_block", cidr,
			fmt.Sprintf("this cloud carves its subnets out of %s with cidrsubnet(), which needs "+
				"a /%d or wider network", tfvar, maxPrefix))
	}
	return nil
}

// validateServiceNames refuses a project whose services would render the same Kubernetes object
// (#2234).
//
// Every service name goes through dns1123 before it becomes a Deployment and a Service name, and
// that function is lossy three ways: case ("api"/"API"), separator folding ("a.b"/"a-b"/"a_b"),
// and truncation at 63 characters. Two names that differ only in one of those ways collapse onto
// one label, and ArgoCD then applies both manifests to one object last-write-wins — so a workload
// is silently absent while the deploy reports SUCCESS. #2054 made both files get written, which
// moved the harm into the GitOps repo where it is at least visible, but did not remove it.
//
// This is the cloud-agnostic half of the rule and runs on every provider: the collapse happens in
// manifest rendering, which no cloud varies.
//
// The collision test itself is manifests.NameCollisions rather than a second copy of dns1123 here
// — rule 2 of this file. A hand-rolled "are these the same?" would have to re-derive all three
// kinds of lossiness, and would drift the first time one of them changed.
func validateServiceNames(config *types.ProjectConfig) error {
	collisions := manifests.NameCollisions(serviceNamesOf(config))
	if len(collisions) == 0 {
		return nil
	}
	c := collisions[0]
	return configError(
		fmt.Sprintf("services %s", strings.Join(c.Names, ", ")),
		fmt.Sprintf("the Kubernetes object name %q", c.Label),
		"service names must stay distinct after they are lowercased, punctuation-folded and cut to "+
			"63 characters — otherwise they render one Deployment and one Service between them, and "+
			"only one workload runs")
}

// serviceNamesOf lists the project's service names, un-normalized.
func serviceNamesOf(config *types.ProjectConfig) []string {
	out := make([]string, 0, len(config.Services))
	for _, s := range config.Services {
		out = append(out, s.Name)
	}
	return out
}
