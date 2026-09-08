// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"errors"
	"fmt"
	"io"
	"os"
	"sort"
	"strings"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/manifest"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/spec"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/names"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/spf13/cobra"
)

// The golden path (#3662): a person with a repository, or nothing at all, reaches a running
// cluster with zero hand-assembled tuples and zero copied ids.
//
//	$ alethia apply
//	  Reading alethia.yaml · boutique · hetzner/nbg1
//	  prod      dedicated   + environment  + cluster
//	  dev-1     namespace   + environment  + repositories
//	  1 project · 2 environments · 2 components to create
//	  Apply these changes? Yes
//	  ▸ Deploying prod… ✓
//	  ▸ Deploying dev-1… ✓
//	  ✓ boutique is up.
//
// The file is DESIRED STATE. `apply` creates what is missing, reports what already matches and
// refuses what it cannot reconcile; it never removes anything the file stopped mentioning. `plan`
// is the same computation with the writes left out.
//
// The complaint this replaces, verbatim from the epic:
//
//	alethia project create boutique \
//	  --region <your-region> --cloud-identity-id <your-identity-id> \
//	  --env prod:production:dedicated \
//	  --env dev-1:development:namespace:boutique-dev-1
//
// Every value in that line is now a key in a file a person can read back, the cloud account is
// its LABEL, and the environment's fields have names rather than positions in a colon tuple.

// docsPlanApplyPage is the page `apply` and `plan` are documented on.
const docsPlanApplyPage = "apps/docs/content/docs/cli/commands/plan-and-apply.mdx"

// applySpec is what `apply` takes from a person, declared once. `plan` shares the manifest half.
var applySpec = spec.Spec{
	Command: "alethia apply",
	Fields: []spec.Field{
		{Command: "alethia apply", Key: "file", Title: "Manifest",
			Description: "The alethia.yaml to apply (default: ./alethia.yaml)",
			Flag:        "file", Shorthand: "f", Default: manifest.FileName, Page: docsPlanApplyPage},
		{Command: "alethia apply", Key: "runner", Title: "Runner",
			Description: "Runner to deploy with, by NAME or id. Omitted: the only online runner, or asked on a terminal",
			Flag:        "runner", Selector: "name", Page: docsPlanApplyPage},
		{Command: "alethia apply", Key: "env", Title: "Environments",
			Description: "Only deploy these environments (repeatable; default: every environment in the file)",
			Flag:        "env", Repeated: true, Page: docsPlanApplyPage},
		{Command: "alethia apply", Key: "yes", Title: "Confirm",
			Description: "Apply without asking (required with --no-input)",
			Flag:        "yes", Shorthand: "y", Bool: true, Page: docsPlanApplyPage},
		{Command: "alethia apply", Key: "no-wait", Title: "Wait",
			Description: "Queue the deploys and return instead of waiting for them",
			Flag:        "no-wait", Bool: true, Page: docsPlanApplyPage},
	},
}

// planSpec is `plan`'s one field: the file. It reads and computes; it has nothing to confirm.
var planSpec = spec.Spec{
	Command: "alethia plan",
	Fields: []spec.Field{
		{Command: "alethia plan", Key: "file", Title: "Manifest",
			Description: "The alethia.yaml to plan (default: ./alethia.yaml)",
			Flag:        "file", Shorthand: "f", Default: manifest.FileName, Page: docsPlanApplyPage},
	},
}

var (
	applyBinder *spec.Binder
	planBinder  *spec.Binder
)

// errApplyRequiresYes is the refusal when nobody can confirm a spend.
var errApplyRequiresYes = errors.New(
	"apply creates cloud resources and interactive prompts are unavailable " +
		"(--no-input, or stdin is not a terminal, or the stream the prompt draws on is redirected): " +
		"pass --yes to confirm")

var applyCmd = &cobra.Command{
	Use:   "apply",
	Short: "Create or update a project from alethia.yaml and deploy it",
	Long: `Read alethia.yaml, create whatever it declares that does not exist yet — the project, its
environments, their components — show the plan, and deploy every environment.

Nothing has to be copied out of another command: the cloud account is named by its label, the
runner by its name, and every environment by the name the file gives it. Re-running apply on a
project that already matches the file changes nothing and deploys again.`,
	Args: cobra.NoArgs,
	Run: func(cmd *cobra.Command, _ []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		values, err := spec.Resolve(applyBinder, spec.Sources{Env: os.LookupEnv})
		if err != nil {
			fail(err)
		}
		client := api.NewClient(token)
		plan, err := planFromFile(client, values.Get("file"))
		if err != nil {
			fail(err)
		}
		only, _ := applyBinder.Strings("env")
		if err := plan.restrictTo(only); err != nil {
			fail(err)
		}
		format := outputFormat(cmd)
		if format == ui.FormatTable {
			renderPlan(os.Stdout, plan)
		}
		if err := plan.refusal(); err != nil {
			fail(err)
		}
		yes, _ := applyBinder.Bool("yes")
		if !confirmApply(yes) {
			return
		}
		runnerID, err := applyRunner(client, token, values.Get("runner"))
		if err != nil {
			fail(err)
		}
		noWait, _ := applyBinder.Bool("no-wait")
		result, err := executeApply(client, os.Stdout, format, plan, runnerID, !noWait)
		if err != nil {
			fail(err)
		}
		if format != ui.FormatTable {
			if err := ui.Render(os.Stdout, format, ui.TableSpec{}, result); err != nil {
				fail(err)
			}
			return
		}
		if noWait {
			for _, j := range result.Jobs {
				ui.JobQueued("DEPLOY", j.JobID)
			}
			return
		}
		ui.Success(fmt.Sprintf("%s is up.", plan.Manifest.Project))
	},
}

var planCmd = &cobra.Command{
	Use:   "plan",
	Short: "Show what `alethia apply` would create, without changing anything",
	Long: `Read alethia.yaml and compare it with what exists: which environments and components would
be created, which already match, and anything the file declares that cannot be reconciled from
the terminal. Nothing is written and no job is queued.

The per-environment OpenTofu plan runs inside a deploy — use "alethia project plan" to queue one
on its own.`,
	Args: cobra.NoArgs,
	Run: func(cmd *cobra.Command, _ []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		values, err := spec.Resolve(planBinder, spec.Sources{Env: os.LookupEnv})
		if err != nil {
			fail(err)
		}
		plan, err := planFromFile(api.NewClient(token), values.Get("file"))
		if err != nil {
			fail(err)
		}
		format := outputFormat(cmd)
		if format != ui.FormatTable {
			if err := ui.Render(os.Stdout, format, ui.TableSpec{}, plan); err != nil {
				fail(err)
			}
			return
		}
		renderPlan(os.Stdout, plan)
		if err := plan.refusal(); err != nil {
			fail(err)
		}
	},
}

// ── the plan ──────────────────────────────────────────────────────────────────────────────

// Action is what apply will do with one thing the file declares.
type Action string

const (
	// ActionCreate — it does not exist and will be created.
	ActionCreate Action = "create"
	// ActionUpdate — it exists and its fields will be sent again (a singleton component, which
	// the server upserts).
	ActionUpdate Action = "update"
	// ActionUnchanged — it exists and is left as it is.
	ActionUnchanged Action = "unchanged"
)

// ApplyPlan is the difference between the file and the organization.
type ApplyPlan struct {
	Manifest *manifest.Manifest `json:"manifest"`
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
}

// applyClient is the slice of the API the plan and the apply need. Narrow so the tests can fake
// it, and so the compiler says which calls apply makes.
type applyClient interface {
	GetConfigurations() ([]types.ConfigurationSummary, error)
	GetCloudIdentities() ([]api.CloudIdentity, error)
	GetComponentSchema() (*api.ComponentSchemaDocument, error)
	ListEnvironments(project string) ([]api.Environment, error)
	ListComponents(project, kind, env string) ([]api.Component, error)
	CreateProject(params api.CreateProjectParams) (*api.Project, error)
	AddEnvironment(params api.AddEnvironmentParams) (*api.Environment, error)
	AddComponent(project, kind, name, env string, fields map[string]interface{}) (*api.Component, error)
	QueueJobWithParams(params api.QueueJobParams) (*api.ProvisionJob, error)
	GetJob(jobID string) (*api.ProvisionJob, error)
	GetRunners() ([]api.Runner, error)
}

// planFromFile reads, normalises and validates the manifest, then computes the plan.
func planFromFile(c applyClient, path string) (*ApplyPlan, error) {
	m, err := manifest.Load(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, fmt.Errorf("%s not found — write one with `alethia init`, or pass --file", path)
		}
		return nil, err
	}
	m.Normalize()
	// FETCHED ONLY WHEN SOMETHING NEEDS IT. The document is ~1100 lines of JSON and
	// `validateComponents` has nothing to check when no environment declares a component, so a
	// plan over a components-free manifest was paying for it on every run. `manifestForCreate`
	// already gates it this way; a nil schema is the reader's documented "could not check", and
	// "nothing to check" reaches the same branch honestly.
	var schema *api.ComponentSchemaDocument
	if m.DeclaresComponents() {
		schema, err = c.GetComponentSchema()
		if err != nil {
			return nil, err
		}
	}
	// RequireDedicated is a CREATE-time rule and is asked as one: the server applies it when a
	// matrix brings a project's first Fabric into being, not when a file adds an environment to a
	// project that already has one. `computePlan` is where "does this project exist" is known, so
	// the decision is deferred to it rather than assumed here.
	if err := m.Validate(manifest.Rules{
		Stages:     environmentStages(),
		Placements: placementModes(),
		Schema:     schema,
	}); err != nil {
		return nil, err
	}
	plan, err := computePlan(c, m)
	if err != nil {
		return nil, err
	}
	// The create-time rule, asked where its condition is known. A matrix with no `dedicated`
	// environment can never provision — but only when it is the matrix that CREATES the project.
	// Adding `dev-1: namespace` to a project whose prod environment was made in the console is
	// exactly what the file is for, and refusing it contradicted this reader's own promise that
	// unmentioned environments are left alone.
	if plan.ProjectID == "" && m.NeedsADedicatedEnvironment() {
		return nil, fmt.Errorf(
			"%s: no environment is `dedicated` — one must own the Fabric a new project provisions, or nothing is ever built",
			manifest.FileName)
	}
	return plan, nil
}

// computePlan compares the manifest with the organization. It reads and never writes.
func computePlan(c applyClient, m *manifest.Manifest) (*ApplyPlan, error) {
	plan := &ApplyPlan{Manifest: m}

	if m.Cloud.Account != "" {
		identities, err := c.GetCloudIdentities()
		if err != nil {
			return nil, fmt.Errorf("resolve cloud.account %q: %w", m.Cloud.Account, err)
		}
		id, err := matchCloudIdentity(identities, m.Cloud.Account)
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
		if exists {
			ep.Action, ep.ID = ActionUnchanged, existing.ID
			if existing.Stage != env.Stage {
				ep.Problems = append(ep.Problems, fmt.Sprintf("the file says stage %s, the server has %s — a stage cannot be changed from here; edit it in the console or the file", env.Stage, existing.Stage))
			}
			if existing.PlacementMode != "" && existing.PlacementMode != env.Placement {
				ep.Problems = append(ep.Problems, fmt.Sprintf("the file says placement %s, the server has %s — placement cannot be changed from here; edit it in the console or the file", env.Placement, existing.PlacementMode))
			}
			// Only when the file declares components for THIS environment. `existingComps` is read
			// nowhere else, so a four-environment project declaring components on one of them was
			// issuing three round trips whose results nobody looked at.
			if len(env.Components) > 0 {
				existingComps, err = c.ListComponents(plan.ProjectID, "", existing.Name)
				if err != nil {
					return nil, fmt.Errorf("list components of %s/%s: %w", m.Project, env.Name, err)
				}
			}
		}
		for _, kind := range env.Components {
			for _, entry := range kind.Entries {
				cp := ComponentPlan{Kind: kind.Kind, Name: entry.Name, Action: ActionCreate, Fields: entry.Fields}
				if kind.List {
					if hasComponent(existingComps, kind.Kind, entry.Name) {
						// A named component has no update route; the server would refuse a
						// second row of the same name. Reported rather than retried.
						cp.Action = ActionUnchanged
					}
				} else if hasComponent(existingComps, kind.Kind, "") {
					// A singleton is UPSERTED by the server, so sending its fields again is
					// how the file's values reach an existing row.
					cp.Action = ActionUpdate
				}
				ep.Components = append(ep.Components, cp)
			}
		}
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

// hasComponent reports whether a component of the kind (and name, for a multi kind) exists.
func hasComponent(comps []api.Component, kind, name string) bool {
	for _, c := range comps {
		if c.Kind != kind {
			continue
		}
		if name == "" || c.Name == name {
			return true
		}
	}
	return false
}

// restrictTo narrows the deploy to the named environments. Creation is NOT narrowed: the file
// is applied whole, and --env says which environments to deploy afterwards.
func (p *ApplyPlan) restrictTo(only []string) error {
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
			strings.Join(missing, ", "), strings.Join(p.envNames(), ", "))
	}
	return nil
}

// envNames is every environment the file declares, in file order, for a refusal that has to list them.
func (p *ApplyPlan) envNames() []string {
	out := make([]string, len(p.Environments))
	for i, e := range p.Environments {
		out[i] = e.Name
	}
	return out
}

// refusal is the error when any environment carries a problem: the plan is shown in full first
// (so the person sees everything at once), then the run stops before a single write.
func (p *ApplyPlan) refusal() error {
	var lines []string
	for _, e := range p.Environments {
		for _, why := range e.Problems {
			lines = append(lines, e.Name+": "+why)
		}
	}
	if len(lines) == 0 {
		return nil
	}
	return fmt.Errorf("%s cannot be applied as written:\n  - %s", manifest.FileName, strings.Join(lines, "\n  - "))
}

// counts summarises what apply will create.
func (p *ApplyPlan) counts() (envs, comps int) {
	for _, e := range p.Environments {
		if e.Action == ActionCreate {
			envs++
		}
		for _, c := range e.Components {
			if c.Action != ActionUnchanged {
				comps++
			}
		}
	}
	return envs, comps
}

// renderPlan prints the plan for a person: one line per environment, then the totals.
func renderPlan(out io.Writer, p *ApplyPlan) {
	where := p.Manifest.Cloud.Region
	if p.Provider != "" {
		where = p.Provider + "/" + where
	}
	fmt.Fprintf(out, "%s Reading %s · %s · %s\n", ui.MutedStyle.Render(ui.SymbolPoint), manifest.FileName, p.Manifest.Project, where)
	if p.ProjectID == "" {
		fmt.Fprintf(out, "  %s project %s\n", glyphFor(ActionCreate), p.Manifest.Project)
	}
	width := 0
	for _, e := range p.Environments {
		if len(e.Name) > width {
			width = len(e.Name)
		}
	}
	for _, e := range p.Environments {
		var cells []string
		for _, c := range e.Components {
			label := c.Kind
			if c.Name != "" {
				label += "/" + c.Name
			}
			cells = append(cells, glyphFor(c.Action)+" "+label)
		}
		line := fmt.Sprintf("  %-*s  %-9s  %s environment", width, e.Name, e.Placement, glyphFor(e.Action))
		if len(cells) > 0 {
			line += "  " + strings.Join(cells, "  ")
		}
		if !e.Deploy {
			line += ui.MutedStyle.Render("  (not deployed: --env)")
		}
		fmt.Fprintln(out, line)
		for _, why := range e.Problems {
			fmt.Fprintf(out, "    %s %s\n", ui.WarningStyle.Render(ui.SymbolError), why)
		}
	}
	for _, name := range p.Unmanaged {
		fmt.Fprintln(out, ui.MutedStyle.Render(fmt.Sprintf("  %s is on the server and not in the file — left alone", name)))
	}
	envs, comps := p.counts()
	projects := 0
	if p.ProjectID == "" {
		projects = 1
	}
	fmt.Fprintln(out, ui.MutedStyle.Render(fmt.Sprintf("  %s to create · %s · %s",
		plural(projects, "project"), plural(envs, "environment"), plural(comps, "component"))))
}

// glyphFor renders an action as the diff marks a person reads at a glance.
func glyphFor(a Action) string {
	switch a {
	case ActionCreate:
		return "+"
	case ActionUpdate:
		return "~"
	case ActionUnchanged:
		return "="
	}
	// Unreachable for the three declared actions, and the `exhaustive` linter is what keeps it
	// that way: a fourth action added without a glyph fails the build here rather than rendering
	// as whatever the default arm happened to be.
	return "?"
}

// plural renders a count with its noun — "1 environment", "2 environments".
func plural(n int, noun string) string {
	if n == 1 {
		return "1 " + noun
	}
	return fmt.Sprintf("%d %ss", n, noun)
}

// ── the apply ─────────────────────────────────────────────────────────────────────────────

// ApplyResult is what apply did, for `--output json`.
type ApplyResult struct {
	ProjectID string      `json:"project_id"`
	Created   []string    `json:"created"`
	Jobs      []DeployJob `json:"jobs"`
}

// DeployJob is one environment's DEPLOY job.
type DeployJob struct {
	Environment string `json:"environment"`
	JobID       string `json:"job_id"`
	Status      string `json:"status,omitempty"`
}

// confirmApply is the spend gate. --yes skips it; without a terminal it refuses rather than
// applying silently, and on a terminal it asks.
func confirmApply(yes bool) bool {
	if yes {
		return true
	}
	if !canPromptForm() {
		fail(errApplyRequiresYes)
		return false
	}
	return confirm("Apply these changes?", "Creates what is missing and deploys every environment in the file")
}

// applyRunner picks the runner the deploys are assigned to.
//
// The rule, in order: a named runner wins; then the ONLY online runner, because asking a person
// to choose from a list of one is a question with no answer; then the picker on a terminal; and
// under --no-input the job is left unassigned for the server to place, exactly as `project
// apply` does.
//
// `--runner` takes the NAME or the id, and there is no `--runner-id` alias here. The other runner
// commands carry one because scripts have always passed it to them; `apply` is new, so an alias
// would be a compatibility shim with nothing to be compatible with — a hidden flag, a both-flags
// refusal and two test cases on a "remove after one release" schedule that nothing tracks.
func applyRunner(c applyClient, token, ref string) (string, error) {
	if ref != "" {
		return resolveRunnerRef(c, "--runner", ref)
	}
	runners, err := c.GetRunners()
	if err != nil {
		return "", fmt.Errorf("list runners: %w", err)
	}
	var online []api.Runner
	for _, r := range runners {
		if r.Status == "ONLINE" {
			online = append(online, r)
		}
	}
	if len(online) == 1 {
		return online[0].ID, nil
	}
	if canPromptForm() {
		return selectRunner(token, "")
	}
	return "", nil
}

// executeApply performs the plan's writes, then queues a DEPLOY per environment.
//
// Order is load-bearing twice. Environments are created with the project in ONE request — the
// matrix — so the server fans them out onto one shared Fabric rather than a cluster each. And the
// deploys run in file order, first the environment that owns the Fabric, because a namespace
// placed onto a cluster that does not exist yet has nowhere to go.
func executeApply(c applyClient, out io.Writer, format string, p *ApplyPlan, runnerID string, wait bool) (*ApplyResult, error) {
	m := p.Manifest
	result := &ApplyResult{ProjectID: p.ProjectID}
	say := func(line string) {
		if format == ui.FormatTable {
			fmt.Fprintln(out, line)
		}
	}

	if p.ProjectID == "" {
		project, err := c.CreateProject(api.CreateProjectParams{
			ProjectName:     m.Project,
			Region:          m.Cloud.Region,
			CloudIdentityID: p.IdentityID,
			IacVersion:      m.IaC.Version,
			Environments:    m.EnvironmentSpecs(),
		})
		if err != nil {
			return nil, fmt.Errorf("create project %s: %w", m.Project, err)
		}
		result.ProjectID = project.ID
		result.Created = append(result.Created, "project "+m.Project)
		say(fmt.Sprintf("  %s created project %s", ui.SymbolSuccess, m.Project))
	} else {
		for _, e := range p.Environments {
			if e.Action != ActionCreate {
				continue
			}
			env, err := findEnv(m, e.Name)
			if err != nil {
				return nil, err
			}
			if _, err := c.AddEnvironment(api.AddEnvironmentParams{
				Project:   p.ProjectID,
				Name:      env.Name,
				Stage:     env.Stage,
				Placement: env.Placement,
				Namespace: env.Namespace,
				Lifecycle: env.Lifecycle,
			}); err != nil {
				return nil, fmt.Errorf("add environment %s: %w", e.Name, err)
			}
			result.Created = append(result.Created, "environment "+e.Name)
			say(fmt.Sprintf("  %s created environment %s", ui.SymbolSuccess, e.Name))
		}
	}

	for _, e := range p.Environments {
		for _, comp := range e.Components {
			if comp.Action == ActionUnchanged {
				continue
			}
			if _, err := c.AddComponent(result.ProjectID, comp.Kind, comp.Name, e.Name, comp.Fields); err != nil {
				return nil, fmt.Errorf("%s/%s: %w", e.Name, comp.Kind, err)
			}
			label := comp.Kind
			if comp.Name != "" {
				label += "/" + comp.Name
			}
			result.Created = append(result.Created, e.Name+" "+label)
			say(fmt.Sprintf("  %s %s %s in %s", ui.SymbolSuccess, pastOf(comp.Action), label, e.Name))
		}
	}

	// The environment ids are read back rather than kept from the create response, because a
	// project created with a matrix returns the project and not its environments, and an
	// existing project's ids came from a list taken before anything was added.
	// Re-listed only when this run CREATED something. A plan over an existing project already
	// holds every id in `EnvPlan.ID`, and a project created here returns the project rather than
	// its environments — so the read-back is for the ids that did not exist a moment ago, and a
	// no-op apply should not pay for it.
	ids := map[string]string{}
	for _, e := range p.Environments {
		if e.ID != "" {
			ids[names.NormalizeEnvironmentName(e.Name)] = e.ID
		}
	}
	if len(result.Created) > 0 {
		envs, err := c.ListEnvironments(result.ProjectID)
		if err != nil {
			return nil, fmt.Errorf("list environments: %w", err)
		}
		for _, env := range envs {
			ids[names.NormalizeEnvironmentName(env.Name)] = env.ID
		}
	}
	for _, e := range p.Environments {
		if !e.Deploy {
			continue
		}
		envID, ok := ids[names.NormalizeEnvironmentName(e.Name)]
		if !ok {
			return nil, fmt.Errorf("environment %s was declared but the server does not list it after apply", e.Name)
		}
		params := api.QueueJobParams{JobType: "DEPLOY", ConfigurationID: result.ProjectID, EnvironmentID: envID}
		if runnerID != "" {
			params.AssignedRunnerID = runnerID
		}
		job, err := c.QueueJobWithParams(params)
		if err != nil {
			return nil, fmt.Errorf("deploy %s: %w", e.Name, err)
		}
		dj := DeployJob{Environment: e.Name, JobID: job.ID, Status: job.Status}
		if wait {
			say(fmt.Sprintf("%s Deploying %s (job %s)", ui.MutedStyle.Render(ui.SymbolPoint), e.Name, job.ID))
			if err := waitForJobQuiet(c, job.ID, format != ui.FormatTable); err != nil {
				result.Jobs = append(result.Jobs, dj)
				return result, fmt.Errorf("deploy %s: %w", e.Name, err)
			}
			dj.Status = "SUCCESS"
		}
		result.Jobs = append(result.Jobs, dj)
	}
	return result, nil
}

// pastOf renders an action in the past tense for the progress line.
func pastOf(a Action) string {
	if a == ActionUpdate {
		return "updated"
	}
	return "added"
}

// findEnv returns the manifest's environment by name.
func findEnv(m *manifest.Manifest, name string) (manifest.Environment, error) {
	for _, e := range m.Environments {
		if e.Name == name {
			return e, nil
		}
	}
	return manifest.Environment{}, fmt.Errorf("environment %s is in the plan and not in the file", name)
}

func init() {
	applyBinder = spec.RegisterFlags(applyCmd, applySpec)
	planBinder = spec.RegisterFlags(planCmd, planSpec)
	rootCmd.AddCommand(applyCmd)
	rootCmd.AddCommand(planCmd)
}
