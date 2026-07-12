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
	// One of: "external-dns" | "external-secrets-store" | "ingress" | "storage-class" | "argocd-url".
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
	return []InfraServiceDecision{
		externalDNSDecision(f),
		externalSecretsStoreDecision(f),
		ingressDecision(f),
		storageClassDecision(f),
		argocdURLDecision(f),
	}
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

// ingressDecision records the ingress controller: AWS ships the ALB controller in-template;
// every other cloud has a cloud load balancer available but no controller wired by default,
// so the ingress-nginx add-on is the path.
func ingressDecision(f *InfraFacts) InfraServiceDecision {
	d := InfraServiceDecision{Service: "ingress"}
	if f.Provider == "aws" {
		d.Status = infraStatusInstalled
		d.Reason = "installed (AWS Load Balancer Controller) — Ingress objects provision ALBs."
		return d
	}
	d.Status = infraStatusSkipped
	d.Reason = "skipped — a cloud load balancer is available; install the ingress-nginx add-on to expose Ingress objects."
	return d
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

// argocdURLDecision records whether a managed ArgoCD URL is reachable: only AWS wires the
// ALB ingress (gated on the ACM certificate), giving a stable URL. Every other cloud has no
// managed ingress yet, so ArgoCD is reached via port-forward + the admin password.
func argocdURLDecision(f *InfraFacts) InfraServiceDecision {
	d := InfraServiceDecision{Service: "argocd-url"}
	if f.Provider == "aws" && f.ACMCertificateArn != "" {
		d.Status = infraStatusInstalled
		d.Reason = "installed — ArgoCD is exposed over the ALB ingress (ACM certificate present)."
		return d
	}
	d.Status = infraStatusSkipped
	d.Reason = "no managed ingress on this cloud yet — access ArgoCD via port-forward + the admin password."
	return d
}
