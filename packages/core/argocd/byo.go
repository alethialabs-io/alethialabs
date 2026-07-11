// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"regexp"
	"strings"
	"text/template"
)

// byoAppProjectTmpl renders a HARDENED per-project ArgoCD AppProject for bring-your-own charts.
// Unlike the wide-open "infra"/"apps" projects (clusterResourceWhitelist [*,*], destinations
// namespace "*"), a BYO project is default-deny:
//   - sourceRepos is locked to exactly the customer's chart repos (no other repo can sync here);
//   - destinations are pinned to the in-cluster server + the specific namespaces the charts target;
//   - clusterResourceWhitelist is EMPTY — no cluster-scoped resource (CRD, ClusterRole/Binding,
//     Namespace, ValidatingWebhook, …) may be created by an untrusted chart;
//   - namespaceResourceBlacklist denies in-namespace privilege-escalation vectors (RBAC Role/
//     RoleBinding, ServiceAccount) so a chart can't grant itself extra permissions.
//
// This is the AppProject half of the trust boundary; namespace PSA + an admission controller
// (Kyverno/Gatekeeper) are the pod-level half added before untrusted charts are allowed.
var byoAppProjectTmpl = template.Must(template.New("byo-project").Parse(`apiVersion: argoproj.io/v1alpha1
kind: AppProject
metadata:
  name: {{ .Name }}
  namespace: argocd
  labels:
    alethia.io/managed-by: byo-charts
  finalizers:
    - resources-finalizer.argocd.argoproj.io
spec:
  description: Bring-your-own Helm charts (hardened, default-deny)
  sourceRepos:
{{- range .SourceRepos }}
    - "{{ . }}"
{{- end }}
  destinations:
{{- range .Namespaces }}
    - namespace: "{{ . }}"
      server: https://kubernetes.default.svc
{{- end }}
  clusterResourceWhitelist: []
  namespaceResourceBlacklist:
    - group: rbac.authorization.k8s.io
      kind: Role
    - group: rbac.authorization.k8s.io
      kind: RoleBinding
    - group: ""
      kind: ServiceAccount
  orphanedResources:
    warn: true
`))

type byoProjectData struct {
	Name        string
	SourceRepos []string
	Namespaces  []string
}

var slugUnsafe = regexp.MustCompile(`[^a-z0-9-]+`)

// ByoProjectName derives a stable, RFC1123-safe ArgoCD AppProject name for a project's BYO
// charts: "byo-<sanitized-slug>". `slug` is typically the project name; a fallback keeps the
// name non-empty and bounded (ArgoCD names must be ≤63 chars).
func ByoProjectName(slug string) string {
	s := slugUnsafe.ReplaceAllString(strings.ToLower(strings.TrimSpace(slug)), "-")
	s = strings.Trim(s, "-")
	if s == "" {
		s = "project"
	}
	name := "byo-" + s
	if len(name) > 63 {
		name = name[:63]
		name = strings.TrimRight(name, "-")
	}
	return name
}

// RenderByoAppProject renders the hardened AppProject YAML locking BYO charts to their own repos
// + namespaces. Empty inputs are tolerated (an empty sourceRepos/destinations project simply
// admits nothing) so a mis-built snapshot fails closed rather than wide-open.
func RenderByoAppProject(name string, sourceRepos, namespaces []string) (string, error) {
	data := byoProjectData{
		Name:        name,
		SourceRepos: dedupeNonEmpty(sourceRepos),
		Namespaces:  dedupeNonEmpty(namespaces),
	}
	var buf bytes.Buffer
	if err := byoAppProjectTmpl.Execute(&buf, data); err != nil {
		return "", fmt.Errorf("render byo AppProject: %w", err)
	}
	return buf.String(), nil
}

// ByoRepoSecretName is the deterministic ArgoCD repository-Secret name for a BYO chart repo:
// "repo-byo-<12 hex of sha256(url)>". Per-repo (not the shared "repo-apps" name) so multiple
// BYO repos — and the apps-destination repo — never collide or read each other's credentials.
func ByoRepoSecretName(repoURL string) string {
	sum := sha256.Sum256([]byte(repoURL))
	return "repo-byo-" + hex.EncodeToString(sum[:])[:12]
}

// dedupeNonEmpty returns the input with blanks dropped and order-preserving de-duplication.
func dedupeNonEmpty(in []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(in))
	for _, s := range in {
		if s == "" || seen[s] {
			continue
		}
		seen[s] = true
		out = append(out, s)
	}
	return out
}
