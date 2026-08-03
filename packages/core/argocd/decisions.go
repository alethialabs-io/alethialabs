// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import "fmt"

// InfraServiceDecision is a machine-readable record of whether a post-apply infra
// service was installed on the cluster, and — when it was skipped — WHY plus the
// alternative. It is the "honest N/A" that verify's `not_evaluable` is for the plan
// gate: rather than silently omitting a per-cloud service (external-dns on Alibaba,
// a cloud secret store on Hetzner), the pipeline records the skip and its reason so
// the console/CLI can render it truthfully instead of leaving the operator guessing.
type InfraServiceDecision struct {
	// Service is the infra service the decision is about.
	// One of: "external-dns" | "external-secrets-store" | "external-secrets-store-xacct" | "ingress" |
	// "storage-class" | "argocd-url" | "apps-repo" | "waf".
	Service string `json:"service"`
	// Status is "installed" or "skipped".
	Status string `json:"status"`
	// Reason is a human-readable explanation. For skips it states WHY and the alternative.
	Reason string `json:"reason"`
}

const (
	infraStatusInstalled = "installed"
	infraStatusSkipped   = "skipped"
)

// InfraServiceDecisions computes the per-service install/skip decisions for a deploy
// from the SAME gates the render/facts use — it calls f.DNSProvider() and mirrors the
// per-cloud ClusterSecretStore / ingress / storage-class / ArgoCD-URL conditions rather
// than re-deriving them loosely, so the recorded decisions can never drift from what
// actually shipped. Every decision carries a non-empty reason.
func InfraServiceDecisions(f *InfraFacts) []InfraServiceDecision {
	decisions := []InfraServiceDecision{
		externalDNSDecision(f),
		externalSecretsStoreDecision(f),
		ingressDecision(f),
		storageClassDecision(f),
		argocdURLDecision(f),
		appsRepoDecision(f),
		wafDecision(f),
	}
	// The cross-account (*-xacct) secret store is an OPT-IN additional read source — record its decision
	// only when the project selected one, so the common-case list stays uncluttered.
	if d, ok := externalSecretsXacctStoreDecision(f); ok {
		decisions = append(decisions, d)
	}
	return decisions
}

// appsRepoDecision mirrors the user-apps.yaml render gate ({{- if .AppsDestinationRepo }}):
// when the project wired an apps-destination repo, the runner registers the shared "repo-apps"
// ArgoCD repository credential (install.go ConfigureRepoCredentials) AND renders the credentialed
// "apps" Application (an app-of-apps syncing the customer's repo). Recording it as an honest
// install/skip decision — from the SAME AppsDestinationRepo gate the render uses — is what lets a
// tier DERIVE the "apps" Application into its expected ArgoCD health set instead of hardcoding it
// (see the T2 harness DeriveExpectedArgoApps + the infraServiceArgoApps map, BYOC A0.6). A project
// with no apps repo skips it (GitOps is opt-in), and the decision states so.
func appsRepoDecision(f *InfraFacts) InfraServiceDecision {
	d := InfraServiceDecision{Service: "apps-repo"}
	if f.AppsDestinationRepo != "" {
		d.Status = infraStatusInstalled
		d.Reason = "installed (repo-apps) — ArgoCD is credentialed to the apps-destination repo and syncs it via the \"apps\" Application."
		return d
	}
	d.Status = infraStatusSkipped
	d.Reason = "no apps-destination repo is wired for this project — connect a git repo to sync applications via GitOps."
	return d
}

// externalDNSDecision mirrors the external-dns render gate: installed only when DNS is
// enabled, a domain is set, AND DNSProvider() resolves a working backend for this cloud.
// A skip reports the specific reason keyed on why the gate failed.
func externalDNSDecision(f *InfraFacts) InfraServiceDecision {
	d := InfraServiceDecision{Service: "external-dns"}
	if f.DNSEnabled && f.DomainName != "" && f.DNSProvider() != "" {
		d.Status = infraStatusInstalled
		d.Reason = fmt.Sprintf("external-dns installed (provider %q) — managing records for %s.", f.DNSProvider(), f.DomainName)
		return d
	}
	d.Status = infraStatusSkipped
	d.Reason = externalDNSSkipReason(f)
	return d
}

// externalDNSSkipReason keys the skip explanation on the first failing condition, then
// on the cloud-specific reason the DNSProvider() gate returned "" — so an operator sees
// the actual blocker (DNS off / no domain / upstream gap / missing token / missing WI).
func externalDNSSkipReason(f *InfraFacts) string {
	if !f.DNSEnabled {
		return "DNS is disabled for this project — enable DNS (with a domain) to install external-dns."
	}
	if f.DomainName == "" {
		return "no domain is configured — set a DNS domain to install external-dns."
	}
	// DNS is on with a domain but DNSProvider() returned "" — explain the cloud-specific gap.
	switch f.Provider {
	case "alibaba":
		return "external-dns's alibabacloud provider has no RRSA support upstream (external-dns#5019) — manage AliDNS records outside the cluster until that lands."
	case "hetzner":
		return "connect a Hetzner Cloud API token — the external-dns Hetzner webhook needs it to manage DNS records."
	case "gcp":
		return "workload identity output not present (external_dns_service_account) — external-dns would ship with an empty identity, so it is skipped."
	case "azure":
		return "workload identity output not present (external_dns_client_id) — external-dns would ship with an empty identity, so it is skipped."
	}
	if f.DNSConnector == "cloudflare" {
		return "the Cloudflare DNS connector is selected but its api_token did not reach the job — reconnect the Cloudflare DNS connector."
	}
	return "no working external-dns backend for this configuration — external-dns is skipped rather than shipped broken."
}

// externalSecretsStoreDecision mirrors CleanupSkippedInfraServices' per-cloud ESO gates:
// the ClusterSecretStore installs only when the cloud's external-secrets identity fact is
// present. Hetzner has no cloud secret store at all → skip toward the Vault connector.
func externalSecretsStoreDecision(f *InfraFacts) InfraServiceDecision {
	d := InfraServiceDecision{Service: "external-secrets-store"}
	switch f.Provider {
	case "aws":
		if f.IRSAExternalSecretsArn != "" {
			return installedStore(d, "AWS Secrets Manager (IRSA-bound ClusterSecretStore)")
		}
		return skippedStore(d, "the external-secrets IRSA role output is not present — the ClusterSecretStore is skipped.")
	case "gcp":
		if f.GCPExternalSecretsSA != "" {
			return installedStore(d, "GCP Secret Manager (Workload-Identity ClusterSecretStore)")
		}
		return skippedStore(d, "the external-secrets service-account output is not present — the ClusterSecretStore is skipped.")
	case "azure":
		if f.AzureExternalSecretsClient != "" && f.AzureKeyVaultURI != "" {
			return installedStore(d, "Azure Key Vault (Workload-Identity ClusterSecretStore)")
		}
		return skippedStore(d, "the external-secrets managed-identity client id / Key Vault URI outputs are not present — the ClusterSecretStore is skipped.")
	case "alibaba":
		if f.AlibabaExternalSecretsRoleArn != "" {
			return installedStore(d, "Alibaba KMS Secrets Manager (RRSA ClusterSecretStore)")
		}
		return skippedStore(d, "the external-secrets RRSA role output is not present — the ClusterSecretStore is skipped.")
	case "hetzner":
		return skippedStore(d, "Hetzner has no cloud secret store — use the Vault connector to source secrets.")
	default:
		return skippedStore(d, "no cloud secret store for this provider — the ClusterSecretStore is skipped.")
	}
}

// externalSecretsXacctStoreDecision records the ADDITIONAL cross-account (*-xacct) ClusterSecretStore
// when the project selected one — an honest install/skip mirroring the *-xacct render gates in
// install.go. Returns ok=false when no cross-account secret manager is selected (the common case), so
// the decision list stays uncluttered. When selected but the cluster's own external-secrets identity
// is absent, it is a FAIL-CLOSED skip: no foreign store is applied.
//
// The gate is InfraFacts.XacctSecretStore, the SAME predicate the render template reads — not a
// hand-copied mirror of it. It used to be one, and the copies had already diverged: facts with an
// IRSA role and a gcp-shaped target (SecretsXacctProjectID set, SecretsXacctRef empty) satisfied
// this function's aws branch and reported "installed" while the template's aws branch, which also
// requires SecretsXacctRef, rendered nothing.
func externalSecretsXacctStoreDecision(f *InfraFacts) (InfraServiceDecision, bool) {
	name, selected := f.XacctSecretStore()
	if !selected {
		return InfraServiceDecision{}, false
	}
	d := InfraServiceDecision{Service: "external-secrets-store-xacct"}
	if name == "" {
		return skippedStore(d, xacctSkipReason(f.Provider)), true
	}
	return installedStore(d, xacctBackend(f.Provider)), true
}

// xacctBackend names the cross-account backend an installed *-xacct store reads.
func xacctBackend(provider string) string {
	switch provider {
	case "aws":
		return "cross-account AWS Secrets Manager (assumes the target-account role)"
	case "gcp":
		return "cross-project GCP Secret Manager (reads the target project)"
	case "azure":
		return "cross-subscription Azure Key Vault (reads the target vault)"
	case "alibaba":
		return "cross-account Alibaba KMS Secrets Manager (RRSA via the target OIDC provider)"
	default:
		return "a cross-account cloud secret manager"
	}
}

// xacctSkipReason explains WHICH half of the gate was missing when a selected cross-account store
// did not render. It is always the cluster's own external-secrets identity: the target half is what
// made the store "selected" in the first place.
func xacctSkipReason(provider string) string {
	switch provider {
	case "aws":
		return "the external-secrets IRSA role output is not present — the cross-account ClusterSecretStore is skipped."
	case "gcp":
		return "the external-secrets service-account output is not present — the cross-account ClusterSecretStore is skipped."
	case "azure":
		return "the external-secrets managed-identity client id output is not present — the cross-account ClusterSecretStore is skipped."
	case "alibaba":
		return "the external-secrets RRSA role output or the target OIDC provider ARN is not present — the cross-account ClusterSecretStore is skipped."
	default:
		return "no cross-account cloud secret store for this provider — skipped."
	}
}

// installedStore stamps an installed external-secrets-store decision with its backend name.
func installedStore(d InfraServiceDecision, backend string) InfraServiceDecision {
	d.Status = infraStatusInstalled
	d.Reason = fmt.Sprintf("external-secrets ClusterSecretStore installed — backed by %s.", backend)
	return d
}

// skippedStore stamps a skipped external-secrets-store decision with its reason.
func skippedStore(d InfraServiceDecision, reason string) InfraServiceDecision {
	d.Status = infraStatusSkipped
	d.Reason = reason
	return d
}

// providerDecision is ONE CLOUD's contribution to a per-cloud decision table: whether the
// service actually shipped on that cloud, and the reason recorded either way. It exists so a
// per-cloud service is a table ENTRY rather than another arm of a growing if/else — four
// ingress-controller lanes (GCP, Azure, Alibaba, plus whatever follows) each land one line in
// the same map instead of four conflicting edits to the same conditional.
type providerDecision struct {
	// installed reports whether the service actually shipped, for the clouds whose install
	// depends on a provisioned fact (AWS's ArgoCD ingress needs the ACM certificate). nil
	// means "unconditional on this cloud" — present in the table ⇒ installed.
	installed func(f *InfraFacts) bool
	// installedReason is recorded when the service shipped. Required for every entry.
	installedReason string
	// skippedReason is recorded when installed returns false. Empty ⇒ the table's shared
	// default skip reason, which is also what a cloud ABSENT from the table gets.
	skippedReason string
}

// perProviderDecision resolves a per-cloud table into an InfraServiceDecision. A cloud absent
// from the table is a SKIP with the shared default reason — the fail-closed direction: a new
// cloud ships nothing and says so, rather than inheriting another cloud's claim.
func perProviderDecision(service string, f *InfraFacts, table map[string]providerDecision, defaultSkipReason string) InfraServiceDecision {
	d := InfraServiceDecision{Service: service, Status: infraStatusSkipped, Reason: defaultSkipReason}
	entry, ok := table[f.Provider]
	if !ok {
		return d
	}
	if entry.installed != nil && !entry.installed(f) {
		if entry.skippedReason != "" {
			d.Reason = entry.skippedReason
		}
		return d
	}
	d.Status = infraStatusInstalled
	d.Reason = entry.installedReason
	return d
}

// ingressControllers is the per-cloud ingress-controller table: one entry per cloud that
// actually wires a controller. AWS ships the ALB controller in-template
// (infra/templates/argocd/aws-load-balancer-controller.yaml); no other cloud has one yet, so
// every other cloud is ABSENT and records ingressNoControllerReason unchanged.
//
// Adding a cloud is ONE ENTRY here — and the e2e assertion's own provider-keyed map
// (test/e2e/argocd_assert.go infraServiceArgoApps) needs the matching Application name, or the
// derivation hard-errors rather than waiting out the ArgoCD timeout on an app nobody rendered.
var ingressControllers = map[string]providerDecision{
	"aws": {installedReason: "installed (AWS Load Balancer Controller) — Ingress objects provision ALBs."},
}

// ingressNoControllerReason is what a cloud with no ingress controller records. Kept
// byte-identical to the pre-table reason: this refactor changes the SHAPE, not any decision.
const ingressNoControllerReason = "skipped — a cloud load balancer is available; install the ingress-nginx add-on to expose Ingress objects."

// ingressDecision records the ingress controller for this cloud, from ingressControllers.
func ingressDecision(f *InfraFacts) InfraServiceDecision {
	return perProviderDecision("ingress", f, ingressControllers, ingressNoControllerReason)
}

// storageClassDecision records the default StorageClass: AWS installs gp3 as default;
// GCP/Azure rely on the built-in cloud default; Alibaba needs a default-annotated class
// verified; Hetzner installs hcloud-volumes as default via the CSI bootstrap.
func storageClassDecision(f *InfraFacts) InfraServiceDecision {
	d := InfraServiceDecision{Service: "storage-class"}
	switch f.Provider {
	case "aws":
		d.Status = infraStatusInstalled
		d.Reason = "installed (gp3, default) — the EBS CSI gp3 StorageClass is the cluster default."
	case "gcp":
		d.Status = infraStatusInstalled
		d.Reason = "built-in default (standard-rwo) — GKE ships a default StorageClass, no install needed."
	case "azure":
		d.Status = infraStatusInstalled
		d.Reason = "built-in default (managed-csi) — AKS ships a default StorageClass, no install needed."
	case "alibaba":
		d.Status = infraStatusSkipped
		d.Reason = "verify a default-annotated alicloud-disk StorageClass exists — ACK may not mark one default out of the box."
	case "hetzner":
		d.Status = infraStatusInstalled
		d.Reason = "installed (hcloud-volumes, default) — the hcloud CSI StorageClass is applied as the cluster default."
	default:
		d.Status = infraStatusSkipped
		d.Reason = "no default StorageClass wired for this provider — verify the cluster's default class."
	}
	return d
}

// argocdURLGates is the per-cloud "what makes a managed ArgoCD URL reachable here" table.
// The predicate is the cloud's own: AWS's ALB ingress renders only when the ACM certificate
// output is present (installArgoCD gates the whole `server.ingress.*` block on it), so a
// certificate-less AWS deploy has no URL. A cloud ABSENT from the table has no managed
// ingress at all and records argocdURLNoIngressReason.
//
// This is the SECOND site a per-cloud ingress lane must touch, and the reason it is a table:
// the lane's cloud contributes its own predicate (an issued cert-manager Certificate, an
// Application Gateway id, an SLB address) without rewriting anyone else's.
var argocdURLGates = map[string]providerDecision{
	"aws": {
		installed:       func(f *InfraFacts) bool { return f.ACMCertificateArn != "" },
		installedReason: "installed — ArgoCD is exposed over the ALB ingress (ACM certificate present).",
		// No skippedReason: an AWS deploy without the certificate has no managed ingress
		// either, which is exactly what the shared default says — unchanged from before.
	},
}

// argocdURLNoIngressReason is what a cloud with no managed ArgoCD ingress records. Kept
// byte-identical to the pre-table reason.
const argocdURLNoIngressReason = "no managed ingress on this cloud yet — access ArgoCD via port-forward + the admin password."

// argocdURLDecision records whether a managed ArgoCD URL is reachable, from argocdURLGates.
func argocdURLDecision(f *InfraFacts) InfraServiceDecision {
	return perProviderDecision("argocd-url", f, argocdURLGates, argocdURLNoIngressReason)
}

// wafDecision records whether the project's web ACL is ATTACHED to anything — the honest
// answer to "I turned the WAF on, is traffic actually being filtered?". Every cloud's template
// can BUILD a WAF construct behind the canvas switch (#1810), but building one and attaching
// one are different facts, and until now nothing recorded the difference: a project could carry
// a web ACL, a bill for it, and zero inspected requests.
//
// On AWS the attach is the `alb.ingress.kubernetes.io/wafv2-acl-arn` annotation
// installArgoCD puts on the ArgoCD server ingress, so this decision mirrors BOTH halves —
// the ACL must exist AND the ingress that carries the annotation must have been configured.
// It reads argocdURLDecision rather than re-deriving the ingress gate, so the two cannot drift.
//
// This ships NO ArgoCD Application (it is an annotation on an existing ingress), which is why
// it belongs in test/e2e/argocd_assert.go's infraServiceNoApp.
func wafDecision(f *InfraFacts) InfraServiceDecision {
	d := InfraServiceDecision{Service: "waf", Status: infraStatusSkipped}
	acl := wafWebACLRef(f)
	if acl == "" {
		d.Reason = wafNoACLReason(f.Provider)
		return d
	}
	if argocdURLDecision(f).Status != infraStatusInstalled {
		d.Reason = "a web ACL was built but this deploy configured no managed ingress to attach it to — the ACL exists, is billed, and inspects nothing."
		return d
	}
	d.Status = infraStatusInstalled
	d.Reason = fmt.Sprintf("attached (%s) — the ArgoCD ingress carries alb.ingress.kubernetes.io/wafv2-acl-arn, so the ALB inspects every request it serves.", acl)
	return d
}

// wafWebACLRef returns the web ACL / security-policy reference this cloud EXPORTS for the
// runner to attach, and "" when it exports none. One arm per cloud, so a lane wiring Cloud
// Armor to a GCP ingress adds its line here rather than widening a boolean.
func wafWebACLRef(f *InfraFacts) string {
	switch f.Provider {
	case "aws":
		return f.WAFWebACLArn
	default:
		// gcp (Cloud Armor), azure (a WAF policy) and alibaba (a WAF instance) each BUILD a
		// construct behind their own canvas switch, but none declares a root output the runner
		// could read and none has a managed ingress to bind one to — so there is no reference
		// here to attach. Hetzner sells no managed WAF at all.
		return ""
	}
}

// wafNoACLReason explains why there was no web ACL reference to attach, keyed on the cloud so
// "you left the switch off" is never confused with "this cloud cannot do it".
func wafNoACLReason(provider string) string {
	switch provider {
	case "aws":
		return "no web ACL was built — turn the WAF switch on for this project to create a regional web ACL and attach it to the ingress."
	case "hetzner":
		return "Hetzner sells no managed WAF — run your own edge (or an in-cluster WAF add-on) if you need request filtering."
	default:
		return "the template builds a web ACL but this cloud has no ingress to attach it to yet — it would be created and left inspecting nothing."
	}
}
