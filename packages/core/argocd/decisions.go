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
		certManagerDecision(f),
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

// certManagerDecision records whether the in-cluster certificate issuer actually shipped — the
// honest answer to "I ticked managed certificate, is anything going to issue one?".
//
// It reads InfraFacts.CertManagerEnabled(), the SAME predicate the render template gates on and
// EnsureCertManagerIssuer reads, rather than restating the `and` — the ClusterSecretStore gates
// were restated by hand in four places and drifted twice.
//
// The skip reasons are keyed on the FIRST failing condition, because "you left the switch off",
// "this cloud cannot do it" and "the identity output is missing" are three completely different
// things for the operator to do next, and a single generic skip would hide which one it is.
func certManagerDecision(f *InfraFacts) InfraServiceDecision {
	d := InfraServiceDecision{Service: "cert-manager"}
	if f.CertManagerEnabled() {
		d.Status = infraStatusInstalled
		d.Reason = fmt.Sprintf(
			"installed (cert-manager) — the %q ClusterIssuer solves ACME DNS01 challenges for %s via the %s solver, reusing external-dns's identity.",
			CertManagerIssuerName, f.DomainName, f.CertManagerSolver())
		return d
	}
	d.Status = infraStatusSkipped
	d.Reason = certManagerSkipReason(f)
	return d
}

// certManagerSkipReason explains WHICH half of the gate was missing. The cloud-specific arms are
// the load-bearing ones: on Alibaba and Hetzner this is a permanent product gap, not a setting the
// operator can turn on, and saying so is the difference between an honest N/A and a bug report.
func certManagerSkipReason(f *InfraFacts) string {
	if !f.ManagedCertificate {
		return "no managed certificate was requested for this project — turn the managed-certificate switch on to have cert-manager issue and renew one in-cluster."
	}
	if !f.DNSEnabled {
		return "DNS is disabled for this project — cert-manager solves ACME challenges over DNS01, so enable DNS (with a domain) to issue a certificate."
	}
	if f.DomainName == "" {
		return "no domain is configured — set a DNS domain to issue a certificate for it."
	}
	// A managed certificate was asked for, DNS is on with a domain, but no solver resolved.
	switch f.Provider {
	case "alibaba":
		return "cert-manager ships no AliDNS DNS01 solver — issuing in-cluster on Alibaba needs the third-party cert-manager-webhook-alidns, so no ClusterIssuer is created rather than one whose challenges would hang pending forever."
	case "hetzner":
		return "cert-manager ships no Hetzner DNS01 solver — issuing in-cluster on Hetzner needs a third-party webhook (the same gap external-dns covers with its webhook sidecar), so no ClusterIssuer is created rather than one whose challenges would hang pending forever."
	}
	if f.DNSConnector != "" && f.DNSConnector != "native" {
		return fmt.Sprintf("the %s DNS connector manages this domain, so the cloud's own zone is not authoritative for it — a cloud DNS01 solver would write its challenge record into a zone the ACME server never queries. Issuing through the connector is not wired yet.", f.DNSConnector)
	}
	switch f.Provider {
	case "aws":
		return "the external-dns IRSA role output is not present — cert-manager's route53 solver would have no identity to write the challenge record with, so it is skipped."
	case "gcp":
		return "the external-dns workload-identity or Cloud DNS managed-zone output is not present — cert-manager's clouddns solver could not find or write the zone, so it is skipped."
	case "azure":
		return "the external-dns managed-identity, resource-group, subscription or tenant fact is not present — cert-manager's azuredns solver would have no identity to write the challenge record with, so it is skipped."
	}
	return "no in-cluster certificate issuer for this configuration — cert-manager is skipped rather than shipped unable to issue."
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
	// skippedReason is recorded when installed returns false. A FUNCTION, not a constant,
	// because `installed` is usually a conjunction and the operator needs to know WHICH half
	// was missing: "you left DNS off" and "you left the certificate off" are different
	// problems with different fixes, and a single sentence covering both tells them neither.
	// Same shape as wafNoACLReason below. nil — or a "" return — ⇒ the table's shared default
	// skip reason, which is also what a cloud ABSENT from the table gets.
	skippedReason func(f *InfraFacts) string
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
		if entry.skippedReason != nil {
			if reason := entry.skippedReason(f); reason != "" {
				d.Reason = reason
			}
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
// Adding a cloud is ONE ENTRY here — and the e2e assertion's own provider-keyed maps
// (test/e2e/argocd_assert.go infraServiceArgoApps / infraServiceNoApp) need the matching
// Application name, or an explicit "this cloud ships none", or the derivation hard-errors rather
// than waiting out the ArgoCD timeout on an app nobody rendered.
//
// ALIBABA IS ABSENT ON PURPOSE, not for lack of a lane. ACK ships its own nginx-ingress-controller
// component — the alicloud provider documents `disabled = true` as the way to turn it OFF at cluster
// creation, and it creates a `nginx-ingress-lb` LoadBalancer Service in kube-system with its own
// CLB/NLB. A platform ingress controller from Alethia would be a SECOND controller fighting the
// first for the same Ingress objects: exactly the #1722 ownership collision that already keeps
// alibaba out of test/e2e/argocd_assert.go's metricsServerProviders, because ACK installs its own
// metrics-server too. The shared skip reason below — install the ingress-nginx add-on — is the
// honest instruction on this cloud, and it is a marketplace add-on precisely so an operator who
// turned the ACK component off can choose it.
var ingressControllers = map[string]providerDecision{
	"aws": {installedReason: "installed (AWS Load Balancer Controller) — Ingress objects provision ALBs."},
	// GKE's Ingress controller is NOT something Alethia installs: it runs in the Google-managed
	// control plane, gated on the cluster's HTTP(S) Load Balancing add-on, which modules/gke enables
	// unconditionally (`http_load_balancing { disabled = false }`). So the honest decision is
	// "installed, by the cloud" — the same shape storageClassDecision already records for GCP
	// ("built-in default (standard-rwo) … no install needed"). It ships no ArgoCD Application, which
	// is why "ingress" gets a gcp entry in infraServiceNoApp rather than a controller name in
	// infraServiceArgoApps.
	//
	// Installing ingress-nginx instead would have been wrong twice over: it is a second controller
	// nobody asked for (the #1722 ownership collision, one layer up), and its L4 pass-through load
	// balancer cannot carry a Cloud Armor policy at all — Cloud Armor binds to a GCLB BACKEND
	// SERVICE, and only the `gce` ingress class provisions one.
	"gcp": {installedReason: "built-in (GKE Ingress, the `gce` class) — HTTP(S) Load Balancing is enabled on the cluster, so an Ingress provisions a Google Cloud Load Balancer; there is no controller to install."},
	"azure": {
		// AGIC provisions nothing per Ingress the way the ALB controller does: it reconciles every
		// Ingress in the cluster onto ONE pre-provisioned Application Gateway. So "a controller
		// shipped" is not a fact about the cluster alone — without the gateway, and without the
		// federated identity that lets AGIC rewrite it, the chart installs a pod that
		// authenticates to nothing and reconciles nothing. Both terms are in the predicate
		// because both are in the template's render gate.
		installed: func(f *InfraFacts) bool {
			return f.AzureIngressClient != "" && f.AzureAppGatewayName != ""
		},
		installedReason: "installed (Application Gateway Ingress Controller) — Ingress objects with ingressClassName azure-application-gateway become listeners and routing rules on the project's Application Gateway.",
		skippedReason: func(_ *InfraFacts) string {
			return "no Application Gateway is provisioned for this project — a v2 gateway is a standing hourly cost, so it is opt-in (azure_application_gateway_enabled, which follows the WAF switch when unset) and needs a template-provisioned VNet to carve its dedicated subnet. Install the ingress-nginx add-on to expose Ingress objects through a cloud load balancer instead."
		},
	},
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
// A cloud ABSENT from the table has no managed ingress at all and records
// argocdURLNoIngressReason.
//
// Each predicate must mirror installArgoCD's emitter for that cloud EXACTLY — every condition,
// not just the interesting one. AWS's ingress renders inside `if vc.DNS.Enabled &&
// vc.DNS.DomainName != ""`, and only then when the ACM certificate output is present; a gate
// that checked the certificate alone reported "installed — ArgoCD is exposed over the ALB
// ingress" for a deploy that emitted no ingress at all. That is reachable rather than
// theoretical: `acm_certificate_enable` comes from DNS.ManagedCertificate, a field independent
// of DNS.Enabled, and provider_config passthrough can set it directly — so DNS off + a domain
// + a zone id yields a real certificate ARN and no ingress. wafDecision reads this decision
// rather than re-deriving the ingress gate, so the same mismatch made the WAF claim "attached"
// about an annotation that was never emitted.
//
// This is the SECOND site a per-cloud ingress lane must touch, and the reason it is a table:
// the lane's cloud contributes its own predicate (an issued cert-manager Certificate, an
// Application Gateway id, an SLB address) without rewriting anyone else's.
var argocdURLGates = map[string]providerDecision{
	"aws": {
		installed: func(f *InfraFacts) bool {
			return f.DNSEnabled && f.DomainName != "" && f.ACMCertificateArn != ""
		},
		installedReason: "installed — ArgoCD is exposed over the ALB ingress (ACM certificate present).",
		skippedReason:   awsArgocdURLSkipReason,
	},
	// GCP converged onto cert-manager (#1858), so its predicate is no longer a certificate output —
	// there isn't one. `google_compute_managed_ssl_certificate` and the `pre-shared-cert` annotation
	// that named it are both deleted; the GKE Ingress now carries `spec.tls` and the GCE controller
	// reads the Secret cert-manager writes.
	//
	// ⚠️ MIRRORS THE EMITTER, EVERY TERM, same as azure below. installArgoCD renders this inside
	// `vc.DNS.Enabled && vc.DNS.DomainName != ""` and then only when
	// `gkeCluster != "" && certManagerWillIssue`. The cluster term is not ceremony: a deploy with DNS
	// and cert-manager but no GKE cluster emits nothing, and a gate that skipped it would report an
	// ingress that does not exist — #1831 on a second cloud.
	//
	// CertManagerEnabled() is CALLED, not restated. It already folds in the managed-certificate
	// switch, DNS, the domain and the per-cloud solver.
	"gcp": {
		installed: func(f *InfraFacts) bool {
			return f.DNSEnabled && f.DomainName != "" && f.ClusterName != "" && f.CertManagerEnabled()
		},
		installedReason: "installed — ArgoCD is exposed over a GKE Ingress (`gce` class), with TLS issued in-cluster by cert-manager and served from a Kubernetes Secret.",
		skippedReason:   gcpArgocdURLSkipReason,
	},
	"azure": {
		// THE FLIP THE PREVIOUS LANE PROMISED (#1825). This was a constant-false predicate while
		// the only certificate Azure could produce was a purchased App Service order that binds to
		// neither AKS nor an Application Gateway. That resource is deleted; cert-manager issues the
		// certificate in-cluster now, and AGIC lifts the Secret onto the gateway listener.
		//
		// ⚠️ MIRRORS THE EMITTER, EVERY TERM. installArgoCD renders this ingress inside
		// `vc.DNS.Enabled && vc.DNS.DomainName != ""` and then only when `agwName != "" &&
		// certManagerWillIssue`. All four are here. Checking a subset is #1831 exactly: that gate
		// tested one of three conditions and reported "installed — exposed over the ALB ingress"
		// for a deploy that emitted no ingress at all, and wafDecision read the lie downstream.
		//
		// CertManagerEnabled() is called rather than restated — the same method the emitter calls,
		// the render template gates on, and certManagerDecision reads. It already folds in the
		// managed-certificate switch, DNS, the domain and the per-cloud solver, so spelling those
		// out here would be four more chances to drift.
		installed: func(f *InfraFacts) bool {
			return f.DNSEnabled && f.DomainName != "" && f.AzureAppGatewayName != "" && f.CertManagerEnabled()
		},
		installedReason: "installed — ArgoCD is exposed over the Application Gateway ingress, with TLS issued in-cluster by cert-manager and lifted onto the listener by AGIC.",
		skippedReason:   azureArgocdURLSkipReason,
	},
}

// gcpArgocdURLSkipReason names which half of the GCP gate was missing, same shape as the AWS one.
func gcpArgocdURLSkipReason(f *InfraFacts) string {
	switch {
	case !f.DNSEnabled:
		return "DNS is disabled for this project — the GKE Ingress is only rendered for a DNS hostname, so no managed ArgoCD URL exists however the certificate switch is set; access ArgoCD via port-forward + the admin password."
	case f.DomainName == "":
		return "no domain is configured — the GKE Ingress has no hostname to serve, so no managed ArgoCD URL exists; set a DNS domain, or access ArgoCD via port-forward + the admin password."
	case f.ClusterName == "":
		return "no GKE cluster was provisioned for this project — there is nothing for a GKE Ingress to run on, so no managed ArgoCD URL exists."
	case !f.CertManagerEnabled():
		// Delegates rather than restating, so "you left the switch off" / "this cloud has no solver"
		// / "the identity output is missing" stay one sentence each, written once. Same shape as
		// azureArgocdURLSkipReason.
		return "the GKE cluster is provisioned, but nothing will issue its TLS certificate: " + certManagerSkipReason(f) + " The GKE Ingress sets allow-http=false, so it would serve nothing at all rather than fall back to plaintext — use port-forward + the admin password."
	}
	return ""
}

// azureArgocdURLSkipReason names WHICH of the four terms was missing, keyed on the first failing
// one. Azure has more distinct ways to not get a URL than the other clouds, and they need different
// things done about them: two are settings, one is a paid opt-in, and one is a per-cloud capability
// the operator cannot change at all. Collapsing them would tell someone to turn on a switch that is
// already on.
//
// The cert-manager arm delegates to certManagerSkipReason rather than restating it, so "the switch
// is off" / "this cloud has no solver" / "the identity output is missing" stay one sentence each,
// written once.
func azureArgocdURLSkipReason(f *InfraFacts) string {
	switch {
	case !f.DNSEnabled:
		return "DNS is disabled for this project — the Application Gateway ingress is only rendered for a DNS hostname, so no managed ArgoCD URL exists however the certificate switch is set; access ArgoCD via port-forward + the admin password."
	case f.DomainName == "":
		return "no domain is configured — the Application Gateway ingress has no hostname to serve, so no managed ArgoCD URL exists; set a DNS domain, or access ArgoCD via port-forward + the admin password."
	case f.AzureAppGatewayName == "":
		return "no Application Gateway is provisioned for this project — a v2 gateway is a standing hourly cost, so it is opt-in (azure_application_gateway_enabled, which follows the WAF switch when unset) and needs a template-provisioned VNet to carve its dedicated subnet; until then use port-forward + the admin password."
	case !f.CertManagerEnabled():
		return "the Application Gateway is provisioned, but nothing will issue its TLS certificate: " + certManagerSkipReason(f) + " ArgoCD is not published over the gateway's plaintext listener, so use port-forward + the admin password."
	}
	return ""
}

// awsArgocdURLSkipReason names which half of the AWS gate was missing. The certificate arm
// deliberately returns "" so a certificate-less deploy keeps recording the shared default,
// byte-identical to before this gate learned about DNS.
func awsArgocdURLSkipReason(f *InfraFacts) string {
	switch {
	case !f.DNSEnabled:
		return "DNS is disabled for this project — the ALB ingress is only rendered for a DNS hostname, so no managed ArgoCD URL exists however the certificate switch is set; access ArgoCD via port-forward + the admin password."
	case f.DomainName == "":
		return "no domain is configured — the ALB ingress has no hostname to serve, so no managed ArgoCD URL exists; set a DNS domain, or access ArgoCD via port-forward + the admin password."
	}
	return ""
}

// argocdURLNoIngressReason is what a cloud with no managed ArgoCD ingress records. Kept
// byte-identical to the pre-table reason.
const argocdURLNoIngressReason = "no managed ingress on this cloud yet — access ArgoCD via port-forward + the admin password."

// argocdURLDecision records whether a managed ArgoCD URL is reachable, from argocdURLGates.
func argocdURLDecision(f *InfraFacts) InfraServiceDecision {
	return perProviderDecision("argocd-url", f, argocdURLGates, argocdURLNoIngressReason)
}

// wafDecision records whether the project's web ACL is ATTACHED to anything — the honest
// answer to "I turned the WAF on, is traffic actually being filtered?". Three clouds' templates
// BUILD a WAF construct behind the canvas switch (#1810) — aws, gcp and azure — but building one
// and attaching one are different facts, and until now nothing recorded the difference: a project
// could carry a web ACL, a bill for it, and zero inspected requests. Hetzner sells none, and
// Alibaba's offer is withdrawn (#1841), so on both the honest answer is that nothing is built.
//
// On AWS the attach is the `alb.ingress.kubernetes.io/wafv2-acl-arn` annotation installArgoCD puts
// on the ArgoCD server ingress; on GCP it is a BackendConfig whose `spec.securityPolicy.name` names
// the Cloud Armor policy, bound to the ArgoCD server Service by a `cloud.google.com/backend-config`
// annotation. Different mechanisms, one shape: the construct must exist AND the ingress that carries
// it must have been configured, so this decision mirrors BOTH halves. It reads argocdURLDecision
// rather than re-deriving the ingress gate, so the two cannot drift.
//
// This ships NO ArgoCD Application on any cloud (it is an annotation or a small CR on an existing
// ingress), which is why it belongs in test/e2e/argocd_assert.go's infraServiceNoApp.
func wafDecision(f *InfraFacts) InfraServiceDecision {
	d := InfraServiceDecision{Service: "waf", Status: infraStatusSkipped}
	acl := wafWebACLRef(f)
	if acl == "" {
		d.Reason = wafNoACLReason(f.Provider)
		return d
	}
	// A cloud with no attachment site cannot bind at all — asked BEFORE "did this deploy configure
	// an ingress", because those are different questions and conflating them was fail-open.
	site, ok := wafAttachments[f.Provider]
	if !ok {
		d.Reason = wafUnattachableReason(f.Provider, acl)
		return d
	}
	if !site.attached(f) {
		d.Reason = site.unattachedReason
		return d
	}
	d.Status = infraStatusInstalled
	d.Reason = site.attachedReason(acl)
	return d
}

// wafAttachment is WHERE and WHETHER a cloud binds its web ACL, plus the two sentences an operator
// reads in each case. It replaces a `map[string]bool` + two switch statements, and the reason is
// Azure: the bool could say whether a cloud binds but never WHERE, and Azure binds through
// `firewall_policy_id` on an Application Gateway — no Ingress object, no ArgoCD URL, nothing the
// "attaches to the ingress" question can express. Keeping the predicate next to its own reasons
// also stops the three from drifting, which is how a cloud ends up reporting another's mechanism.
type wafAttachment struct {
	// attached reports whether THIS deploy actually bound it. Distinct from membership: membership
	// is a fact about the cloud, this is a fact about the deploy.
	attached func(*InfraFacts) bool
	// attachedReason names the object an operator should go and look at — "attached" alone is not
	// actionable when the object differs per cloud.
	attachedReason func(ref string) string
	// unattachedReason explains a construct that was built and bound to nothing on a cloud that
	// COULD have bound it, i.e. the deploy's fault rather than the cloud's.
	unattachedReason string
}

// wafAttachments is the per-cloud attachment site. Absence means the cloud cannot bind at all and
// `wafUnattachableReason` explains why — fail-closed, so a lane that starts exporting a reference
// without adding a site here reports it UNATTACHED rather than inheriting another cloud's mechanism.
var wafAttachments = map[string]wafAttachment{
	"aws": {
		// Mirrors BOTH halves: the ACL must exist AND the ingress that carries the annotation must
		// have been configured. Reads argocdURLDecision rather than re-deriving the ingress gate,
		// so the two cannot drift.
		attached: func(f *InfraFacts) bool { return argocdURLDecision(f).Status == infraStatusInstalled },
		attachedReason: func(ref string) string {
			return fmt.Sprintf("attached (%s) — the ArgoCD ingress carries alb.ingress.kubernetes.io/wafv2-acl-arn, so the ALB inspects every request it serves.", ref)
		},
		unattachedReason: "a web ACL was built but this deploy configured no managed ingress to attach it to — the ACL exists, is billed, and inspects nothing.",
	},
	"gcp": {
		// Same shape as AWS — the BackendConfig binds the policy to the GCLB backend service the
		// GKE Ingress provisions, so without the Ingress there is no backend service to bind to.
		attached: func(f *InfraFacts) bool { return argocdURLDecision(f).Status == infraStatusInstalled },
		attachedReason: func(ref string) string {
			return fmt.Sprintf("attached (%s) — a BackendConfig binds the Cloud Armor policy to the GCLB backend service the GKE Ingress provisions, so the load balancer evaluates it on every request it serves.", ref)
		},
		unattachedReason: "a Cloud Armor policy was built but this deploy configured no managed ingress to attach it to — the policy exists, is billed, and inspects nothing.",
	},
	"azure": {
		// Deliberately NOT argocdURLDecision. The gateway filters everything it serves the moment
		// firewall_policy_id is set, and on Azure that is decided in the template — ArgoCD's own
		// exposure (blocked on #1825) has nothing to do with it. The template drives the WAF_v2 SKU
		// and firewall_policy_id from one term, so a gateway plus a policy is an attachment.
		attached: func(f *InfraFacts) bool { return f.AzureAppGatewayName != "" },
		attachedReason: func(ref string) string {
			return fmt.Sprintf("attached (%s) — the Application Gateway carries firewall_policy_id on a WAF_v2 SKU, so every request it serves is inspected.", ref)
		},
		unattachedReason: "a WAF policy was built but no Application Gateway was provisioned to bind it to — on Azure a policy attaches to a gateway (firewall_policy_id) and never to an Ingress annotation, so the policy exists, is billed, and inspects nothing. Enable the Application Gateway (azure_application_gateway_enabled) on a template-provisioned VNet.",
	},
}

// wafWebACLRef returns the web ACL / security-policy reference this cloud EXPORTS for the
// runner to attach, and "" when it exports none. One arm per cloud, so a lane wiring Cloud
// Armor to a GCP ingress adds its line here rather than widening a boolean.
func wafWebACLRef(f *InfraFacts) string {
	switch f.Provider {
	case "aws":
		return f.WAFWebACLArn
	case "gcp":
		// The Cloud Armor security policy NAME. Its root output (`cloud_armor_policy_name`) did not
		// exist until this lane: the module had exported policy_id/policy_self_link since it was
		// written and the root swallowed both, so the policy was created, billed, and unreachable.
		return f.GCPArmorPolicy
	case "azure":
		// The Application Gateway WAF policy id. Unlike AWS's and GCP's, the runner never ATTACHES
		// this one: on Azure the bind is `firewall_policy_id` on the gateway, performed by the
		// template at apply time. The reference is exported so the deploy can REPORT the
		// attachment honestly, not to perform it.
		return f.AzureWAFPolicyID
	default:
		// hetzner and alibaba, for DIFFERENT reasons, both of them settled: Hetzner sells no
		// managed WAF at all, and Alibaba's offer is withdrawn (#1841) because WAF 3.0 is an
		// account-level purchase a per-project state model cannot own. Neither builds anything,
		// so neither has a reference to export. The three clouds that do — aws and gcp attach
		// theirs to the ingress, azure's is bound by the template — all carry a `wafAttachments`
		// entry, which is why the unattachable arm below is now a backstop rather than a live path.
		return ""
	}
}

// wafUnattachableReason explains a built-but-unbindable WAF: a cloud exported a reference and has no
// `wafAttachments` entry to bind it with.
//
// UNREACHABLE TODAY, ON PURPOSE. Alibaba was its only live caller and its offer is withdrawn
// (#1841), so every cloud that now exports a reference also has an attachment site. It stays because
// it is the fail-closed half of wafDecision: the next lane to export a reference before wiring its
// attachment reports the WAF UNATTACHED here rather than inheriting another cloud's "attached"
// claim. Deleting it would turn that lane's first deploy into a silent fail-open.
// The provider is deliberately unnamed: withdrawing Alibaba's offer (#1841) removed the only
// per-cloud branch this had, and the generic sentence names no cloud. The parameter stays so the
// next lane that needs a per-cloud reason re-adds a `switch` rather than changing every call site.
func wafUnattachableReason(_, ref string) string {
	return fmt.Sprintf("a web ACL (%s) was built and nothing on this cloud can attach it yet — it exists, is billed, and inspects nothing.", ref)
}

// wafNoACLReason explains why there was no web ACL reference to attach, keyed on the cloud so
// "you left the switch off" is never confused with "this cloud cannot do it".
func wafNoACLReason(provider string) string {
	switch provider {
	case "aws":
		return "no web ACL was built — turn the WAF switch on for this project to create a regional web ACL and attach it to the ingress."
	case "gcp":
		// Now that the policy IS reachable, GCP must stop falling into the "this cloud has nowhere to
		// attach it" default below: on GCP the only remaining reason there is nothing to attach is
		// that the operator left the switch off, and telling them otherwise would send them to fix a
		// gap that no longer exists.
		return "no Cloud Armor policy was built — turn the WAF switch on for this project to create a security policy and bind it to the ingress's backend service."
	case "azure":
		return "no WAF policy was built — turn the WAF switch on for this project to create an Application Gateway WAF policy; the template then also provisions the Application Gateway it binds to."
	case "alibaba":
		// NOT "turn the switch on" — there is no switch to turn on any more, and promising one
		// would send the operator looking for a control the canvas now renders disabled. The offer
		// is withdrawn (#1841): WAF 3.0 is an account-level purchase (`alicloud_wafv3_instance`
		// takes no arguments at all, and its create/delete are CreatePostpaidInstance /
		// ReleaseInstance), so one project destroying it would release the firewall for every other
		// project in the account.
		return "Alethia does not provision a WAF on Alibaba Cloud — WAF 3.0 is an account-level purchase there, and a project that owned it would release the whole account's firewall when it was destroyed. Buy a WAF 3.0 instance in your account and put it in front of your ingress from the WAF console."
	case "hetzner":
		return "Hetzner sells no managed WAF — run your own edge (or an in-cluster WAF add-on) if you need request filtering."
	default:
		return "the template builds a web ACL but this cloud has no ingress to attach it to yet — it would be created and left inspecting nothing."
	}
}
