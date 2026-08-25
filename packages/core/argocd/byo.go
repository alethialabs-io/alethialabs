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

	"gopkg.in/yaml.v3"
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
// admits nothing) so a mis-built snapshot fails closed rather than wide-open. commonLabels are the
// classification/sweep labels stamped onto the AppProject (BYOC B1.4); pass nil to add none.
func RenderByoAppProject(name string, sourceRepos, namespaces []string, commonLabels map[string]string) (string, error) {
	data := byoProjectData{
		Name:        name,
		SourceRepos: dedupeNonEmpty(sourceRepos),
		Namespaces:  dedupeNonEmpty(namespaces),
	}
	var buf bytes.Buffer
	if err := byoAppProjectTmpl.Execute(&buf, data); err != nil {
		return "", fmt.Errorf("render byo AppProject: %w", err)
	}
	labeled, err := InjectCommonLabels(buf.String(), commonLabels)
	if err != nil {
		return "", fmt.Errorf("label byo AppProject: %w", err)
	}
	return labeled, nil
}

// byoNamespaceTmpl renders the target namespaces for BYO charts.
//
// WHY THE RUNNER MUST CREATE THESE, and why `CreateNamespace=true` cannot.
//
// A BYO Application is rendered with the `CreateNamespace=true` sync option, which asks ArgoCD to
// create the destination namespace as part of the sync. Against a HARDENED BYO AppProject that can
// never work: `clusterResourceWhitelist` is empty, and a Namespace is a cluster-scoped resource —
// the byoAppProjectTmpl comment above names Namespace in that list explicitly. So ArgoCD is asked
// to create a namespace it is simultaneously forbidden from creating, and every BYO chart whose
// namespace does not already exist fails its sync with
//
//	one or more objects failed to apply, reason: namespaces "<ns>" not found
//
// leaving the Application health=Missing sync=OutOfSync forever. That is not a race and no wait
// fixes it. It is what the BYO-IaC dimension did on its first ever real execution (gcp, #2490's
// sibling): `apps` and `external-secrets-operator` converged, `addon-byo-e2e` did not.
//
// The resolution is NOT to relax the AppProject — the whole point is that an untrusted chart may
// not create cluster-scoped objects. It is for the RUNNER, which is a trusted actor holding the
// cluster's admin kubeconfig, to create the namespace itself before the chart syncs into it. The
// trust boundary is unchanged: the chart still cannot create one.
//
// Pod-level hardening (Pod Security Admission labels + an admission controller) is deliberately NOT
// applied here. byoAppProjectTmpl's comment scopes that as the separate pod-level half of the
// boundary, and inventing a PSA level here would silently change what customer charts are permitted
// to run — a security posture worth deciding explicitly rather than acquiring as a side effect of a
// bug fix.
// dns1123Label is Kubernetes' own rule for a Namespace name: lowercase alphanumerics and '-',
// starting and ending alphanumeric, at most 63 characters. Matched in FULL — an unanchored pattern
// would accept a valid prefix followed by anything at all, which is the whole attack.
var dns1123Label = regexp.MustCompile(`^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`)

const dns1123LabelMaxLen = 63

// validateByoNamespace REFUSES a namespace Kubernetes itself would refuse, rather than normalising
// it.
//
// Normalising would be the more forgiving choice and it is the wrong one here, for a reason specific
// to this call site: the SAME string is also written into the hardened AppProject's `destinations`
// list. Silently rewriting it in one place and not the other would produce a project whose
// destination never matches the namespace the chart syncs into, and the failure would surface as an
// ArgoCD permission error naming neither cause.
func validateByoNamespace(ns string) error {
	if len(ns) > dns1123LabelMaxLen {
		return fmt.Errorf("namespace %q is %d characters; Kubernetes allows at most %d", ns, len(ns), dns1123LabelMaxLen)
	}
	if !dns1123Label.MatchString(ns) {
		return fmt.Errorf("namespace %q is not a valid DNS-1123 label (lowercase alphanumerics and '-', starting and ending alphanumeric)", ns)
	}
	return nil
}

// RenderByoNamespaces renders the destination namespaces for a project's BYO charts, so the runner
// can create them before the charts sync. Returns "" when there are none, which callers treat as
// "nothing to apply" rather than an error.
//
// # Why this is marshalled rather than templated (#2540)
//
// It used to interpolate the namespace RAW into hand-rolled YAML. Every other label-emitting path in
// this package round-trips through gopkg.in/yaml.v3 and is therefore quoted correctly; this one did
// not, and it is the one applied with the cluster's ADMIN kubeconfig as a standalone multi-document
// manifest. A namespace containing a newline and a `---` therefore yielded arbitrary top-level
// objects — a ClusterRoleBinding, say — created by the runner, which is precisely the cluster-scoped
// power the hardened AppProject exists to deny an untrusted chart. The fix that created the
// namespace to honour that boundary had opened a way around it.
//
// The value reaches here unvalidated: the console field is `z.string().trim().optional()` with no
// DNS-1123 check, and it lands in a plain `text()` column, so interior newlines survive to the
// runner.
//
// BOTH halves are kept. Marshalling makes injection structurally impossible — yaml.v3 quotes what
// needs quoting, so a hostile value becomes one absurd namespace NAME rather than a second document.
// Validation then refuses that absurd name outright, because a namespace Kubernetes would reject is
// a deploy that fails later and more confusingly. Either alone would close the hole; the pair also
// fails in the right direction.
func RenderByoNamespaces(namespaces []string, commonLabels map[string]string) (string, error) {
	ns := dedupeNonEmpty(namespaces)
	if len(ns) == 0 {
		return "", nil
	}

	labels := map[string]string{"alethia.io/managed-by": "byo-charts"}
	for k, v := range commonLabels {
		labels[k] = v
	}

	var buf bytes.Buffer
	enc := yaml.NewEncoder(&buf)
	enc.SetIndent(2)
	for _, n := range ns {
		if err := validateByoNamespace(n); err != nil {
			return "", fmt.Errorf("render byo namespaces: %w", err)
		}
		doc := map[string]any{
			"apiVersion": "v1",
			"kind":       "Namespace",
			"metadata": map[string]any{
				"name":   n,
				"labels": labels,
			},
		}
		if err := enc.Encode(doc); err != nil {
			return "", fmt.Errorf("render byo namespaces: %w", err)
		}
	}
	if err := enc.Close(); err != nil {
		return "", fmt.Errorf("render byo namespaces: %w", err)
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
