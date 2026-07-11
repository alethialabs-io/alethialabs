// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"encoding/base64"
	"fmt"
	"io"
	"os"

	"github.com/alethialabs-io/alethialabs/packages/core/utils"
)

func ApplyApplications(renderedDir string, stdout, stderr io.Writer) error {
	cmd := fmt.Sprintf("kubectl apply -f %s", renderedDir)
	fmt.Fprintln(stdout, "Applying ArgoCD infrastructure applications...")
	if err := utils.ExecuteCommand(cmd, ".", nil, stdout, stderr); err != nil {
		return fmt.Errorf("kubectl apply failed: %w", err)
	}
	fmt.Fprintln(stdout, "ArgoCD infrastructure applications applied.")
	return nil
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
	if facts.Provider != "aws" {
		cmd := "kubectl delete clustersecretstore secretstore-aws --ignore-not-found --timeout=60s"
		if err := utils.ExecuteCommand(cmd, ".", nil, stdout, stderr); err != nil {
			fmt.Fprintf(stderr, "Warning: could not remove stale AWS ClusterSecretStore: %v\n", err)
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
