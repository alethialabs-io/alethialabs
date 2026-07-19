// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// templatesDir resolves the repo's ArgoCD templates from the package dir.
func templatesDir(t *testing.T) string {
	t.Helper()
	// packages/core/argocd → repo root is three levels up.
	dir := filepath.Join("..", "..", "..", "infra", "templates", "argocd")
	if _, err := os.Stat(dir); err != nil {
		t.Fatalf("templates dir not found at %s: %v", dir, err)
	}
	return dir
}

func cfg(provider string) *types.ProjectConfig {
	vc := &types.ProjectConfig{
		ProjectName:      "demo",
		EnvironmentStage: "development",
		Region:           "us-east-1",
		Provider:         types.CloudProvider(provider),
		CloudAccountID:   "acct-123",
	}
	vc.DNS.Enabled = true
	vc.DNS.DomainName = "demo.example.com"
	vc.DNS.ZoneID = "zone-1"
	vc.Repositories.AppsDestinationRepo = "https://github.com/acme/manifests"
	vc.Cluster.ProviderConfig = map[string]any{"enable_karpenter": true}
	return vc
}

func TestBuildFromOutputs_PerCloudCluster(t *testing.T) {
	aws := BuildFromOutputs(map[string]interface{}{
		"eks_cluster_name":              "eks-demo",
		"eks_irsa_external_dns_arn":     "arn:aws:iam::acct-123:role/x",
		"eks_irsa_external_secrets_arn": "arn:aws:iam::acct-123:role/eso",
		"gke_cluster_name":              "SHOULD-BE-IGNORED",
	}, cfg("aws"))
	if aws.ClusterName != "eks-demo" || aws.Provider != "aws" {
		t.Errorf("aws facts wrong: %+v", aws)
	}
	if aws.IRSAExternalSecretsArn != "arn:aws:iam::acct-123:role/eso" {
		t.Errorf("aws external-secrets IRSA fact wrong: %+v", aws)
	}
	if aws.DNSProvider() != "aws" {
		t.Errorf("aws DNSProvider = %q", aws.DNSProvider())
	}

	gcp := BuildFromOutputs(map[string]interface{}{
		"gke_cluster_name":                 "gke-demo",
		"external_dns_service_account":     "extdns@proj.iam.gserviceaccount.com",
		"external_secrets_service_account": "extsec@proj.iam.gserviceaccount.com",
	}, cfg("gcp"))
	if gcp.ClusterName != "gke-demo" || gcp.GCPExternalDNSSA == "" {
		t.Errorf("gcp facts wrong: %+v", gcp)
	}
	if gcp.GCPExternalSecretsSA != "extsec@proj.iam.gserviceaccount.com" {
		t.Errorf("gcp external-secrets GSA fact wrong: %+v", gcp)
	}
	if gcp.DNSProvider() != "google" {
		t.Errorf("gcp DNSProvider = %q, want google", gcp.DNSProvider())
	}

	az := BuildFromOutputs(map[string]interface{}{
		"aks_cluster_name":           "aks-demo",
		"external_dns_client_id":     "client-guid",
		"external_secrets_client_id": "extsec-guid",
		"key_vault_uri":              "https://demo-kv.vault.azure.net/",
	}, cfg("azure"))
	if az.ClusterName != "aks-demo" || az.AzureExternalDNSClient == "" {
		t.Errorf("azure facts wrong: %+v", az)
	}
	if az.AzureExternalSecretsClient != "extsec-guid" || az.AzureKeyVaultURI != "https://demo-kv.vault.azure.net/" {
		t.Errorf("azure external-secrets facts wrong: %+v", az)
	}
	if az.DNSProvider() != "azure" {
		t.Errorf("azure DNSProvider = %q, want azure", az.DNSProvider())
	}

	ali := BuildFromOutputs(map[string]interface{}{
		"ack_cluster_name":              "ack-demo",
		"eks_cluster_name":              "SHOULD-BE-IGNORED",
		"vpc_id":                        "vpc-ali",
		"external_secrets_ram_role_arn": "acs:ram::123:role/eso",
	}, cfg("alibaba"))
	if ali.ClusterName != "ack-demo" || ali.VPCID != "vpc-ali" {
		t.Errorf("alibaba facts wrong: %+v", ali)
	}
	if ali.AlibabaExternalSecretsRoleArn != "acs:ram::123:role/eso" {
		t.Errorf("alibaba external-secrets RRSA fact wrong: %+v", ali)
	}
	if ali.AWSAccountID != "" {
		t.Errorf("alibaba must not populate the AWS identity block: %+v", ali)
	}
	if ali.DNSProvider() != "" {
		t.Errorf("alibaba DNSProvider = %q, want honest skip until RRSA lands", ali.DNSProvider())
	}

	hz := BuildFromOutputs(map[string]interface{}{
		"talos_cluster_name": "talos-demo",
		"eks_cluster_name":   "SHOULD-BE-IGNORED",
	}, cfg("hetzner"))
	if hz.ClusterName != "talos-demo" {
		t.Errorf("hetzner facts wrong: %+v", hz)
	}
	if hz.DNSProvider() != "" {
		t.Errorf("hetzner DNSProvider = %q, want honest skip until the webhook lands", hz.DNSProvider())
	}
}

// A DNS connector (cloudflare) overrides the cloud-native backend; until the
// connector-aware branch renders it, external-dns must skip rather than deploy the
// native provider that would fight cloudflare-managed records.
func TestDNSProviderConnectorOverride(t *testing.T) {
	vc := cfg("aws")
	vc.DNS.Provider = "cloudflare"
	f := BuildFromOutputs(map[string]interface{}{"eks_cluster_name": "eks-demo"}, vc)
	if f.DNSProvider() != "" {
		t.Errorf("cloudflare connector should skip native external-dns, got %q", f.DNSProvider())
	}

	native := cfg("aws")
	native.DNS.Provider = "native"
	nf := BuildFromOutputs(map[string]interface{}{"eks_cluster_name": "eks-demo"}, native)
	if nf.DNSProvider() != "aws" {
		t.Errorf("explicit native connector should keep the cloud backend, got %q", nf.DNSProvider())
	}
}

func renderAll(t *testing.T, facts *InfraFacts) map[string]string {
	t.Helper()
	out, err := RenderApplications(templatesDir(t), facts)
	if err != nil {
		t.Fatalf("RenderApplications: %v", err)
	}
	files := map[string]string{}
	entries, _ := os.ReadDir(out)
	for _, e := range entries {
		b, _ := os.ReadFile(filepath.Join(out, e.Name()))
		files[e.Name()] = string(b)
	}
	return files
}

func TestRender_AWSUnchanged(t *testing.T) {
	files := renderAll(t, BuildFromOutputs(map[string]interface{}{
		"eks_cluster_name": "eks-demo",
	}, cfg("aws")))
	dns := files["external-dns.yaml"]
	if !strings.Contains(dns, "provider: aws") {
		t.Errorf("aws external-dns should use provider: aws:\n%s", dns)
	}
	if !strings.Contains(dns, "eks.amazonaws.com/role-arn") {
		t.Errorf("aws external-dns should carry the IRSA annotation")
	}
	// AWS-only apps still render.
	if _, ok := files["aws-load-balancer-controller.yaml"]; !ok {
		t.Errorf("ALB controller should render on AWS")
	}
	if _, ok := files["storage-class-gp3.yaml"]; !ok {
		t.Errorf("gp3 storage class should render on AWS")
	}
	if _, ok := files["karpenter.yaml"]; !ok {
		t.Errorf("karpenter should render on AWS (enable_karpenter=true)")
	}
}

// The apps-overlays ApplicationSet (decoupled env-model, #838) renders one Application per
// overlays/<env> directory in the apps repo — the enterprise-demo layout. It must carry the git
// directories generator over overlays/*, emit ArgoCD's own path placeholders LITERALLY (so ArgoCD,
// not Alethia, resolves them), run under the "apps" AppProject, and propagate the sweep labels.
func TestRender_AppsOverlaysApplicationSet(t *testing.T) {
	vc := cfg("aws")
	vc.Repositories.AppsDestinationRepo = "https://github.com/acme/demo"
	files := renderAll(t, BuildFromOutputs(map[string]interface{}{"eks_cluster_name": "eks-demo"}, vc))

	as, ok := files["user-apps-overlays.yaml"]
	if !ok {
		t.Fatalf("apps-overlays ApplicationSet should render when AppsDestinationRepo is set")
	}
	for _, want := range []string{
		"kind: ApplicationSet",
		"repoURL: https://github.com/acme/demo",
		"path: overlays/*",
		"name: 'apps-{{ .path.basename }}'", // literal ArgoCD placeholder, not Alethia-resolved
		"path: '{{ .path.path }}'",
		"project: apps",
		"CreateNamespace=true",
	} {
		if !strings.Contains(as, want) {
			t.Errorf("apps-overlays ApplicationSet missing %q:\n%s", want, as)
		}
	}
	// The ArgoCD path placeholders must NOT have been resolved by Alethia's Go template.
	if strings.Contains(as, "<no value>") || strings.Contains(as, "apps-eks-demo") {
		t.Errorf("ArgoCD path placeholders were wrongly resolved at Alethia render time:\n%s", as)
	}

	// Flat / no apps repo → the ApplicationSet is gated out entirely (no empty Application deployed).
	noRepo := cfg("aws")
	noRepo.Repositories.AppsDestinationRepo = ""
	flat := renderAll(t, BuildFromOutputs(map[string]interface{}{"eks_cluster_name": "eks-demo"}, noRepo))
	if _, present := flat["user-apps-overlays.yaml"]; present {
		t.Errorf("apps-overlays ApplicationSet must not render without an apps repo")
	}
}

func TestRender_GCPWorkloadIdentity(t *testing.T) {
	files := renderAll(t, BuildFromOutputs(map[string]interface{}{
		"gke_cluster_name":             "gke-demo",
		"external_dns_service_account": "extdns@proj.iam.gserviceaccount.com",
	}, cfg("gcp")))
	dns := files["external-dns.yaml"]
	if !strings.Contains(dns, "provider: google") {
		t.Errorf("gcp external-dns should use provider: google:\n%s", dns)
	}
	if !strings.Contains(dns, "iam.gke.io/gcp-service-account: extdns@proj.iam.gserviceaccount.com") {
		t.Errorf("gcp external-dns should carry the Workload Identity annotation:\n%s", dns)
	}
	// AWS-only apps are skipped (rendered empty → not written).
	for _, awsOnly := range []string{"aws-load-balancer-controller.yaml", "storage-class-gp3.yaml", "karpenter.yaml"} {
		if _, ok := files[awsOnly]; ok {
			t.Errorf("%s must NOT render on GCP", awsOnly)
		}
	}
}

func TestRender_AzureFederatedIdentity(t *testing.T) {
	files := renderAll(t, BuildFromOutputs(map[string]interface{}{
		"aks_cluster_name":       "aks-demo",
		"external_dns_client_id": "client-guid",
	}, cfg("azure")))
	dns := files["external-dns.yaml"]
	if !strings.Contains(dns, "provider: azure") {
		t.Errorf("azure external-dns should use provider: azure:\n%s", dns)
	}
	if !strings.Contains(dns, "azure.workload.identity/client-id: client-guid") {
		t.Errorf("azure external-dns should carry the workload-identity client id:\n%s", dns)
	}
	if !strings.Contains(dns, "azure.workload.identity/use") {
		t.Errorf("azure external-dns pod should opt into workload identity")
	}
	if _, ok := files["aws-load-balancer-controller.yaml"]; ok {
		t.Errorf("ALB controller must NOT render on Azure")
	}
}

// assertNoExternalDNS asserts the external-dns app was skipped entirely.
func assertNoExternalDNS(t *testing.T, files map[string]string, why string) {
	t.Helper()
	if body, ok := files["external-dns.yaml"]; ok {
		t.Errorf("external-dns must NOT render (%s):\n%s", why, body)
	}
}

func TestRender_DNSDisabledSkipsExternalDNS(t *testing.T) {
	vc := cfg("aws")
	vc.DNS.Enabled = false
	files := renderAll(t, BuildFromOutputs(map[string]interface{}{
		"eks_cluster_name": "eks-demo",
	}, vc))
	assertNoExternalDNS(t, files, "DNS disabled")

	noDomain := cfg("aws")
	noDomain.DNS.DomainName = ""
	files = renderAll(t, BuildFromOutputs(map[string]interface{}{
		"eks_cluster_name": "eks-demo",
	}, noDomain))
	assertNoExternalDNS(t, files, "no domain")
}

// Without its api_token credential the cloudflare connector must skip (fail-closed);
// with it, external-dns renders provider cloudflare + the token env and NO cloud
// identity annotation (the connector needs no IRSA/WI).
func TestRender_CloudflareConnector(t *testing.T) {
	vc := cfg("aws")
	vc.DNS.Provider = "cloudflare"
	files := renderAll(t, BuildFromOutputs(map[string]interface{}{
		"eks_cluster_name": "eks-demo",
	}, vc))
	assertNoExternalDNS(t, files, "cloudflare connector without a credential")

	vc.ConnectorCredentials = []types.ConnectorCredential{{
		Category: "dns", Slug: "cloudflare",
		Credentials: map[string]string{"api_token": "cf-tok"},
	}}
	files = renderAll(t, BuildFromOutputs(map[string]interface{}{
		"eks_cluster_name": "eks-demo",
	}, vc))
	dns, ok := files["external-dns.yaml"]
	if !ok {
		t.Fatalf("external-dns should render with the cloudflare credential present")
	}
	if !strings.Contains(dns, "provider: cloudflare") {
		t.Errorf("expected provider: cloudflare:\n%s", dns)
	}
	if !strings.Contains(dns, "CF_API_TOKEN") || !strings.Contains(dns, "external-dns-cloudflare") {
		t.Errorf("expected the CF_API_TOKEN secret env wiring:\n%s", dns)
	}
	if strings.Contains(dns, "eks.amazonaws.com/role-arn") {
		t.Errorf("cloudflare-backed external-dns must not carry the IRSA annotation:\n%s", dns)
	}
	if strings.Contains(dns, "cf-tok") {
		t.Errorf("the token itself must NEVER appear in a rendered manifest:\n%s", dns)
	}
}

// Hetzner renders the official webhook sidecar when the Cloud API token is present.
func TestRender_HetznerWebhookExternalDNS(t *testing.T) {
	t.Setenv("HCLOUD_TOKEN", "hz-tok")
	files := renderAll(t, BuildFromOutputs(map[string]interface{}{
		"talos_cluster_name": "talos-demo",
	}, cfg("hetzner")))
	dns, ok := files["external-dns.yaml"]
	if !ok {
		t.Fatalf("external-dns should render on hetzner with HCLOUD_TOKEN present")
	}
	for _, want := range []string{
		"name: webhook",
		"docker.io/hetzner/external-dns-hetzner-webhook",
		"HETZNER_TOKEN",
		"external-dns-hetzner",
	} {
		if !strings.Contains(dns, want) {
			t.Errorf("hetzner webhook render missing %q:\n%s", want, dns)
		}
	}
	if strings.Contains(dns, "hz-tok") {
		t.Errorf("the token itself must NEVER appear in a rendered manifest:\n%s", dns)
	}
}

func TestRender_Hetzner(t *testing.T) {
	t.Setenv("HCLOUD_TOKEN", "") // no Cloud API token → the webhook backend must skip
	files := renderAll(t, BuildFromOutputs(map[string]interface{}{
		"talos_cluster_name": "talos-demo",
	}, cfg("hetzner")))
	assertNoExternalDNS(t, files, "no Cloud API token for the hetzner webhook")
	for _, awsOnly := range []string{"aws-load-balancer-controller.yaml", "storage-class-gp3.yaml", "karpenter.yaml"} {
		if _, ok := files[awsOnly]; ok {
			t.Errorf("%s must NOT render on Hetzner", awsOnly)
		}
	}
	// The cloud-agnostic operator still ships, but NEVER a cloud secret store — Hetzner
	// has no cloud secret manager; the Vault connector is the supported path.
	eso, ok := files["external-secrets-operator.yaml"]
	if !ok {
		t.Fatalf("external-secrets operator should render on Hetzner")
	}
	if strings.Contains(eso, "ClusterSecretStore") || strings.Contains(eso, "secretstore-") {
		t.Errorf("no ClusterSecretStore may render on Hetzner:\n%s", eso)
	}
	if _, ok := files["metrics-server.yaml"]; !ok {
		t.Errorf("metrics-server should render on every cloud")
	}
}

func TestRender_Alibaba(t *testing.T) {
	// RRSA identity is now provisioned, but external-dns's alibabacloud provider does
	// not support RRSA upstream (external-dns#5019) → external-dns still skips honestly.
	files := renderAll(t, BuildFromOutputs(map[string]interface{}{
		"ack_cluster_name":       "ack-demo",
		"rrsa_oidc_issuer_url":   "https://oidc.ack.example/issuer",
		"rrsa_oidc_provider_arn": "acs:ram::123:oidc-provider/ack-rrsa",
	}, cfg("alibaba")))
	assertNoExternalDNS(t, files, "external-dns alibabacloud has no RRSA support upstream")
	for _, awsOnly := range []string{"aws-load-balancer-controller.yaml", "storage-class-gp3.yaml", "karpenter.yaml"} {
		if _, ok := files[awsOnly]; ok {
			t.Errorf("%s must NOT render on Alibaba", awsOnly)
		}
	}
	eso, ok := files["external-secrets-operator.yaml"]
	if !ok {
		t.Fatalf("external-secrets operator should render on Alibaba")
	}
	// No external_secrets_ram_role_arn output in this render → the alibaba store must
	// stay fail-closed (the positive case lives in TestRender_ESOStoresPerCloud).
	if strings.Contains(eso, "ClusterSecretStore") {
		t.Errorf("no ClusterSecretStore may render on Alibaba without the RRSA role fact:\n%s", eso)
	}
}

// GCP/Azure follow the same honesty rule: no workload-identity output → external-dns
// would ship with an empty identity annotation and crash-loop, so it must skip.
func TestRender_MissingIdentitySkipsExternalDNS(t *testing.T) {
	gcp := renderAll(t, BuildFromOutputs(map[string]interface{}{
		"gke_cluster_name": "gke-demo", // no external_dns_service_account output
	}, cfg("gcp")))
	assertNoExternalDNS(t, gcp, "gcp without a Workload Identity GSA")

	az := renderAll(t, BuildFromOutputs(map[string]interface{}{
		"aks_cluster_name": "aks-demo", // no external_dns_client_id output
	}, cfg("azure")))
	assertNoExternalDNS(t, az, "azure without a workload-identity client id")
}

// Every managed cloud's ClusterSecretStore renders ONLY when its workload-identity fact
// is present (fail-closed, like external-dns) — and the raw identity value (an ARN /
// GSA email / client id, never a secret) lands on the operator's ServiceAccount
// annotation and the store spec. Without the identity the store must be absent while
// the cloud-agnostic operator chart still ships.
func TestRender_ESOStoresPerCloud(t *testing.T) {
	cases := []struct {
		provider     string
		withIdentity map[string]interface{}
		noIdentity   map[string]interface{}
		store        string
		want         []string
	}{
		{
			provider: "aws",
			withIdentity: map[string]interface{}{
				"eks_cluster_name":              "eks-demo",
				"eks_irsa_external_secrets_arn": "arn:aws:iam::acct-123:role/eks-demo-secrets-operator",
			},
			noIdentity: map[string]interface{}{"eks_cluster_name": "eks-demo"},
			store:      "secretstore-aws",
			want: []string{
				"eks.amazonaws.com/role-arn: arn:aws:iam::acct-123:role/eks-demo-secrets-operator",
				"service: SecretsManager",
				"region: us-east-1",
			},
		},
		{
			provider: "gcp",
			withIdentity: map[string]interface{}{
				"gke_cluster_name":                 "gke-demo",
				"gcp_project_id":                   "proj-1",
				"external_secrets_service_account": "extsec@proj-1.iam.gserviceaccount.com",
			},
			noIdentity: map[string]interface{}{"gke_cluster_name": "gke-demo", "gcp_project_id": "proj-1"},
			store:      "secretstore-gcp",
			want: []string{
				"iam.gke.io/gcp-service-account: extsec@proj-1.iam.gserviceaccount.com",
				"projectID: proj-1",
			},
		},
		{
			provider: "azure",
			withIdentity: map[string]interface{}{
				"aks_cluster_name":           "aks-demo",
				"azure_tenant_id":            "tenant-guid",
				"external_secrets_client_id": "extsec-client-guid",
				"key_vault_uri":              "https://demo-development-kv.vault.azure.net/",
			},
			noIdentity: map[string]interface{}{"aks_cluster_name": "aks-demo", "azure_tenant_id": "tenant-guid"},
			store:      "secretstore-azure",
			want: []string{
				"azure.workload.identity/client-id: extsec-client-guid",
				"azure.workload.identity/tenant-id: tenant-guid",
				`azure.workload.identity/use: "true"`,
				"authType: WorkloadIdentity",
				"vaultUrl: https://demo-development-kv.vault.azure.net/",
			},
		},
		{
			provider: "alibaba",
			withIdentity: map[string]interface{}{
				"ack_cluster_name":              "ack-demo",
				"rrsa_oidc_issuer_url":          "https://oidc.ack.example/issuer",
				"rrsa_oidc_provider_arn":        "acs:ram::123:oidc-provider/ack-rrsa-c1",
				"external_secrets_ram_role_arn": "acs:ram::123:role/demo-development-extsecrets",
			},
			noIdentity: map[string]interface{}{
				"ack_cluster_name":       "ack-demo",
				"rrsa_oidc_issuer_url":   "https://oidc.ack.example/issuer",
				"rrsa_oidc_provider_arn": "acs:ram::123:oidc-provider/ack-rrsa-c1",
			},
			store: "secretstore-alibaba",
			want: []string{
				"roleArn: acs:ram::123:role/demo-development-extsecrets",
				"oidcProviderArn: acs:ram::123:oidc-provider/ack-rrsa-c1",
				"oidcTokenFilePath: /var/run/secrets/tokens/oidc-token",
				"sessionName: external-secrets",
				"extraVolumes",
				`audience: "sts.aliyuncs.com"`,
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.provider, func(t *testing.T) {
			files := renderAll(t, BuildFromOutputs(tc.withIdentity, cfg(tc.provider)))
			eso, ok := files["external-secrets-operator.yaml"]
			if !ok {
				t.Fatalf("external-secrets operator should render on %s", tc.provider)
			}
			if !strings.Contains(eso, "name: "+tc.store) {
				t.Errorf("%s should render with the identity fact present:\n%s", tc.store, eso)
			}
			for _, want := range tc.want {
				if !strings.Contains(eso, want) {
					t.Errorf("%s render missing %q:\n%s", tc.provider, want, eso)
				}
			}
			// Only THIS cloud's store may render.
			for _, other := range []string{"secretstore-aws", "secretstore-gcp", "secretstore-azure", "secretstore-alibaba"} {
				if other != tc.store && strings.Contains(eso, other) {
					t.Errorf("%s must NOT render on %s:\n%s", other, tc.provider, eso)
				}
			}

			// Fail-closed: without the identity output the store (and the SA annotation)
			// must be absent, while the operator itself still renders.
			files = renderAll(t, BuildFromOutputs(tc.noIdentity, cfg(tc.provider)))
			eso, ok = files["external-secrets-operator.yaml"]
			if !ok {
				t.Fatalf("external-secrets operator should render on %s even without identity", tc.provider)
			}
			if strings.Contains(eso, "ClusterSecretStore") {
				t.Errorf("no ClusterSecretStore may render on %s without its identity fact:\n%s", tc.provider, eso)
			}
			for _, ann := range []string{"eks.amazonaws.com/role-arn", "iam.gke.io/gcp-service-account", "azure.workload.identity/client-id"} {
				if strings.Contains(eso, ann) {
					t.Errorf("the SA identity annotation %q must not render on %s without its identity fact:\n%s", ann, tc.provider, eso)
				}
			}
		})
	}
}
