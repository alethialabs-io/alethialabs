// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"os"

	"github.com/alethialabs-io/alethialabs/packages/core/categories"
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
	// ManagedCertificate is vc.DNS.ManagedCertificate — the canvas's "issue a managed TLS
	// certificate for this domain" switch. It is NOT a tofu output: it is the user's ASK,
	// carried verbatim from the config snapshot, and it is what gates the cert-manager
	// platform Application (infra/templates/argocd/cert-manager.yaml). Every cloud ALSO
	// fronts the same switch with its own tfvar (acm_certificate_enable,
	// cloud_dns_managed_certificate, …) for the cloud-NATIVE certificate; the in-cluster
	// issuer is the portable half, and the only half Alethia can offer on a cloud whose
	// native certificate has nothing to attach to.
	ManagedCertificate bool
	EnableKarpenter    bool

	ClusterName     string
	ClusterEndpoint string
	ClusterArn      string // AWS EKS ARN (empty on GCP/Azure)

	AppsDestinationRepo string

	// Labels are the classification + sweep-handle Kubernetes labels (cloud.ClassificationLabels)
	// stamped onto metadata.labels of every rendered ArgoCD Application/AppProject (BYOC B1.4).
	// Attribution/selection only — never secrets (facts are rendered into templates).
	Labels map[string]string

	// ── AWS (IRSA) ──────────────────────────────────────────────
	AWSAccountID      string
	VPCID             string
	ACMCertificateArn string
	// WAFWebACLArn is the REGIONAL wafv2 web ACL the template built for the project's
	// application WAF switch (root output `waf_webacl_arn`, null when the switch is off).
	// A REFERENCE, not a credential. Empty ⇒ no `wafv2-acl-arn` annotation is emitted at
	// all: the ALB controller rejects an empty annotation value and wedges the ingress.
	WAFWebACLArn           string
	IRSAExternalDNSArn     string
	IRSAALBControllerArn   string
	IRSAExternalSecretsArn string // IRSA role for the external-secrets operator (gates secretstore-aws)
	NodeIAMRoleName        string
	NodeSecurityGroup      string
	KarpenterQueueName     string

	// ── GCP (Workload Identity) ─────────────────────────────────
	GCPProjectID     string
	GCPExternalDNSSA string // GSA email bound to the external-dns KSA
	// GCPDNSZoneName is the Cloud DNS MANAGED-ZONE resource name (root output
	// `cloud_dns_zone_name`), not the domain. cert-manager's cloudDNS solver is rendered
	// with it explicitly because the external-dns GSA's dns.admin grant is ZONE-scoped and
	// therefore carries no project-level dns.managedZones.list — without the name the
	// solver cannot find the zone it is allowed to write to.
	GCPDNSZoneName string
	// GCPIngressSA is wired to the output key `ingress_service_account`, which NO template exports —
	// so it has been "" on every deploy since it was written. The GKE ingress lane deliberately did
	// not use it and deliberately did not export one to match: GKE's Ingress controller runs in the
	// Google-managed control plane and authenticates as the cluster's own service agent, so there is
	// no in-cluster workload identity to annotate. Left in place rather than deleted because removing
	// it is a rename across the Azure/Alibaba lanes landing beside this one; tracked separately.
	GCPIngressSA         string // GSA email for the ingress/gateway controller — SEE ABOVE: permanently empty
	GCPExternalSecretsSA string // GSA email bound to the external-secrets KSA (gates secretstore-gcp)
	// GCPManagedCertName is the GLOBAL Google-managed SSL certificate the template built for the
	// project's certificate switch (root output `cloud_dns_managed_certificate_name`; null when the
	// switch is off, or when a pluggable DNS connector means the zone is not ours). A NAME, because
	// `ingress.gcp.kubernetes.io/pre-shared-cert` takes a comma-separated list of certificate names
	// and nothing else — an id or a self link there is rejected.
	//
	// IT NO LONGER GATES ANYTHING (#1858). The GKE platform ingress gets its TLS from cert-manager,
	// like every other cloud's managed_certificate switch, so `CertManagerEnabled()` is what decides
	// whether that ingress renders and this name is attached to nothing. It is still read — and only
	// read — so installArgoCD can TELL the operator that the certificate their switch created is now
	// unattached and will therefore sit in PROVISIONING/FAILED_NOT_VISIBLE. Dropping the fact would
	// turn that into a silent one. It goes when the resource does, in the lane that moves the
	// `dns:managed_certificate` offer-parity carrier onto the in-cluster issuer.
	GCPManagedCertName string
	// GCPArmorPolicy is the Cloud Armor security policy the template built for the project's WAF
	// switch (root output `cloud_armor_policy_name`, null when the switch is off). A REFERENCE, not
	// a credential. The NAME, because a GKE BackendConfig's `spec.securityPolicy.name` resolves a
	// bare policy name inside the cluster's own project. Empty ⇒ NO BackendConfig is rendered at all:
	// one carrying an empty securityPolicy name is not "no WAF", it is a resource the GKE ingress
	// controller rejects, which wedges the ingress — the GCP shape of the empty-wafv2-annotation trap.
	GCPArmorPolicy string

	// ── Azure (Federated / Workload Identity) ───────────────────
	AzureResourceGroup string
	AzureTenantID      string
	// AzureSubscriptionID is the subscription the project's resource group, DNS zone and gateway
	// live in. Read output-first with the config snapshot's CloudAccountID as the fallback — this
	// lane adds the `azure_subscription_id` output, and CloudAccountID is the identical value
	// azure_provider.go emits as the `subscription_id` tfvar, so the two cannot disagree about
	// what was applied.
	//
	// TWO consumers, which is why the fallback is load-bearing rather than a nicety:
	// cert-manager's azureDNS solver requires it explicitly (there is no ambient default from the
	// workload identity), and it is the AGIC chart's `appgw.subscriptionId`. Dropping the fallback
	// would leave cert-manager permanently skipped on every environment whose state predates the
	// new output — the exact latent bug the cert-manager lane fixed for Azure.
	AzureSubscriptionID    string
	AzureExternalDNSClient string // managed-identity client id for external-dns
	AzureIngressClient     string // managed-identity client id for the AGIC
	// AzureAppGatewayName is the Application Gateway AGIC reconciles Ingress objects onto, and the
	// resource the project's WAF policy binds to. Empty ⇒ this deploy provisioned no gateway, which
	// means BOTH no ingress controller and nothing for a web ACL to attach to (root output
	// `application_gateway_name`, null when the gateway is off).
	AzureAppGatewayName string
	// AzureWAFPolicyID is the Application Gateway WAF policy built for the project's WAF switch
	// (root output `waf_policy_id`, null — so "" — when the switch is off). A REFERENCE, not a
	// credential, and unlike AWS's one the runner never ATTACHES: on Azure the bind is
	// `firewall_policy_id` on the gateway, performed by the template at apply time. This fact
	// exists so the deploy can REPORT the attachment honestly, not to perform it.
	AzureWAFPolicyID           string
	AzureExternalSecretsClient string // managed-identity client id for the external-secrets operator (gates secretstore-azure)
	AzureKeyVaultURI           string // project Key Vault URI (the azurekv store's vaultUrl)

	// ── Alibaba (RRSA — RAM Roles for Service Accounts) ─────────
	AlibabaOIDCIssuerURL          string // ACK cluster OIDC issuer
	AlibabaOIDCProviderArn        string // RAM OIDC provider ARN that RRSA roles trust
	AlibabaExternalSecretsRoleArn string // RRSA RAM role for the external-secrets operator (gates secretstore-alibaba)
	// AlibabaWAFInstanceID is the WAF 3.0 instance the template bought for the project's
	// application WAF switch (root output `waf_instance_id`, null when the switch is off).
	// A REFERENCE, not a credential — and, unlike AWS's web ACL, one with NOTHING BOUND TO IT:
	// the pinned alicloud provider can only bind a hostname (alicloud_wafv3_domain, CNAME mode),
	// which needs the ingress load balancer's address, and that does not exist at plan time.
	// The fact exists so wafDecision can say "built and billed and filtering nothing" instead of
	// leaving that indistinguishable from "the switch is off".
	AlibabaWAFInstanceID string

	// ── Cross-account keyless secret manager (*-xacct) ──────────
	// The ADDITIONAL foreign-account secret store the project selected (AWS SM / GCP SM / Azure KV /
	// Alibaba KMS in a DIFFERENT account than the cluster), layered on top of the native store. Built
	// from the connector provider_config (categories.DominantKeylessSecretTarget), NOT tofu outputs —
	// the cross-account read is performed by ESO itself. Empty → no cross-account store renders
	// (fail-closed). The store renders only when BOTH these AND the cloud's external-secrets identity
	// fact above are present. An identity/resource REFERENCE, never a key.
	SecretsXacctRef             string // aws/alibaba: target role ARN the ESO identity assumes; azure: target Key Vault URL
	SecretsXacctRegion          string // aws, alibaba
	SecretsXacctProjectID       string // gcp: the target project the store reads
	SecretsXacctOIDCProviderRef string // alibaba only: the target-account RAM OIDC provider ARN (see KeylessSecretTarget)
	SecretsXacctExternalID      string // aws only, OPTIONAL: the sts:ExternalId the target role's trust policy requires (see KeylessSecretTarget)
	// SecretsXacctSlug is the *-xacct connector slug that selected the store (e.g. "aws-sm-xacct").
	// The cross-account store is DOMINANT per project, so the manifest lane needs the slug to tell
	// WHICH project secrets may be read through it: a secret selecting a DIFFERENT xacct slug has no
	// store of its own and must stay unresolved rather than silently read the dominant account.
	SecretsXacctSlug string

	// ── Pluggable SaaS secret store (Vault / OpenBao / Doppler / generic Vault-compatible) ──
	// The credential-based external store the project selected via the `secrets` connector, that ESO
	// reads IN-CLUSTER with a STATIC token seeded into an in-cluster Secret (categories.SecretsSaaSStore).
	// Cloud-AGNOSTIC (renders on any provider incl. Hetzner, which has no native store), and REPLACES
	// the native store as the secret source. nil → none selected, or the store has no first-class ESO
	// runtime-read path on the pinned chart (infisical / 1Password — documented exclusions). Built from
	// the connector provider_config + a credential-presence check (fail-closed); the token itself is
	// seeded out-of-band by the runner and NEVER lives on the facts (facts render into manifests).
	SecretsSaaS *categories.SecretsSaaSStore
}

// XacctSecretStore reports the cross-account (*-xacct) ClusterSecretStore for this deploy.
// `name` is the store externalSecretsStoreTemplate actually renders ("secretstore-<cloud>-xacct")
// and is "" when the render gate is closed; `selected` says whether the project chose a
// cross-account secret manager at all, so a caller can tell "not selected" (stay silent) from
// "selected but fail-closed" (say so, loudly).
//
// SINGLE GATE. The template's *-xacct branches, CleanupSkippedInfraServices' reap map,
// externalSecretsXacctStoreDecision and the manifest lane that points ExternalSecrets at the store
// all read this, so they cannot drift apart — the drift is not hypothetical: the decision used to
// report "installed" for facts the template renders nothing for, because the two lists of gate
// conditions were maintained by hand in four places.
//
// Fail-closed on both halves of every lane: the CLUSTER's own external-secrets identity fact must be
// present (without it ESO has nothing to authenticate as) AND the cross-account target from the
// connector provider_config must be present (without it there is nothing to read).
func (f *InfraFacts) XacctSecretStore() (name string, selected bool) {
	selected = f.SecretsXacctRef != "" || f.SecretsXacctProjectID != ""
	if !selected {
		return "", false
	}
	renders := false
	switch f.Provider {
	case "aws":
		renders = f.IRSAExternalSecretsArn != "" && f.SecretsXacctRef != ""
	case "gcp":
		renders = f.GCPExternalSecretsSA != "" && f.SecretsXacctProjectID != ""
	case "azure":
		renders = f.AzureExternalSecretsClient != "" && f.SecretsXacctRef != ""
	case "alibaba":
		renders = f.AlibabaExternalSecretsRoleArn != "" && f.SecretsXacctRef != "" && f.SecretsXacctOIDCProviderRef != ""
	}
	if !renders {
		return "", true
	}
	return categories.XacctStoreName(f.Provider), true
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

// certManagerDNS01Solvers maps a cloud to the cert-manager DNS01 solver stanza that can
// actually issue there. It is an ALLOWLIST of solvers cert-manager ships IN THE BOX, and
// the exclusions are as load-bearing as the entries:
//
//	aws     — route53,  authenticated by the IRSA role external-dns already holds.
//	gcp     — clouddns, authenticated by the Workload-Identity GSA external-dns already holds.
//	azure   — azuredns, authenticated by the federated identity external-dns already holds.
//	alibaba — EXCLUDED. cert-manager has no AliDNS solver; it needs a third-party webhook
//	          (cert-manager-webhook-alidns). external-dns is already skipped on Alibaba for
//	          the sibling upstream gap (external-dns#5019), so the cloud has no in-cluster
//	          DNS automation of any kind today.
//	hetzner — EXCLUDED. cert-manager has no Hetzner Cloud DNS solver; it needs a third-party
//	          webhook, exactly as external-dns needs the Hetzner webhook sidecar. Shipping a
//	          ClusterIssuer without one would create an issuer whose every Challenge is stuck
//	          `pending` forever — a certificate that never issues is WORSE than an honest skip,
//	          because nothing in the cluster reports it as broken.
//
// DNS01 and not HTTP01 on purpose: HTTP01 needs a reachable ingress, and AWS is the only
// cloud with an ingress controller today (argocd.ingressControllers). DNS01 needs only the
// zone, which every one of these three clouds provisions.
var certManagerDNS01Solvers = map[string]string{
	"aws":   "route53",
	"gcp":   "clouddns",
	"azure": "azuredns",
}

// CertManagerSolver returns the cert-manager DNS01 solver this deploy can honestly issue
// with, or "" when it cannot. It is the SINGLE GATE for the cert-manager platform add-on:
// the render template (infra/templates/argocd/cert-manager.yaml), certManagerDecision and
// CleanupSkippedInfraServices all read THIS, so they cannot drift into disagreeing about
// whether cert-manager shipped — the failure the ClusterSecretStore lanes hit twice.
//
// It fails closed on three separate things, because each of them produces an issuer that
// looks installed and never issues:
//
//   - a cloud with no in-box solver (alibaba, hetzner — see certManagerDNS01Solvers);
//   - a NON-NATIVE DNS connector (cloudflare): the cloud's own zone is then not
//     authoritative for the domain, so a route53/clouddns/azuredns solver would write its
//     TXT record into a zone the ACME server never queries. cert-manager does ship a
//     cloudflare solver, but it needs the connector's api_token seeded into the
//     cert-manager namespace, which no lane has built yet;
//   - a MISSING identity/zone fact: the solver authenticates as external-dns's identity, so
//     without that identity (or, on GCP, without the zone NAME its zone-scoped grant makes
//     mandatory) the challenge cannot be written at all.
func (f *InfraFacts) CertManagerSolver() string {
	solver, ok := certManagerDNS01Solvers[f.Provider]
	if !ok {
		return ""
	}
	if f.DNSConnector != "" && f.DNSConnector != "native" {
		return ""
	}
	switch f.Provider {
	case "aws":
		if f.IRSAExternalDNSArn == "" {
			return ""
		}
	case "gcp":
		if f.GCPExternalDNSSA == "" || f.GCPProjectID == "" || f.GCPDNSZoneName == "" {
			return ""
		}
	case "azure":
		if f.AzureExternalDNSClient == "" || f.AzureResourceGroup == "" ||
			f.AzureSubscriptionID == "" || f.AzureTenantID == "" {
			return ""
		}
	}
	return solver
}

// CertManagerEnabled reports whether the cert-manager platform Application renders for this
// deploy: the user asked for a managed certificate, DNS is on with a domain to issue for,
// and this cloud has a DNS01 solver that can actually complete a challenge. Kept as a method
// so the Go decision and the YAML template read the same predicate rather than two copies of
// the same `and` — the template gate is literally `{{- if .CertManagerEnabled }}`.
func (f *InfraFacts) CertManagerEnabled() bool {
	return f.ManagedCertificate && f.DNSEnabled && f.DomainName != "" && f.CertManagerSolver() != ""
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
		Environment:          string(vc.EnvironmentStage),
		Region:               vc.Region,
		Provider:             string(vc.Provider),
		DomainName:           vc.DNS.DomainName,
		DNSZoneID:            vc.DNS.ZoneID,
		DNSEnabled:           vc.DNS.Enabled,
		DNSConnector:         vc.DNS.Provider,
		DNSCredentialPresent: dnsCredentialPresent(vc),
		ManagedCertificate:   vc.DNS.ManagedCertificate,
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
		f.GCPDNSZoneName = ExtractOutput(outputs, "cloud_dns_zone_name")
		f.GCPIngressSA = ExtractOutput(outputs, "ingress_service_account")
		f.GCPExternalSecretsSA = ExtractOutput(outputs, "external_secrets_service_account")
		// Both keys are exported by infra/templates/project/gcp/outputs.tf and both are null when
		// their canvas switch is off — ExtractOutput yields "" for a null, which is exactly the
		// "render no ingress" / "attach nothing" signal argocdURLGates and wafWebACLRef want.
		// The spelling is pinned from BOTH sides: checks_ingress_armor.tftest.hcl asserts the output
		// names in the template, and TestGCPIngressFactsMatchTemplateOutputs asserts them here.
		f.GCPManagedCertName = ExtractOutput(outputs, "cloud_dns_managed_certificate_name")
		f.GCPArmorPolicy = ExtractOutput(outputs, "cloud_armor_policy_name")
	case "azure":
		f.ClusterName = ExtractOutput(outputs, "aks_cluster_name")
		f.ClusterEndpoint = ExtractOutput(outputs, "aks_cluster_endpoint")
		f.AzureResourceGroup = ExtractOutput(outputs, "resource_group_name")
		// Output FIRST, snapshot as the fallback — and the fallback is the load-bearing half.
		//
		// The cert-manager lane read this from `vc.CloudAccountID` alone, correctly at the time:
		// the azure template declared `subscription_id` as an input VARIABLE and exported no
		// output for it, so ExtractOutput would have returned "" forever — the permanently-empty
		// fact bug GCPIngressSA already carries. This lane ADDS `azure_subscription_id` to
		// outputs.tf, so that reasoning stops holding the moment both land.
		//
		// firstNonEmpty satisfies both: a deploy whose state predates the new output still
		// resolves from the snapshot (CloudAccountID is the identical value azure_provider.go
		// emits as that tfvar, so the two cannot disagree about what was applied), and a fresh
		// one prefers the output the template actually produced. Taking either side alone would
		// have broken the other: snapshot-only leaves AGIC without the authoritative value, and
		// output-only leaves cert-manager permanently skipped on every pre-existing environment.
		f.AzureSubscriptionID = firstNonEmpty(ExtractOutput(outputs, "azure_subscription_id"), vc.CloudAccountID)
		f.AzureTenantID = firstNonEmpty(ExtractOutput(outputs, "azure_tenant_id"), vc.CloudAccountID)
		f.AzureExternalDNSClient = ExtractOutput(outputs, "external_dns_client_id")
		// `ingress_client_id` was read here long before any template exported it, so this fact was
		// permanently "" and the AGIC render gate could never open. The azure template emits it now.
		f.AzureIngressClient = ExtractOutput(outputs, "ingress_client_id")
		f.AzureAppGatewayName = ExtractOutput(outputs, "application_gateway_name")
		// null when azure_waf_enabled is off — ExtractOutput yields "" for a null, which is exactly
		// the "there is nothing to attach" signal wafDecision wants.
		f.AzureWAFPolicyID = ExtractOutput(outputs, "waf_policy_id")
		f.AzureExternalSecretsClient = ExtractOutput(outputs, "external_secrets_client_id")
		f.AzureKeyVaultURI = ExtractOutput(outputs, "key_vault_uri")
	case "alibaba":
		f.ClusterName = ExtractOutput(outputs, "ack_cluster_name")
		f.ClusterEndpoint = ExtractOutput(outputs, "ack_cluster_endpoint")
		f.VPCID = ExtractOutput(outputs, "vpc_id")
		f.AlibabaOIDCIssuerURL = ExtractOutput(outputs, "rrsa_oidc_issuer_url")
		f.AlibabaOIDCProviderArn = ExtractOutput(outputs, "rrsa_oidc_provider_arn")
		f.AlibabaExternalSecretsRoleArn = ExtractOutput(outputs, "external_secrets_ram_role_arn")
		// null when application_waf_enabled is off — "" is the "nothing built" signal, the same
		// shape as AWS's waf_webacl_arn below. Unlike AWS's, a non-empty value here does NOT mean
		// anything is being filtered; see the field comment and modules/waf/main.tf.
		f.AlibabaWAFInstanceID = ExtractOutput(outputs, "waf_instance_id")
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
		// null when application_waf_enabled is off — ExtractOutput yields "" for a null, which
		// is exactly the "attach nothing" signal wafDecision and the ingress annotation want.
		f.WAFWebACLArn = ExtractOutput(outputs, "waf_webacl_arn")
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

	// Cross-account keyless secret manager: the target lives in the connector's provider_config, not the
	// tofu outputs (ESO performs the cross-account read). A misconfigured target was already rejected
	// fail-closed by Compose pre-plan; here a nil/error target simply renders no cross-account store
	// (also fail-closed). Guard on the cluster cloud so a stray cross-cloud target never renders.
	if t, err := categories.DominantKeylessSecretTarget(vc); err == nil && t != nil && t.Provider == f.Provider {
		f.SecretsXacctRef = t.TargetRef
		f.SecretsXacctRegion = t.Region
		f.SecretsXacctProjectID = t.TargetProjectID
		f.SecretsXacctOIDCProviderRef = t.TargetOIDCProviderRef
		f.SecretsXacctExternalID = t.TargetExternalID
		f.SecretsXacctSlug = t.Slug
	}

	// Pluggable SaaS secret store (Vault / OpenBao / Doppler / generic Vault-compatible). Cloud-agnostic
	// and credential-based: DominantSecretsSaaSStore runs the provider's Validate over the job's
	// ConnectorCredentials, so a nil/error result means the store's token/config is absent — render no
	// store (fail-closed), which also stops us pointing an ESO store at a Secret the seeder would refuse
	// to write. The token is seeded separately by the runner; only the non-secret descriptor lands here.
	if s, err := categories.DominantSecretsSaaSStore(vc); err == nil && s != nil {
		f.SecretsSaaS = s
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
