// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"
)

// injectCommonLabels stamps `labels` onto metadata.labels of every ArgoCD Application/AppProject
// document in a rendered (post-template) manifest string. It is the single label-injection point
// shared by all three render paths — static infra Applications (RenderApplications), marketplace/
// BYO add-on Applications (RenderManagedAddOns), and the hardened BYO AppProject
// (RenderByoAppProject) — so classification/attribution labels land uniformly (BYOC B1.4).
//
// Guarantees:
//   - Only documents whose top-level `kind` is Application or AppProject are labelled; every other
//     document (ClusterSecretStore, StorageClass, …) is re-emitted with its content unchanged.
//   - An existing metadata.labels key is never overwritten — Alethia's identity labels
//     (alethia.io/managed-by, alethia.io/addon-id, …) always win over an attribution label of the
//     same name.
//   - The metadata.labels map is created when the resource declares none.
//   - Documents round-trip through the yaml.Node API, which preserves the `helm.values` literal
//     block scalar (and every other value) — only the label keys are added.
//
// An empty/nil `labels` map returns the manifest unchanged (fast path), so callers can pass it
// unconditionally.
func injectCommonLabels(manifest string, labels map[string]string) (string, error) {
	if len(labels) == 0 {
		return manifest, nil
	}

	dec := yaml.NewDecoder(strings.NewReader(manifest))
	var out bytes.Buffer
	enc := yaml.NewEncoder(&out)
	enc.SetIndent(2)

	for {
		var doc yaml.Node
		if err := dec.Decode(&doc); err != nil {
			if errors.Is(err, io.EOF) {
				break
			}
			return "", fmt.Errorf("decode manifest: %w", err)
		}
		// Skip empty documents (e.g. a trailing "---" with nothing after it): re-encoding a
		// content-less node would emit a bare "null", corrupting the stream.
		if len(doc.Content) == 0 {
			continue
		}
		if isAppOrProject(&doc) {
			addLabels(&doc, labels)
		}
		if err := enc.Encode(&doc); err != nil {
			return "", fmt.Errorf("re-encode manifest: %w", err)
		}
	}
	if err := enc.Close(); err != nil {
		return "", fmt.Errorf("flush manifest: %w", err)
	}
	return out.String(), nil
}

// isAppOrProject reports whether a decoded YAML document is an ArgoCD Application or AppProject —
// the only kinds B1.4 labels (a StorageClass / ClusterSecretStore in the same file is left alone).
func isAppOrProject(doc *yaml.Node) bool {
	root := mappingOf(doc)
	if root == nil {
		return false
	}
	switch scalarValue(root, "kind") {
	case "Application", "AppProject":
		return true
	default:
		return false
	}
}

// addLabels merges `labels` into the document's metadata.labels mapping, creating metadata and/or
// labels when absent, and never overwriting a key the manifest already declares. Keys are added in
// sorted order for deterministic output.
func addLabels(doc *yaml.Node, labels map[string]string) {
	root := mappingOf(doc)
	if root == nil {
		return
	}
	labelsNode := childMap(childMap(root, "metadata"), "labels")

	existing := make(map[string]bool, len(labelsNode.Content)/2)
	for i := 0; i+1 < len(labelsNode.Content); i += 2 {
		existing[labelsNode.Content[i].Value] = true
	}

	keys := make([]string, 0, len(labels))
	for k := range labels {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		if existing[k] {
			continue
		}
		labelsNode.Content = append(labelsNode.Content,
			&yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: k},
			&yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: labels[k]},
		)
	}
}

// mappingOf unwraps a DocumentNode to its root MappingNode, or returns nil when the document is not
// a single mapping (e.g. a scalar or sequence document — never an ArgoCD resource).
func mappingOf(doc *yaml.Node) *yaml.Node {
	if doc.Kind == yaml.DocumentNode && len(doc.Content) == 1 {
		doc = doc.Content[0]
	}
	if doc.Kind == yaml.MappingNode {
		return doc
	}
	return nil
}

// scalarValue returns the scalar value for `key` in a mapping node, or "" when the key is absent
// or non-scalar. Mapping nodes store children as a flat [key0, val0, key1, val1, …] slice.
func scalarValue(m *yaml.Node, key string) string {
	for i := 0; i+1 < len(m.Content); i += 2 {
		if m.Content[i].Value == key {
			return m.Content[i+1].Value
		}
	}
	return ""
}

// childMap returns the mapping node stored under `key` in `parent`, creating (and appending) an
// empty mapping when the key is absent, or coercing a null/empty placeholder to a mapping. The
// returned node is a live pointer into `parent`, so appends to its Content mutate the document.
func childMap(parent *yaml.Node, key string) *yaml.Node {
	for i := 0; i+1 < len(parent.Content); i += 2 {
		if parent.Content[i].Value == key {
			v := parent.Content[i+1]
			if v.Kind != yaml.MappingNode {
				// e.g. `labels:` with no value decodes to a null scalar — make it a mapping.
				v.Kind = yaml.MappingNode
				v.Tag = "!!map"
				v.Value = ""
			}
			return v
		}
	}
	valNode := &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}
	parent.Content = append(parent.Content,
		&yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: key},
		valNode,
	)
	return valNode
}
