// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloud

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

// Azure per-namespace tenant identity (#1128, the federated-identity twin of the AWS IRSA path in
// cloud/aws/tenant_identity.go and the GCP Workload-Identity path in gcp_namespace_identity.go). A
// `namespace`-placement tenant on a shared AKS Fabric must get its OWN least-priv Azure identity, never a
// path to the node/kubelet identity. The namespace-deploy path runs NO tofu, so this provisions the
// identity LIVE via ARM at deploy time, keyless (the runner's federated-identity ARM token is injected —
// stdlib net/http only, no Azure management SDK added to packages/core/go.mod, mirroring the mint files).
//
// The identity is a per-(cluster,namespace) user-assigned managed identity (UAMI) with **NO role
// assignments** (zero-perm, like the zero-perm IRSA role); the ONLY trust is a federated identity
// credential on it whose (issuer = the AKS OIDC issuer, subject = system:serviceaccount:<ns>:default,
// audience = api://AzureADTokenExchange) lets the tenant namespace's default KSA — and only it — federate
// as this UAMI. The KSA is then labeled `azure.workload.identity/use=true` + annotated
// `azure.workload.identity/client-id=<clientId>` (bindAKSNamespaceIdentity, deploy_namespace.go).
//
// Idempotent (ARM PUT is an upsert) and fail-closed throughout. Both ARM writes require the runner's
// federated principal to hold write on the resource group (Managed Identity Contributor) — the approved
// IAM-write posture for the namespace tier.

const (
	// azureMSIAPIVersion pins the Managed Identity (UAMI + federated credential) REST API version.
	azureMSIAPIVersion = "2023-01-31"
	// azureWorkloadIdentityAudience is the fixed audience an AKS Workload-Identity federated credential
	// trusts (the AzureAD token-exchange audience).
	azureWorkloadIdentityAudience = "api://AzureADTokenExchange"
	// azureNamespaceFICName is the deterministic federated-credential name (one per UAMI — the ns default SA).
	azureNamespaceFICName = "kubernetes-default"
)

// ErrAKSIdentity wraps any non-recoverable AKS identity provisioning failure.
var ErrAKSIdentity = errors.New("aks namespace identity")

// uamiClientIDRe matches an Azure clientId (a GUID) — shell-safe (it flows into `kubectl annotate ...`).
var uamiClientIDRe = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

// IsValidUAMIClientID reports whether s is a well-formed managed-identity clientId (shell-safe for the
// KSA annotation).
func IsValidUAMIClientID(s string) bool { return uamiClientIDRe.MatchString(s) }

// namespaceUAMIName derives a deterministic, ARM-valid managed-identity name (3–128 chars, `[a-zA-Z0-9-_]`)
// for a (cluster, namespace) pair. Deterministic so a re-deploy reconciles the SAME UAMI (idempotent); a
// short content hash keeps it unique + bounded when the inputs are long.
func namespaceUAMIName(clusterName, namespace string) string {
	sum := sha256.Sum256([]byte(clusterName + "/" + namespace))
	ns := namespace
	if len(ns) > 32 {
		ns = ns[:32]
	}
	return "alethia-ns-" + ns + "-" + hex.EncodeToString(sum[:])[:8]
}

// aksUAMIResponse is the slice of a userAssignedIdentity PUT/GET response this reads (its clientId).
type aksUAMIResponse struct {
	Properties struct {
		ClientID string `json:"clientId"`
	} `json:"properties"`
}

// ProvisionAKSNamespaceIdentity get-or-creates the per-namespace UAMI and its federated identity
// credential trusting the namespace default KSA on the AKS OIDC issuer, returning the UAMI clientId.
// Idempotent: both ARM PUTs are upserts. `armToken` is a keyless federated ARM token with write on the
// resource group; it is a bearer, never logged. `location` is the UAMI's Azure region, `oidcIssuer` the
// AKS OIDC issuer URL (resolve via ResolveAKSOIDCIssuer). `namespace` MUST already be DNS-1123 validated.
func ProvisionAKSNamespaceIdentity(
	ctx context.Context,
	client *http.Client,
	armToken, subscriptionID, resourceGroup, location, oidcIssuer, clusterName, namespace string,
) (string, error) {
	if strings.TrimSpace(armToken) == "" {
		return "", fmt.Errorf("%w: empty ARM token (a keyless federated-identity token is required)", ErrAKSIdentity)
	}
	for k, v := range map[string]string{"subscription": subscriptionID, "resourceGroup": resourceGroup, "location": location, "oidcIssuer": oidcIssuer, "cluster": clusterName, "namespace": namespace} {
		if strings.TrimSpace(v) == "" {
			return "", fmt.Errorf("%w: %s must be set", ErrAKSIdentity, k)
		}
	}
	if client == nil {
		client = &http.Client{Timeout: 20 * time.Second}
	}
	name := namespaceUAMIName(clusterName, namespace)
	uamiBase := fmt.Sprintf(
		"%s/subscriptions/%s/resourceGroups/%s/providers/Microsoft.ManagedIdentity/userAssignedIdentities/%s",
		azureARMBase, url.PathEscape(subscriptionID), url.PathEscape(resourceGroup), url.PathEscape(name),
	)

	// (1) PUT the UAMI (zero-perm — no role assignments), read back its clientId.
	uamiBody, _ := json.Marshal(map[string]any{"location": location})
	respBody, err := armRequestBody(ctx, client, http.MethodPut, uamiBase+"?api-version="+azureMSIAPIVersion, armToken, uamiBody)
	if err != nil {
		return "", fmt.Errorf("%w: create user-assigned identity %q: %w", ErrAKSIdentity, name, err)
	}
	var uami aksUAMIResponse
	if err := json.Unmarshal(respBody, &uami); err != nil {
		return "", fmt.Errorf("%w: decode identity response: %w", ErrAKSIdentity, err)
	}
	clientID := strings.TrimSpace(uami.Properties.ClientID)
	if !IsValidUAMIClientID(clientID) {
		return "", fmt.Errorf("%w: identity %q returned no/invalid clientId", ErrAKSIdentity, name)
	}

	// (2) PUT the federated identity credential trusting the namespace default KSA on the AKS OIDC issuer.
	ficBody, _ := json.Marshal(map[string]any{
		"properties": map[string]any{
			"issuer":    oidcIssuer,
			"subject":   "system:serviceaccount:" + namespace + ":default",
			"audiences": []string{azureWorkloadIdentityAudience},
		},
	})
	ficURL := fmt.Sprintf("%s/federatedIdentityCredentials/%s?api-version=%s", uamiBase, azureNamespaceFICName, azureMSIAPIVersion)
	if _, err := armRequestBody(ctx, client, http.MethodPut, ficURL, armToken, ficBody); err != nil {
		return "", fmt.Errorf("%w: create federated credential for %q: %w", ErrAKSIdentity, name, err)
	}
	return clientID, nil
}

// DeprovisionAKSNamespaceIdentity best-effort deletes the per-namespace UAMI (env/namespace teardown).
// Deleting the identity removes its federated credentials with it. A missing identity is not an error.
func DeprovisionAKSNamespaceIdentity(ctx context.Context, client *http.Client, armToken, subscriptionID, resourceGroup, clusterName, namespace string) error {
	if client == nil {
		client = &http.Client{Timeout: 20 * time.Second}
	}
	name := namespaceUAMIName(clusterName, namespace)
	delURL := fmt.Sprintf(
		"%s/subscriptions/%s/resourceGroups/%s/providers/Microsoft.ManagedIdentity/userAssignedIdentities/%s?api-version=%s",
		azureARMBase, url.PathEscape(subscriptionID), url.PathEscape(resourceGroup), url.PathEscape(name), azureMSIAPIVersion,
	)
	// DELETE is idempotent for ARM (204 on missing); armRequest tolerates 2xx, so a not-found 204 passes.
	if _, err := armRequest(ctx, client, http.MethodDelete, delURL, armToken); err != nil {
		return fmt.Errorf("%w: delete user-assigned identity %q: %w", ErrAKSIdentity, name, err)
	}
	return nil
}
