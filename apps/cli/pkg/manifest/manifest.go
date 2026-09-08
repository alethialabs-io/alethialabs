// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Package manifest reads and writes `alethia.yaml`, the declarative description of a project that
// `alethia apply` reconciles and `alethia plan` previews.
//
// # What the file is
//
// The file is DESIRED STATE, not a bag of flag defaults. It declares the project, the cloud it
// provisions into, every environment with its placement, and the components each environment
// carries. `apply` creates what is missing, reports what already matches, and refuses what it
// cannot reconcile; it never deletes anything the file stopped mentioning, because a manifest
// that can tear down an environment by omission is a manifest nobody dares edit.
//
//	project: boutique
//	cloud:
//	  account: prod-account        # the connector's LABEL, never its id
//	  region: nbg1
//	environments:
//	  - name: prod
//	    stage: production
//	    placement: dedicated
//	    components:
//	      cluster:
//	        node_min_size: 2
//	        node_max_size: 3
//	  - name: dev-1
//	    stage: development
//	    placement: namespace
//	    namespace: boutique-dev-1
//	    components:
//	      repositories:
//	        apps_destination_repo: https://github.com/alethialabs-io/alethia-examples
//	        apps_path: examples/online-boutique/overlays/dev-1
//	      databases:
//	        - name: orders
//	          engine: postgres
//
// # Why the CLI validates only a provable subset
//
// The server is the authority on what a project may be. Everything Validate refuses is something
// the server would certainly refuse too — a stage outside the generated enum, a component kind the
// published schema does not carry, a field the kind does not accept. Anything else is passed
// through, so that drift between this package and the server can only ever make the CLI too
// permissive (which the server catches) and never too strict (which nothing would).
//
// # The scalar keys agree with the field-spec kit
//
// `project create`'s spec declares its manifest keys (`project`, `cloud.region`, `stage`,
// `iac.version`, `placement`) and the kit's resolver reads them through Lookup. That contract is
// pinned from the command side, where both halves are visible: a key the spec declares and Lookup
// cannot answer is a test failure, not a rung that silently resolves nothing.
package manifest

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"
)

// FileName is the manifest's name in a project's working directory.
const FileName = "alethia.yaml"

// Manifest is one project as a person declares it.
type Manifest struct {
	// Project is the project's name — its identity within the organization. Per-org unique on the
	// server, case-insensitively, which is what lets `apply` find an existing project by it.
	Project string `yaml:"project"`
	// Cloud is where the project provisions.
	Cloud Cloud `yaml:"cloud"`
	// IaC pins the OpenTofu version; omitted, the server defaults it.
	IaC IaC `yaml:"iac,omitempty"`
	// Environments are the project's deployment targets, in order. THE FIRST IS THE DEFAULT and
	// owns the Fabric the project provisions, which is why it defaults to `dedicated` while every
	// later one defaults to `namespace`.
	Environments []Environment `yaml:"environments"`
}

// Cloud names the account and region a project provisions into.
type Cloud struct {
	// Account is the cloud account's LABEL as `alethia connector list` shows it. An id is also
	// accepted, because the server resolves either — but a label is what a person can read back
	// and a file should be readable.
	Account string `yaml:"account,omitempty"`
	// Region is the cloud region.
	Region string `yaml:"region"`
}

// IaC carries the infrastructure-as-code settings.
type IaC struct {
	Version string `yaml:"version,omitempty"`
}

// Environment is one deployment target and how it is placed onto a Fabric.
type Environment struct {
	Name  string `yaml:"name"`
	Stage string `yaml:"stage"`
	// Placement is the isolation rung: dedicated, vcluster or namespace. Empty is filled by
	// Normalize from the environment's position — the first is dedicated, the rest namespace.
	Placement string `yaml:"placement,omitempty"`
	// Namespace is the ArgoCD destination namespace for a shared placement. Empty derives from the
	// name; meaningless on a dedicated placement, and dropped there by Normalize.
	Namespace string `yaml:"namespace,omitempty"`
	// Lifecycle is `persistent` (the default) or `ephemeral`.
	Lifecycle string `yaml:"lifecycle,omitempty"`
	// Components are the resources this environment carries, keyed by kind.
	Components Components `yaml:"components,omitempty"`
}

// Components are an environment's resources in FILE ORDER, keyed by kind.
//
// A singleton kind (cluster, network, dns, observability, repositories) is written as a mapping of
// its fields; a multi kind (databases, caches, …) as a list of mappings each carrying a `name`.
// Order is kept rather than sorted so that Render writes back the file a person wrote, and so that
// a refusal can point at the entry by position.
type Components []KindEntries

// KindEntries are every component of one kind in one environment.
type KindEntries struct {
	Kind string
	// List records whether the kind was written as a list. Validate compares it with the schema's
	// singleton bit; a singleton written as a list is refused rather than silently taking the
	// first element.
	List    bool
	Entries []Component
}

// Component is one resource: its name (empty for a singleton) and its settable fields.
type Component struct {
	Name   string
	Fields map[string]any
}

// Kind returns the entries for one kind.
func (c Components) Kind(kind string) (KindEntries, bool) {
	for _, k := range c {
		if k.Kind == kind {
			return k, true
		}
	}
	return KindEntries{}, false
}

// UnmarshalYAML reads the `components` mapping, keeping kind order.
func (c *Components) UnmarshalYAML(node *yaml.Node) error {
	if node.Kind != yaml.MappingNode {
		return fmt.Errorf("components must be a mapping of kind to fields (line %d)", node.Line)
	}
	out := Components{}
	for i := 0; i+1 < len(node.Content); i += 2 {
		keyNode, valNode := node.Content[i], node.Content[i+1]
		kind := keyNode.Value
		if _, dup := out.Kind(kind); dup {
			return fmt.Errorf("components lists kind %q twice (line %d)", kind, keyNode.Line)
		}
		entries := KindEntries{Kind: kind}
		switch valNode.Kind {
		case yaml.MappingNode:
			fields := map[string]any{}
			if err := valNode.Decode(&fields); err != nil {
				return fmt.Errorf("components.%s: %w", kind, err)
			}
			entries.Entries = []Component{{Fields: fields}}
		case yaml.SequenceNode:
			entries.List = true
			for j, item := range valNode.Content {
				if item.Kind != yaml.MappingNode {
					return fmt.Errorf("components.%s[%d] must be a mapping with a name (line %d)", kind, j, item.Line)
				}
				fields := map[string]any{}
				if err := item.Decode(&fields); err != nil {
					return fmt.Errorf("components.%s[%d]: %w", kind, j, err)
				}
				name, _ := fields["name"].(string)
				delete(fields, "name")
				entries.Entries = append(entries.Entries, Component{Name: name, Fields: fields})
			}
		case yaml.ScalarNode:
			if valNode.Tag == "!!null" {
				// `repositories:` with nothing under it declares the singleton with every field
				// at its server default. A bare key is the most natural way to write "I want
				// one of these", so it means exactly that rather than being a syntax error.
				entries.Entries = []Component{{Fields: map[string]any{}}}
			} else {
				return fmt.Errorf("components.%s must be a mapping of fields or a list of named entries (line %d)", kind, valNode.Line)
			}
		default:
			return fmt.Errorf("components.%s must be a mapping of fields or a list of named entries (line %d)", kind, valNode.Line)
		}
		out = append(out, entries)
	}
	*c = out
	return nil
}

// MarshalYAML writes the `components` mapping in the order it was read.
func (c Components) MarshalYAML() (any, error) {
	node := &yaml.Node{Kind: yaml.MappingNode}
	for _, k := range c {
		key := &yaml.Node{Kind: yaml.ScalarNode, Value: k.Kind}
		var val yaml.Node
		if k.List {
			items := make([]map[string]any, 0, len(k.Entries))
			for _, e := range k.Entries {
				fields := map[string]any{"name": e.Name}
				for f, v := range e.Fields {
					fields[f] = v
				}
				items = append(items, fields)
			}
			if err := val.Encode(items); err != nil {
				return nil, err
			}
		} else {
			fields := map[string]any{}
			if len(k.Entries) > 0 {
				fields = k.Entries[0].Fields
			}
			if err := val.Encode(fields); err != nil {
				return nil, err
			}
		}
		node.Content = append(node.Content, key, &val)
	}
	return node, nil
}

// Parse decodes a manifest, refusing unknown keys.
//
// STRICT ON PURPOSE. A misspelt `placment:` that decoded to nothing would make an environment
// silently `dedicated` — the rung with a bill — and the person would learn about it from an
// invoice. So an unknown key is an error naming the line.
func Parse(data []byte) (*Manifest, error) {
	dec := yaml.NewDecoder(bytes.NewReader(data))
	dec.KnownFields(true)
	var m Manifest
	if err := dec.Decode(&m); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, err
		}
		return nil, fmt.Errorf("%s: %w", FileName, err)
	}
	return &m, nil
}

// Load reads and decodes the manifest at path.
func Load(path string) (*Manifest, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	m, err := Parse(data)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", path, unwrapFileName(err))
	}
	return m, nil
}

// unwrapFileName strips the generic FileName prefix Parse adds, so Load can name the real path.
func unwrapFileName(err error) error {
	msg := err.Error()
	if strings.HasPrefix(msg, FileName+": ") {
		return errors.New(strings.TrimPrefix(msg, FileName+": "))
	}
	return err
}

// Find reports the manifest in dir, if there is one. It looks in dir ONLY, never up the tree: a
// manifest found three directories above the shell's cwd would apply a project the person did not
// know was in scope, and `apply` is the command with a bill.
func Find(dir string) (string, bool) {
	path := filepath.Join(dir, FileName)
	info, err := os.Stat(path)
	if err != nil || info.IsDir() {
		return "", false
	}
	return path, true
}

// Render writes the manifest as YAML, in the field order a person would write it.
func Render(m *Manifest) ([]byte, error) {
	var buf bytes.Buffer
	enc := yaml.NewEncoder(&buf)
	enc.SetIndent(2)
	if err := enc.Encode(m); err != nil {
		return nil, err
	}
	if err := enc.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// Write renders the manifest to path, refusing to overwrite an existing file unless overwrite is
// set — a person's hand-edited manifest is not something a generator may replace unasked.
func Write(path string, m *Manifest, overwrite bool) error {
	if !overwrite {
		if _, err := os.Stat(path); err == nil {
			return fmt.Errorf("%s already exists — edit it, or pass --force to replace it", path)
		}
	}
	data, err := Render(m)
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o644)
}

// Lookup answers the field-spec kit's manifest rung: the value at a dotted scalar key, and
// whether the manifest has one.
//
// The keys are the ones `project create`'s spec declares. `stage` and `placement` describe the
// DEFAULT environment, which is the first one, because that is what the flags of the same name on
// `project create` describe; a manifest with no environments has neither.
func (m *Manifest) Lookup(key string) (string, bool) {
	if m == nil {
		return "", false
	}
	var v string
	switch key {
	case "project":
		v = m.Project
	case "cloud.account":
		v = m.Cloud.Account
	case "cloud.region":
		v = m.Cloud.Region
	case "iac.version":
		v = m.IaC.Version
	case "stage":
		if len(m.Environments) > 0 {
			v = m.Environments[0].Stage
		}
	case "placement":
		if len(m.Environments) > 0 {
			v = m.Environments[0].Placement
		}
	default:
		return "", false
	}
	return v, v != ""
}

// ScalarKeys is every dotted key Lookup answers, sorted. The command-side test walks the spec's
// ManifestKeyPaths against this, so the two lists cannot drift apart unnoticed.
func ScalarKeys() []string {
	keys := []string{"project", "cloud.account", "cloud.region", "iac.version", "stage", "placement"}
	sort.Strings(keys)
	return keys
}
