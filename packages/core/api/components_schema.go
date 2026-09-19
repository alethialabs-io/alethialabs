// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"fmt"
	"sort"
)

// The published component-kind registry, `GET /api/cli/schema/components` (#3671).
//
// This is the document that replaces the CLI's hand-typed `componentKinds` / `singletonKinds`
// literals with a cache of what the server actually accepts. The manifest reader validates
// `alethia.yaml`'s components against it, so a kind the server grew (helm_registries was the
// first) reaches the CLI on the next run rather than the next release.
//
// It mirrors `componentSchemaWire` in apps/console/lib/cli/project-components.ts and is pinned
// by testdata/component_schema.json, which is dumped from that file's own builder.

// ComponentSchemaKind is one published kind.
type ComponentSchemaKind struct {
	Kind string `json:"kind"`
	// Singleton kinds are one per (project, environment) and take no name.
	Singleton bool `json:"singleton"`
	// Fields are the settable field names, in registry order — derived server-side from the
	// schema's properties, so the two cannot disagree.
	Fields []string `json:"fields"`
	// Schema is the JSON Schema (draft-7) of an add request's `fields` object.
	Schema map[string]any `json:"schema"`
}

// ComponentSchemaDocument is the registry as it goes over the wire.
type ComponentSchemaDocument struct {
	// Version is a hash over the kinds — the route's ETag and a client's cache key.
	Version string                `json:"version"`
	Kinds   []ComponentSchemaKind `json:"kinds"`
}

// Kind returns one published kind by name.
func (d *ComponentSchemaDocument) Kind(name string) (ComponentSchemaKind, bool) {
	if d == nil {
		return ComponentSchemaKind{}, false
	}
	for _, k := range d.Kinds {
		if k.Kind == name {
			return k, true
		}
	}
	return ComponentSchemaKind{}, false
}

// KindNames is every published kind, sorted.
func (d *ComponentSchemaDocument) KindNames() []string {
	if d == nil {
		return nil
	}
	out := make([]string, 0, len(d.Kinds))
	for _, k := range d.Kinds {
		out = append(out, k.Kind)
	}
	sort.Strings(out)
	return out
}

// GetComponentSchema fetches the published component registry.
//
// A document with ZERO kinds is refused here as well as on the server: a client that cached one
// would refuse every kind the server accepts, and a working CLI that has quietly lost a
// capability is the failure mode this route's own builder asserts against.
func (c *Client) GetComponentSchema() (*ComponentSchemaDocument, error) {
	endpoint := fmt.Sprintf("%s/cli/schema/components", c.baseURL)
	var doc ComponentSchemaDocument
	if err := c.doGet(endpoint, &doc); err != nil {
		return nil, fmt.Errorf("failed to fetch the component schema: %w", err)
	}
	if len(doc.Kinds) == 0 {
		return nil, fmt.Errorf("the component schema published zero kinds — refusing to cache a document that would reject every component")
	}
	return &doc, nil
}
