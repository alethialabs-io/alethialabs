// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloud

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	yaml "gopkg.in/yaml.v3"
)

// Azure namespace keyless-mint (#1128, a per-cloud lane of #1013). The Azure mirror of the AWS EKS
// output-free mint (cloud/aws/eks.go ResolveEKSClusterConn) and the GCP lane (#1127): resolve an
// EXISTING shared-Fabric AKS cluster BY NAME — with NO tofu outputs — to its control-plane endpoint +
// CA, so a `namespace` placement can mint keyless kube access onto a cluster it did not provision.
//
// AKS splits the two facts across two ARM REST calls (mirroring `az aks get-credentials`): the API
// server FQDN + readiness come from ManagedClusters.Get; the cluster CA comes from the kubeconfig that
// listClusterUserCredentials returns (base64 YAML → clusters[0].cluster.certificate-authority-data). It
// calls ARM directly with a keyless federated-identity bearer token (the runner's workload-identity ARM
// token — never a stored key), which keeps this lane dependency-free (stdlib + the already-present
// yaml.v3 — no cloud SDK added to packages/core/go.mod, so the per-cloud lanes stay disjoint). The
// returned endpoint + CA feed the Azure provider's ConfigureKubeconfig exactly like the tofu-output
// `aks_cluster_endpoint` / `aks_cluster_ca_certificate` values do (the `kube-token --provider azure`
// exec-plugin kubeconfig). Wiring this into ConfigureKubeconfig + the namespaceRemintProviders allowlist
// lives in the provider/dispatch files (out of this lane's single-file scope) — the activation follow-up.
//
// Keyless + fail-closed: the ARM token is a bearer, NEVER logged; a cluster that isn't Succeeded+Running
// or whose endpoint/CA is empty returns ErrAKSClusterNotReady (a retry signal), never a partial conn.

// ErrAKSClusterNotReady is returned when an AKS cluster exists but its control-plane connection details
// aren't usable yet — it isn't provisioned+Running, or the FQDN / CA is still empty. Mirrors
// aws.ErrClusterNotReady / ErrGKEClusterNotReady.
var ErrAKSClusterNotReady = errors.New("aks cluster is not ready yet")

const (
	// azureARMBase is the Azure Resource Manager REST base. A const in production; tests redirect via the
	// injected http.Client's transport, so the resolver's URL construction is still exercised.
	azureARMBase = "https://management.azure.com"
	// aksAPIVersion is the AKS (Microsoft.ContainerService) REST API version this mint pins.
	aksAPIVersion = "2024-09-01"
)

// AKSClusterConn is the connection detail needed to build a kubeconfig for a ready AKS cluster — the
// Azure twin of aws.EKSClusterConn. Endpoint is the https API-server URL; CAData is base64 (a PUBLIC CA
// cert, not a secret).
type AKSClusterConn struct {
	Endpoint string
	CAData   string
}

// AKSClusterResourceID builds the ARM resource id for an AKS managed cluster. Each segment is
// path-escaped defensively (the cluster name flows from the config snapshot — the runner is the trust
// boundary).
func AKSClusterResourceID(subscriptionID, resourceGroup, clusterName string) string {
	return fmt.Sprintf(
		"/subscriptions/%s/resourceGroups/%s/providers/Microsoft.ContainerService/managedClusters/%s",
		url.PathEscape(subscriptionID),
		url.PathEscape(resourceGroup),
		url.PathEscape(clusterName),
	)
}

// aksManagedClusterResponse is the slice of the AKS ManagedCluster resource this mint reads.
type aksManagedClusterResponse struct {
	Properties struct {
		Fqdn              string `json:"fqdn"`
		ProvisioningState string `json:"provisioningState"`
		PowerState        struct {
			Code string `json:"code"`
		} `json:"powerState"`
		OidcIssuerProfile struct {
			Enabled   bool   `json:"enabled"`
			IssuerURL string `json:"issuerURL"`
		} `json:"oidcIssuerProfile"`
	} `json:"properties"`
}

// ResolveAKSOIDCIssuer resolves an AKS cluster's Workload-Identity OIDC issuer URL BY NAME via ARM
// managedClusters.get — the output-free trust anchor a federated-identity credential needs. `armToken`
// is a keyless federated ARM bearer (never logged). Fail-closed: an issuer that is disabled or empty is
// an error (the Fabric must have oidc-issuer + workload-identity enabled), never a guessed value.
func ResolveAKSOIDCIssuer(
	ctx context.Context,
	client *http.Client,
	armToken, subscriptionID, resourceGroup, clusterName string,
) (string, error) {
	if strings.TrimSpace(armToken) == "" {
		return "", errors.New("aks oidc issuer: empty ARM token (a keyless federated-identity token is required)")
	}
	if subscriptionID == "" || resourceGroup == "" || clusterName == "" {
		return "", fmt.Errorf("aks oidc issuer: subscription, resource group and cluster must all be set (got %q / %q / %q)", subscriptionID, resourceGroup, clusterName)
	}
	if client == nil {
		client = &http.Client{Timeout: 20 * time.Second}
	}
	getURL := fmt.Sprintf("%s%s?api-version=%s", azureARMBase, AKSClusterResourceID(subscriptionID, resourceGroup, clusterName), aksAPIVersion)
	body, err := armRequest(ctx, client, http.MethodGet, getURL, armToken)
	if err != nil {
		return "", fmt.Errorf("aks managedClusters.get %q: %w", clusterName, err)
	}
	var mc aksManagedClusterResponse
	if err := json.Unmarshal(body, &mc); err != nil {
		return "", fmt.Errorf("aks managedClusters.get %q: decode: %w", clusterName, err)
	}
	issuer := strings.TrimSpace(mc.Properties.OidcIssuerProfile.IssuerURL)
	if issuer == "" {
		return "", fmt.Errorf("aks cluster %q has no OIDC issuer (workload identity / oidc-issuer not enabled on the Fabric) — cannot provision a per-namespace federated identity", clusterName)
	}
	return issuer, nil
}

// armRequestBody performs a bearer-authenticated ARM REST call WITH a JSON body (PUT/POST) and returns
// the (bounded) response body on a 2xx. The token is only ever in the Authorization header (never
// logged); a non-2xx is an error carrying status + a bounded snippet.
func armRequestBody(ctx context.Context, client *http.Client, method, rawURL, armToken string, reqBody []byte) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, method, rawURL, bytes.NewReader(reqBody))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+armToken)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("status %d: %s", resp.StatusCode, armErrSnippet(body))
	}
	return body, nil
}

// aksCredentialsResponse is the listClusterUserCredentials response — a list of base64-encoded kubeconfigs.
type aksCredentialsResponse struct {
	Kubeconfigs []struct {
		Name  string `json:"name"`
		Value string `json:"value"`
	} `json:"kubeconfigs"`
}

// aksKubeconfigYAML is the slice of a kubeconfig this mint reads (just the cluster CA).
type aksKubeconfigYAML struct {
	Clusters []struct {
		Cluster struct {
			CertificateAuthorityData string `yaml:"certificate-authority-data"`
			Server                   string `yaml:"server"`
		} `yaml:"cluster"`
	} `yaml:"clusters"`
}

// ResolveAKSClusterConn resolves an EXISTING AKS cluster BY NAME (no tofu outputs) via ARM and safely
// extracts its endpoint + CA. `armToken` is a short-lived keyless federated-identity ARM OAuth token
// (workload identity) with a scope that permits reading the cluster + its user credentials; it is sent
// as a bearer and never logged. Returns ErrAKSClusterNotReady — never a partial conn — when the cluster
// isn't Succeeded+Running or the endpoint/CA is empty. A non-2xx or transport error is wrapped (the
// token is never included).
func ResolveAKSClusterConn(
	ctx context.Context,
	client *http.Client,
	armToken, subscriptionID, resourceGroup, clusterName string,
) (AKSClusterConn, error) {
	if strings.TrimSpace(armToken) == "" {
		return AKSClusterConn{}, errors.New("aks mint: empty ARM token (a keyless federated-identity token is required)")
	}
	if subscriptionID == "" || resourceGroup == "" || clusterName == "" {
		return AKSClusterConn{}, fmt.Errorf(
			"aks mint: subscription, resource group and cluster must all be set (got %q / %q / %q)",
			subscriptionID, resourceGroup, clusterName,
		)
	}
	if client == nil {
		client = &http.Client{Timeout: 20 * time.Second}
	}
	resourceID := AKSClusterResourceID(subscriptionID, resourceGroup, clusterName)

	// (1) ManagedClusters.Get → FQDN + readiness.
	getURL := fmt.Sprintf("%s%s?api-version=%s", azureARMBase, resourceID, aksAPIVersion)
	getBody, err := armRequest(ctx, client, http.MethodGet, getURL, armToken)
	if err != nil {
		return AKSClusterConn{}, fmt.Errorf("aks managedClusters.get %q: %w", clusterName, err)
	}
	var mc aksManagedClusterResponse
	if err := json.Unmarshal(getBody, &mc); err != nil {
		return AKSClusterConn{}, fmt.Errorf("aks managedClusters.get %q: decode: %w", clusterName, err)
	}
	fqdn := strings.TrimSpace(mc.Properties.Fqdn)
	powerOK := mc.Properties.PowerState.Code == "" || mc.Properties.PowerState.Code == "Running"
	if mc.Properties.ProvisioningState != "Succeeded" || !powerOK || fqdn == "" {
		return AKSClusterConn{}, fmt.Errorf(
			"%w: %q (provisioningState %q, powerState %q)",
			ErrAKSClusterNotReady, clusterName, mc.Properties.ProvisioningState, mc.Properties.PowerState.Code,
		)
	}

	// (2) listClusterUserCredentials → the cluster CA (from the returned kubeconfig).
	credURL := fmt.Sprintf(
		"%s%s/listClusterUserCredentials?api-version=%s", azureARMBase, resourceID, aksAPIVersion,
	)
	credBody, err := armRequest(ctx, client, http.MethodPost, credURL, armToken)
	if err != nil {
		return AKSClusterConn{}, fmt.Errorf("aks listClusterUserCredentials %q: %w", clusterName, err)
	}
	ca, err := extractAKSCACert(credBody)
	if err != nil {
		return AKSClusterConn{}, fmt.Errorf("aks listClusterUserCredentials %q: %w", clusterName, err)
	}
	if ca == "" {
		return AKSClusterConn{}, fmt.Errorf("%w: %q (empty cluster CA)", ErrAKSClusterNotReady, clusterName)
	}

	endpoint := fqdn
	if !strings.HasPrefix(endpoint, "https://") {
		endpoint = "https://" + endpoint
	}
	return AKSClusterConn{Endpoint: endpoint, CAData: ca}, nil
}

// aksListResponse is the slice of the ManagedClusters LIST (by subscription) response this resolver
// reads — each entry's ARM `id` carries its resource group, and `name` is the cluster name.
type aksListResponse struct {
	Value []struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	} `json:"value"`
	NextLink string `json:"nextLink"`
}

// aksResourceGroupFromID extracts the resource group from an AKS ARM resource id
// (`/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.ContainerService/managedClusters/<name>`).
// ARM segment names are case-insensitive, so the `resourcegroups` marker is matched case-folded.
func aksResourceGroupFromID(id string) string {
	parts := strings.Split(strings.Trim(id, "/"), "/")
	for i := 0; i+1 < len(parts); i++ {
		if strings.EqualFold(parts[i], "resourceGroups") {
			return parts[i+1]
		}
	}
	return ""
}

// ResolveAKSResourceGroup finds the resource group of an EXISTING AKS cluster BY NAME within a
// subscription, via ARM `ManagedClusters` LIST — the output-free way to reach a cluster whose RG is not
// on the (placed-env) config snapshot (a namespace/vcluster env's project/env differ from the Fabric's,
// so the `rg-<project>-<env>` convention can't be reconstructed). `armToken` is a keyless federated
// ARM bearer (never logged). Follows `nextLink` pagination. Fail-closed: an unmatched name is an error,
// never a guessed RG. A subscription with two clusters of the same name (across RGs) is rejected as
// ambiguous rather than silently picking one.
func ResolveAKSResourceGroup(
	ctx context.Context,
	client *http.Client,
	armToken, subscriptionID, clusterName string,
) (string, error) {
	if strings.TrimSpace(armToken) == "" {
		return "", errors.New("aks rg lookup: empty ARM token (a keyless federated-identity token is required)")
	}
	if subscriptionID == "" || clusterName == "" {
		return "", fmt.Errorf("aks rg lookup: subscription and cluster must both be set (got %q / %q)", subscriptionID, clusterName)
	}
	if client == nil {
		client = &http.Client{Timeout: 20 * time.Second}
	}
	nextURL := fmt.Sprintf(
		"%s/subscriptions/%s/providers/Microsoft.ContainerService/managedClusters?api-version=%s",
		azureARMBase, url.PathEscape(subscriptionID), aksAPIVersion,
	)
	found := ""
	for pages := 0; nextURL != "" && pages < 50; pages++ {
		body, err := armRequest(ctx, client, http.MethodGet, nextURL, armToken)
		if err != nil {
			return "", fmt.Errorf("aks managedClusters.list: %w", err)
		}
		var list aksListResponse
		if err := json.Unmarshal(body, &list); err != nil {
			return "", fmt.Errorf("aks managedClusters.list: decode: %w", err)
		}
		for _, c := range list.Value {
			if !strings.EqualFold(c.Name, clusterName) {
				continue
			}
			rg := aksResourceGroupFromID(c.ID)
			if rg == "" {
				return "", fmt.Errorf("aks rg lookup: cluster %q id %q has no resource group segment", clusterName, c.ID)
			}
			if found != "" && !strings.EqualFold(found, rg) {
				return "", fmt.Errorf("aks rg lookup: cluster name %q is ambiguous across resource groups (%q and %q)", clusterName, found, rg)
			}
			found = rg
		}
		nextURL = list.NextLink
	}
	if found == "" {
		return "", fmt.Errorf("aks rg lookup: no cluster named %q found in subscription %q", clusterName, subscriptionID)
	}
	return found, nil
}

// extractAKSCACert decodes the first kubeconfig from a listClusterUserCredentials response and returns
// its cluster certificate-authority-data (base64 CA). A public cert — safe to surface.
func extractAKSCACert(credBody []byte) (string, error) {
	var creds aksCredentialsResponse
	if err := json.Unmarshal(credBody, &creds); err != nil {
		return "", fmt.Errorf("decode credentials: %w", err)
	}
	if len(creds.Kubeconfigs) == 0 || strings.TrimSpace(creds.Kubeconfigs[0].Value) == "" {
		return "", errors.New("no kubeconfig in credentials response")
	}
	raw, err := base64.StdEncoding.DecodeString(creds.Kubeconfigs[0].Value)
	if err != nil {
		return "", fmt.Errorf("decode kubeconfig base64: %w", err)
	}
	var kc aksKubeconfigYAML
	if err := yaml.Unmarshal(raw, &kc); err != nil {
		return "", fmt.Errorf("parse kubeconfig yaml: %w", err)
	}
	if len(kc.Clusters) == 0 {
		return "", errors.New("kubeconfig has no clusters")
	}
	return strings.TrimSpace(kc.Clusters[0].Cluster.CertificateAuthorityData), nil
}

// armRequest performs a bearer-authenticated ARM REST call and returns the (bounded) body on a 2xx. The
// token is only ever placed in the Authorization header (never logged); a non-2xx is an error carrying
// the status + a bounded body snippet (ARM error bodies carry a message, never credentials).
func armRequest(ctx context.Context, client *http.Client, method, rawURL, armToken string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, method, rawURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+armToken)
	req.Header.Set("Accept", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("status %d: %s", resp.StatusCode, armErrSnippet(body))
	}
	return body, nil
}

// armErrSnippet bounds an ARM error-response body for a log-safe message.
func armErrSnippet(b []byte) string {
	const max = 256
	s := strings.TrimSpace(string(b))
	if len(s) > max {
		return s[:max] + "…"
	}
	return s
}
