// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

// W5 Path A Lane 2b — prune runner-applied BYO chart binding ExternalSecrets. These are applied by
// the runner OUTSIDE ArgoCD (the hardened BYO AppProject forbids namespaced CRs), so nothing else
// sweeps them: when a binding is removed (or its chart detached), its ExternalSecret would orphan.
// This mirrors PruneAddOnSecrets (addon_secrets.go) for the binding-ExternalSecret case.

import (
	"encoding/json"
	"fmt"
	"io"

	"github.com/alethialabs-io/alethialabs/packages/core/utils"
)

// ByoBindingSecretLabel marks an ExternalSecret the runner applied for a BYO chart workload's
// credential binding. The renderer stamps it (ExternalSecretParams.Labels) so the prune below can
// list them; the desired set is the ExternalSecret NAMES the current deploy re-applied.
const ByoBindingSecretLabel = "alethia.io/byo-binding"

// PruneChartBindingSecrets deletes any labelled BYO binding ExternalSecret whose name is no longer
// desired (a removed binding, or a detached chart). Best-effort + fail-closed on odd names — same
// discipline as PruneAddOnSecrets. `desiredNames` are the ExternalSecret names this deploy applied.
func PruneChartBindingSecrets(desiredNames []string, stdout, stderr io.Writer) {
	desired := make(map[string]struct{}, len(desiredNames))
	for _, n := range desiredNames {
		desired[n] = struct{}{}
	}
	raw, err := utils.ExecuteCommandWithOutput(
		fmt.Sprintf("kubectl get externalsecrets -A -l %s=true -o json", ByoBindingSecretLabel),
		".",
		nil,
	)
	if err != nil {
		fmt.Fprintf(stderr, "Warning: could not list BYO binding ExternalSecrets to prune: %v\n", err)
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
		fmt.Fprintf(stderr, "Warning: could not parse BYO binding ExternalSecret list to prune: %v\n", err)
		return
	}
	for _, item := range list.Items {
		if _, keep := desired[item.Metadata.Name]; keep {
			continue
		}
		// name/namespace interpolate into a kubectl command; the API server already constrains them
		// to DNS labels, but fail closed on anything that isn't one (mirrors PruneAddOnSecrets).
		if !k8sNameRe.MatchString(item.Metadata.Name) || !k8sNameRe.MatchString(item.Metadata.Namespace) {
			fmt.Fprintf(stderr, "Warning: skipping prune of oddly-named ExternalSecret %q/%q\n", item.Metadata.Namespace, item.Metadata.Name)
			continue
		}
		fmt.Fprintf(stdout, "Pruning removed BYO binding ExternalSecret: %s/%s\n", item.Metadata.Namespace, item.Metadata.Name)
		cmd := fmt.Sprintf("kubectl delete externalsecret -n %s %s --ignore-not-found=true",
			item.Metadata.Namespace, item.Metadata.Name)
		if delErr := utils.ExecuteCommand(cmd, ".", nil, stdout, stderr); delErr != nil {
			fmt.Fprintf(stderr, "Warning: failed to prune BYO binding ExternalSecret %s/%s: %v\n",
				item.Metadata.Namespace, item.Metadata.Name, delErr)
		}
	}
}
