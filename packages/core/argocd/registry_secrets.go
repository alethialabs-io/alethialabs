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

// A pluggable container-registry connector (dockerhub/ghcr/…) authenticates a private image pull
// with a dockerconfigjson imagePullSecret. It used to be created by an in-tofu kubernetes_secret,
// but the in-tofu kubernetes provider is host+CA-only on AWS (no token/exec — removed for the
// CLI-free runner) and cannot create it there, failing the whole apply. So the runner seeds it
// POST-APPLY via kubectl apply instead (the EnsureExternalDNSSecret pattern), authenticating
// through the exec-plugin KUBECONFIG that mints a cluster token in-process — which works on every
// cloud incl. AWS. The Secret carries a prune label but deliberately NO ArgoCD tracking metadata:
// no Application owns it, so nothing syncs it away, and PruneRegistryPullSecrets GCs a stale one.

// registryPullSecretLabelKey marks a runner-seeded registry pull Secret so PruneRegistryPullSecrets
// can find it wherever it lives, once its registry is deselected.
const registryPullSecretLabelKey = "alethia.io/registry-pull"

// registryPullSecretManifest renders the dockerconfigjson Secret (+ its namespace, in case the app
// namespace isn't created yet). dockerConfigJSON is the raw ".dockerconfigjson" value; it is
// base64'd into the Secret data and NEVER logged.
func registryPullSecretManifest(name, namespace, dockerConfigJSON string) string {
	b64 := base64.StdEncoding.EncodeToString
	return fmt.Sprintf(`apiVersion: v1
kind: Namespace
metadata:
  name: %s
---
apiVersion: v1
kind: Secret
metadata:
  name: %s
  namespace: %s
  labels:
    %s: "true"
type: kubernetes.io/dockerconfigjson
data:
  .dockerconfigjson: %s
`, namespace, name, namespace, registryPullSecretLabelKey, b64([]byte(dockerConfigJSON)))
}

// EnsureRegistryPullSecret seeds the dockerconfigjson imagePullSecret the app pods reference
// (manifests.Options.ImagePullSecrets). Idempotent — re-applying refreshes a rotated credential on
// every deploy. Logs the name only (never the payload). name/namespace derive from a trusted
// catalog slug, but are validated (fail-closed) since they interpolate into a kubectl command.
func EnsureRegistryPullSecret(name, namespace, dockerConfigJSON string, stdout, stderr io.Writer) error {
	if dockerConfigJSON == "" {
		return fmt.Errorf("refusing to write an empty registry pull secret %s", name)
	}
	if !k8sNameRe.MatchString(name) || !k8sNameRe.MatchString(namespace) {
		return fmt.Errorf("refusing to write registry pull secret with invalid name/namespace %q/%q", namespace, name)
	}
	fmt.Fprintf(stdout, "Seeding registry pull secret %s/%s...\n", namespace, name)
	return ApplyManifest(registryPullSecretManifest(name, namespace, dockerConfigJSON), stdout, stderr)
}

// PruneRegistryPullSecrets deletes runner-seeded registry pull Secrets that are no longer desired
// (mirrors PruneAddOnSecrets: lists across ALL namespaces by label, deletes anything not in the
// desired set). Runs even when no registry is selected (desiredNames empty) so a deselected
// registry's secret is cleaned up. Best-effort + idempotent.
func PruneRegistryPullSecrets(desiredNames []string, stdout, stderr io.Writer) {
	desired := make(map[string]struct{}, len(desiredNames))
	for _, n := range desiredNames {
		desired[n] = struct{}{}
	}
	raw, err := utils.ExecuteCommandWithOutput(
		fmt.Sprintf("kubectl get secrets -A -l %s -o json", registryPullSecretLabelKey),
		".",
		nil,
	)
	if err != nil {
		fmt.Fprintf(stderr, "Warning: could not list registry pull secrets to prune: %v\n", err)
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
		fmt.Fprintf(stderr, "Warning: could not parse registry pull secret list to prune: %v\n", err)
		return
	}
	for _, item := range list.Items {
		if _, keep := desired[item.Metadata.Name]; keep {
			continue
		}
		// The name/namespace interpolate into a kubectl command; fail closed on anything the API
		// server wouldn't already constrain to a DNS label.
		if !k8sNameRe.MatchString(item.Metadata.Name) || !k8sNameRe.MatchString(item.Metadata.Namespace) {
			fmt.Fprintf(stderr, "Warning: skipping prune of oddly-named registry pull secret %q/%q\n", item.Metadata.Namespace, item.Metadata.Name)
			continue
		}
		fmt.Fprintf(stdout, "Pruning deselected registry's pull secret: %s/%s\n", item.Metadata.Namespace, item.Metadata.Name)
		cmd := fmt.Sprintf("kubectl delete secret -n %s %s --ignore-not-found=true",
			item.Metadata.Namespace, item.Metadata.Name)
		if delErr := utils.ExecuteCommand(cmd, ".", nil, stdout, stderr); delErr != nil {
			fmt.Fprintf(stderr, "Warning: failed to prune registry pull secret %s/%s: %v\n",
				item.Metadata.Namespace, item.Metadata.Name, delErr)
		}
	}
}
