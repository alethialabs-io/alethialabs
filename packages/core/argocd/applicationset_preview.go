// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"bytes"
	"fmt"
	"sort"
	"strings"
	"text/template"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// PreviewAppSetInput carries the inputs for the ephemeral PR-preview ApplicationSet (#842, W-f).
// The rendered ApplicationSet uses ArgoCD's Pull Request generator: it lists the repo's OPEN pull
// requests and materializes one Application per PR (deploying that PR's head_sha), then destroys the
// Application when the PR closes — so create-on-open / deploy-head_sha / destroy-on-close is native
// to ArgoCD, no webhook receiver required. PlacementMode selects the per-team tenancy of each
// preview (namespace | vcluster); dedicated is not a valid preview placement.
type PreviewAppSetInput struct {
	// Project slug — names the ApplicationSet (preview-<project>) and the generated Applications.
	Project string
	// SCM host for the PR generator block: github | gitlab | bitbucket.
	GitProvider string
	// The repo whose open pull requests generate previews.
	RepoOwner string
	RepoName  string
	// ArgoCD Secret (in the argocd namespace) the PR generator authenticates the SCM API with.
	// Empty → the generator polls anonymously (public repos only).
	TokenSecretRef string
	// Git URL ArgoCD deploys each preview's manifests from, and the path within it. The manifests
	// are read at the PR's head_sha (targetRevision below), so previews always track the PR's code.
	AppsRepoURL string
	AppsPath    string
	// Per-team tenancy of each preview env.
	PlacementMode types.PlacementMode
	// namespace placement: the Fabric cluster's ArgoCD destination API server. Empty → in-cluster
	// (https://kubernetes.default.svc), i.e. the Fabric ArgoCD runs on.
	DestServer string
	// vcluster placement: the registered ArgoCD cluster name of the per-PR vcluster host. The
	// vcluster itself is provisioned by a later unit; this only names the destination.
	VClusterName string
	// Namespace prefix for each preview (e.g. "preview" → preview-pr-<number>). Defaults to "preview".
	NamespacePrefix string
	// Common labels stamped on the ApplicationSet and propagated onto each generated Application
	// (InjectCommonLabels does not descend into an ApplicationSet, so this template loops explicitly).
	Labels map[string]string
}

// previewAppSetTmpl renders the PR-preview ApplicationSet. It uses [[ ]] delimiters so ArgoCD's own
// {{ }} generator placeholders ({{ .number }}, {{ .head_sha }}, {{ .branch }}) pass through to
// ArgoCD verbatim instead of being resolved here.
const previewAppSetTmpl = `apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: preview-[[ .Project ]]
  namespace: argocd
  labels:
    alethia.io/preview: "true"
[[- range .SortedLabels ]]
    [[ .Key ]]: "[[ .Value ]]"
[[- end ]]
spec:
  goTemplate: true
  goTemplateOptions: ["missingkey=error"]
  generators:
    - pullRequest:
        [[ .GitProvider ]]:
          owner: [[ .RepoOwner ]]
          repo: [[ .RepoName ]]
[[- if .TokenSecretRef ]]
          tokenRef:
            secretName: [[ .TokenSecretRef ]]
            key: token
[[- end ]]
        requeueAfterSeconds: 60
  template:
    metadata:
      name: 'preview-[[ .Project ]]-{{ .number }}'
      labels:
        alethia.io/preview: "true"
        alethia.io/preview-pr: '{{ .number }}'
[[- range .SortedLabels ]]
        [[ .Key ]]: "[[ .Value ]]"
[[- end ]]
    spec:
      project: apps
      source:
        repoURL: [[ .AppsRepoURL ]]
        targetRevision: '{{ .head_sha }}'
        path: '[[ .AppsPath ]]'
      destination:
[[- if eq .PlacementModeStr "vcluster" ]]
        name: '[[ .VClusterName ]]-{{ .number }}'
        namespace: [[ .NamespacePrefix ]]
[[- else ]]
        server: [[ .DestServerOrDefault ]]
        namespace: '[[ .NamespacePrefix ]]-{{ .number }}'
[[- end ]]
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
        syncOptions:
          - CreateNamespace=true
`

// SECURITY (#887): a preview deploys UNTRUSTED PR code into a namespace. Before the runner is wired
// to apply this ApplicationSet, each preview namespace must receive least-priv RBAC + a default-deny
// NetworkPolicy + a ResourceQuota — this renderer is an unused seam until that guardrail lands.
//
// RenderPreviewApplicationSet renders the ephemeral PR-preview ApplicationSet YAML (#842, W-f).
// It returns an error when a required field is missing, or when PlacementMode is anything other than
// namespace|vcluster (dedicated/"" is not a valid preview placement — fail closed rather than emit a
// manifest that can't run). The caller (runner) applies the result to the Fabric's ArgoCD like the
// other Applications; ArgoCD then reconciles one preview per open PR.
func RenderPreviewApplicationSet(in PreviewAppSetInput) (string, error) {
	if err := in.validate(); err != nil {
		return "", err
	}
	data := in.templateData()
	tmpl, err := template.New("preview-appset").Delims("[[", "]]").Parse(previewAppSetTmpl)
	if err != nil {
		return "", fmt.Errorf("parse preview ApplicationSet template: %w", err)
	}
	var buf bytes.Buffer
	if err := tmpl.Execute(&buf, data); err != nil {
		return "", fmt.Errorf("render preview ApplicationSet: %w", err)
	}
	return buf.String(), nil
}

// validate fails closed on missing inputs or an unsupported placement, so a broken config never
// reaches ArgoCD as a half-formed manifest.
func (in PreviewAppSetInput) validate() error {
	switch {
	case strings.TrimSpace(in.Project) == "":
		return fmt.Errorf("preview ApplicationSet: project is required")
	case strings.TrimSpace(in.GitProvider) == "":
		return fmt.Errorf("preview ApplicationSet: git provider is required")
	case strings.TrimSpace(in.RepoOwner) == "" || strings.TrimSpace(in.RepoName) == "":
		return fmt.Errorf("preview ApplicationSet: repo owner and name are required")
	case strings.TrimSpace(in.AppsRepoURL) == "":
		return fmt.Errorf("preview ApplicationSet: apps repo URL is required")
	}
	switch in.PlacementMode {
	case types.PlacementModeNamespace, types.PlacementModeVcluster:
		// ok — the two valid preview tenancies.
	case types.PlacementModeDedicated:
		return fmt.Errorf("preview ApplicationSet: dedicated placement is not valid for an ephemeral preview (want namespace|vcluster)")
	default:
		return fmt.Errorf("preview ApplicationSet: placement mode %q is not a valid preview placement (want namespace|vcluster)", in.PlacementMode)
	}
	if in.PlacementMode == types.PlacementModeVcluster && strings.TrimSpace(in.VClusterName) == "" {
		return fmt.Errorf("preview ApplicationSet: vcluster placement requires a vcluster name")
	}
	return nil
}

// previewTemplateData is the flattened view the template consumes (methods can't take args in a
// template, so precompute the derived values here).
type previewTemplateData struct {
	PreviewAppSetInput
	SortedLabels        []labelKV
	PlacementModeStr    string
	DestServerOrDefault string
}

type labelKV struct {
	Key   string
	Value string
}

// templateData precomputes derived template values (sorted labels for determinism, the
// placement-mode string, and the in-cluster default destination).
func (in PreviewAppSetInput) templateData() previewTemplateData {
	prefix := in.NamespacePrefix
	if strings.TrimSpace(prefix) == "" {
		prefix = "preview"
	}
	in.NamespacePrefix = prefix

	dest := in.DestServer
	if strings.TrimSpace(dest) == "" {
		dest = "https://kubernetes.default.svc"
	}

	keys := make([]string, 0, len(in.Labels))
	for k := range in.Labels {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	labels := make([]labelKV, 0, len(keys))
	for _, k := range keys {
		labels = append(labels, labelKV{Key: k, Value: in.Labels[k]})
	}

	return previewTemplateData{
		PreviewAppSetInput:  in,
		SortedLabels:        labels,
		PlacementModeStr:    string(in.PlacementMode),
		DestServerOrDefault: dest,
	}
}
