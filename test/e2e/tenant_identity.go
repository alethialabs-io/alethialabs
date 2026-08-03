// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Per-namespace cloud identity — the "platform team / hard multi-tenancy" surface. The PURE half:
// untagged, so the per-cloud contract is unit-tested without a cloud and `go mod tidy` sees its deps.
//
// # What was uncovered
//
// A namespace placement mints a per-namespace, zero-permission cloud identity and binds the tenant
// namespace's `default` ServiceAccount to it (IRSA on aws, Workload Identity on gcp, Workload
// Identity on azure, RRSA on alibaba). That binding is what makes one Fabric genuinely
// multi-tenant rather than merely namespaced: without it, every tenant pod inherits the NODE's
// credentials and the isolation is cosmetic.
//
// Nothing in test/e2e asserted it. #959 checks the PSA label, the guardrail bundle, the hardened
// AppProject and the cluster-resource whitelist — all Kubernetes-native — and never looks at the
// ServiceAccount. So the cloud-identity half of the tenancy claim had no end-to-end coverage on any
// cloud, and a regression would have surfaced only as a customer's pod holding node credentials.
//
// # hetzner is an EXCLUSION, asserted as one
//
// hetzner-talos has no cloud IAM to bind, so `provisionAndBindNamespaceIdentity` deliberately does
// nothing there and says so. That is a real product limit, not an oversight — so this asserts the
// ABSENCE positively rather than skipping the cloud. A skip would read green and hide the day the
// exclusion silently became true of a cloud that is supposed to bind an identity.
package e2e

import (
	"fmt"
	"strings"
)

// tenantIdentityBinding is the observable in-cluster artifact of a per-namespace cloud identity.
type tenantIdentityBinding struct {
	// SAAnnotation is the annotation key on the tenant namespace's `default` ServiceAccount that
	// names the minted identity. Empty for a cloud with no cloud-IAM binding.
	SAAnnotation string
	// SALabel is an additional label the cloud's webhook requires on the ServiceAccount ("" if none).
	SALabel string
	// SALabelValue is the exact value that label must carry.
	SALabelValue string
	// NamespaceLabel is a label the cloud's webhook requires on the NAMESPACE ("" if none).
	NamespaceLabel string
	// NamespaceLabelValue is the exact value that namespace label must carry.
	NamespaceLabelValue string
	// Mechanism is the human name of the identity mechanism, for the log line and the verdict.
	Mechanism string
	// Excluded marks a cloud that binds no cloud identity at all, with Reason saying why.
	Excluded bool
	Reason   string
}

// tenantIdentityForProvider mirrors the product's binding contract
// (packages/core/provisioner/deploy_namespace.go: bindNamespaceIdentity / bindGKENamespaceIdentity /
// bindAKSNamespaceIdentity / bindACKNamespaceIdentity). These literals are a SECOND source of truth,
// which is a real hazard — TestTenantIdentityMirrorsTheProduct reads the product source and fails if
// the two ever drift, so a renamed annotation cannot leave this harness asserting the old key.
//
// An UNRECOGNISED provider is an error, never a silent skip: a new cloud that reaches this code
// without a documented decision must fail loudly rather than quietly assert nothing.
func tenantIdentityForProvider(provider string) (tenantIdentityBinding, error) {
	switch strings.ToLower(strings.TrimSpace(provider)) {
	case "aws":
		return tenantIdentityBinding{
			SAAnnotation: "eks.amazonaws.com/role-arn",
			Mechanism:    "IRSA (IAM role for service account)",
		}, nil
	case "gcp":
		return tenantIdentityBinding{
			SAAnnotation: "iam.gke.io/gcp-service-account",
			Mechanism:    "GKE Workload Identity",
		}, nil
	case "azure":
		return tenantIdentityBinding{
			SAAnnotation: "azure.workload.identity/client-id",
			SALabel:      "azure.workload.identity/use",
			SALabelValue: "true",
			Mechanism:    "Azure Workload Identity (federated UAMI)",
		}, nil
	case "alibaba":
		return tenantIdentityBinding{
			SAAnnotation:        "pod-identity.alibabacloud.com/role-name",
			NamespaceLabel:      "pod-identity.alibabacloud.com/injection",
			NamespaceLabelValue: "on",
			Mechanism:           "RRSA (RAM role for service account)",
		}, nil
	case "hetzner":
		return tenantIdentityBinding{
			Excluded:  true,
			Mechanism: "none",
			Reason:    "hetzner-talos exposes no cloud IAM, so a namespace tenant gets k8s-native isolation only (PSA + NetworkPolicy + ResourceQuota + a hardened AppProject) and no per-namespace cloud identity",
		}, nil
	}
	return tenantIdentityBinding{}, fmt.Errorf("no per-namespace identity contract is recorded for provider %q — a cloud must either bind an identity or carry a documented exclusion, never reach this assertion undecided", provider)
}

// TenantIdentitySummary is the machine-readable result folded into the proof bundle.
type TenantIdentitySummary struct {
	Provider  string `json:"provider"`
	Namespace string `json:"namespace"`
	Mechanism string `json:"mechanism"`
	// Excluded records that this cloud binds NO cloud identity, with the reason — reported as a
	// first-class outcome rather than a missing field.
	Excluded bool   `json:"excluded"`
	Reason   string `json:"reason,omitempty"`
	// Bound is true when the ServiceAccount really carried the identity annotation.
	Bound bool `json:"bound"`
	// IdentityRef is the minted identity as the cluster reports it (a role ARN / GSA email / client
	// id / role name). A NAME, never a credential.
	IdentityRef string `json:"identity_ref,omitempty"`
	// AutomountDisabled records that the tenant SA does not automount its token — the other half of
	// the isolation claim.
	AutomountDisabled bool `json:"automount_token_disabled"`
}

// tenantIdentityVerdictPass reports whether the tenancy claim actually held. An excluded cloud
// passes only by genuinely binding NOTHING — if an identity turned up on a cloud we documented as
// having none, the documented exclusion is wrong and must fail.
func tenantIdentityVerdictPass(s TenantIdentitySummary) bool {
	if s.Excluded {
		return !s.Bound && s.IdentityRef == ""
	}
	return s.Bound && strings.TrimSpace(s.IdentityRef) != ""
}

// tenantIdentityVerdict renders the one-line human verdict.
func tenantIdentityVerdict(s TenantIdentitySummary) string {
	icon := "✅"
	if !tenantIdentityVerdictPass(s) {
		icon = "❌"
	}
	if s.Excluded {
		return fmt.Sprintf("%s tenant-identity on %s: NO cloud identity by design — %s", icon, s.Provider, s.Reason)
	}
	return fmt.Sprintf("%s tenant-identity on %s: ns %s default SA bound via %s to %s (automount disabled=%t)",
		icon, s.Provider, s.Namespace, s.Mechanism, s.IdentityRef, s.AutomountDisabled)
}
