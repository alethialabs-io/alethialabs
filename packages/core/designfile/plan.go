// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package designfile

import (
	"fmt"
	"sort"
	"strings"

	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/names"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// The plan: the difference between a design file and the organization it describes.
//
// It lives here, rather than in the command that prints it, so that everything which reads a
// design file against the server — `alethia plan`, `alethia apply`, the runner's design-file job —
// computes one answer. The plan only reads. Printing it and carrying it out belong to the caller.

// PlanReader is the slice of the API a plan reads. Narrow so a caller can fake it, and so the
// compiler says which calls a plan makes — none of which writes.
type PlanReader interface {
	// ResolveCloudAccount finds the cloud account `cloud.account` names, by label or id. It is the
	// caller's because what counts as a match, and how a miss is worded, is the caller's to say.
	ResolveCloudAccount(ref string) (api.CloudIdentity, error)
	GetConfigurations() ([]types.ConfigurationSummary, error)
	ListEnvironments(project string) ([]api.Environment, error)
	ListComponents(project, kind, env string) ([]api.Component, error)
	GetProjectAddons(project, env string) (*api.ProjectAddons, error)
}

// DefaultLifecycle is the lifecycle an environment has when none is said — the column default
// (`environment_lifecycle`), which is also what `project env add` creates without `--lifecycle`.
const DefaultLifecycle = "persistent"

// Plan is the difference between the file and the organization.
type Plan struct {
	Manifest *Manifest `json:"manifest"`
	// Provider is the cloud the account belongs to, for the summary line. Empty when the file
	// names no account.
	Provider string `json:"provider,omitempty"`
	// IdentityID is the cloud account resolved from the file's label; empty when none was named.
	IdentityID string `json:"identity_id,omitempty"`
	// ProjectID is the existing project, or empty when apply will create it.
	ProjectID    string    `json:"project_id,omitempty"`
	Environments []EnvPlan `json:"environments"`
	// Unmanaged are environments the project has that the file does not mention. They are left
	// alone and listed, so a file that forgot one does not read as a project that lost one.
	Unmanaged []string `json:"unmanaged,omitempty"`

	// Catalog is the add-on catalog the plan was computed against — nil when the file declares no
	// add-on. Kept so rendering can tell a secret setting by name. Never serialized.
	Catalog *api.AddonCatalogDocument `json:"-"`
}

// EnvPlan is one environment's difference.
type EnvPlan struct {
	Name      string `json:"name"`
	Stage     string `json:"stage"`
	Placement string `json:"placement"`
	Action    Action `json:"action"`
	// ID is the existing environment's id; empty until created.
	ID         string          `json:"id,omitempty"`
	Components []ComponentPlan `json:"components"`
	// Addons are the catalog add-ons the file declares for this environment (apply_addons.go).
	Addons []AddonPlan `json:"addons,omitempty"`
	// UnmanagedAddons are add-ons enabled on the server that the file does not mention. Listed,
	// never disabled — the rule Unmanaged states for environments.
	UnmanagedAddons []string `json:"unmanaged_addons,omitempty"`
	// Problems are the reasons this environment cannot be reconciled from here — the file says
	// one stage and the server has another, say. Any problem refuses the whole apply, because a
	// deploy of an environment the file describes wrongly is not what the person asked for.
	Problems []string `json:"problems,omitempty"`
	// Deploy is false when --env narrowed the run to other environments.
	Deploy bool `json:"deploy"`
}

// ComponentPlan is one component's difference.
type ComponentPlan struct {
	Kind   string         `json:"kind"`
	Name   string         `json:"name,omitempty"`
	Action Action         `json:"action"`
	Fields map[string]any `json:"fields,omitempty"`
	// Changes are the declared fields whose value differs from the server's, one per field, for
	// an `update`. Empty for `create` (everything is new) and `unchanged` (nothing differs).
	Changes []FieldChange `json:"changes,omitempty"`
	// Revision is the server's revision of the component as the plan READ it (its updated_at); empty
	// for `create`, and for a server too old to send one. Apply sends it back as If-Match, so a
	// component that changed on the server after the plan read it is refused rather than overwritten
	// (#5551). There is no saved plan file: apply recomputes the plan, and this is that read.
	Revision string `json:"revision,omitempty"`

	// Read is every settable value the plan read from the server, so a refused update can name the
	// fields that changed since. Never serialized.
	Read map[string]any `json:"-"`
}

// ComputePlan compares the manifest with the organization. It reads and never writes. catalog is the
// add-on catalog when the file declares add-ons, and nil otherwise.
func ComputePlan(c PlanReader, m *Manifest, catalog *api.AddonCatalogDocument) (*Plan, error) {
	plan := &Plan{Manifest: m, Catalog: catalog}

	if m.Cloud.Account != "" {
		id, err := c.ResolveCloudAccount(m.Cloud.Account)
		if err != nil {
			return nil, err
		}
		plan.IdentityID = id.ID
		plan.Provider = id.Provider
	}

	configs, err := c.GetConfigurations()
	if err != nil {
		return nil, fmt.Errorf("list projects: %w", err)
	}
	var matches []types.ConfigurationSummary
	for _, cfg := range configs {
		// Case-insensitive, because the server's uniqueness index is on lower(project_name)
		// — `Boutique` and `boutique` are one project there, so they must be one here.
		if strings.EqualFold(cfg.ProjectName, m.Project) {
			matches = append(matches, cfg)
		}
	}
	if len(matches) > 1 {
		return nil, fmt.Errorf("project name %q matches %d projects — rename one in the console before applying", m.Project, len(matches))
	}

	var existingEnvs []api.Environment
	if len(matches) == 1 {
		plan.ProjectID = matches[0].ID
		existingEnvs, err = c.ListEnvironments(plan.ProjectID)
		if err != nil {
			return nil, fmt.Errorf("list environments of %s: %w", m.Project, err)
		}
	}
	byName := map[string]api.Environment{}
	for _, e := range existingEnvs {
		byName[names.NormalizeEnvironmentName(e.Name)] = e
	}

	declared := map[string]bool{}
	for _, env := range m.Environments {
		ep := EnvPlan{Name: env.Name, Stage: env.Stage, Placement: env.Placement, Action: ActionCreate, Deploy: true}
		key := names.NormalizeEnvironmentName(env.Name)
		declared[key] = true
		existing, exists := byName[key]
		var existingComps []api.Component
		var existingAddons []api.Addon
		if exists {
			ep.Action, ep.ID = ActionUnchanged, existing.ID
			if existing.Stage != env.Stage {
				ep.Problems = append(ep.Problems, fmt.Sprintf("the file says stage %s, the server has %s — a stage cannot be changed from here; edit it in the console or the file", env.Stage, existing.Stage))
			}
			if existing.PlacementMode != "" && existing.PlacementMode != env.Placement {
				ep.Problems = append(ep.Problems, fmt.Sprintf("the file says placement %s, the server has %s — placement cannot be changed from here; edit it in the console or the file", env.Placement, existing.PlacementMode))
			}
			if why := lifecycleProblem(env.Lifecycle, existing.Lifecycle); why != "" {
				ep.Problems = append(ep.Problems, why)
			}
			// Only when the file declares components for THIS environment. `existingComps` is read
			// nowhere else, so a four-environment project declaring components on one of them was
			// issuing three round trips whose results nobody looked at.
			//
			// Every per-environment read below addresses the environment by its ID, never its name
			// (#5583). The server resolves `?env=` as id, name OR stage, so a NAME is ambiguous: with a
			// default environment `main` at stage `staging` and a second environment literally named
			// `staging`, the name `staging` once resolved to `main` — and this plan diffed, and apply
			// then wrote, the other environment's components. The id is the one address that cannot
			// land anywhere else; #5580 made the same change in export.
			if len(env.Components) > 0 {
				existingComps, err = c.ListComponents(plan.ProjectID, "", existing.ID)
				if err != nil {
					return nil, fmt.Errorf("list components of %s/%s: %w", m.Project, env.Name, err)
				}
			}
			// Read for EVERY existing environment once the file declares an add-on anywhere, so an
			// environment whose add-ons the file does not list still shows them as unmanaged. A file
			// with no add-ons reads none, and plans exactly as before.
			if m.DeclaresAddons() {
				rows, err := c.GetProjectAddons(plan.ProjectID, existing.ID)
				if err != nil {
					return nil, fmt.Errorf("list add-ons of %s/%s: %w", m.Project, env.Name, err)
				}
				existingAddons = rows.Addons
			}
		}
		for _, kind := range env.Components {
			for _, entry := range kind.Entries {
				cp := ComponentPlan{Kind: kind.Kind, Name: entry.Name, Action: ActionCreate, Fields: entry.Fields}
				name := ""
				if kind.List {
					name = entry.Name
				}
				if current, ok := findComponent(existingComps, kind.Kind, name); ok {
					// Only the fields the FILE declares are compared: an omitted field is left
					// as the server has it, never cleared. Equal everywhere is `unchanged` and
					// apply sends nothing; any difference is an `update` carrying the diff.
					cp.Read = ComponentValues(current)
					cp.Changes = DiffFields(entry.Fields, cp.Read)
					if current.UpdatedAt != nil {
						cp.Revision = *current.UpdatedAt
					}
					cp.Action = ActionUnchanged
					if len(cp.Changes) > 0 {
						cp.Action = ActionUpdate
					}
				}
				ep.Components = append(ep.Components, cp)
			}
		}
		var addonProblems []string
		ep.Addons, ep.UnmanagedAddons, addonProblems = PlanAddons(env, existingAddons, catalog)
		ep.Problems = append(ep.Problems, addonProblems...)
		plan.Environments = append(plan.Environments, ep)
	}
	for _, e := range existingEnvs {
		if !declared[names.NormalizeEnvironmentName(e.Name)] {
			plan.Unmanaged = append(plan.Unmanaged, e.Name)
		}
	}
	sort.Strings(plan.Unmanaged)
	return plan, nil
}

// lifecycleProblem is the refusal when the file's lifecycle for an EXISTING environment differs from
// the server's, and "" when they agree (#5590).
//
// It is a refusal rather than an update because the server has no way to change a lifecycle: it is
// written only when an environment is created (`POST /api/cli/projects/{id}/environments` and project
// creation), and no route, server action or console screen updates it afterwards. Sending it on any
// other request would be dropped, so the honest answer is to say so before a single write.
//
// An omitted key in the file means the default, `persistent` — the value apply would create — so a
// file that leaves it out disagrees with an ephemeral environment. A server that reports no lifecycle
// at all (one from before #5581) is not compared against: an empty value there is "not said", not a
// lifecycle.
func lifecycleProblem(declared, stored string) string {
	if stored == "" {
		return ""
	}
	if declared == "" {
		declared = DefaultLifecycle
	}
	if declared == stored {
		return ""
	}
	// Keeping the environment means making the file say what the server holds. For the default that
	// is either spelling — the key removed or written out — so both are named.
	keep := fmt.Sprintf("set it to `lifecycle: %s`", stored)
	if stored == DefaultLifecycle {
		keep = fmt.Sprintf("remove `lifecycle` or set it to `lifecycle: %s`", stored)
	}
	// The other remedy is a NEW environment, and two of its consequences are easy to miss: apply
	// never deletes, so the old one keeps running (and billing) until someone destroys it; and a new
	// environment that is not first in the file and names no placement is placed `namespace`
	// (Normalize), not on a dedicated cluster like the one it may be replacing.
	return fmt.Sprintf("the file says lifecycle %s, the server has %s — a lifecycle is set only when an environment is created, and nothing changes it afterwards (not apply, not the console). To keep this environment, %s. To get %s, declare a NEW environment with `lifecycle: %s`: apply creates it with `namespace` placement unless the file sets `placement` (or lists it first), and this environment keeps running until it is destroyed", declared, stored, keep, declared, declared)
}

// findComponent returns the existing component of the kind (and name, for a multi kind).
func findComponent(comps []api.Component, kind, name string) (api.Component, bool) {
	for _, c := range comps {
		if c.Kind != kind {
			continue
		}
		if name == "" || c.Name == name {
			return c, true
		}
	}
	return api.Component{}, false
}

// ComponentValues is the server's current value of every settable field of a component, keyed
// the way a manifest names them. `cloud_identity_id` travels as its own wire field rather than in
// Config, so it is folded back in for the comparison.
func ComponentValues(c api.Component) map[string]any {
	out := make(map[string]any, len(c.Config)+1)
	for k, v := range c.Config {
		out[k] = v
	}
	if c.CloudIdentityID != nil {
		out["cloud_identity_id"] = *c.CloudIdentityID
	}
	return out
}

// RestrictTo narrows the deploy to the named environments. Creation is NOT narrowed: the file
// is applied whole, and --env says which environments to deploy afterwards.
func (p *Plan) RestrictTo(only []string) error {
	if len(only) == 0 {
		return nil
	}
	want := map[string]bool{}
	for _, name := range only {
		want[names.NormalizeEnvironmentName(name)] = true
	}
	found := map[string]bool{}
	for i := range p.Environments {
		key := names.NormalizeEnvironmentName(p.Environments[i].Name)
		p.Environments[i].Deploy = want[key]
		if want[key] {
			found[key] = true
		}
	}
	var missing []string
	for _, name := range only {
		if !found[names.NormalizeEnvironmentName(name)] {
			missing = append(missing, name)
		}
	}
	if len(missing) > 0 {
		return fmt.Errorf("--env names %s, which the file does not declare (have: %s)",
			strings.Join(missing, ", "), strings.Join(p.EnvNames(), ", "))
	}
	return nil
}

// EnvNames is every environment the file declares, in file order, for a refusal that has to list them.
func (p *Plan) EnvNames() []string {
	out := make([]string, len(p.Environments))
	for i, e := range p.Environments {
		out[i] = e.Name
	}
	return out
}

// Refusal is the error when any environment carries a problem: the plan is shown in full first
// (so the person sees everything at once), then the run stops before a single write.
func (p *Plan) Refusal() error {
	var lines []string
	for _, e := range p.Environments {
		for _, why := range e.Problems {
			lines = append(lines, e.Name+": "+why)
		}
	}
	if len(lines) == 0 {
		return nil
	}
	return fmt.Errorf("%s cannot be applied as written:\n  - %s", FileName, strings.Join(lines, "\n  - "))
}

// Counts summarises what apply will create and what it will change.
func (p *Plan) Counts() (envs, comps, updates int) {
	for _, e := range p.Environments {
		if e.Action == ActionCreate {
			envs++
		}
		for _, c := range e.Components {
			switch c.Action {
			case ActionCreate:
				comps++
			case ActionUpdate:
				updates++
			case ActionUnchanged:
			}
		}
	}
	return envs, comps, updates
}

// HasChanges reports whether apply would write anything: a project or environment to create, or a
// component or add-on to create or update. Unmanaged environments and add-ons are left alone, so
// they are not changes.
func (p *Plan) HasChanges() bool {
	if p.ProjectID == "" {
		return true
	}
	for _, e := range p.Environments {
		if e.Action != ActionUnchanged {
			return true
		}
		for _, c := range e.Components {
			if c.Action != ActionUnchanged {
				return true
			}
		}
		for _, a := range e.Addons {
			if a.Action != ActionUnchanged {
				return true
			}
		}
	}
	return false
}

// AddonCounts is how many add-ons apply will enable and how many it will change.
func (p *Plan) AddonCounts() (enable, update int) {
	for _, e := range p.Environments {
		for _, a := range e.Addons {
			switch a.Action {
			case ActionCreate:
				enable++
			case ActionUpdate:
				update++
			case ActionUnchanged:
			}
		}
	}
	return enable, update
}

// AddonSecretKeys names one add-on's secret settings from the catalog the plan was computed against.
func (p *Plan) AddonSecretKeys(id string) []string {
	entry, _ := p.Catalog.Addon(id)
	return entry.SecretKeys
}
