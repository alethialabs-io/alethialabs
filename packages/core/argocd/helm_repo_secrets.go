// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"

	"github.com/alethialabs-io/alethialabs/packages/core/utils"
)

// A pluggable helm_registry connector authenticates a PRIVATE Helm/OCI chart pull with an ArgoCD
// repository credential — an Opaque Secret in the argocd namespace labelled
// `argocd.argoproj.io/secret-type`, carrying `type: helm`, the chart-repo `url`, and
// username/password (and `enableOCI: "true"` for an OCI registry). ArgoCD matches it to any add-on /
// BYO Application whose repoURL matches (exact for a `repository` secret, URL-prefix for a
// `repo-creds` template) — so we do NOT edit any Application manifest to reference the repo; the
// credential is wired by URL. Like the registry pull secret, it is seeded POST-APPLY over the
// authenticated kubeconfig (the in-tofu kubernetes provider is host+CA-only on AWS and cannot create
// it) and carries a prune label but deliberately NO ArgoCD tracking metadata: no Application owns it,
// so nothing syncs it away, and PruneHelmRepoCredentials GCs a stale one. Secret material is NEVER
// rendered into a git-committed manifest and NEVER logged.

// helmRepoCredLabelKey marks a runner-seeded Helm repo-credential Secret so PruneHelmRepoCredentials
// can find it once its connector is deselected.
const helmRepoCredLabelKey = "alethia.io/helm-repo-cred"

// helmRepoCredManifest renders the ArgoCD repository-credential Secret. An OCI registry gets a
// `repo-creds` secret-type (URL-PREFIX match, so one credential covers every chart under the host)
// plus `enableOCI: "true"`; an HTTPS index repo gets `repository` (EXACT url match). url/username/
// password are base64'd into the Secret data and NEVER logged.
func helmRepoCredManifest(name, url, username, password string, enableOCI bool) string {
	b64 := func(s string) string { return base64.StdEncoding.EncodeToString([]byte(s)) }
	secretType := "repository"
	if enableOCI {
		secretType = "repo-creds"
	}
	manifest := fmt.Sprintf(`apiVersion: v1
kind: Secret
metadata:
  name: %s
  namespace: argocd
  labels:
    argocd.argoproj.io/secret-type: %s
    %s: "true"
type: Opaque
data:
  type: %s
  url: %s
  username: %s
  password: %s
`, name, secretType, helmRepoCredLabelKey, b64("helm"), b64(url), b64(username), b64(password))
	if enableOCI {
		manifest += fmt.Sprintf("  enableOCI: %s\n", b64("true"))
	}
	return manifest
}

// EnsureHelmRepoCredential seeds the ArgoCD repository credential for one connected private Helm/OCI
// chart repo. Idempotent — re-applying refreshes a rotated credential every deploy. Logs the name +
// url only (never the password). name derives from a sha256 of the URL (HelmRepoCredSecretName), but
// is validated (fail-closed) since it interpolates into a kubectl command.
func EnsureHelmRepoCredential(name, url, username, password string, enableOCI bool, stdout, stderr io.Writer) error {
	if url == "" || password == "" {
		return fmt.Errorf("refusing to write an incomplete Helm repo credential %s (missing url or password)", name)
	}
	if !k8sNameRe.MatchString(name) {
		return fmt.Errorf("refusing to write Helm repo credential with invalid name %q", name)
	}
	fmt.Fprintf(stdout, "Seeding Helm repo credential %s for %s...\n", name, url)
	return ApplyManifest(helmRepoCredManifest(name, url, username, password, enableOCI), stdout, stderr)
}

// PruneHelmRepoCredentials deletes runner-seeded Helm repo-credential Secrets in the argocd namespace
// that are no longer desired (mirrors PruneRegistryPullSecrets). Runs even when no helm_registry is
// selected (desiredNames empty) so a deselected connector's Secret is cleaned up. Best-effort +
// idempotent.
func PruneHelmRepoCredentials(desiredNames []string, stdout, stderr io.Writer) {
	desired := make(map[string]struct{}, len(desiredNames))
	for _, n := range desiredNames {
		desired[n] = struct{}{}
	}
	raw, err := utils.ExecuteCommandWithOutput(
		fmt.Sprintf("kubectl get secrets -n argocd -l %s -o json", helmRepoCredLabelKey),
		".",
		nil,
	)
	if err != nil {
		fmt.Fprintf(stderr, "Warning: could not list Helm repo credentials to prune: %v\n", err)
		return
	}
	var list struct {
		Items []struct {
			Metadata struct {
				Name      string `json:"name"`
				Namespace string `json:"namespace"`
			} `json:"metadata"`
		} `json:"items"`
	}
	if err := json.Unmarshal([]byte(raw), &list); err != nil {
		fmt.Fprintf(stderr, "Warning: could not parse Helm repo credential list to prune: %v\n", err)
		return
	}
	for _, item := range list.Items {
		if _, keep := desired[item.Metadata.Name]; keep {
			continue
		}
		// The name/namespace interpolate into a kubectl command; fail closed on anything the API
		// server wouldn't already constrain to a DNS label.
		if !k8sNameRe.MatchString(item.Metadata.Name) || !k8sNameRe.MatchString(item.Metadata.Namespace) {
			fmt.Fprintf(stderr, "Warning: skipping prune of oddly-named Helm repo credential %q/%q\n", item.Metadata.Namespace, item.Metadata.Name)
			continue
		}
		fmt.Fprintf(stdout, "Pruning deselected Helm repo credential: %s/%s\n", item.Metadata.Namespace, item.Metadata.Name)
		cmd := fmt.Sprintf("kubectl delete secret -n %s %s --ignore-not-found=true",
			item.Metadata.Namespace, item.Metadata.Name)
		if delErr := utils.ExecuteCommand(cmd, ".", nil, stdout, stderr); delErr != nil {
			fmt.Fprintf(stderr, "Warning: failed to prune Helm repo credential %s/%s: %v\n",
				item.Metadata.Namespace, item.Metadata.Name, delErr)
		}
	}
}
