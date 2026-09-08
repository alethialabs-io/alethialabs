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
	"io"
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
				// A type-assertion MISS is refused rather than discarded. `name: 2024` decoded to
				// `Name: ""` with the key deleted, so `Validate` then said the entry needed a name
				// it visibly carried, and the person had no way to learn they must quote it. Worse,
				// an unnamed entry and a numeric one both became `""`, which `hasComponent` reads
				// as the singleton case.
				var name string
				if raw, ok := fields["name"]; ok {
					s, isString := raw.(string)
					if !isString {
						return fmt.Errorf("components.%s[%d].name is %v, which YAML reads as %T — quote it (`name: \"%v\"`) if that is the name you meant",
							kind, j, raw, raw, raw)
					}
					name = s
				}
				delete(fields, "name")
				entries.Entries = append(entries.Entries, Component{Name: name, Fields: fields})
			}
		case yaml.AliasNode:
			// Unreachable: refuseAliases rejects every alias in the document before this decodes.
			// Kept as a named case so the `exhaustive` linter sees the kind, and separate from
			// DocumentNode so neither ever reports the other's message.
			return fmt.Errorf("components.%s: unexpected YAML alias (line %d)", kind, valNode.Line)
		case yaml.DocumentNode:
			// A document node cannot appear as a mapping value. Named for the same reason.
			return fmt.Errorf("components.%s must be a mapping of fields or a list of named entries (line %d)", kind, valNode.Line)
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
	if err := refuseAliases(data); err != nil {
		return nil, err
	}
	dec := yaml.NewDecoder(bytes.NewReader(data))
	dec.KnownFields(true)
	var m Manifest
	if err := dec.Decode(&m); err != nil {
		// An EMPTY or comment-only document. yaml.Decoder reports that as io.EOF, which is not a
		// syntax error and must not be reported as one: the honest answer is a manifest with
		// nothing in it, and `Validate` then says exactly which required keys are missing.
		if errors.Is(err, io.EOF) {
			return &m, nil
		}
		if errors.Is(err, os.ErrNotExist) {
			return nil, err
		}
		return nil, fmt.Errorf("%s: %w", FileName, err)
	}
	return &m, nil
}

// refuseAliases rejects a manifest containing a YAML alias, anywhere.
//
// # Why refuse at all
//
// The reason is REVERSIBILITY, not taste. Refusing is a decision that can be undone later without
// breaking anyone; resolving is one-way, because the moment a manifest in somebody's repository
// relies on an anchor, this reader can never stop resolving it. An `alethia.yaml` that means what
// it says where it says it is also the version a person can diff, review and grep — but that
// argument would lose the day somebody arrives with five near-identical environments, and the
// asymmetry above does not.
//
// # Why it is a separate pass over the whole document
//
// The obvious place — an `AliasNode` arm in the components decoder — catches only the form nobody
// writes:
//
//	components:
//	  cluster: *base        # the whole value is an alias, so dev's cluster is IDENTICAL to prod's
//
// The form people reach for is the merge key, and yaml.v3 resolves it inside `Decode` before any
// arm of ours runs:
//
//	components:
//	  cluster:
//	    <<: *base           # accepted and silently resolved, before this pass existed
//	    node_min_size: 1
//
// That is exactly the cross-environment dependency the refusal is for, and everything outside
// `components` — `project`, `cloud`, `iac`, the environment scalars — had no arm at all. So the
// check walks the parsed node tree ONCE, before the typed decode, where every alias is still
// visible as an alias.
func refuseAliases(data []byte) error {
	var root yaml.Node
	if err := yaml.Unmarshal(data, &root); err != nil {
		// Not a refusal: a document that does not parse is the strict decoder's error to report,
		// with its own message. Saying nothing here lets that happen.
		return nil
	}
	anchors := map[string]int{}
	var alias *yaml.Node
	var walk func(n *yaml.Node)
	walk = func(n *yaml.Node) {
		if n == nil {
			return
		}
		if n.Anchor != "" {
			if _, seen := anchors[n.Anchor]; !seen {
				anchors[n.Anchor] = n.Line
			}
		}
		// The FIRST alias, not the last: a person fixes one at a time, and the first is the one
		// their eye is already on.
		if n.Kind == yaml.AliasNode && alias == nil {
			alias = n
		}
		for _, c := range n.Content {
			walk(c)
		}
	}
	walk(&root)
	if alias == nil {
		return nil
	}
	where := ""
	if line, ok := anchors[alias.Value]; ok {
		where = fmt.Sprintf(", defined on line %d", line)
	}
	return fmt.Errorf(
		"%s line %d: `*%s` refers to an anchor%s — this file does not resolve aliases or merge keys, "+
			"so write the fields out. (Refusing is reversible; resolving is not, which is why it is "+
			"refused while no manifest depends on it.)",
		FileName, alias.Line, alias.Value, where)
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
