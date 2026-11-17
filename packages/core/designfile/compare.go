// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package designfile

import (
	"fmt"
	"sort"

	"github.com/alethialabs-io/alethialabs/packages/core/names"
)

// Action is what happens to one thing a design file is compared against.
//
// # Omission is not removal
//
// The file is desired state for what it NAMES and says nothing about what it does not. An
// environment, a component, an add-on or a single field that a file stops mentioning is left
// exactly as it is — still running, still billed, still holding its value. That is the rule the
// reader has always had ("a manifest that can tear down an environment by omission is a manifest
// nobody dares edit") and it is why there are two values here where one might be expected:
//
//   - ActionOmitted is the only thing an absence in the file can ever produce;
//   - ActionRemove is an explicit request, and no content of a file produces it.
//
// Keeping them as separate values means a consumer cannot turn the first into the second by
// forgetting a case: code that destroys has to be handed an ActionRemove, and nothing in this
// package that reads a file returns one.
type Action string

const (
	// ActionCreate — it does not exist and will be created.
	ActionCreate Action = "create"
	// ActionUpdate — it exists and at least one field the file declares differs. The changes are
	// listed beside it.
	ActionUpdate Action = "update"
	// ActionUnchanged — it exists, every field the file declares already matches, and it is left
	// as it is.
	ActionUnchanged Action = "unchanged"
	// ActionOmitted — it exists and the file does not mention it. It is left as it is and stops
	// being described by the file; nothing is deleted.
	ActionOmitted Action = "omitted"
	// ActionRemove — an explicit request to take the entry out. Compare and ComputePlan never
	// return it; the only way to get one is to write it, as an Edit does for a deletion made
	// somewhere other than the file.
	ActionRemove Action = "remove"
)

// Comparison is the difference between two versions of one design file — the file on a branch and
// the file a pull request proposes, say. `after` is read as the file that will be in force, by the
// same rules the plan reads a file against the server.
type Comparison struct {
	// Fields are the project-level scalars that differ: `project`, `cloud.account`,
	// `cloud.region`, `iac.version`.
	Fields []FieldChange `json:"fields,omitempty"`
	// Environments are every environment either version names: first the ones `after` declares, in
	// its order, then the ones only `before` had, sorted, each ActionOmitted.
	Environments []EnvironmentChange `json:"environments"`
}

// EnvironmentChange is one environment's difference.
type EnvironmentChange struct {
	Name   string `json:"name"`
	Action Action `json:"action"`
	// Fields are the environment's own scalars that differ: stage, placement, namespace, lifecycle.
	Fields     []FieldChange     `json:"fields,omitempty"`
	Components []ComponentChange `json:"components,omitempty"`
	Addons     []AddonChange     `json:"addons,omitempty"`
}

// ComponentChange is one component's difference.
type ComponentChange struct {
	Kind   string `json:"kind"`
	Name   string `json:"name,omitempty"`
	Action Action `json:"action"`
	// Changes are the declared fields whose value differs, for an update.
	Changes []FieldChange `json:"changes,omitempty"`
	// OmittedFields are fields the earlier version declared and this one does not, sorted. Each
	// keeps the value it has; none is cleared. Listed so a reviewer can see that a field stopped
	// being described without reading it as a field that was reset.
	OmittedFields []string `json:"omitted_fields,omitempty"`
}

// AddonChange is one add-on's difference.
type AddonChange struct {
	ID      string        `json:"id"`
	Action  Action        `json:"action"`
	Changes []FieldChange `json:"changes,omitempty"`
}

// Compare reads `after` against `before`. A nil `before` is a file that did not exist, so
// everything `after` declares is a create.
//
// Both are compared as given. Call Normalize on each first when a placement or a name the file
// left to its default should compare equal to the same value written out.
//
// It never returns ActionRemove, for anything, whatever the two files hold: see Action.
func Compare(before, after *Manifest) *Comparison {
	if after == nil {
		after = &Manifest{}
	}
	out := &Comparison{Environments: []EnvironmentChange{}}
	var prior []Environment
	if before != nil {
		prior = before.Environments
		out.Fields = scalarChanges(
			[]string{"project", "cloud.account", "cloud.region", "iac.version"},
			[]string{before.Project, before.Cloud.Account, before.Cloud.Region, before.IaC.Version},
			[]string{after.Project, after.Cloud.Account, after.Cloud.Region, after.IaC.Version},
		)
	}
	byName := map[string]Environment{}
	for _, e := range prior {
		byName[names.NormalizeEnvironmentName(e.Name)] = e
	}
	declared := map[string]bool{}
	for _, e := range after.Environments {
		key := names.NormalizeEnvironmentName(e.Name)
		declared[key] = true
		old, existed := byName[key]
		ec := EnvironmentChange{Name: e.Name, Action: ActionCreate}
		if existed {
			ec.Fields = scalarChanges(
				[]string{"stage", "placement", "namespace", "lifecycle"},
				[]string{old.Stage, old.Placement, old.Namespace, old.Lifecycle},
				[]string{e.Stage, e.Placement, e.Namespace, e.Lifecycle},
			)
		}
		ec.Components = compareComponents(old.Components, e.Components, existed)
		ec.Addons = compareAddons(old.Addons, e.Addons, existed)
		if existed {
			ec.Action = ActionUnchanged
			if len(ec.Fields) > 0 || anyComponentChanged(ec.Components) || anyAddonChanged(ec.Addons) {
				ec.Action = ActionUpdate
			}
		}
		out.Environments = append(out.Environments, ec)
	}
	var omitted []EnvironmentChange
	for _, e := range prior {
		if !declared[names.NormalizeEnvironmentName(e.Name)] {
			omitted = append(omitted, EnvironmentChange{Name: e.Name, Action: ActionOmitted})
		}
	}
	sort.Slice(omitted, func(i, j int) bool { return omitted[i].Name < omitted[j].Name })
	out.Environments = append(out.Environments, omitted...)
	return out
}

// HasChanges reports whether applying `after` would create or update anything. Omissions are not
// changes: they leave everything as it is.
func (c *Comparison) HasChanges() bool {
	if len(c.Fields) > 0 {
		return true
	}
	for _, e := range c.Environments {
		if e.Action == ActionCreate || e.Action == ActionUpdate {
			return true
		}
	}
	return false
}

// Omitted lists what the earlier version described and the later one does not, one line each, in
// the order of the comparison: `environment prod`, `prod: databases/orders`, `prod: add-on loki`.
// Every one of them is left as it is.
func (c *Comparison) Omitted() []string {
	var out []string
	for _, e := range c.Environments {
		if e.Action == ActionOmitted {
			out = append(out, "environment "+e.Name)
			continue
		}
		for _, comp := range e.Components {
			if comp.Action == ActionOmitted {
				out = append(out, fmt.Sprintf("%s: %s", e.Name, componentRefText(comp.Kind, comp.Name)))
			}
		}
		for _, a := range e.Addons {
			if a.Action == ActionOmitted {
				out = append(out, fmt.Sprintf("%s: add-on %s", e.Name, a.ID))
			}
		}
	}
	return out
}

// componentRefText names a component the way a person does: `cluster`, or `databases/orders`.
func componentRefText(kind, name string) string {
	if name == "" {
		return kind
	}
	return kind + "/" + name
}

// scalarChanges compares named strings pairwise and returns one change per pair that differs. An
// empty string is "not said", and is reported as no value.
func scalarChanges(fields, before, after []string) []FieldChange {
	var out []FieldChange
	for i, f := range fields {
		if before[i] == after[i] {
			continue
		}
		out = append(out, FieldChange{Field: f, From: emptyAsNil(before[i]), To: emptyAsNil(after[i])})
	}
	return out
}

// emptyAsNil turns "" into nil, so an unset scalar reads as unset rather than as an empty string.
func emptyAsNil(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// compareComponents reads one environment's components in `after` against `before`: every entry
// `after` declares, in file order, then every entry only `before` had, sorted, as omitted.
func compareComponents(before, after Components, existed bool) []ComponentChange {
	type ref struct{ kind, name string }
	find := func(kind, name string) (Component, bool) {
		entries, ok := before.Kind(kind)
		if !ok {
			return Component{}, false
		}
		for _, e := range entries.Entries {
			if e.Name == name {
				return e, true
			}
		}
		return Component{}, false
	}
	var out []ComponentChange
	seen := map[ref]bool{}
	for _, k := range after {
		for _, entry := range k.Entries {
			seen[ref{k.Kind, entry.Name}] = true
			cc := ComponentChange{Kind: k.Kind, Name: entry.Name, Action: ActionCreate}
			if old, ok := find(k.Kind, entry.Name); ok && existed {
				cc.Changes = DiffFields(entry.Fields, old.Fields)
				for f := range old.Fields {
					if _, still := entry.Fields[f]; !still {
						cc.OmittedFields = append(cc.OmittedFields, f)
					}
				}
				sort.Strings(cc.OmittedFields)
				cc.Action = ActionUnchanged
				if len(cc.Changes) > 0 {
					cc.Action = ActionUpdate
				}
			}
			out = append(out, cc)
		}
	}
	var omitted []ComponentChange
	for _, k := range before {
		for _, entry := range k.Entries {
			if !seen[ref{k.Kind, entry.Name}] {
				omitted = append(omitted, ComponentChange{Kind: k.Kind, Name: entry.Name, Action: ActionOmitted})
			}
		}
	}
	sort.Slice(omitted, func(i, j int) bool {
		if omitted[i].Kind != omitted[j].Kind {
			return omitted[i].Kind < omitted[j].Kind
		}
		return omitted[i].Name < omitted[j].Name
	})
	return append(out, omitted...)
}

// compareAddons reads one environment's add-ons in `after` against `before`, by the entry rule in
// addons.go: an omitted field keeps what is there, and each `settings` key stands on its own.
func compareAddons(before, after []Addon, existed bool) []AddonChange {
	prior := map[string]Addon{}
	for _, a := range before {
		prior[a.ID] = a
	}
	var out []AddonChange
	seen := map[string]bool{}
	for _, a := range after {
		seen[a.ID] = true
		ac := AddonChange{ID: a.ID, Action: ActionCreate}
		if old, ok := prior[a.ID]; ok && existed {
			ac.Changes = DiffFields(addonDeclared(a), addonDeclared(old))
			ac.Changes = append(ac.Changes, diffKeys("settings", a.Settings, old.Settings)...)
			SortChanges(ac.Changes)
			ac.Action = ActionUnchanged
			if len(ac.Changes) > 0 {
				ac.Action = ActionUpdate
			}
		}
		out = append(out, ac)
	}
	var omitted []AddonChange
	for _, a := range before {
		if !seen[a.ID] {
			omitted = append(omitted, AddonChange{ID: a.ID, Action: ActionOmitted})
		}
	}
	sort.Slice(omitted, func(i, j int) bool { return omitted[i].ID < omitted[j].ID })
	return append(out, omitted...)
}

// addonDeclared is the fields of an add-on entry that the file actually states, apart from
// `settings` (compared key by key). A field the entry leaves out is not in the map, so it is never
// compared — which is what "omitted keeps" means.
func addonDeclared(a Addon) map[string]any {
	out := map[string]any{}
	if a.Version != nil {
		out["version"] = *a.Version
	}
	if a.Mode != "" {
		out["mode"] = a.Mode
	}
	switch {
	case a.Values != nil:
		out["values"] = a.Values
	case a.ValuesCleared:
		out["values"] = nil
	}
	if a.ValuesFile != nil {
		out["values_file"] = *a.ValuesFile
	}
	return out
}

// anyComponentChanged reports whether any component is created or updated.
func anyComponentChanged(cs []ComponentChange) bool {
	for _, c := range cs {
		if c.Action == ActionCreate || c.Action == ActionUpdate {
			return true
		}
	}
	return false
}

// anyAddonChanged reports whether any add-on is created or updated.
func anyAddonChanged(as []AddonChange) bool {
	for _, a := range as {
		if a.Action == ActionCreate || a.Action == ActionUpdate {
			return true
		}
	}
	return false
}
