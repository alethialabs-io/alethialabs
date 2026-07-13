// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloud

import (
	"crypto/sha256"
	"encoding/hex"
	"regexp"
	"sort"
	"strings"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// tags.go turns a project's frozen classification (ProjectConfig.Classification, captured by
// the console in B1.1) into a per-cloud resource tag/label map, and always emits two platform
// sweep handles — `<prefix>project-id` and `<prefix>environment-id` — so a guarded sweeper can
// scope destroys to exactly one environment's cloud resources. Each ProviderTfvars builder sets
// the result on the `classification_tags` tfvar (before mergeProviderConfig); the per-cloud
// OpenTofu templates merge it into their resource tags/labels (B1.3).
//
// Cloud tag/label key+value rules differ sharply, so styling is per cloud:
//   - AWS / Azure / Alibaba tags: colon-namespaced keys (`alethia:project-id`), mixed case ok.
//   - GCP labels: lowercase only, charset [a-z0-9_-], ≤63 — colons invalid → `alethia_project-id`.
//   - Hetzner (Kubernetes/Talos) labels: charset [A-Za-z0-9_.-], ≤63, must start/end alnum.
// Over-long keys/values are truncated collision-safely (a short content hash is appended) so two
// distinct long inputs never fold to the same tag.

const tagNamespace = "alethia"

// tagStyle captures one cloud's tag/label key+value constraints.
type tagStyle struct {
	sep     string         // separator between the "alethia" namespace and the name segment
	lower   bool           // force keys+values to lowercase (GCP labels)
	keyMax  int            // max key length for this cloud
	valMax  int            // max value length for this cloud
	charset *regexp.Regexp // if set, characters to replace with "-" (GCP/Hetzner label charset)
}

var (
	// AWS/Azure/Alibaba: colon-namespaced, generous length, no charset rewrite (these clouds
	// accept the slug charset as-is). Matches AWS's existing `platform:environment` style.
	awsTagStyle     = tagStyle{sep: ":", keyMax: 128, valMax: 256}
	azureTagStyle   = tagStyle{sep: ":", keyMax: 512, valMax: 256}
	alibabaTagStyle = tagStyle{sep: ":", keyMax: 128, valMax: 128}

	// GCP labels: lowercase, [a-z0-9_-], ≤63 on both key and value; a key must start with a
	// lowercase letter (the "alethia" namespace guarantees that).
	gcpTagStyle = tagStyle{sep: "_", lower: true, keyMax: 63, valMax: 63, charset: regexp.MustCompile(`[^a-z0-9_-]`)}

	// Hetzner runs Kubernetes/Talos → K8s label rules: [A-Za-z0-9_.-], ≤63, alnum start/end.
	hetznerTagStyle = tagStyle{sep: "_", keyMax: 63, valMax: 63, charset: regexp.MustCompile(`[^A-Za-z0-9_.-]`)}
)

// classificationTags renders the platform sweep handles plus every classification dimension into
// a cloud-correct resource tag/label map, using this cloud's tag style.
func classificationTags(config *types.ProjectConfig, st tagStyle) map[string]string {
	return buildResourceTags(config, st.render)
}

// buildResourceTags renders the platform sweep handles plus every classification dimension into a
// tag/label map, applying `render` (a per-cloud tag style, or the Kubernetes-label style) to each
// (name, value) pair. Keys and values are sorted/deterministic; multi-value dimensions join their
// sorted slugs with "_" (valid across every cloud's charset). An empty value is skipped, but
// project-id (and environment-id when present) are always emitted, so the sweep handle exists even
// for an unclassified project.
//
// Classification dimensions are emitted FIRST and the mandatory sweep handles LAST, so a dimension
// that renders to the same key (a dimension literally named "project-id", or one that charset-folds
// into it, e.g. "Project-Id"→"project-id") can never clobber the handle: the platform base tags win
// conflicts, keeping a guarded sweeper correctly scoped.
func buildResourceTags(config *types.ProjectConfig, render func(name, value string) (string, string)) map[string]string {
	out := make(map[string]string)

	// Reserve the rendered handle keys up front so NO classification dimension can occupy them.
	// Emit-last ordering already makes a non-empty handle win, but reserving the KEYS keeps the
	// handle authoritative even when its value is empty (e.g. an unset ID) or a dimension
	// charset-folds onto the same key — a guarded sweeper must never key off an attacker-influenced
	// value. handleKey derives the key deterministically (render's key depends only on the name).
	handleKey := func(name string) string { k, _ := render(name, "x"); return k }
	pidKey := handleKey("project-id")
	eidKey := handleKey("environment-id")

	add := func(name, value string, isHandle bool) {
		if value == "" {
			return
		}
		k, v := render(name, value)
		if k == "" || v == "" {
			return
		}
		if !isHandle && (k == pidKey || k == eidKey) {
			return // a classification dimension may not shadow a reserved sweep-handle key
		}
		out[k] = v
	}

	dims := make([]string, 0, len(config.Classification))
	for dim := range config.Classification {
		dims = append(dims, dim)
	}
	sort.Strings(dims)
	for _, dim := range dims {
		vals := append([]string(nil), config.Classification[dim]...)
		sort.Strings(vals)
		add(dim, strings.Join(vals, "_"), false)
	}

	add("project-id", config.ID, true)
	add("environment-id", config.EnvironmentID, true)
	return out
}

// render applies this cloud's styling to one (name, value) pair and returns the final
// (key, value). The key is the namespace + separator + name; both are lowercased/charset-rewritten
// per the style, trimmed of stray separators (K8s/GCP require alnum boundaries), then truncated
// collision-safely.
func (st tagStyle) render(name, value string) (string, string) {
	key := tagNamespace + st.sep + name
	if st.lower {
		key = strings.ToLower(key)
		value = strings.ToLower(value)
	}
	if st.charset != nil {
		key = st.charset.ReplaceAllString(key, "-")
		value = st.charset.ReplaceAllString(value, "-")
		// GCP/K8s labels must begin and end with an alphanumeric character.
		key = strings.Trim(key, "-_.")
		value = strings.Trim(value, "-_.")
	}
	return clip(key, st.keyMax), clip(value, st.valMax)
}

// clip truncates s to max characters collision-safely: when it must cut, it appends a short hash
// of the FULL original so two distinct long strings never truncate to the same output.
func clip(s string, max int) string {
	if len(s) <= max {
		return s
	}
	sum := sha256.Sum256([]byte(s))
	suffix := hex.EncodeToString(sum[:])[:6]
	if max <= len(suffix)+1 {
		// Degenerate cap: return as much of the hash as fits (still deterministic + distinct).
		return hex.EncodeToString(sum[:])[:max]
	}
	return s[:max-len(suffix)-1] + "-" + suffix
}

// k8sLabelPrefix namespaces every Alethia-emitted Kubernetes label. It is the key's optional
// DNS-subdomain prefix segment (dots are valid there and it is NOT charset-folded) — distinct from
// the ≤63 name segment after the "/", which is.
const k8sLabelPrefix = "alethia.io/"

// k8sLabelCharset matches characters invalid in a Kubernetes label name/value segment (RFC1123:
// alphanumerics plus '-', '_', '.'); each is replaced with '-'. Same charset the Hetzner (K8s/Talos)
// tag style uses — labels and Hetzner tags share the Kubernetes label rules.
var k8sLabelCharset = regexp.MustCompile(`[^A-Za-z0-9_.-]`)

// ClassificationLabels renders the same classification dimensions + sweep handles as
// classificationTags, but as Kubernetes labels: each key is `alethia.io/<name>`, and both the name
// segment and the value are folded to the RFC1123 label charset, trimmed to alphanumeric boundaries,
// and collision-safe clipped to 63. It stamps attribution/sweep labels onto the metadata.labels of
// every ArgoCD Application/AppProject Alethia renders (BYOC B1.4), so an environment's GitOps objects
// are selectable/attributable in-cluster exactly as its cloud resources are via classificationTags.
func ClassificationLabels(config *types.ProjectConfig) map[string]string {
	return buildResourceTags(config, renderK8sLabel)
}

// renderK8sLabel styles one (name, value) pair as a Kubernetes label. Only the name segment is
// folded/clipped (the fixed alethia.io prefix is already a valid DNS subdomain); the value is folded
// and clipped independently. Returns empty strings when the name folds away entirely (caller skips
// it). Case is preserved — Kubernetes label keys/values are case-sensitive.
func renderK8sLabel(name, value string) (string, string) {
	n := strings.Trim(k8sLabelCharset.ReplaceAllString(name, "-"), "-_.")
	if n == "" {
		return "", ""
	}
	v := strings.Trim(k8sLabelCharset.ReplaceAllString(value, "-"), "-_.")
	return k8sLabelPrefix + clip(n, 63), clip(v, 63)
}
