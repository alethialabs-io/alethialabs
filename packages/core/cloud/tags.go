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
// a cloud-correct tag/label map. Keys and values are sorted/deterministic; multi-value dimensions
// join their sorted slugs with "_" (valid across every cloud's charset). An empty value is
// skipped, but project-id (and environment-id when present) are always emitted, so the sweep
// handle exists even for an unclassified project.
func classificationTags(config *types.ProjectConfig, st tagStyle) map[string]string {
	out := make(map[string]string)
	add := func(name, value string) {
		if value == "" {
			return
		}
		k, v := st.render(name, value)
		if k == "" || v == "" {
			return
		}
		out[k] = v
	}

	// Classification dimensions first, then the mandatory sweep handles LAST so a dimension
	// that renders to the same key (a dimension literally named "project-id", or one that
	// charset-folds into it, e.g. GCP "Project-Id"→"project-id") can never clobber the handle:
	// the platform base tags win conflicts, keeping a guarded sweeper correctly scoped.
	dims := make([]string, 0, len(config.Classification))
	for dim := range config.Classification {
		dims = append(dims, dim)
	}
	sort.Strings(dims)
	for _, dim := range dims {
		vals := append([]string(nil), config.Classification[dim]...)
		sort.Strings(vals)
		add(dim, strings.Join(vals, "_"))
	}

	add("project-id", config.ID)
	add("environment-id", config.EnvironmentID)
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
