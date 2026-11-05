// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"encoding/json"
	"fmt"
	"io"
	"regexp"
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

// ReleaseLegacyByoNamespaceLabels removes, from namespace ns, the labels an earlier runner stamped on
// it when a BYO chart deployed there (RenderByoNamespaces applied `alethia.io/managed-by: byo-charts`
// plus every one of the environment's commonLabels — the project and environment ids and the
// classification dimensions), and nothing else. It is for "default" after the charts in it moved out
// (#6446): nothing keyed on those labels may select the platform's namespace.
//
// It removes a key only when its value is exactly the one this environment's runner wrote:
// `managed-by` when it is "byo-charts", the owner label when it is owner, and each key of ours when
// its value equals ours. When the namespace's owner label names ANOTHER environment it touches
// nothing at all, because that environment's charts may still be there and the labels are then
// theirs too. Returns the keys it removed, sorted.
func ReleaseLegacyByoNamespaceLabels(ns, owner string, ours map[string]string, stdout io.Writer) ([]string, error) {
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
	want := map[string]string{byoNamespaceManagedByLabel: byoNamespaceManagedByValue, ByoBindingOwnerLabel: owner}
	for k, v := range ours {
		if k != byoNamespaceManagedByLabel && v != "" {
			want[k] = v
		}
	}
	var remove []string
	for k, v := range want {
		if got, ok := labels[k]; ok && got == v {
			remove = append(remove, k)
		}
	}
	if len(remove) == 0 {
		return nil, nil
	}
	sort.Strings(remove)
	args := make([]string, len(remove))
	for i, k := range remove {
		// A label key is a qualified name, so it cannot carry shell metacharacters; refuse one that
		// does rather than interpolate it.
		if !labelKeyRe.MatchString(k) {
			return nil, fmt.Errorf("refusing to remove label %q from namespace %s: not a label key", k, ns)
		}
		args[i] = k + "-"
	}
	if _, err := utils.ExecuteCommandWithOutput(fmt.Sprintf("kubectl label namespace %s %s", ns, strings.Join(args, " ")), ".", nil); err != nil {
		return nil, fmt.Errorf("remove BYO labels from namespace %s: %w", ns, err)
	}
	fmt.Fprintf(stdout, "Removed the BYO chart labels %s from namespace %q\n", strings.Join(remove, ", "), ns)
	return remove, nil
}

// labelKeyRe is a Kubernetes label key: an optional DNS-subdomain prefix and a name segment.
var labelKeyRe = regexp.MustCompile(`^([a-z0-9]([-a-z0-9.]*[a-z0-9])?/)?[A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?$`)
