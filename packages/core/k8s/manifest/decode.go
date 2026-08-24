// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Package manifest decodes rendered Kubernetes manifests (a `helm template` / `kustomize build`
// stream) into lightweight resource objects. It is deliberately dependency-light — multi-doc YAML →
// map[string]any, and nothing else — and shared by two callers: the elench `verify` control set
// (which reads pod specs for security controls) and the BYO chart-scan workload extractor (which
// reads image/ports/env/resources per workload). Keeping one decoder means the two can never
// disagree about what a manifest stream contains.
//
// It is a LEAF on purpose. It used to live in the parent `k8s` package, which also constructs a live
// EKS client — and Go has no sub-package import granularity, so `verify` reaching this decoder put
// the whole AWS SDK dependency closure into every binary that imports `verify`, including the
// Homebrew-distributed `alethia` CLI (#2342). Nothing that talks to a cloud may be added here.
package manifest

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
			Kind:      AsString(doc["kind"]),
			Name:      AsString(meta["name"]),
			Namespace: AsString(meta["namespace"]),
			Raw:       doc,
		})
	}
	return out, nil
}

// AsString coerces a decoded YAML scalar to a string ("" when absent or not a string). Exported
// because the workload extractor in the parent package reads the same decoded documents and must
// coerce them identically — one decoder implies one coercion.
func AsString(v any) string {
	s, _ := v.(string)
	return s
}
