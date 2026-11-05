// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"encoding/json"
	"fmt"
	"io"
	"sort"
	"strings"

	"github.com/alethialabs-io/alethialabs/packages/core/utils"
)

// The cluster reads and the one label edit the BYO migrations need (#6445, #6446). Each touches
// exactly one named object and fails soft: a read that fails is reported to the caller, which then
// says nothing rather than something false.

// byoNamespaceManagedByLabel and byoNamespaceManagedByValue are the label RenderByoNamespaces stamps
// on every namespace it applies.
const (
	byoNamespaceManagedByLabel = "alethia.io/managed-by"
	byoNamespaceManagedByValue = "byo-charts"
)

// LiveApplicationProject returns spec.project of the add-on Application named name as it is on the
// cluster now, or "" when there is no such Application. Used before an OCI BYO chart's Application is
// re-applied, to tell whether this deploy moves it out of another project.
func LiveApplicationProject(name string) (string, error) {
	if !k8sNameRe.MatchString(name) {
		return "", fmt.Errorf("refusing to read Application %q: not a Kubernetes name", name)
	}
	out, err := utils.ExecuteCommandWithOutput(
		fmt.Sprintf("kubectl get applications.argoproj.io %s -n argocd --ignore-not-found -o jsonpath={.spec.project}", name),
		".", nil)
	if err != nil {
		return "", fmt.Errorf("read Application %s: %w", name, err)
	}
	return strings.TrimSpace(out), nil
}

// ReleaseLegacyByoNamespaceLabels removes, from namespace ns, the two labels an earlier runner put on
// it when a BYO chart deployed there — `alethia.io/managed-by: byo-charts` and this environment's
// `alethia.io/environment-id: <owner>` — and nothing else. It is for "default" after the charts in
// it moved out (#6446): nothing keyed on those labels may select the platform's namespace.
//
// It removes a key only when its value is exactly the one this environment's runner wrote. When the
// namespace names ANOTHER environment it touches nothing at all, because that environment's charts
// may still be there and the managed-by label is then theirs too. Returns the keys it removed.
func ReleaseLegacyByoNamespaceLabels(ns, owner string, stdout io.Writer) ([]string, error) {
	if !k8sNameRe.MatchString(ns) || !validOwner(owner) {
		return nil, fmt.Errorf("refusing to edit namespace %q labels for owner %q", ns, owner)
	}
	raw, err := utils.ExecuteCommandWithOutput(fmt.Sprintf("kubectl get namespace %s -o json", ns), ".", nil)
	if err != nil {
		return nil, fmt.Errorf("read namespace %s: %w", ns, err)
	}
	var obj struct {
		Metadata struct {
			Labels map[string]string `json:"labels"`
		} `json:"metadata"`
	}
	if err := json.Unmarshal([]byte(raw), &obj); err != nil {
		return nil, fmt.Errorf("parse namespace %s: %w", ns, err)
	}
	labels := obj.Metadata.Labels
	if v, ok := labels[ByoBindingOwnerLabel]; ok && v != owner {
		return nil, nil
	}
	var remove []string
	if labels[ByoBindingOwnerLabel] == owner {
		remove = append(remove, ByoBindingOwnerLabel)
	}
	if labels[byoNamespaceManagedByLabel] == byoNamespaceManagedByValue {
		remove = append(remove, byoNamespaceManagedByLabel)
	}
	if len(remove) == 0 {
		return nil, nil
	}
	sort.Strings(remove)
	args := make([]string, len(remove))
	for i, k := range remove {
		args[i] = k + "-"
	}
	if _, err := utils.ExecuteCommandWithOutput(fmt.Sprintf("kubectl label namespace %s %s", ns, strings.Join(args, " ")), ".", nil); err != nil {
		return nil, fmt.Errorf("remove BYO labels from namespace %s: %w", ns, err)
	}
	fmt.Fprintf(stdout, "Removed the BYO chart labels %s from namespace %q\n", strings.Join(remove, ", "), ns)
	return remove, nil
}
