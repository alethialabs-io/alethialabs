// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package designfile

import (
	"fmt"

	"github.com/alethialabs-io/alethialabs/packages/core/names"
)

// Edit is one change to a component, made somewhere other than the file — on the canvas, by an
// agent — that the file should now state.
//
// An Edit changes the FILE. `ActionRemove` takes the entry out of it, and by the reading rule
// (Action) an entry that is not in the file is left running: removing it here stops the file
// describing the component and deletes nothing.
type Edit struct {
	// Environment is the environment's name.
	Environment string
	// Kind is the component kind, e.g. `databases`.
	Kind string
	// Name is the component's name; empty for a kind with one component per environment.
	Name string
	// Action is ActionCreate or ActionUpdate (both write the fields, adding the entry when it is
	// not there) or ActionRemove.
	Action Action
	// Fields are the fields to write. A field not named keeps what the file says; a field named
	// with a nil value is written as `field: null`. A field the server merges key by key
	// (`provider_config`) is merged key by key here too.
	Fields map[string]any
}

// Apply makes the edits to the manifest, in order. It refuses an edit it cannot place — an
// environment the file does not declare, a name on a one-per-environment kind — without having
// applied any of them, so a file is never left half edited.
func (m *Manifest) Apply(edits ...Edit) error {
	work, err := m.Clone()
	if err != nil {
		return err
	}
	for i, e := range edits {
		if err := work.applyEdit(e); err != nil {
			return fmt.Errorf("edit %d (%s %s): %w", i, e.Action, componentRefText(e.Kind, e.Name), err)
		}
	}
	*m = *work
	return nil
}

// Clone returns a copy that shares nothing with the manifest, taken through the file's own
// written form — so the copy is exactly what a reader of the rendered file would hold.
func (m *Manifest) Clone() (*Manifest, error) {
	data, err := Render(m)
	if err != nil {
		return nil, err
	}
	out, err := Parse(data)
	if err != nil {
		return nil, fmt.Errorf("the design does not survive being written: %w", err)
	}
	return out, nil
}

// applyEdit makes one edit in place.
func (m *Manifest) applyEdit(e Edit) error {
	if e.Kind == "" {
		return fmt.Errorf("an edit needs a component kind")
	}
	var env *Environment
	want := names.NormalizeEnvironmentName(e.Environment)
	for i := range m.Environments {
		if names.NormalizeEnvironmentName(m.Environments[i].Name) == want {
			env = &m.Environments[i]
			break
		}
	}
	if env == nil {
		return fmt.Errorf("%s declares no environment %q", FileName, e.Environment)
	}
	at := -1
	for i := range env.Components {
		if env.Components[i].Kind == e.Kind {
			at = i
			break
		}
	}
	switch e.Action {
	case ActionRemove:
		if at < 0 {
			return nil
		}
		kind := &env.Components[at]
		kept := kind.Entries[:0:0]
		for _, c := range kind.Entries {
			if c.Name != e.Name {
				kept = append(kept, c)
			}
		}
		kind.Entries = kept
		if len(kept) == 0 {
			env.Components = append(env.Components[:at:at], env.Components[at+1:]...)
		}
		return nil
	case ActionCreate, ActionUpdate:
		if at < 0 {
			env.Components = append(env.Components, KindEntries{Kind: e.Kind, List: e.Name != ""})
			at = len(env.Components) - 1
		}
		kind := &env.Components[at]
		if kind.List && e.Name == "" {
			return fmt.Errorf("%s components are named in this file — the edit needs a name", e.Kind)
		}
		if !kind.List && e.Name != "" {
			return fmt.Errorf("%s is written as one per environment in this file — the edit must not name it", e.Kind)
		}
		for i := range kind.Entries {
			if kind.Entries[i].Name == e.Name {
				kind.Entries[i].Fields = mergeFields(kind.Entries[i].Fields, e.Fields)
				return nil
			}
		}
		kind.Entries = append(kind.Entries, Component{Name: e.Name, Fields: mergeFields(nil, e.Fields)})
		return nil
	case ActionUnchanged, ActionOmitted:
		return fmt.Errorf("%q is a result of comparing, not an edit — use create, update or remove", e.Action)
	}
	return fmt.Errorf("unknown action %q", e.Action)
}

// mergeFields writes `set` over `have` and returns the result as a new map. A field the server
// merges key by key is merged key by key; every other field is replaced.
func mergeFields(have, set map[string]any) map[string]any {
	out := make(map[string]any, len(have)+len(set))
	for k, v := range have {
		out[k] = v
	}
	for k, v := range set {
		if mergedFields[k] {
			if setKeys, ok := StringKeyed(v); ok {
				haveKeys, _ := StringKeyed(out[k])
				merged := make(map[string]any, len(haveKeys)+len(setKeys))
				for hk, hv := range haveKeys {
					merged[hk] = hv
				}
				for sk, sv := range setKeys {
					merged[sk] = sv
				}
				out[k] = merged
				continue
			}
		}
		out[k] = v
	}
	return out
}
