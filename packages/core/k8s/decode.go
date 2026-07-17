// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Package k8s decodes rendered Kubernetes manifests (a `helm template` / `kustomize build` stream)
// into lightweight resource objects and extracts the workloads Alethia DESCRIBES from them (W5 Path
// A — Option B). It is deliberately dependency-light (multi-doc YAML → map[string]any) and shared by
// two callers: the elench `verify` control set (which reads pod specs for security controls) and the
// BYO chart-scan workload extractor (which reads image/ports/env/resources per workload). Keeping one
// decoder means the two can never disagree about what a manifest stream contains.
package k8s

import (
	"bytes"
	"fmt"

	"gopkg.in/yaml.v3"
)

// Resource is one decoded Kubernetes manifest reduced to its identity + raw body. Raw is the full
// decoded document so callers can read whatever fields they need without a second parse.
type Resource struct {
	Kind      string
	Name      string
	Namespace string
	Raw       map[string]any
}

// Decode decodes a (possibly multi-document) YAML manifest stream into resources, skipping
// empty/null documents. The error message matches the verify path's historical wording so callers
// asserting on it do not drift.
func Decode(manifests []byte) ([]Resource, error) {
	dec := yaml.NewDecoder(bytes.NewReader(manifests))
	var out []Resource
	for {
		var doc map[string]any
		err := dec.Decode(&doc)
		if err != nil {
			if err.Error() == "EOF" {
				break
			}
			return nil, fmt.Errorf("invalid k8s YAML: %w", err)
		}
		if doc == nil {
			continue
		}
		meta, _ := doc["metadata"].(map[string]any)
		out = append(out, Resource{
			Kind:      asString(doc["kind"]),
			Name:      asString(meta["name"]),
			Namespace: asString(meta["namespace"]),
			Raw:       doc,
		})
	}
	return out, nil
}

// asString coerces a decoded YAML scalar to a string ("" when absent or not a string).
func asString(v any) string {
	s, _ := v.(string)
	return s
}
