// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// InfraFacts is the cloud-agnostic set of provisioned-infrastructure facts the ArgoCD
// application templates render against. Common fields apply to every cloud; the
// per-cloud blocks (AWS IRSA / GCP Workload Identity / Azure Federated Identity) are
// populated only for the matching Provider and read by the templates behind
// `{{ if eq .Provider "…" }}` guards. Adding a cloud = a new BuildFromOutputs case +
// a per-cloud block here + the template branches (see packages/core/cloud/README.md).
type InfraFacts struct {
	ProjectName     string
	Environment     string
	Region          string
	Provider        string // aws | gcp | azure | alibaba | hetzner
	DomainName      string
	DNSZoneID       string
	DNSEnabled      bool   // vc.DNS.Enabled — templates must not render DNS-dependent apps without it
	DNSConnector    string // vc.DNS.Provider — ""/"native" = cloud-native; "cloudflare" = the DNS connector
	EnableKarpenter bool

	ClusterName     string
	ClusterEndpoint string
	ClusterArn      string // AWS EKS ARN (empty on GCP/Azure)

	AppsDestinationRepo string

	// ── AWS (IRSA) ──────────────────────────────────────────────
	AWSAccountID         string
	VPCID                string
	ACMCertificateArn    string
	IRSAExternalDNSArn   string
	IRSAALBControllerArn string
	NodeIAMRoleName      string
	NodeSecurityGroup    string
	KarpenterQueueName   string

	// ── GCP (Workload Identity) ─────────────────────────────────
	GCPProjectID     string
	GCPExternalDNSSA string // GSA email bound to the external-dns KSA
	GCPIngressSA     string // GSA email for the ingress/gateway controller

	// ── Azure (Federated / Workload Identity) ───────────────────
	AzureResourceGroup     string
	AzureTenantID          string
	AzureExternalDNSClient string // managed-identity client id for external-dns
	AzureIngressClient     string // managed-identity client id for the AGIC
}

// DNSProvider maps the cloud (and DNS connector) to the external-dns `provider` value.
// An empty return means "no working external-dns backend for this configuration" — the
// template's render gate skips the app entirely rather than deploying a broken one
// (the pre-parity behavior was to fall back to "aws" on every unknown cloud, which shipped
// external-dns with a malformed IRSA annotation on alibaba/hetzner).
func (f *InfraFacts) DNSProvider() string {
	// A non-native DNS connector overrides the cloud-native backend. Cloudflare rendering
	// lands with the connector-aware branch (A3); until then it skips honestly.
	if f.DNSConnector != "" && f.DNSConnector != "native" {
		return ""
	}
	switch f.Provider {
	case "aws":
		return "aws"
	case "gcp":
		return "google"
	case "azure":
		return "azure"
	case "alibaba":
		// "alibabacloud" once RRSA identity is provisioned (A5); no identity → honest skip.
		return ""
	case "hetzner":
		// Hetzner has no native external-dns provider; the official webhook lands in A4.
		return ""
	default:
		return ""
	}
}

// BuildFromOutputs assembles InfraFacts from the tofu outputs for the config's cloud.
// Common facts come from the ProjectConfig; the cloud-specific cluster + workload-identity
// outputs are extracted per provider. Every cloud gets an explicit case — an unknown
// provider yields common facts only, never another cloud's output keys.
func BuildFromOutputs(outputs map[string]interface{}, vc *types.ProjectConfig) *InfraFacts {
	enableKarpenter := false
	if v, ok := vc.Cluster.ProviderConfig["enable_karpenter"]; ok {
		if b, ok := v.(bool); ok {
			enableKarpenter = b
		}
	}

	f := &InfraFacts{
		ProjectName:         vc.ProjectName,
		Environment:         vc.EnvironmentStage,
		Region:              vc.Region,
		Provider:            vc.Provider,
		DomainName:          vc.DNS.DomainName,
		DNSZoneID:           vc.DNS.ZoneID,
		DNSEnabled:          vc.DNS.Enabled,
		DNSConnector:        vc.DNS.Provider,
		EnableKarpenter:     enableKarpenter,
		AppsDestinationRepo: vc.Repositories.AppsDestinationRepo,
	}

	switch vc.Provider {
	case "gcp":
		f.ClusterName = ExtractOutput(outputs, "gke_cluster_name")
		f.ClusterEndpoint = ExtractOutput(outputs, "gke_cluster_endpoint")
		f.GCPProjectID = firstNonEmpty(ExtractOutput(outputs, "gcp_project_id"), vc.CloudAccountID)
		f.GCPExternalDNSSA = ExtractOutput(outputs, "external_dns_service_account")
		f.GCPIngressSA = ExtractOutput(outputs, "ingress_service_account")
	case "azure":
		f.ClusterName = ExtractOutput(outputs, "aks_cluster_name")
		f.ClusterEndpoint = ExtractOutput(outputs, "aks_cluster_endpoint")
		f.AzureResourceGroup = ExtractOutput(outputs, "resource_group_name")
		f.AzureTenantID = firstNonEmpty(ExtractOutput(outputs, "azure_tenant_id"), vc.CloudAccountID)
		f.AzureExternalDNSClient = ExtractOutput(outputs, "external_dns_client_id")
		f.AzureIngressClient = ExtractOutput(outputs, "ingress_client_id")
	case "alibaba":
		f.ClusterName = ExtractOutput(outputs, "ack_cluster_name")
		f.ClusterEndpoint = ExtractOutput(outputs, "ack_cluster_endpoint")
		f.VPCID = ExtractOutput(outputs, "vpc_id")
		// Workload-identity (RRSA) facts land with the alibaba external-dns work; until
		// then no identity block exists and DNS-dependent apps skip via DNSProvider().
	case "hetzner":
		f.ClusterName = ExtractOutput(outputs, "talos_cluster_name")
		f.ClusterEndpoint = ExtractOutput(outputs, "talos_cluster_endpoint")
		// No cloud IAM on Hetzner — no identity block by design.
	case "aws":
		f.ClusterName = ExtractOutput(outputs, "eks_cluster_name")
		f.ClusterEndpoint = ExtractOutput(outputs, "eks_cluster_endpoint")
		f.ClusterArn = ExtractOutput(outputs, "eks_cluster_arn")
		f.AWSAccountID = vc.CloudAccountID
		f.VPCID = ExtractOutput(outputs, "vpc_id")
		f.ACMCertificateArn = ExtractOutput(outputs, "acm_certificate_arn")
		f.IRSAExternalDNSArn = ExtractOutput(outputs, "eks_irsa_external_dns_arn")
		f.IRSAALBControllerArn = ExtractOutput(outputs, "eks_irsa_alb_controller_arn")
		f.NodeIAMRoleName = ExtractOutput(outputs, "node_iam_role_name")
		f.NodeSecurityGroup = ExtractOutput(outputs, "node_security_group")
		f.KarpenterQueueName = ExtractOutput(outputs, "karpenter_queue_name")
	default:
		// Unknown/connect-only clouds (digitalocean, civo): common facts only — never
		// fall through to another cloud's output keys.
	}

	return f
}

// firstNonEmpty returns the first non-empty string.
func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

func ExtractOutput(outputs map[string]interface{}, key string) string {
	val, ok := outputs[key]
	if !ok || val == nil {
		return ""
	}
	if s, ok := val.(string); ok {
		return s
	}
	if m, ok := val.(map[string]interface{}); ok {
		if v, ok := m["value"].(string); ok {
			return v
		}
	}
	return ""
}
