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
		Provider:         provider,
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
		"eks_cluster_name":          "eks-demo",
		"eks_irsa_external_dns_arn": "arn:aws:iam::acct-123:role/x",
		"gke_cluster_name":          "SHOULD-BE-IGNORED",
	}, cfg("aws"))
	if aws.ClusterName != "eks-demo" || aws.Provider != "aws" {
		t.Errorf("aws facts wrong: %+v", aws)
	}
	if aws.DNSProvider() != "aws" {
		t.Errorf("aws DNSProvider = %q", aws.DNSProvider())
	}

	gcp := BuildFromOutputs(map[string]interface{}{
		"gke_cluster_name":             "gke-demo",
		"external_dns_service_account": "extdns@proj.iam.gserviceaccount.com",
	}, cfg("gcp"))
	if gcp.ClusterName != "gke-demo" || gcp.GCPExternalDNSSA == "" {
		t.Errorf("gcp facts wrong: %+v", gcp)
	}
	if gcp.DNSProvider() != "google" {
		t.Errorf("gcp DNSProvider = %q, want google", gcp.DNSProvider())
	}

	az := BuildFromOutputs(map[string]interface{}{
		"aks_cluster_name":       "aks-demo",
		"external_dns_client_id": "client-guid",
	}, cfg("azure"))
	if az.ClusterName != "aks-demo" || az.AzureExternalDNSClient == "" {
		t.Errorf("azure facts wrong: %+v", az)
	}
	if az.DNSProvider() != "azure" {
		t.Errorf("azure DNSProvider = %q, want azure", az.DNSProvider())
	}

	ali := BuildFromOutputs(map[string]interface{}{
		"ack_cluster_name": "ack-demo",
		"eks_cluster_name": "SHOULD-BE-IGNORED",
		"vpc_id":           "vpc-ali",
	}, cfg("alibaba"))
	if ali.ClusterName != "ack-demo" || ali.VPCID != "vpc-ali" {
		t.Errorf("alibaba facts wrong: %+v", ali)
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
	// The cloud-agnostic operator still ships, but never the AWS secret store.
	eso, ok := files["external-secrets-operator.yaml"]
	if !ok {
		t.Fatalf("external-secrets operator should render on Hetzner")
	}
	if strings.Contains(eso, "ClusterSecretStore") {
		t.Errorf("the AWS ClusterSecretStore must NOT render on Hetzner:\n%s", eso)
	}
	if _, ok := files["metrics-server.yaml"]; !ok {
		t.Errorf("metrics-server should render on every cloud")
	}
}

func TestRender_Alibaba(t *testing.T) {
	files := renderAll(t, BuildFromOutputs(map[string]interface{}{
		"ack_cluster_name": "ack-demo",
	}, cfg("alibaba")))
	assertNoExternalDNS(t, files, "no RRSA identity for external-dns yet")
	for _, awsOnly := range []string{"aws-load-balancer-controller.yaml", "storage-class-gp3.yaml", "karpenter.yaml"} {
		if _, ok := files[awsOnly]; ok {
			t.Errorf("%s must NOT render on Alibaba", awsOnly)
		}
	}
	eso, ok := files["external-secrets-operator.yaml"]
	if !ok {
		t.Fatalf("external-secrets operator should render on Alibaba")
	}
	if strings.Contains(eso, "ClusterSecretStore") {
		t.Errorf("the AWS ClusterSecretStore must NOT render on Alibaba:\n%s", eso)
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

// The AWS store keeps rendering on AWS — and only there (GCP/Azure were silently
// receiving it before the guard).
func TestRender_ESOStoreAWSOnly(t *testing.T) {
	aws := renderAll(t, BuildFromOutputs(map[string]interface{}{
		"eks_cluster_name": "eks-demo",
	}, cfg("aws")))
	if !strings.Contains(aws["external-secrets-operator.yaml"], "name: secretstore-aws") {
		t.Errorf("AWS should keep its SecretsManager ClusterSecretStore")
	}
	for _, provider := range []string{"gcp", "azure"} {
		outputs := map[string]interface{}{
			"gke_cluster_name": "gke-demo",
			"aks_cluster_name": "aks-demo",
		}
		files := renderAll(t, BuildFromOutputs(outputs, cfg(provider)))
		if strings.Contains(files["external-secrets-operator.yaml"], "ClusterSecretStore") {
			t.Errorf("the AWS ClusterSecretStore must NOT render on %s", provider)
		}
	}
}
