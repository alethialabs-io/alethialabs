// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"os"

	"github.com/alethialabs-io/alethialabs/packages/core/cloud"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// InfraFacts is the cloud-agnostic set of provisioned-infrastructure facts the ArgoCD
// application templates render against. Common fields apply to every cloud; the
// per-cloud blocks (AWS IRSA / GCP Workload Identity / Azure Federated Identity) are
// populated only for the matching Provider and read by the templates behind
// `{{ if eq .Provider "…" }}` guards. Adding a cloud = a new BuildFromOutputs case +
// a per-cloud block here + the template branches (see packages/core/cloud/README.md).
type InfraFacts struct {
	ProjectName  string
	Environment  string
	Region       string
	Provider     string // aws | gcp | azure | alibaba | hetzner
	DomainName   string
	DNSZoneID    string
	DNSEnabled   bool   // vc.DNS.Enabled — templates must not render DNS-dependent apps without it
	DNSConnector string // vc.DNS.Provider — ""/"native" = cloud-native; "cloudflare" = the DNS connector
	// DNSCredentialPresent is true when the token the selected DNS backend needs is
	// actually available (cloudflare connector credential / hetzner HCLOUD_TOKEN).
	// The token itself NEVER lives on the facts — facts are rendered into templates.
	DNSCredentialPresent bool
	EnableKarpenter      bool

	ClusterName     string
	ClusterEndpoint string
	ClusterArn      string // AWS EKS ARN (empty on GCP/Azure)

	AppsDestinationRepo string

	// Labels are the classification + sweep-handle Kubernetes labels (cloud.ClassificationLabels)
	// stamped onto metadata.labels of every rendered ArgoCD Application/AppProject (BYOC B1.4).
	// Attribution/selection only — never secrets (facts are rendered into templates).
	Labels map[string]string

	// ── AWS (IRSA) ──────────────────────────────────────────────
	AWSAccountID           string
	VPCID                  string
	ACMCertificateArn      string
	IRSAExternalDNSArn     string
	IRSAALBControllerArn   string
	IRSAExternalSecretsArn string // IRSA role for the external-secrets operator (gates secretstore-aws)
	NodeIAMRoleName        string
	NodeSecurityGroup      string
	KarpenterQueueName     string

	// ── GCP (Workload Identity) ─────────────────────────────────
	GCPProjectID         string
	GCPExternalDNSSA     string // GSA email bound to the external-dns KSA
	GCPIngressSA         string // GSA email for the ingress/gateway controller
	GCPExternalSecretsSA string // GSA email bound to the external-secrets KSA (gates secretstore-gcp)

	// ── Azure (Federated / Workload Identity) ───────────────────
	AzureResourceGroup         string
	AzureTenantID              string
	AzureExternalDNSClient     string // managed-identity client id for external-dns
	AzureIngressClient         string // managed-identity client id for the AGIC
	AzureExternalSecretsClient string // managed-identity client id for the external-secrets operator (gates secretstore-azure)
	AzureKeyVaultURI           string // project Key Vault URI (the azurekv store's vaultUrl)

	// ── Alibaba (RRSA — RAM Roles for Service Accounts) ─────────
	AlibabaOIDCIssuerURL          string // ACK cluster OIDC issuer
	AlibabaOIDCProviderArn        string // RAM OIDC provider ARN that RRSA roles trust
	AlibabaExternalSecretsRoleArn string // RRSA RAM role for the external-secrets operator (gates secretstore-alibaba)
}

// DNSProvider maps the cloud (and DNS connector) to the external-dns `provider` value.
// An empty return means "no working external-dns backend for this configuration" — the
// template's render gate skips the app entirely rather than deploying a broken one
// (the pre-parity behavior was to fall back to "aws" on every unknown cloud, which shipped
// external-dns with a malformed IRSA annotation on alibaba/hetzner).
func (f *InfraFacts) DNSProvider() string {
	// A non-native DNS connector overrides the cloud-native backend on every cloud.
	// Cloudflare is the only pluggable DNS connector today; it renders only when its
	// api_token credential actually reached the job (fail-closed, not crash-loop).
	if f.DNSConnector != "" && f.DNSConnector != "native" {
		if f.DNSConnector == "cloudflare" && f.DNSCredentialPresent {
			return "cloudflare"
		}
		return ""
	}
	switch f.Provider {
	case "aws":
		return "aws"
	case "gcp":
		// Same honesty rule: without the Workload Identity GSA output the controller
		// would ship with an empty identity annotation and crash-loop.
		if f.GCPExternalDNSSA == "" {
			return ""
		}
		return "google"
	case "azure":
		if f.AzureExternalDNSClient == "" {
			return ""
		}
		return "azure"
	case "alibaba":
		// "alibabacloud" once RRSA identity is provisioned (A5); no identity → honest skip.
		return ""
	case "hetzner":
		// Hetzner Cloud DNS via the official external-dns webhook sidecar, driven by the
		// same Cloud API token the connector already holds.
		if !f.DNSCredentialPresent {
			return ""
		}
		return "webhook"
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
		ProjectName:          vc.ProjectName,
		Environment:          vc.EnvironmentStage,
		Region:               vc.Region,
		Provider:             string(vc.Provider),
		DomainName:           vc.DNS.DomainName,
		DNSZoneID:            vc.DNS.ZoneID,
		DNSEnabled:           vc.DNS.Enabled,
		DNSConnector:         vc.DNS.Provider,
		DNSCredentialPresent: dnsCredentialPresent(vc),
		EnableKarpenter:      enableKarpenter,
		AppsDestinationRepo:  vc.Repositories.AppsDestinationRepo,
		Labels:               cloud.ClassificationLabels(vc),
	}

	// Switch on the string form: the per-cloud output keys are string-addressed, and the
	// string-literal cases below are clearer here than the CloudProvider constants.
	switch string(vc.Provider) {
	case "gcp":
		f.ClusterName = ExtractOutput(outputs, "gke_cluster_name")
		f.ClusterEndpoint = ExtractOutput(outputs, "gke_cluster_endpoint")
		f.GCPProjectID = firstNonEmpty(ExtractOutput(outputs, "gcp_project_id"), vc.CloudAccountID)
		f.GCPExternalDNSSA = ExtractOutput(outputs, "external_dns_service_account")
		f.GCPIngressSA = ExtractOutput(outputs, "ingress_service_account")
		f.GCPExternalSecretsSA = ExtractOutput(outputs, "external_secrets_service_account")
	case "azure":
		f.ClusterName = ExtractOutput(outputs, "aks_cluster_name")
		f.ClusterEndpoint = ExtractOutput(outputs, "aks_cluster_endpoint")
		f.AzureResourceGroup = ExtractOutput(outputs, "resource_group_name")
		f.AzureTenantID = firstNonEmpty(ExtractOutput(outputs, "azure_tenant_id"), vc.CloudAccountID)
		f.AzureExternalDNSClient = ExtractOutput(outputs, "external_dns_client_id")
		f.AzureIngressClient = ExtractOutput(outputs, "ingress_client_id")
		f.AzureExternalSecretsClient = ExtractOutput(outputs, "external_secrets_client_id")
		f.AzureKeyVaultURI = ExtractOutput(outputs, "key_vault_uri")
	case "alibaba":
		f.ClusterName = ExtractOutput(outputs, "ack_cluster_name")
		f.ClusterEndpoint = ExtractOutput(outputs, "ack_cluster_endpoint")
		f.VPCID = ExtractOutput(outputs, "vpc_id")
		f.AlibabaOIDCIssuerURL = ExtractOutput(outputs, "rrsa_oidc_issuer_url")
		f.AlibabaOIDCProviderArn = ExtractOutput(outputs, "rrsa_oidc_provider_arn")
		f.AlibabaExternalSecretsRoleArn = ExtractOutput(outputs, "external_secrets_ram_role_arn")
		// The RRSA facts feed workload-identity for in-cluster components (the
		// external-secrets store renders off the role ARN above). external-dns's
		// alibabacloud provider does NOT
		// support RRSA upstream (kubernetes-sigs/external-dns#5019), so DNSProvider()
		// still skips external-dns on alibaba — an honest gap, recorded in the docs.
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
		f.IRSAExternalSecretsArn = ExtractOutput(outputs, "eks_irsa_external_secrets_arn")
		f.NodeIAMRoleName = ExtractOutput(outputs, "node_iam_role_name")
		f.NodeSecurityGroup = ExtractOutput(outputs, "node_security_group")
		f.KarpenterQueueName = ExtractOutput(outputs, "karpenter_queue_name")
	default:
		// Unknown/connect-only clouds (digitalocean, civo): common facts only — never
		// fall through to another cloud's output keys.
	}

	return f
}

// dnsCredentialPresent reports whether the token the config's DNS backend needs is
// available in this process. Cloudflare's api_token arrives on the job at claim time
// (ConnectorCredentials); Hetzner's Cloud API token is the runner's activated
// HCLOUD_TOKEN. Cloud-native backends (aws/gcp/azure) authenticate via workload
// identity, not a token — they report true and are gated on their identity outputs
// in DNSProvider() instead.
func dnsCredentialPresent(vc *types.ProjectConfig) bool {
	if vc.DNS.Provider == "cloudflare" {
		return vc.ConnectorCredentialFor("dns", "cloudflare")["api_token"] != ""
	}
	if vc.Provider == "hetzner" {
		return os.Getenv("HCLOUD_TOKEN") != ""
	}
	return true
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
