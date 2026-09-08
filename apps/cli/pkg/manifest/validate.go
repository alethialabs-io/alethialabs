// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package manifest

import (
	"fmt"
	"sort"
	"strings"

	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/names"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// Rules are the vocabularies Validate checks against. They are PASSED IN rather than imported:
// the stage and placement enums are generated into the cmd package from the console's schema, and
// the component schema comes from the server at run time. This package owns the checking, not the
// vocabulary, so it can never hold a second opinion about either.
type Rules struct {
	// Stages are the environment stages the server accepts.
	Stages []string
	// Placements are the placement rungs the server accepts.
	Placements []string
	// Lifecycles are the environment lifecycles the server accepts. Empty skips the check.
	Lifecycles []string
	// Schema is the published component registry. Nil skips every component check — which is
	// the right answer when the schema could not be fetched, because "could not check" must not
	// become "refused".
	Schema *api.ComponentSchemaDocument
	// RequireDedicated asks for the server's create-time rule: a matrix that brings a project's
	// first Fabric into being must contain one `dedicated` environment. It is FALSE when the
	// project already exists, because the server does not apply it then and this reader must not
	// invent a refusal the front door would not make.
	RequireDedicated bool
}

// Normalize fills the defaults a person may leave out and drops what cannot apply.
//
// The placement default follows position: the FIRST environment owns the Fabric the project
// provisions, so it is `dedicated`; every later one is `namespace`, the rung with no bill. Same
// rule as `project create` states for its form and `project env add` for its flag, applied here
// once more so a manifest and a form cannot disagree about what an omitted placement means.
func (m *Manifest) Normalize() {
	m.Project = strings.TrimSpace(m.Project)
	m.Cloud.Account = strings.TrimSpace(m.Cloud.Account)
	m.Cloud.Region = strings.TrimSpace(m.Cloud.Region)
	m.IaC.Version = strings.TrimSpace(m.IaC.Version)
	for i := range m.Environments {
		e := &m.Environments[i]
		// NORMALIZED, not merely trimmed, and this is a correctness fix rather than tidying.
		// `environmentNameSchema` on the server transforms every name through the same slugifier
		// before storing it, so a file saying `Prod` produces a row called `prod` — and
		// `resolveCliEnvironment` then matches on the stored name EXACTLY. Sending the raw name
		// created the project and made every later address of that environment fail. Doing it here
		// means the plan's comparisons, the create payload, `AddEnvironment` and the component
		// `--env` all speak the one name the server will hold.
		//
		// A name that slugs away entirely keeps its RAW value so `Validate` can quote what the
		// person actually wrote; `EnvironmentNameProblem` is what refuses it.
		e.Name = strings.TrimSpace(e.Name)
		if n := names.NormalizeEnvironmentName(e.Name); n != "" {
			e.Name = n
		}
		e.Stage = strings.TrimSpace(e.Stage)
		e.Placement = strings.TrimSpace(e.Placement)
		e.Namespace = strings.TrimSpace(e.Namespace)
		e.Lifecycle = strings.TrimSpace(e.Lifecycle)
		if e.Placement == "" {
			// The GENERATED constants, not literals. The previous comment claimed neither package
			// could import the other's vocabulary; that was false — this package already imports
			// `packages/core/api`, which imports `packages/core/types` — and the claim had turned
			// one rule into two copies that a renamed rung would silently separate.
			if i == 0 {
				e.Placement = string(types.PlacementModeDedicated)
			} else {
				e.Placement = string(types.PlacementModeNamespace)
			}
		}
		// A dedicated environment owns a new Fabric and has no destination namespace on a
		// shared one; carrying the value through would put a field in the request the server
		// ignores, and a person reading the file back would believe it had an effect.
		if e.Placement == string(types.PlacementModeDedicated) {
			e.Namespace = ""
		}
	}
}

// Problems is every reason a manifest cannot be applied, at once.
//
// It names EVERY problem rather than the first, for the reason spec.MissingError does: a file
// refused one line at a time turns one editing session into as many as there are mistakes.
type Problems []string

// Error renders the problems one per line under a heading.
func (p Problems) Error() string {
	if len(p) == 1 {
		return FileName + ": " + p[0]
	}
	var b strings.Builder
	fmt.Fprintf(&b, "%s has %d problems:", FileName, len(p))
	for _, s := range p {
		b.WriteString("\n  - " + s)
	}
	return b.String()
}

// Validate refuses what the server would certainly refuse, and nothing else.
//
// Call Normalize first; Validate checks the file as it will be sent.
func (m *Manifest) Validate(rules Rules) error {
	var p Problems
	if m.Project == "" {
		p = append(p, "`project` is required — the project's name in the organization")
	}
	if m.Cloud.Region == "" {
		p = append(p, "`cloud.region` is required")
	}
	if len(m.Environments) == 0 {
		p = append(p, "`environments` must declare at least one environment")
	}

	seen := map[string]int{}
	dedicated := false
	for i, e := range m.Environments {
		at := fmt.Sprintf("environments[%d]", i)
		if e.Name != "" {
			at = fmt.Sprintf("environments[%s]", e.Name)
		}
		if e.Name == "" {
			p = append(p, at+": `name` is required")
		} else {
			if why := names.EnvironmentNameProblem(e.Name); why != "" {
				p = append(p, fmt.Sprintf("%s: name %q — %s", at, e.Name, why))
			}
			key := names.NormalizeEnvironmentName(e.Name)
			if prev, dup := seen[key]; dup {
				p = append(p, fmt.Sprintf("%s: name %q is also environments[%d]'s", at, e.Name, prev))
			}
			seen[key] = i
		}
		if e.Stage == "" {
			p = append(p, at+": `stage` is required")
		} else if !oneOf(e.Stage, rules.Stages) {
			p = append(p, fmt.Sprintf("%s: stage %q is not one of %s", at, e.Stage, oneOfText(rules.Stages)))
		}
		if !oneOf(e.Placement, rules.Placements) {
			p = append(p, fmt.Sprintf("%s: placement %q is not one of %s", at, e.Placement, oneOfText(rules.Placements)))
		}
		if e.Placement == string(types.PlacementModeDedicated) {
			dedicated = true
		}
		if e.Namespace != "" {
			if why := names.NamespaceProblem(e.Namespace); why != "" {
				p = append(p, fmt.Sprintf("%s: namespace %q — %s", at, e.Namespace, why))
			}
		}
		if e.Lifecycle != "" && len(rules.Lifecycles) > 0 && !oneOf(e.Lifecycle, rules.Lifecycles) {
			p = append(p, fmt.Sprintf("%s: lifecycle %q is not one of %s", at, e.Lifecycle, oneOfText(rules.Lifecycles)))
		}
		p = append(p, validateComponents(at, e.Components, rules.Schema)...)
	}
	if rules.RequireDedicated && len(m.Environments) > 0 && !dedicated {
		// The server refuses a matrix with no dedicated entry, and refuses it CONDITIONALLY:
		// `hasShared && dedicated.length === 0` fires only where a matrix creates a project's
		// Fabric. A file that adds `dev-1: namespace` to an EXISTING project whose prod
		// environment was made in the console is fine — `AddEnvironment` places it on the default
		// Fabric — and refusing it here contradicted this reader's own promise that environments
		// the file does not mention are left alone. The caller says which case it is in.
		p = append(p, "no environment is `dedicated` — one must own the Fabric the project provisions, or nothing is ever built")
	}
	if len(p) == 0 {
		return nil
	}
	return p
}

// validateComponents checks one environment's components against the published schema.
func validateComponents(at string, comps Components, schema *api.ComponentSchemaDocument) Problems {
	var p Problems
	for _, k := range comps {
		where := at + ".components." + k.Kind
		if schema == nil {
			// Without a schema the shape is still checkable: a list entry with no name is
			// refused by every multi kind, and a singleton has no list form.
			for j, e := range k.Entries {
				if k.List && e.Name == "" {
					p = append(p, fmt.Sprintf("%s[%d]: every entry of a list needs a `name`", where, j))
				}
			}
			continue
		}
		def, ok := schema.Kind(k.Kind)
		if !ok {
			p = append(p, fmt.Sprintf("%s: unknown component kind (have: %s)", where, strings.Join(schema.KindNames(), ", ")))
			continue
		}
		if def.Singleton && k.List {
			p = append(p, fmt.Sprintf("%s: %s is one per environment — write its fields directly, not as a list", where, k.Kind))
			continue
		}
		if !def.Singleton && !k.List {
			p = append(p, fmt.Sprintf("%s: %s components are named — write them as a list of entries, each with a `name`", where, k.Kind))
			continue
		}
		namesSeen := map[string]bool{}
		for j, e := range k.Entries {
			entry := where
			if k.List {
				entry = fmt.Sprintf("%s[%d]", where, j)
				if e.Name == "" {
					p = append(p, entry+": every entry needs a `name`")
				} else if namesSeen[e.Name] {
					p = append(p, fmt.Sprintf("%s: name %q is used twice", entry, e.Name))
				}
				namesSeen[e.Name] = true
			}
			var unknown []string
			for f := range e.Fields {
				if !oneOf(f, def.Fields) {
					unknown = append(unknown, f)
				}
			}
			sort.Strings(unknown)
			if len(unknown) > 0 {
				p = append(p, fmt.Sprintf("%s: %s does not take %s (it takes: %s)", entry, k.Kind,
					strings.Join(unknown, ", "), strings.Join(def.Fields, ", ")))
			}
		}
	}
	return p
}

// DeclaresComponents reports whether any environment declares a component.
//
// It is the question "does this manifest need the published schema" — asked so the caller can skip
// fetching a document with nothing to check against, rather than paying for it on every plan.
func (m *Manifest) DeclaresComponents() bool {
	for _, e := range m.Environments {
		if len(e.Components) > 0 {
			return true
		}
	}
	return false
}

// NeedsADedicatedEnvironment reports whether the matrix has an environment that owns a Fabric.
//
// Separate from Validate because the SERVER's rule is conditional — it fires only where a matrix
// brings a project's first Fabric into being — and only the caller knows whether the project
// already exists. Asking it here keeps the rule's one definition in this package while leaving the
// condition where the answer lives.
func (m *Manifest) NeedsADedicatedEnvironment() bool {
	for _, e := range m.Environments {
		if e.Placement == string(types.PlacementModeDedicated) {
			return false
		}
	}
	return len(m.Environments) > 0
}

// EnvironmentSpecs renders the environments as the wire shape `project create` sends.
func (m *Manifest) EnvironmentSpecs() []api.EnvironmentSpec {
	out := make([]api.EnvironmentSpec, 0, len(m.Environments))
	for i, e := range m.Environments {
		out = append(out, api.EnvironmentSpec{
			Name:          e.Name,
			Stage:         e.Stage,
			PlacementMode: e.Placement,
			Namespace:     e.Namespace,
			Lifecycle:     e.Lifecycle,
			IsDefault:     i == 0,
		})
	}
	return out
}

// FromEnvironmentSpecs is the inverse of EnvironmentSpecs, for a command that collected the
// matrix through a form and wants to show the file those answers add up to.
func FromEnvironmentSpecs(specs []api.EnvironmentSpec) []Environment {
	out := make([]Environment, 0, len(specs))
	for _, s := range specs {
		out = append(out, Environment{
			Name:      s.Name,
			Stage:     s.Stage,
			Placement: s.PlacementMode,
			Namespace: s.Namespace,
			Lifecycle: s.Lifecycle,
		})
	}
	return out
}

// oneOf reports whether v is one of the allowed values.
func oneOf(v string, allowed []string) bool {
	for _, a := range allowed {
		if a == v {
			return true
		}
	}
	return false
}

// oneOfText renders an allowed set for a refusal, SORTED — every validation message the docs pin
// depends on that order, so it is the behaviour worth recording rather than the joining.
func oneOfText(allowed []string) string {
	sorted := append([]string(nil), allowed...)
	sort.Strings(sorted)
	return strings.Join(sorted, " | ")
}
