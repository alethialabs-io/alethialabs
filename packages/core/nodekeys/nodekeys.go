// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Package nodekeys is the ONE definition of what a node label or taint key and value may be when a
// user sets it through Alethia: the Kubernetes key and value grammar, and the domains a user may not
// write in.
//
// Three places check these rules. This package is the definition, and the other two are held to it:
//
//   - packages/core/provisioner/karpenter.go calls this package directly, before it applies a
//     Karpenter NodePool with cluster-admin rights (#5527).
//   - The OpenTofu validations cannot import Go, so they carry the same regexes as string literals:
//     the Karpenter knobs in infra/templates/project/aws/variables.tf, and the cross-cloud node-pool
//     contract in packages/core/cloud/testdata/nodepool/reference/variables.tf (#5533), which every
//     cloud lane copies. drift_test.go reads those files and fails when a literal stops being equal
//     to the regex here.
//
// LENGTH differs by caller, and both bounds live here. A Karpenter NodePool's labels go to the API
// server, so Kubernetes' own lengths apply (ValidKey: a prefix of up to 253 characters plus a name of
// up to 63); karpenter.go calls ValidKey. A label on a managed node group goes through the cloud's
// API, and EKS caps the WHOLE key at 63 characters, so the cross-cloud contract bounds every key by
// PortableKeyMaxLength and every value by 1..ValueMaxLength. Those bounds are tofu `length()`
// checks, which drift_test.go reads and holds to these constants. The grammar is the same for both.
package nodekeys

import (
	"regexp"
	"strings"
)

// ReservedDomains are the label and taint key prefixes a user may not write in. Kubernetes owns the
// first two, Karpenter the next two, and each cloud one more. Alethia owns alethia.io: the platform
// labels every extra pool alethia.io/pool=<name> and taints every arm64 pool alethia.io/arch, and a
// user who could write either could steer a workload onto a pool it did not ask for.
//
// A prefix that ENDS in one of these is reserved, with no dot boundary: Karpenter's NodePool CRD
// tests endsWith("kubernetes.io"), so examplekubernetes.io/x fails at apply and is refused here too.
// The list is the union across clouds, because a key refused on one cloud must be refused on all of
// them, or a portable alethia.yaml breaks when the project moves.
var ReservedDomains = []string{
	"kubernetes.io",
	"k8s.io",
	"karpenter.sh",
	"karpenter.k8s.aws",
	"amazonaws.com",
	"cloud.google.com",
	"gke.io",
	"azure.com",
	"hetzner.cloud",
	"alethia.io",
}

// QualifiedKeyRegex is a Kubernetes label or taint key: an optional DNS-subdomain prefix and a
// slash, then a name of 1 to 63 characters that starts and ends with a letter or digit.
const QualifiedKeyRegex = `^([a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*/)?[A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$`

// ValueRegex is a Kubernetes label or taint value: letters, digits, '-', '_' and '.', starting and
// ending with a letter or digit, or empty. The length (at most 63) is checked separately.
const ValueRegex = `^([A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?)?$`

// NodeRestrictionDomainRegex is the one reserved subdomain a KARPENTER label may use. Kubernetes
// documents node-restriction.kubernetes.io/ for labels a kubelet cannot set on its own node, and
// Karpenter sets labels through the API rather than the kubelet, so its CRD admits it. The
// cross-cloud contract does NOT admit it: a managed pool labels its nodes through the kubelet, which
// refuses that prefix (IsKubeletLabel, k8s.io/kubelet/pkg/apis/well_known_labels.go).
const NodeRestrictionDomainRegex = `(^|\.)node-restriction\.kubernetes\.io$`

// PortableKeyMaxLength is the longest key, prefix included, the cross-cloud contract accepts: the
// EKS managed node group API caps label and taint keys at 63 characters. The contract's tofu
// validations carry it as `length(k) <= 63`, held to this constant by drift_test.go.
const PortableKeyMaxLength = 63

// ValueMaxLength is the longest label or taint value Kubernetes and every cloud accept.
const ValueMaxLength = 63

// ReservedDomainRegex matches a key prefix that ends in one of ReservedDomains.
var ReservedDomainRegex = reservedDomainRegex()

var (
	qualifiedKey          = regexp.MustCompile(QualifiedKeyRegex)
	value                 = regexp.MustCompile(ValueRegex)
	reservedDomain        = regexp.MustCompile(ReservedDomainRegex)
	nodeRestrictionDomain = regexp.MustCompile(NodeRestrictionDomainRegex)
)

// reservedDomainRegex builds the alternation over ReservedDomains, anchored at the end only.
func reservedDomainRegex() string {
	quoted := make([]string, len(ReservedDomains))
	for i, d := range ReservedDomains {
		quoted[i] = regexp.QuoteMeta(d)
	}
	return "(" + strings.Join(quoted, "|") + ")$"
}

// keyPrefix returns a key's prefix ("example.com" for "example.com/gpu"), or "" when it has none.
func keyPrefix(key string) string {
	if i := strings.Index(key, "/"); i >= 0 {
		return key[:i]
	}
	return ""
}

// ValidKey reports whether key follows the Kubernetes grammar with Kubernetes' lengths: a prefix of
// at most 253 characters whose dot-separated labels are at most 63 each, and a name of at most 63.
func ValidKey(key string) bool {
	if !qualifiedKey.MatchString(key) {
		return false
	}
	prefix := keyPrefix(key)
	if len(prefix) > 253 {
		return false
	}
	for _, label := range strings.Split(prefix, ".") {
		if len(label) > 63 {
			return false
		}
	}
	return true
}

// ValidValue reports whether v is a label or taint value Kubernetes accepts (empty included).
func ValidValue(v string) bool {
	return len(v) <= ValueMaxLength && value.MatchString(v)
}

// ReservedDomain returns the key's prefix and whether it is in a reserved domain. A key with no
// prefix is never reserved.
func ReservedDomain(key string) (string, bool) {
	d := keyPrefix(key)
	return d, d != "" && reservedDomain.MatchString(d)
}

// IsNodeRestrictionDomain reports whether a prefix is node-restriction.kubernetes.io or a subdomain
// of it: the one reserved domain a Karpenter label may use.
func IsNodeRestrictionDomain(domain string) bool {
	return nodeRestrictionDomain.MatchString(domain)
}

// ReservedDomainsText lists ReservedDomains for an error message: "a, b, … or z".
func ReservedDomainsText() string {
	n := len(ReservedDomains)
	return strings.Join(ReservedDomains[:n-1], ", ") + " or " + ReservedDomains[n-1]
}
