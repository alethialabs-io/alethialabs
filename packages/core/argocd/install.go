// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"io"
	"os"
	"strings"
	"text/template"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/utils"
)

// applyCRDRaceMaxWait bounds how long ApplyApplications retries while ArgoCD establishes the CRDs
// that its wave-1 operator Applications (e.g. external-secrets) install asynchronously.
var applyCRDRaceMaxWait = 5 * time.Minute

func ApplyApplications(renderedDir string, stdout, stderr io.Writer) error {
	cmd := fmt.Sprintf("kubectl apply -f %s", renderedDir)
	fmt.Fprintln(stdout, "Applying ArgoCD infrastructure applications...")
	// ArgoCD Applications install their CRDs + admission webhooks ASYNCHRONOUSLY via ArgoCD sync
	// (e.g. external-secrets-operator). The infra dir now contains ONLY Applications — the per-cloud
	// ClusterSecretStore CR that used to share the operator's file was pulled out because mixing a
	// CR-instance into this client-side apply deadlocked it on a fresh cluster (see
	// EnsureExternalSecretsStore / #1208). The retry below is kept as a harmless backstop for the
	// "an operator isn't fully up yet" markers, should a future template mix a CR-instance in again.
	deadline := time.Now().Add(applyCRDRaceMaxWait)
	for attempt := 1; ; attempt++ {
		var captured bytes.Buffer
		err := utils.ExecuteCommand(cmd, ".", nil, stdout, io.MultiWriter(stderr, &captured))
		if err == nil {
			fmt.Fprintln(stdout, "ArgoCD infrastructure applications applied.")
			return nil
		}
		// Retry ONLY the "operator not fully up yet" races; any other failure is fatal.
		if !isOperatorNotReady(captured.String()) || time.Now().After(deadline) {
			return fmt.Errorf("kubectl apply failed: %w", err)
		}
		fmt.Fprintf(stdout, "  An operator (CRD/webhook) isn't ready yet (attempt %d) — "+
			"waiting 15s for ArgoCD to finish installing it...\n", attempt)
		time.Sleep(15 * time.Second)
	}
}

// isOperatorNotReady reports whether a kubectl failure is a transient "the operator that backs this
// custom resource isn't fully installed yet" race — its CRD isn't registered, or its admission
// webhook has no ready endpoints. These are the only conditions ApplyApplications retries; a real
// validation/authz/config error is NOT retried.
func isOperatorNotReady(kubectlOutput string) bool {
	for _, marker := range []string{
		"no matches for kind",        // the CRD isn't registered yet
		"resource mapping not found", // ditto (RESTMapper hasn't seen the CRD)
		"failed calling webhook",     // the admission webhook backend isn't reachable yet
		"no endpoints available",     // the webhook Service has no ready pods yet
	} {
		if strings.Contains(kubectlOutput, marker) {
			return true
		}
	}
	return false
}

// externalDNSSecretManifest builds the namespace + token Secret manifest external-dns's
// connector-backed providers read (cloudflare CF_API_TOKEN / hetzner HETZNER_TOKEN).
// The namespace is included because the Secret must exist before the Application's first
// sync creates it via CreateNamespace=true.
func externalDNSSecretManifest(secretName, key, token string) string {
	b64 := base64.StdEncoding.EncodeToString
	return fmt.Sprintf(`apiVersion: v1
kind: Namespace
metadata:
  name: external-dns
---
apiVersion: v1
kind: Secret
metadata:
  name: %s
  namespace: external-dns
data:
  %s: %s
`, secretName, key, b64([]byte(token)))
}

// EnsureExternalDNSSecret applies the token Secret a connector-backed external-dns needs
// (idempotent; re-applying refreshes a rotated token on every deploy). Callers must pass a
// non-empty token — the render gate (DNSCredentialPresent) skips the app otherwise.
func EnsureExternalDNSSecret(secretName, key, token string, stdout, stderr io.Writer) error {
	if token == "" {
		return fmt.Errorf("refusing to write an empty %s token secret", secretName)
	}
	fmt.Fprintf(stdout, "Seeding external-dns credential secret %s...\n", secretName)
	return ApplyManifest(externalDNSSecretManifest(secretName, key, token), stdout, stderr)
}

// externalSecretsStoreMaxWait bounds how long EnsureExternalSecretsStore retries while ArgoCD
// installs the external-secrets operator (asynchronously) and its validating webhook becomes ready.
// Generous on purpose: on a fresh managed cluster the FULL chain — ArgoCD reconcile → Helm install →
// CRD registered → webhook pod scheduled + Ready — routinely runs past 10m (the old 5m mixed-file
// retry #784, and a first 10m attempt, both timed out on real EKS — #1208). The caller treats a
// timeout as NON-fatal, so this is an upper bound on the wait, not a hard requirement.
var externalSecretsStoreMaxWait = 15 * time.Minute

// externalSecretsStoreTemplate renders the per-cloud ClusterSecretStore. It carries the SAME
// per-cloud, workload-identity-gated conditions the operator's Application template used to embed —
// now separated so the store is applied on its OWN, AFTER the operator is up (see #1208). Exactly
// one branch renders (the `eq .Provider` guards are mutually exclusive); hetzner renders none.
const externalSecretsStoreTemplate = `
{{- if and (eq .Provider "aws") .IRSAExternalSecretsArn }}
apiVersion: external-secrets.io/v1beta1
kind: ClusterSecretStore
metadata:
  name: secretstore-aws
spec:
  provider:
    aws:
      service: SecretsManager
      region: {{ .Region }}
      auth:
        jwt:
          serviceAccountRef:
            name: external-secrets-operator-sa
            namespace: external-secrets-operator
{{- end }}
{{- if and (eq .Provider "gcp") .GCPExternalSecretsSA }}
apiVersion: external-secrets.io/v1beta1
kind: ClusterSecretStore
metadata:
  name: secretstore-gcp
spec:
  provider:
    gcpsm:
      projectID: {{ .GCPProjectID }}
{{- end }}
{{- if and (eq .Provider "azure") .AzureExternalSecretsClient .AzureKeyVaultURI }}
apiVersion: external-secrets.io/v1beta1
kind: ClusterSecretStore
metadata:
  name: secretstore-azure
spec:
  provider:
    azurekv:
      authType: WorkloadIdentity
      vaultUrl: {{ .AzureKeyVaultURI }}
{{- end }}
{{- if and (eq .Provider "alibaba") .AlibabaExternalSecretsRoleArn }}
apiVersion: external-secrets.io/v1beta1
kind: ClusterSecretStore
metadata:
  name: secretstore-alibaba
spec:
  provider:
    alibaba:
      regionID: {{ .Region }}
      auth:
        rrsa:
          oidcProviderArn: {{ .AlibabaOIDCProviderArn }}
          oidcTokenFilePath: /var/run/secrets/tokens/oidc-token
          roleArn: {{ .AlibabaExternalSecretsRoleArn }}
          sessionName: external-secrets
{{- end }}
`

var externalSecretsStoreTmpl = template.Must(template.New("external-secrets-store").Parse(externalSecretsStoreTemplate))

// externalSecretsStoreManifest renders the per-cloud ClusterSecretStore for the given facts, or ""
// when the provider/identity fact means there is no cloud secret store (e.g. hetzner).
func externalSecretsStoreManifest(facts *InfraFacts) (string, error) {
	var buf bytes.Buffer
	if err := externalSecretsStoreTmpl.Execute(&buf, facts); err != nil {
		return "", fmt.Errorf("render ClusterSecretStore: %w", err)
	}
	return strings.TrimSpace(buf.String()), nil
}

// EnsureExternalSecretsStore applies the per-cloud ClusterSecretStore AFTER ApplyApplications has
// applied the external-secrets operator's ArgoCD Application. The store is a custom resource whose
// kind + validating webhook the operator provides, so on a fresh cluster it races the operator in
// two stages ("no matches for kind", then "no endpoints available" for the webhook). Applying it
// here — on its own, server-side, retrying ONLY the transient operator-not-ready markers until the
// operator (installed asynchronously by ArgoCD) is up — fixes the #1208 bootstrap deadlock: mixing
// the store into the operator's client-side apply file could poison that file so the operator never
// installed and the retry could never converge. No-op when no store renders. Returns a timeout error
// after externalSecretsStoreMaxWait, which the caller treats as NON-fatal (the store is idempotent
// and reconciles on the next deploy — see deploy.go), so a slow operator webhook on a fresh cluster
// never fails an otherwise-healthy deploy.
func EnsureExternalSecretsStore(facts *InfraFacts, stdout, stderr io.Writer) error {
	manifest, err := externalSecretsStoreManifest(facts)
	if err != nil {
		return err
	}
	if manifest == "" {
		return nil
	}
	fmt.Fprintln(stdout, "Ensuring external-secrets ClusterSecretStore (waiting for the operator's CRD + webhook)...")
	deadline := time.Now().Add(externalSecretsStoreMaxWait)
	for attempt := 1; ; attempt++ {
		var captured bytes.Buffer
		applyErr := applyManifestServerSide(manifest, stdout, io.MultiWriter(stderr, &captured))
		if applyErr == nil {
			fmt.Fprintln(stdout, "ClusterSecretStore applied.")
			return nil
		}
		if !isOperatorNotReady(captured.String()) || time.Now().After(deadline) {
			if time.Now().After(deadline) {
				// The operator didn't become ready within the window — dump its pods so a recurrence
				// is diagnosable (slow install vs a stuck/unschedulable/crash-looping webhook pod).
				_ = utils.ExecuteCommand("kubectl get pods -n external-secrets-operator -o wide", ".", nil, stderr, stderr)
			}
			return fmt.Errorf("apply ClusterSecretStore: %w", applyErr)
		}
		fmt.Fprintf(stdout, "  external-secrets operator (CRD/webhook) isn't ready yet (attempt %d) — "+
			"waiting 15s for ArgoCD to finish installing it...\n", attempt)
		time.Sleep(15 * time.Second)
	}
}

// CleanupSkippedInfraServices removes infra-service objects that earlier deploys applied but
// the current facts no longer render. Infra services are plain `kubectl apply` (no label/prune
// scheme yet), so an app that stops rendering would otherwise be ORPHANED on the cluster —
// notably the pre-parity external-dns that shipped with `provider: aws` on alibaba/hetzner
// (crash-looping) and the unguarded AWS ClusterSecretStore applied on every cloud. Deletes are
// best-effort + idempotent (--ignore-not-found); deleting the Application cascades removal of
// the controller through its resources-finalizer.
func CleanupSkippedInfraServices(facts *InfraFacts, stdout, stderr io.Writer) {
	if !facts.DNSEnabled || facts.DomainName == "" || facts.DNSProvider() == "" {
		cmd := "kubectl delete application external-dns -n argocd --ignore-not-found --timeout=60s"
		fmt.Fprintln(stdout, "external-dns is not rendered for this configuration — removing any stale install...")
		if err := utils.ExecuteCommand(cmd, ".", nil, stdout, stderr); err != nil {
			fmt.Fprintf(stderr, "Warning: could not remove stale external-dns application: %v\n", err)
		}
	}
	// Per-cloud ClusterSecretStores: each gate must mirror external-secrets-operator.yaml's
	// render conditions — a store whose identity fact disappeared (or that belongs to another
	// cloud) stops rendering and would otherwise be orphaned in a permanently-broken state.
	esoStores := map[string]bool{
		"secretstore-aws":     facts.Provider == "aws" && facts.IRSAExternalSecretsArn != "",
		"secretstore-gcp":     facts.Provider == "gcp" && facts.GCPExternalSecretsSA != "",
		"secretstore-azure":   facts.Provider == "azure" && facts.AzureExternalSecretsClient != "" && facts.AzureKeyVaultURI != "",
		"secretstore-alibaba": facts.Provider == "alibaba" && facts.AlibabaExternalSecretsRoleArn != "",
	}
	for name, renders := range esoStores {
		if renders {
			continue
		}
		cmd := fmt.Sprintf("kubectl delete clustersecretstore %s --ignore-not-found --timeout=60s", name)
		if err := utils.ExecuteCommand(cmd, ".", nil, stdout, stderr); err != nil {
			fmt.Fprintf(stderr, "Warning: could not remove stale ClusterSecretStore %s: %v\n", name, err)
		}
	}
}

// ApplyManifest kubectl-applies a single in-memory manifest (e.g. a hardened BYO AppProject) via
// a temp file, so callers with a rendered string don't need to stage a directory.
func ApplyManifest(manifest string, stdout, stderr io.Writer) error {
	tmpFile, err := os.CreateTemp("", "argocd-manifest-*.yaml")
	if err != nil {
		return fmt.Errorf("failed to create temp file: %w", err)
	}
	defer os.Remove(tmpFile.Name())
	if _, err := tmpFile.WriteString(manifest); err != nil {
		tmpFile.Close()
		return fmt.Errorf("failed to write manifest: %w", err)
	}
	tmpFile.Close()
	cmd := fmt.Sprintf("kubectl apply -f %s", tmpFile.Name())
	if err := utils.ExecuteCommand(cmd, ".", nil, stdout, stderr); err != nil {
		return fmt.Errorf("kubectl apply failed: %w", err)
	}
	return nil
}

// ConfigureRepoCredentials registers the customer's apps-destination repo with ArgoCD under the
// shared "repo-apps" Secret. BYO chart repos use ConfigureRepoCredentialsNamed with a per-repo
// Secret name so they never collide with — or read — the apps repo's credential.
func ConfigureRepoCredentials(repoURL, token string, stdout, stderr io.Writer) error {
	return ConfigureRepoCredentialsNamed(repoURL, token, "repo-apps", stdout, stderr)
}

// ConfigureRepoCredentialsNamed applies an ArgoCD repository Secret (name `secretName`) granting
// token access to `repoURL`. Parametrizing the name lets each repo (apps destination + every BYO
// chart repo) own an isolated credential — a shared name would let one tenant's Application read
// another repo's token.
func ConfigureRepoCredentialsNamed(repoURL, token, secretName string, stdout, stderr io.Writer) error {
	fmt.Fprintf(stdout, "Configuring ArgoCD repository credentials for %s (secret %s)\n", repoURL, secretName)

	b64 := base64.StdEncoding.EncodeToString
	manifest := fmt.Sprintf(`apiVersion: v1
kind: Secret
metadata:
  name: %s
  namespace: argocd
  labels:
    argocd.argoproj.io/secret-type: repository
data:
  type: %s
  url: %s
  username: %s
  password: %s
`, secretName, b64([]byte("git")), b64([]byte(repoURL)), b64([]byte("x-access-token")), b64([]byte(token)))

	tmpFile, err := os.CreateTemp("", "argocd-repo-*.yaml")
	if err != nil {
		return fmt.Errorf("failed to create temp file: %w", err)
	}
	defer os.Remove(tmpFile.Name())

	if _, err := tmpFile.WriteString(manifest); err != nil {
		tmpFile.Close()
		return fmt.Errorf("failed to write secret manifest: %w", err)
	}
	tmpFile.Close()

	cmd := fmt.Sprintf("kubectl apply -f %s", tmpFile.Name())
	if err := utils.ExecuteCommand(cmd, ".", nil, stdout, stderr); err != nil {
		return fmt.Errorf("failed to apply repo credentials: %w", err)
	}

	fmt.Fprintln(stdout, "ArgoCD repository credentials configured.")
	return nil
}
