// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"reflect"
	"sort"
	"strings"

	"github.com/alethialabs-io/alethialabs/packages/core/designfile"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// The JSON Schema of alethia.yaml, generated.
//
// The STRUCTURE comes from the types that read the file (packages/core/designfile): every key is a
// field's yaml tag, a key is required exactly when its tag has no `omitempty`, and an object takes
// no other key because the reader refuses an unknown one. The CLOSED VOCABULARIES come from the
// generated enum lists (packages/core/types). Only the sentences are written here, in descriptions,
// and the test fails when a key has no sentence or a sentence has no key.
//
// The schema follows one rule, the reader's own: it may refuse only what `alethia plan` would
// certainly refuse. So an environment's components are open objects (their fields are published by
// the control plane and fetched at run time, not known here), an add-on's settings are open, and a
// value the reader accepts in two spellings is accepted in both.

// draft is the JSON Schema dialect the document declares. Draft 7 is the one every YAML language
// server reads.
const draft = "http://json-schema.org/draft-07/schema#"

// Schema is one JSON Schema node, with the keywords this generator writes.
type Schema struct {
	Schema      string `json:"$schema,omitempty"`
	ID          string `json:"$id,omitempty"`
	Title       string `json:"title,omitempty"`
	Description string `json:"description,omitempty"`
	// Type is one type name, or several for a value that may also be null.
	Type any `json:"type,omitempty"`
	// Enum is the closed set of values. A nil entry is JSON null.
	Enum       []any      `json:"enum,omitempty"`
	Properties Properties `json:"properties,omitempty"`
	Required   []string   `json:"required,omitempty"`
	// AdditionalProperties is false for an object that takes no other key, or the schema every
	// other key's value follows.
	AdditionalProperties any       `json:"additionalProperties,omitempty"`
	Items                *Schema   `json:"items,omitempty"`
	MinItems             int       `json:"minItems,omitempty"`
	OneOf                []*Schema `json:"oneOf,omitempty"`
}

// Property is one named property of an object.
type Property struct {
	Name   string
	Schema *Schema
}

// Properties are an object's properties in the order the file is written, which is the order of
// the fields in the Go type. A map would sort them.
type Properties []Property

// MarshalJSON writes the properties as one JSON object, keeping their order.
func (p Properties) MarshalJSON() ([]byte, error) {
	var b bytes.Buffer
	b.WriteByte('{')
	for i, prop := range p {
		if i > 0 {
			b.WriteByte(',')
		}
		name, err := json.Marshal(prop.Name)
		if err != nil {
			return nil, err
		}
		value, err := json.Marshal(prop.Schema)
		if err != nil {
			return nil, err
		}
		b.Write(name)
		b.WriteByte(':')
		b.Write(value)
	}
	b.WriteByte('}')
	return b.Bytes(), nil
}

// Get returns the property with this name, or nil.
func (p Properties) Get(name string) *Schema {
	for _, prop := range p {
		if prop.Name == name {
			return prop.Schema
		}
	}
	return nil
}

// descriptions is the sentence for every key of the file, by its path. `[]` is "each entry of".
// It is the one hand-written part of the schema; see the test for how it is held to the types.
var descriptions = map[string]string{
	"project":       "The project's name. It is unique in the organization, and it is how apply finds a project that already exists.",
	"cloud":         "The cloud account and region the project is built in.",
	"cloud.account": "The cloud account, by the label `alethia connector list` shows. An id is also accepted.",
	"cloud.region":  "The cloud region, for example eu-west-1.",
	"iac":           "Settings of the infrastructure-as-code engine.",
	"iac.version":   "The OpenTofu version to use. Leave it out to take the control plane's default.",
	"environments":  "The project's environments, in order. The first one owns the cluster the others are placed on.",

	"environments[].name":       "The environment's name, unique in the project.",
	"environments[].stage":      "What the environment is for.",
	"environments[].placement":  "How the environment is isolated: `dedicated` gets its own cluster, `vcluster` and `namespace` share one. Left out, the first environment is dedicated and every later one is a namespace.",
	"environments[].namespace":  "The Kubernetes namespace of an environment that shares a cluster. Left out, it is derived from the name.",
	"environments[].lifecycle":  "`persistent` (the default) or `ephemeral`. It is set when the environment is created and cannot be changed afterwards.",
	"environments[].components": "The environment's resources, by kind. A kind with one instance (cluster, network, dns, observability, repositories) is a mapping of its fields; a kind with several (databases, caches, ...) is a list of mappings, each with a `name`. `alethia project component kinds` lists the kinds and their fields. A component the file leaves out is unmanaged: it is never removed.",
	"environments[].addons":     "The catalog add-ons the environment runs. `alethia addon list` shows the ones an environment has. An add-on the file leaves out is unmanaged: it is never disabled.",

	"environments[].addons[].id":          "The add-on's id in the catalog, for example external-dns.",
	"environments[].addons[].version":     "The chart version to pin. Left out, the stored pin is kept; an empty string or null removes the pin.",
	"environments[].addons[].mode":        "How the add-on is delivered. Left out, the stored mode is kept.",
	"environments[].addons[].settings":    "The add-on's own settings. Each key is merged over the stored ones; `key: null` resets that key to the add-on's default.",
	"environments[].addons[].values":      "Helm values that replace the stored Advanced override whole. `null` removes the override. Not with `values_file`.",
	"environments[].addons[].values_file": "A Helm values file, relative to alethia.yaml, that replaces the stored Advanced override whole. An empty string removes the override. Not with `values`.",
}

// Generate returns the schema document as indented JSON, ending in a newline.
func Generate() ([]byte, error) {
	root, err := Build()
	if err != nil {
		return nil, err
	}
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(root); err != nil {
		return nil, err
	}
	return b.Bytes(), nil
}

// Build returns the schema of the whole file.
func Build() (*Schema, error) {
	g := &generator{used: map[string]bool{}}
	root := g.object(reflect.TypeOf(designfile.Manifest{}), "")
	root.Schema = draft
	root.ID = designfile.SchemaURL
	root.Title = designfile.FileName
	root.Description = "A project as `alethia apply` reconciles it and `alethia plan` previews it. " +
		"The file is desired state: apply creates what is missing and changes what differs, and never removes what the file leaves out."
	if envs := root.Properties.Get("environments"); envs != nil {
		// The reader refuses a file with no environment.
		envs.MinItems = 1
	}

	var unused []string
	for path := range descriptions {
		if !g.used[path] {
			unused = append(unused, path)
		}
	}
	sort.Strings(unused)
	g.problems = append(g.problems, prefixed("a description is written for a key the file does not have: ", unused)...)
	if len(g.problems) > 0 {
		return nil, fmt.Errorf("the schema cannot be generated:\n  - %s", strings.Join(g.problems, "\n  - "))
	}
	return root, nil
}

// prefixed returns each of items behind prefix.
func prefixed(prefix string, items []string) []string {
	out := make([]string, len(items))
	for i, item := range items {
		out[i] = prefix + item
	}
	return out
}

// generator walks the file's types and collects what it could not describe.
type generator struct {
	// used records every description that was attached to a key.
	used map[string]bool
	// problems are the reasons the schema would be wrong; any one fails the generation.
	problems []string
}

// The types the walk does not derive by reflection, because each reads its own YAML.
var (
	componentsType = reflect.TypeOf(designfile.Components{})
	addonType      = reflect.TypeOf(designfile.Addon{})
)

// describe returns the sentence for the key at path, and records a key that has none.
func (g *generator) describe(path string) string {
	text, ok := descriptions[path]
	if !ok {
		g.problems = append(g.problems, "no description is written for the key "+path)
		return ""
	}
	g.used[path] = true
	return text
}

// object is the schema of a struct the file is decoded into: one property per yaml-tagged field,
// in field order, required unless the tag says omitempty, and closed.
func (g *generator) object(t reflect.Type, path string) *Schema {
	s := &Schema{Type: "object", AdditionalProperties: false}
	for i := range t.NumField() {
		field := t.Field(i)
		name, optional := tagName(field.Tag.Get("yaml"))
		if name == "" {
			continue
		}
		at := name
		if path != "" {
			at = path + "." + name
		}
		prop := g.value(field.Type, at)
		prop.Description = g.describe(at)
		g.vocabulary(at, prop)
		s.Properties = append(s.Properties, Property{Name: name, Schema: prop})
		if !optional {
			s.Required = append(s.Required, name)
		}
	}
	return s
}

// tagName reads a yaml or json struct tag: the key, and whether the field may be left out. A field
// with no tag, or the tag `-`, has no key.
func tagName(tag string) (name string, optional bool) {
	name, opts, _ := strings.Cut(tag, ",")
	if name == "-" {
		return "", false
	}
	return name, strings.Contains(opts, "omitempty")
}

// value is the schema of one field's value, by its Go type.
func (g *generator) value(t reflect.Type, path string) *Schema {
	switch {
	case t == componentsType:
		return componentsSchema()
	case t == addonType:
		return g.addon(path)
	case t.Kind() == reflect.Struct:
		return g.object(t, path)
	case t.Kind() == reflect.Slice:
		return &Schema{Type: "array", Items: g.value(t.Elem(), path+"[]")}
	case t.Kind() == reflect.String:
		return &Schema{Type: "string"}
	}
	g.problems = append(g.problems, fmt.Sprintf("the key %s has the Go type %s, which this generator does not know how to describe", path, t))
	return &Schema{}
}

// vocabulary closes the keys whose values are one of a generated list.
func (g *generator) vocabulary(path string, s *Schema) {
	switch path {
	case "environments[].stage":
		s.Enum = enum(types.AllEnvironmentStages)
	case "environments[].placement":
		s.Enum = enum(types.AllPlacementModes)
	}
}

// enum returns a generated enum list as the values of an `enum` keyword.
func enum[T ~string](values []T) []any {
	out := make([]any, len(values))
	for i, v := range values {
		out[i] = string(v)
	}
	return out
}

// componentsSchema is the schema of an environment's `components`: any kind, written as a mapping
// of its fields, as a list of named entries, or as a bare key that takes every default. The fields
// are open because the control plane publishes them, per kind and per cloud, at run time.
func componentsSchema() *Schema {
	return &Schema{
		Type: "object",
		AdditionalProperties: &Schema{
			OneOf: []*Schema{
				{Type: "object", Description: "A kind with one instance: its fields."},
				{
					Type:        "array",
					Description: "A kind with several instances: one entry each.",
					Items: &Schema{
						Type: "object",
						Properties: Properties{{Name: "name", Schema: &Schema{
							Type: "string", Description: "The component's name, unique in its kind and environment.",
						}}},
						Required: []string{"name"},
					},
				},
				{Type: "null", Description: "The kind with every field at its default."},
			},
		},
	}
}

// addonKeyTypes is the JSON type of each key of an add-on entry, as the entry's own reader takes
// it: a key that can be cleared also takes null, and a version may be written unquoted.
var addonKeyTypes = map[string]any{
	"id":          "string",
	"version":     []string{"string", "number", "null"},
	"mode":        nil, // a closed list, set below
	"settings":    []string{"object", "null"},
	"values":      []string{"object", "null"},
	"values_file": []string{"string", "null"},
}

// addon is the schema of one add-on entry. Its keys are the type's json tags, which are the keys
// its YAML reader takes; a field the reader fills in itself has no key in the file and none here.
func (g *generator) addon(path string) *Schema {
	s := &Schema{Type: "object", AdditionalProperties: false, Required: []string{"id"}}
	for i := range addonType.NumField() {
		name, _ := tagName(addonType.Field(i).Tag.Get("json"))
		if name == "" || name == "values_cleared" {
			// values_cleared records that the file said `values: null`. It is not a key.
			continue
		}
		kind, known := addonKeyTypes[name]
		if !known {
			g.problems = append(g.problems, "the add-on key "+name+" has no type in addonKeyTypes")
			continue
		}
		prop := &Schema{Type: kind, Description: g.describe(path + "." + name)}
		if name == "mode" {
			prop.Enum = append(enum(types.AllAddonModes), nil)
		}
		s.Properties = append(s.Properties, Property{Name: name, Schema: prop})
	}
	return s
}
