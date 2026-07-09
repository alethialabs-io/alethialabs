// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"text/template"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/alethialabs-io/alethialabs/packages/core/utils"
	"gopkg.in/yaml.v3"
)

// applicationTmpl renders a marketplace add-on as an ArgoCD Helm Application, mirroring the
// hardcoded platform templates (e.g. external-secrets-operator.yaml). Automated + self-heal
// so the cluster converges to the declared chart; CreateNamespace so the target namespace is
// made on first sync. The sync-wave orders installs (lower first).
var applicationTmpl = template.Must(template.New("addon-app").Parse(`apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: {{ .Name }}
  namespace: argocd
  annotations:
    argocd.argoproj.io/sync-wave: "{{ .SyncWave }}"
  labels:
    alethia.io/managed-by: addon-marketplace
    alethia.io/addon-id: {{ .ID }}
    alethia.io/addon-mode: {{ .Mode }}
  finalizers:
    - resources-finalizer.argocd.argoproj.io
spec:
  project: infra
  source:
    repoURL: {{ .ChartRepo }}
    chart: {{ .Chart }}
    targetRevision: "{{ .Version }}"
    helm:
      values: |
{{ .ValuesIndented }}
  destination:
    server: https://kubernetes.default.svc
    namespace: {{ .Namespace }}
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - CreateNamespace=true
  revisionHistoryLimit: 3
`))

// addonTmplData is the flattened view the Application template renders against.
type addonTmplData struct {
	Name           string
	ID             string
	Mode           string
	Chart          string
	ChartRepo      string
	Version        string
	Namespace      string
	SyncWave       int
	ValuesIndented string
}

// AddOnAppName is the ArgoCD Application name for an add-on. Deterministic (the catalog id),
// so re-deploys converge on the same Application rather than creating duplicates. Exported so
// the health read-back can address the same names.
func AddOnAppName(id string) string {
	return "addon-" + id
}

// RenderManagedAddOns writes one ArgoCD Application manifest per managed add-on into a fresh
// temp dir and returns it, ready for ApplyApplications (kubectl apply). Gitops-mode add-ons
// are skipped here (Phase 2 writes those into the customer's apps repo). Returns an empty dir
// (and no error) when there are no managed add-ons, so the caller can apply unconditionally.
func RenderManagedAddOns(addons []types.AddOnInstall) (string, error) {
	outDir, err := os.MkdirTemp("", "argocd-addons-*")
	if err != nil {
		return "", fmt.Errorf("failed to create temp dir: %w", err)
	}

	for _, a := range addons {
		if a.Mode != "managed" {
			continue
		}
		manifest, err := RenderAddOnApplication(a)
		if err != nil {
			return "", fmt.Errorf("failed to render add-on %s: %w", a.ID, err)
		}
		dst := filepath.Join(outDir, AddOnAppName(a.ID)+".yaml")
		if err := os.WriteFile(dst, []byte(manifest), 0644); err != nil {
			return "", fmt.Errorf("failed to write add-on %s: %w", a.ID, err)
		}
	}

	return outDir, nil
}

// RenderAddOnApplication produces the ArgoCD Application YAML for a single add-on: the Helm
// values map is marshalled to YAML and indented under `helm.values: |` (a literal block).
// Exported so gitops-mode writes reuse the exact same manifest body the managed apply uses.
func RenderAddOnApplication(a types.AddOnInstall) (string, error) {
	valuesYAML, err := marshalValues(a.Values)
	if err != nil {
		return "", err
	}
	mode := a.Mode
	if mode == "" {
		mode = "managed"
	}
	data := addonTmplData{
		Name:           AddOnAppName(a.ID),
		ID:             a.ID,
		Mode:           mode,
		Chart:          a.Chart,
		ChartRepo:      a.ChartRepo,
		Version:        a.Version,
		Namespace:      a.Namespace,
		SyncWave:       a.SyncWave,
		ValuesIndented: indent(valuesYAML, "        "),
	}
	var buf bytes.Buffer
	if err := applicationTmpl.Execute(&buf, data); err != nil {
		return "", err
	}
	return buf.String(), nil
}

// marshalValues renders the Helm values map to deterministic YAML (yaml.v3 sorts map keys),
// so the same values always produce the same manifest — stable diffs + no spurious ArgoCD
// OutOfSync. An empty/nil map yields "{}" so `helm.values` is always valid YAML.
func marshalValues(values map[string]interface{}) (string, error) {
	if len(values) == 0 {
		return "{}", nil
	}
	var buf bytes.Buffer
	enc := yaml.NewEncoder(&buf)
	enc.SetIndent(2)
	if err := enc.Encode(values); err != nil {
		return "", fmt.Errorf("failed to marshal helm values: %w", err)
	}
	_ = enc.Close()
	return buf.String(), nil
}

// indent prefixes every non-empty line with `prefix` (for nesting a YAML block under a
// literal-block scalar). Trailing empty lines are dropped so the block stays tight.
func indent(s, prefix string) string {
	lines := splitLines(s)
	var buf bytes.Buffer
	for i, ln := range lines {
		if ln == "" && i == len(lines)-1 {
			continue
		}
		buf.WriteString(prefix)
		buf.WriteString(ln)
		buf.WriteByte('\n')
	}
	return buf.String()
}

// splitLines splits on '\n' without a trailing empty element surprise (keeps interior blanks).
func splitLines(s string) []string {
	var out []string
	start := 0
	for i := 0; i < len(s); i++ {
		if s[i] == '\n' {
			out = append(out, s[start:i])
			start = i + 1
		}
	}
	out = append(out, s[start:])
	return out
}

// ManagedAddOnNames returns the ArgoCD Application names for the managed add-ons, sorted.
func ManagedAddOnNames(addons []types.AddOnInstall) []string {
	var names []string
	for _, a := range addons {
		if a.Mode == "managed" {
			names = append(names, AddOnAppName(a.ID))
		}
	}
	sort.Strings(names)
	return names
}

// AllAddOnNames returns the ArgoCD Application names for every enabled add-on (managed +
// gitops), sorted — the health read-back reads them all (gitops child apps are named the
// same `addon-<id>`, created by the app-of-apps).
func AllAddOnNames(addons []types.AddOnInstall) []string {
	names := make([]string, 0, len(addons))
	for _, a := range addons {
		names = append(names, AddOnAppName(a.ID))
	}
	sort.Strings(names)
	return names
}

// PruneManagedAddOns deletes ArgoCD Applications this marketplace manages directly (label
// `alethia.io/addon-mode=managed`) that are NOT in `desiredNames` — i.e. add-ons the user
// disabled. The Application's finalizer cascades cleanup of its workloads. Best-effort: a
// read/delete hiccup is logged, not fatal (a failed prune must not fail an otherwise-healthy
// deploy). Gitops add-ons are pruned via their repo files, not here.
func PruneManagedAddOns(desiredNames []string, stdout, stderr io.Writer) error {
	desired := make(map[string]struct{}, len(desiredNames))
	for _, n := range desiredNames {
		desired[n] = struct{}{}
	}

	raw, err := utils.ExecuteCommandWithOutput(
		"kubectl get applications.argoproj.io -n argocd -l alethia.io/managed-by=addon-marketplace,alethia.io/addon-mode=managed -o json",
		".",
		nil,
	)
	if err != nil {
		fmt.Fprintf(stderr, "Warning: could not list add-ons to prune: %v\n", err)
		return nil
	}
	var list struct {
		Items []struct {
			Metadata struct {
				Name string `json:"name"`
			} `json:"metadata"`
		} `json:"items"`
	}
	if err := json.Unmarshal([]byte(raw), &list); err != nil {
		fmt.Fprintf(stderr, "Warning: could not parse add-on list to prune: %v\n", err)
		return nil
	}

	for _, item := range list.Items {
		if _, keep := desired[item.Metadata.Name]; keep {
			continue
		}
		fmt.Fprintf(stdout, "Pruning disabled add-on: %s\n", item.Metadata.Name)
		cmd := fmt.Sprintf(
			"kubectl delete applications.argoproj.io -n argocd %s --ignore-not-found=true",
			item.Metadata.Name,
		)
		if delErr := utils.ExecuteCommand(cmd, ".", nil, stdout, stderr); delErr != nil {
			fmt.Fprintf(stderr, "Warning: failed to prune %s: %v\n", item.Metadata.Name, delErr)
		}
	}
	return nil
}

// ApplyAddOns applies the rendered managed add-on manifests (kubectl apply). A thin alias over
// ApplyApplications kept separate so the deploy log reads "add-ons" distinctly from the
// platform infra apply. A no-op (nil) when the dir is empty.
func ApplyAddOns(renderedDir string, stdout, stderr io.Writer) error {
	entries, err := os.ReadDir(renderedDir)
	if err != nil {
		return fmt.Errorf("failed to read add-on dir: %w", err)
	}
	if len(entries) == 0 {
		return nil
	}
	fmt.Fprintln(stdout, "Applying marketplace add-ons...")
	return ApplyApplications(renderedDir, stdout, stderr)
}
