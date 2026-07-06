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
