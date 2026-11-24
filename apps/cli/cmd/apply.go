// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/clierr"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/manifest"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/spec"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/designfile"
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
const docsPlanApplyPage = "apps/docs/content/docs/reference/cli/plan-and-apply.mdx"

// applySpec is what `apply` takes from a person, declared once. `plan` shares the manifest half.
var applySpec = spec.Spec{
	Command: "alethia apply",
	Fields: []spec.Field{
		{Command: "alethia apply", Key: "file", Title: "Manifest",
			Description: "The alethia.yaml to apply (default: ./alethia.yaml)",
			Flag:        "file", Shorthand: "f", Default: manifest.FileName, Page: docsPlanApplyPage},
		{Command: "alethia apply", Key: "runner", Title: "Runner",
			Description: "Runner to deploy with, by NAME or id. Omitted: the only online runner that takes this cloud's jobs, or asked on a terminal",
			Flag:        "runner", Selector: "name", Page: docsPlanApplyPage},
		{Command: "alethia apply", Key: "env", Title: "Environments",
			Description: "Only deploy these environments (repeatable; default: every environment in the file)",
			Flag:        "env", Repeated: true, Page: docsPlanApplyPage},
		{Command: "alethia apply", Key: "yes", Title: "Confirm",
			Description: "Apply without asking (required with --no-input)",
			Flag:        "yes", Shorthand: "y", Bool: true, Page: docsPlanApplyPage},
		{Command: "alethia apply", Key: "no-wait", Title: "Wait",
			Description: "Queue the deploys and return instead of waiting for them or for a person's approval (exits 9 when one is needed)",
			Flag:        "no-wait", Bool: true, Page: docsPlanApplyPage},
		{Command: "alethia apply", Key: applyKeyTimeout, Title: "Timeout",
			Description: applyTimeoutDescription,
			Flag:        applyKeyTimeout, Page: docsPlanApplyPage},
	},
}

// applyKeyTimeout is the key and the flag of the wait deadline, on `apply` and wherever else an
// apply is run from.
const applyKeyTimeout = "timeout"

// applyTimeoutDescription is the help of --timeout wherever an apply is waited for.
const applyTimeoutDescription = "Stop waiting after this long, for example 30m (the deploys keep running; exits 12). Omitted or 0: wait without a limit"

// planSpec is `plan`'s fields: the file, and how much the exit code says (plan_exit.go). It reads and
// computes; it has nothing to confirm.
var planSpec = spec.Spec{
	Command: "alethia plan",
	Fields: []spec.Field{
		{Command: "alethia plan", Key: "file", Title: "Manifest",
			Description: "The alethia.yaml to plan (default: ./alethia.yaml)",
			Flag:        "file", Shorthand: "f", Default: manifest.FileName, Page: docsPlanApplyPage},
		{Command: "alethia plan", Key: "detailed-exitcode", Title: "Detailed exit code",
			Description: "Exit 0 with no changes, 2 with changes, 3 with problems (1 is an error). Default: 0 unless the plan has problems (2)",
			Flag:        "detailed-exitcode", Bool: true, Page: docsPlanApplyPage},
	},
}

var (
	applyBinder *spec.Binder
	planBinder  *spec.Binder
)

// errApplyRequiresYes is the refusal when nobody can confirm a spend.
var errApplyRequiresYes = refusal(clierr.CodeConfirmationRequired,
	"alethia plan   shows the same changes without applying them",
	"apply creates cloud resources and interactive prompts are unavailable "+
		"(--no-input, or stdin is not a terminal, or the stream the prompt draws on is redirected): "+
		"pass --yes to confirm")

var applyCmd = &cobra.Command{
	Use:   "apply",
	Short: "Create or update a project from alethia.yaml and deploy it",
	Long: `Read alethia.yaml, create whatever it declares that does not exist yet (the project, its
environments, their components and add-ons), show the plan, and deploy every environment.

Use it to bring a project to what the file says. It asks once before it writes anything; pass
--yes to skip the question, which a script or an agent must. Then it deploys each environment, in
file order, and waits for the deploys. A deploy applies a reviewed plan, so each environment is
previewed first and its change counts printed; the deploy then applies exactly that plan. --no-wait returns as soon as the deploys are
queued, and --timeout bounds the wait: when it passes, the deploys keep running and the command
exits 12 with the job to follow.

Nothing has to be copied out of another command: the cloud account is named by its label, the
runner by its name, and every environment by the name the file gives it. Omitted, the runner is
the only online one that takes this cloud's jobs.

apply never removes anything. An environment, a component or an add-on that is on the server and
not in the file is unmanaged: it is left as it is. Running apply again on a project that already
matches the file changes nothing and deploys again.

A deploy from the CLI needs a person's approval of its plan. The command asks for one, prints the
console page where a person approves it and the plan digest that page must show, and waits for
the decision. --no-wait (and agent mode) asks for every environment's approval, waits for none,
and exits 9 with the pages and the "alethia project deploy" line that deploys each plan once it
is approved.

The plan is written to stdout and progress to stderr. With --output json, stdout is one result
object that names every job; a deploy that is held for an approval says so, with the console
page where a person approves it.

Exit codes: 0 done, 1 the file does not exist or is not valid, 2 the file cannot be applied as
written (the same code "alethia plan" gives it), 9 nobody could confirm and --yes was not
passed, or a deploy waits for a person's approval, 12 the wait timed out, 13 a preview or a deploy
failed. Every other code is in the CLI's exit table.`,
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
		only, _ := applyBinder.Strings("env")
		yes, _ := applyBinder.Bool("yes")
		noWait, _ := applyBinder.Bool("no-wait")
		// --wait=false is --no-wait under the name every other long-running command uses.
		if wait, _ := cmd.Flags().GetBool(applyFlagWait); !wait {
			noWait = true
		}
		timeout, err := applyTimeout(values.Get(applyKeyTimeout), noWait)
		if err != nil {
			fail(err)
		}
		runApply(cmd, api.NewClient(token), token, applyOptions{
			file:    values.Get("file"),
			runner:  values.Get("runner"),
			only:    only,
			yes:     yes,
			noWait:  noWait,
			timeout: timeout,
			format:  outputFormat(cmd),
		})
	},
}

// applyFlagWait is the flag every long-running command has. `apply` waits by default, so here it
// is on unless it is turned off; it exists so `--wait` means the same thing on every command that
// queues a job, and a caller who passes it by habit is not refused.
const applyFlagWait = "wait"

// applyTimeout reads the --timeout value: a duration, where empty and 0 both mean "no deadline".
// A deadline on a run that does not wait is refused, because it would be ignored without a word.
func applyTimeout(raw string, noWait bool) (time.Duration, error) {
	if raw == "" {
		return 0, nil
	}
	d, err := time.ParseDuration(raw)
	if err != nil || d < 0 {
		return 0, refusal(clierr.CodeInvalidFlag, "",
			"invalid --timeout %q (want a duration such as 30m or 1h30m; 0 waits without a limit)", raw)
	}
	if noWait && d > 0 {
		return 0, refusal(clierr.CodeInvalidUsage, "",
			"--timeout bounds the wait and --no-wait does not wait: pass one or the other")
	}
	return d, nil
}

// applyOptions is one apply, as `apply` and `up` both describe it.
//
// It exists so `up` runs THIS code rather than a second copy: the plan, the refusal, the
// confirmation, the runner rule and the deploy ordering are each a decision with a reason, and two
// implementations of them is the defect the whole epic is named after.
type applyOptions struct {
	file   string
	runner string
	only   []string
	yes    bool
	noWait bool
	// timeout is the longest the whole wait may run, over every deploy. Zero is no deadline.
	timeout time.Duration
	format  string
}

// runApply is the apply, from the file to the finished deploys. Every failure leaves through fail;
// the two that are not failures of the command (a plan with problems, a declined confirmation)
// are handled here.
func runApply(_ *cobra.Command, client applyClient, token string, o applyOptions) {
	p := *printer
	p.Format = o.format

	plan, err := planFromFile(client, o.file)
	if err != nil {
		fail(err)
		return
	}
	if err := plan.RestrictTo(o.only); err != nil {
		fail(firstRunErr(clierr.CodeInvalidFlag, err, "alethia plan --file "+o.file))
		return
	}
	if p.Format == ui.FormatTable {
		renderPlan(p.Out, plan)
	}
	// A refusal exits 2, the code the default `plan` gives the same file (plan_exit.go), so a script
	// can tell "this file cannot be applied as written" from an error.
	if err := plan.Refusal(); err != nil {
		reportRefusal(err, p.Format, exitPlanRefused)
		exitFunc(exitPlanRefused)
		return
	}
	if !confirmApply(o.yes) {
		return
	}
	runnerID, err := applyRunner(client, token, o.runner, plan.Provider)
	if err != nil {
		fail(err)
		return
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	// The wait reads every poll for the two states in which a deploy waits on somebody (up.go).
	// `up` hands in a client that already does.
	if _, watched := client.(*deployWatcher); !watched && !o.noWait {
		client = newDeployWatcher(client, &p)
	}
	result, err := executeApply(ctx, client, &p, plan, runnerID, waitFlags{Wait: !o.noWait, Timeout: o.timeout})
	if err != nil {
		// A partial result is still the record of what happened: the project that was created and
		// the jobs that were queued. A machine reader gets it before the failure rather than losing
		// it, and the failure itself is on stderr with its exit code.
		if result != nil && p.Format == ui.FormatJSON {
			_ = p.Result(result.mutation(), nil)
		}
		fail(err)
		return
	}
	if err := p.Result(result.mutation(), func(w io.Writer) { renderApplyResult(w, plan.Manifest.Project, result) }); err != nil {
		fail(err)
	}
}

var planCmd = &cobra.Command{
	Use:   "plan",
	Short: "Show what `alethia apply` would create, without changing anything",
	Long: `Read alethia.yaml and compare it with what exists: which environments, components and
add-ons would be created or changed, which already match, and anything the file declares that
cannot be reconciled from the terminal. Nothing is written and no job is queued.

Use it before "alethia apply", and on every pull request that changes the file: its exit code
says whether apply would accept the file.

A plan never contains a removal. Whatever is on the server and not in the file is listed as
unmanaged and left as it is.

Exit codes: 0 when apply would accept the file, 2 when the plan has problems that apply would
refuse. With --detailed-exitcode: 0 no changes, 2 changes, 3 problems. 1 is an error in the file
itself: it does not exist, or it is not valid. Any other code is an error from the CLI's exit
table, for example 4 when you are not signed in and 11 when the control plane cannot be reached.

The per-environment OpenTofu plan runs inside a deploy. Use "alethia project preview" to queue
one on its own.`,
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
		detailed, _ := planBinder.Bool("detailed-exitcode")
		plan, err := planFromFile(api.NewClient(token), values.Get("file"))
		if err != nil {
			fail(err)
			return
		}
		p := printerFor(cmd)
		// The plan is printed whole first, in either form, and only then does the exit code say what
		// it found: a JSON document with problems is still the whole document (#5600).
		if err := printPlan(p, plan); err != nil {
			fail(err)
			return
		}
		finishPlan(plan, detailed, p.Format)
	},
}

// printPlan writes the plan on p.Out: the lines a person reads, or the typed plan as json. The plan
// has no rows, so `--output csv` writes nothing and the exit code is the whole answer, which is
// what a pipeline that only gates on it asked for.
func printPlan(p *Printer, plan *ApplyPlan) error {
	if p.Format == ui.FormatTable {
		renderPlan(p.Out, plan)
		return nil
	}
	return ui.Render(p.Out, p.Format, ui.TableSpec{}, plan)
}

// ── the plan ──────────────────────────────────────────────────────────────────────────────

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
	UpdateComponent(project, kind, name, env string, fields map[string]interface{}, ifMatch string) (*api.Component, error)
	UpsertComponent(project, kind, env string, fields map[string]interface{}, ifMatch string) (*api.Component, error)
	QueueJobWithParams(params api.QueueJobParams) (*api.ProvisionJob, error)
	GetJob(jobID string) (*api.ProvisionJob, error)
	GetRunners() ([]api.Runner, error)
	GetAddonCatalog() (*api.AddonCatalogDocument, error)
	GetProjectAddons(project, env string) (*api.ProjectAddons, error)
	EnableAddon(p api.EnableAddonParams) error
	// Whoami names the organization, for the console page of a deploy that waits for an approval.
	Whoami() (*api.WhoAmI, error)
	// A deploy from the CLI needs a person's approval of its plan (approve.go).
	approvalClient
}

// planFromFile reads, normalises and validates the manifest, then computes the plan.
func planFromFile(c applyClient, path string) (*ApplyPlan, error) {
	m, err := manifest.Load(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, refusal(codeManifestNotFound, "alethia init",
				"%s not found — write one with `alethia init`, or pass --file", path)
		}
		return nil, invalidManifest(err)
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
	// The add-on catalog, on the same terms: fetched only when the file declares an add-on, so a file
	// without one plans exactly as it did before add-ons existed. The values files are read here,
	// next to the manifest, so the plan diffs the file apply will send.
	var catalog *api.AddonCatalogDocument
	if m.DeclaresAddons() {
		if err := m.LoadValuesFiles(filepath.Dir(path)); err != nil {
			return nil, invalidManifest(err)
		}
		catalog, err = c.GetAddonCatalog()
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
		Addons:     catalog,
		AddonModes: addonModeValues(),
	}); err != nil {
		return nil, invalidManifest(err)
	}
	plan, err := computePlan(c, m, catalog)
	if err != nil {
		return nil, err
	}
	// The create-time rule, asked where its condition is known. A matrix with no `dedicated`
	// environment can never provision — but only when it is the matrix that CREATES the project.
	// Adding `dev-1: namespace` to a project whose prod environment was made in the console is
	// exactly what the file is for, and refusing it contradicted this reader's own promise that
	// unmentioned environments are left alone.
	if plan.ProjectID == "" && m.NeedsADedicatedEnvironment() {
		return nil, invalidManifest(fmt.Errorf(
			"%s: no environment is `dedicated` — one must own the Fabric a new project provisions, or nothing is ever built",
			manifest.FileName))
	}
	return plan, nil
}

// manifestSchemaURL is where the JSON Schema of alethia.yaml is published. `export` writes it into
// the file's first line, so an editor checks the file as it is typed.
const manifestSchemaURL = designfile.SchemaURL

// The codes of the two ways the file itself stops a plan. Neither is in the global registry, and
// that is deliberate: `plan` and `apply` document exit 1 for "the file could not be read or is not
// valid", pipelines gate on it next to 2 and 3 (plan_exit.go), and a code the registry does not
// carry keeps exit 1. The code still tells a program which of the two it was.
const (
	// codeManifestNotFound is "there is no file at that path".
	codeManifestNotFound = "manifest_not_found"
	// codeManifestInvalid is "the file was read and cannot be applied as it is written".
	codeManifestInvalid = "manifest_invalid"
)

// invalidManifest names "the file was read and is not valid", with the next step: nothing was
// sent, and the same command works once the file is fixed. An error the control plane classified
// keeps its class and its own hint.
func invalidManifest(err error) error {
	return firstRunErr(codeManifestInvalid, err, "fix the file, then run `alethia plan`. Its schema: "+manifestSchemaURL)
}

// componentLabel is `kind` for a singleton and `kind/name` for a named component.
func componentLabel(c ComponentPlan) string {
	if c.Name != "" {
		return c.Kind + "/" + c.Name
	}
	return c.Kind
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
			cells = append(cells, glyphFor(c.Action)+" "+componentLabel(c))
		}
		line := fmt.Sprintf("  %-*s  %-9s  %s environment", width, e.Name, e.Placement, glyphFor(e.Action))
		if len(cells) > 0 {
			line += "  " + strings.Join(cells, "  ")
		}
		if !e.Deploy {
			line += ui.MutedStyle.Render("  (not deployed: --env)")
		}
		fmt.Fprintln(out, line)
		for _, c := range e.Components {
			for _, ch := range c.Changes {
				fmt.Fprintf(out, "    %s %s  %s: %s → %s\n", glyphFor(ActionUpdate), componentLabel(c),
					ch.Label(), formatFieldValue(ch.From), formatFieldValue(ch.To))
			}
		}
		renderAddons(out, e, p.AddonSecretKeys)
		for _, why := range e.Problems {
			fmt.Fprintf(out, "    %s %s\n", ui.WarningStyle.Render(ui.SymbolError), why)
		}
	}
	for _, name := range p.Unmanaged {
		fmt.Fprintln(out, ui.MutedStyle.Render(fmt.Sprintf("  %s is on the server and not in the file — left alone (unmanaged)", name)))
	}
	// Said once, under whatever the plan listed as unmanaged, because it is the rule a person
	// needs before they delete a line from the file: leaving something out is never a removal.
	if planListsUnmanaged(p) {
		fmt.Fprintln(out, ui.MutedStyle.Render("  "+unmanagedRule))
	}
	envs, comps, updates := p.Counts()
	projects := 0
	if p.ProjectID == "" {
		projects = 1
	}
	summary := fmt.Sprintf("  %s to create · %s · %s",
		plural(projects, "project"), plural(envs, "environment"), plural(comps, "component"))
	if updates > 0 {
		summary += fmt.Sprintf(" · %s to update", plural(updates, "component"))
	}
	// Only when there is something to say, so a plan without add-ons reads exactly as it did.
	if enable, change := p.AddonCounts(); enable > 0 || change > 0 {
		summary += fmt.Sprintf(" · %s to enable · %d to change", plural(enable, "add-on"), change)
	}
	fmt.Fprintln(out, ui.MutedStyle.Render(summary))
}

// unmanagedRule is the one line a plan says about what it listed as unmanaged.
const unmanagedRule = "Not in the file means unmanaged: apply leaves it as it is and never removes it."

// planListsUnmanaged reports whether the plan found anything on the server that the file does not
// mention.
func planListsUnmanaged(p *ApplyPlan) bool {
	if len(p.Unmanaged) > 0 {
		return true
	}
	return slices.ContainsFunc(p.Environments, func(e EnvPlan) bool { return len(e.UnmanagedAddons) > 0 })
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
	case designfile.ActionOmitted, designfile.ActionRemove:
		// Neither is ever in a plan: what the file leaves out is listed as unmanaged rather than
		// given an action, and nothing a file says is a removal. They are named so the `exhaustive`
		// linter keeps this switch complete, and they take the arm below.
	}
	// Unreachable for every action a plan carries, and the `exhaustive` linter is what keeps it
	// that way: an action added without a glyph fails the build here rather than rendering
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

// ApplyResult is what apply did: the `object` of its result.
type ApplyResult struct {
	ProjectID string `json:"project_id"`
	// Created is one entry per thing this run wrote, in the order it wrote them. Always an array.
	Created []string `json:"created"`
	// Jobs is one DEPLOY job per environment that was deployed, in the order they were queued, in
	// the shape every job-queuing command uses. Always an array.
	Jobs []projectJobEntry `json:"jobs"`
	// Errors are the component updates the server refused. Each one keeps its environment from
	// being deployed — a deploy would ship the configuration the person asked to change — and
	// leaves every other environment to carry on.
	Errors []ComponentError `json:"errors,omitempty"`

	// createdProject records that this run created the project, which decides the result's action.
	createdProject bool
}

// mutation is the apply as the one result shape every mutating command returns. The subject is the
// project; `job` is the last deploy queued, and `object.jobs` lists every one.
func (r *ApplyResult) mutation() MutationResult {
	m := MutationResult{ID: r.ProjectID, Kind: "project", Action: ResultUnchanged, Object: r}
	switch {
	case r.createdProject:
		m.Action = ResultCreated
	case len(r.Created) > 0:
		m.Action = ResultUpdated
	case len(r.Jobs) > 0:
		m.Action = ResultQueued
	}
	if n := len(r.Jobs); n > 0 {
		m.Job = &JobRef{ID: r.Jobs[n-1].ID, Type: r.Jobs[n-1].Type}
	}
	return m
}

// renderApplyResult writes the apply's result for a person: one line per deploy that is not
// finished, or the one sentence that says the project is up.
func renderApplyResult(w io.Writer, project string, r *ApplyResult) {
	finished := len(r.Jobs) > 0
	for _, j := range r.Jobs {
		if !strings.EqualFold(j.Status, jobStatusSuccess) {
			finished = false
		}
	}
	if finished {
		fmt.Fprintln(w, ui.FormatSuccess(project+" is up."))
		return
	}
	for _, j := range r.Jobs {
		fmt.Fprintln(w, projectJobLine(j))
	}
	if len(r.Jobs) == 0 {
		fmt.Fprintln(w, ui.MutedStyle.Render("No environment was deployed."))
	}
}

// refusedKinds records what the server refused in one environment during an apply.
type refusedKinds struct {
	component bool
	addon     bool
}

// refusedIn returns the record for env, creating it on first use.
func refusedIn(m map[string]*refusedKinds, env string) *refusedKinds {
	key := names.NormalizeEnvironmentName(env)
	if m[key] == nil {
		m[key] = &refusedKinds{}
	}
	return m[key]
}

// sentence says why the environment was held back from its deploy, naming what was refused.
func (r refusedKinds) sentence() string {
	switch {
	case r.component && r.addon:
		return "a component update and an add-on change were refused"
	case r.addon:
		return "an add-on change was refused"
	}
	return "a component update was refused"
}

// ComponentError is one component the server refused to update.
type ComponentError struct {
	Environment string `json:"environment"`
	Component   string `json:"component"`
	Error       string `json:"error"`
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

// applyRunner picks the runner the deploys are assigned to, for a project on cloud.
//
// The rule, in order: a named runner wins; then the ONLY online runner that takes this cloud's
// jobs, because asking a person to choose from a list of one is a question with no answer; then
// the picker on a terminal; and under --no-input the job is left unassigned for the server to
// place, exactly as `project deploy` does.
//
// A runner that does not take the cloud's jobs is never assigned, named or not: the job would be
// queued for a runner that never claims it. A runner that lists no cloud takes every one.
//
// `--runner` takes the NAME or the id, and there is no `--runner-id` alias here. The other runner
// commands carry one because scripts have always passed it to them; `apply` is new, so an alias
// would be a compatibility shim with nothing to be compatible with — a hidden flag, a both-flags
// refusal and two test cases on a "remove after one release" schedule that nothing tracks.
func applyRunner(c applyClient, token, ref, cloud string) (string, error) {
	runners, err := c.GetRunners()
	if err != nil {
		return "", fmt.Errorf("list runners: %w", err)
	}
	if ref != "" {
		id, err := resolveRunnerRef(runnerList(runners), "--runner", ref)
		if err != nil {
			return "", firstRunErr(clierr.CodeNotFound, err, "alethia runner list")
		}
		return id, runnerTakesCloud(runners, id, cloud)
	}
	var usable []api.Runner
	for _, r := range runners {
		if r.Status == runnerStatusOnline && runnerServes(r, cloud) {
			usable = append(usable, r)
		}
	}
	if len(usable) == 1 {
		return usable[0].ID, nil
	}
	if len(usable) > 1 && canPromptForm() {
		id, err := selectRunner(token, "")
		if err != nil {
			return "", err
		}
		return id, runnerTakesCloud(runners, id, cloud)
	}
	return "", nil
}

// runnerTakesCloud refuses the runner with this id when it does not take cloud's jobs. An empty id
// (the picker's "any available"), an id the list does not carry and an unknown cloud all pass.
func runnerTakesCloud(runners []api.Runner, id, cloud string) error {
	i := slices.IndexFunc(runners, func(r api.Runner) bool { return r.ID == id })
	if id == "" || i < 0 || runnerServes(runners[i], cloud) {
		return nil
	}
	return refusal(clierr.CodeConflict, "alethia runner list   then name one that does with --runner",
		"runner %q does not take %s jobs (it takes %s), so it would never claim this deploy",
		runners[i].Name, cloud, strings.Join(runners[i].SupportedProviders, ", "))
}

// executeApply performs the plan's writes, then queues a DEPLOY per environment and, when wait
// says so, follows each one to its end.
//
// Order is load-bearing twice. Environments are created with the project in ONE request — the
// matrix — so the server fans them out onto one shared Fabric rather than a cluster each. And the
// deploys run in file order, first the environment that owns the Fabric, because a namespace
// placed onto a cluster that does not exist yet has nowhere to go.
//
// Progress is narrated on p.Err, in every output format. The result is returned, never printed: a
// failure part-way returns the result as far as it got together with the classified error.
func executeApply(ctx context.Context, c applyClient, p *Printer, plan *ApplyPlan, runnerID string, wait waitFlags) (*ApplyResult, error) {
	m := plan.Manifest
	result := &ApplyResult{ProjectID: plan.ProjectID, Created: []string{}, Jobs: []projectJobEntry{}}
	say := func(line string) { fmt.Fprintln(p.Err, line) }

	// The id of every environment the plan read, by normalised name. An environment this run creates
	// joins it below, before anything is written into it.
	ids := map[string]string{}
	for _, e := range plan.Environments {
		if e.ID != "" {
			ids[names.NormalizeEnvironmentName(e.Name)] = e.ID
		}
	}

	if plan.ProjectID == "" {
		project, err := c.CreateProject(api.CreateProjectParams{
			ProjectName:     m.Project,
			Region:          m.Cloud.Region,
			CloudIdentityID: plan.IdentityID,
			IacVersion:      m.IaC.Version,
			Environments:    m.EnvironmentSpecs(),
		})
		if err != nil {
			return nil, fmt.Errorf("create project %s: %w", m.Project, err)
		}
		result.ProjectID = project.ID
		result.createdProject = true
		result.Created = append(result.Created, "project "+m.Project)
		say(fmt.Sprintf("  %s created project %s", ui.SymbolSuccess, m.Project))
	} else {
		for _, e := range plan.Environments {
			if e.Action != ActionCreate {
				continue
			}
			env, err := findEnv(m, e.Name)
			if err != nil {
				return result, err
			}
			created, err := c.AddEnvironment(api.AddEnvironmentParams{
				Project:   plan.ProjectID,
				Name:      env.Name,
				Stage:     env.Stage,
				Placement: env.Placement,
				Namespace: env.Namespace,
				Lifecycle: env.Lifecycle,
			})
			if err != nil {
				return result, fmt.Errorf("add environment %s: %w", e.Name, err)
			}
			if created != nil && created.ID != "" {
				ids[names.NormalizeEnvironmentName(e.Name)] = created.ID
			}
			result.Created = append(result.Created, "environment "+e.Name)
			say(fmt.Sprintf("  %s created environment %s", ui.SymbolSuccess, e.Name))
		}
	}

	// Every environment is addressed by its ID from here on — each component add, PATCH and upsert,
	// each add-on enable and each deploy (#5583). The server resolves a NAME as name OR stage; a
	// server from before #5583 lets the default environment's stage beat another environment's exact
	// name, so a name can land in a different environment from the one the plan diffed. An id has
	// one meaning everywhere. Ids come from the plan's read for existing environments and from
	// AddEnvironment's response for ones created above; the environment list is read back once, and
	// only when an id is still missing (a project created with a matrix returns the project, not its
	// environments), so a no-op apply does not pay for the read.
	if err := fillEnvironmentIDs(c, result.ProjectID, plan.Environments, ids); err != nil {
		return result, err
	}
	envID := func(name string) string { return ids[names.NormalizeEnvironmentName(name)] }

	// What was refused in each environment, by kind, so the "not deployed" line names the right one.
	refused := map[string]*refusedKinds{}
	// firstRefusal is the first refusal as the server made it. Its class is the class of the
	// command's failure when anything was refused.
	var firstRefusal error
	for _, e := range plan.Environments {
		for _, comp := range e.Components {
			label := componentLabel(comp)
			switch comp.Action {
			case ActionUnchanged, designfile.ActionOmitted, designfile.ActionRemove:
				// Unchanged is left as it is. The other two are never in a plan, and if one ever
				// were it would be left alone too: apply creates and updates, and deletes nothing.
				continue
			case ActionCreate:
				if _, err := c.AddComponent(result.ProjectID, comp.Kind, comp.Name, envID(e.Name), comp.Fields); err != nil {
					return result, fmt.Errorf("%s/%s: %w", e.Name, comp.Kind, err)
				}
			case ActionUpdate:
				// ONLY the fields that changed are sent, for every kind. A named component is
				// PATCHED; a singleton has no name to address, so it goes through the add route,
				// whose ON CONFLICT arm sets exactly the keys it is given. Re-sending an unchanged
				// field is not harmless: the cluster's one-writer rule turns a re-sent `node_size`
				// into `instance_types: []`, clearing a field the file never touched.
				//
				// Both carry the revision the plan read as If-Match (#5551): the diff was computed
				// against THAT copy, so it may only land on that copy.
				changed := changedFields(comp.Changes)
				var err error
				if comp.Name != "" {
					_, err = c.UpdateComponent(result.ProjectID, comp.Kind, comp.Name, envID(e.Name), changed, comp.Revision)
				} else {
					_, err = c.UpsertComponent(result.ProjectID, comp.Kind, envID(e.Name), changed, comp.Revision)
				}
				if err != nil {
					// The refusal belongs to THIS component. Recorded and reported, and the
					// environment is held back from its deploy; the other environments carry on.
					why := componentUpdateRefusal(comp, err)
					refusedIn(refused, e.Name).component = true
					if firstRefusal == nil {
						firstRefusal = err
					}
					result.Errors = append(result.Errors, ComponentError{Environment: e.Name, Component: label, Error: why})
					say(fmt.Sprintf("  %s %s in %s was not updated: %s", ui.ErrorStyle.Render(ui.SymbolError), label, e.Name, why))
					continue
				}
			}
			result.Created = append(result.Created, e.Name+" "+label)
			say(fmt.Sprintf("  %s %s %s in %s", ui.SymbolSuccess, pastOf(comp.Action), label, e.Name))
		}
	}

	// Add-ons after components and before any deploy, so the deploy ships them. A refusal is held
	// like a component update's: recorded, the environment is not deployed, the others carry on.
	for _, e := range plan.Environments {
		for _, a := range e.Addons {
			if a.Action == ActionUnchanged {
				continue
			}
			label := "addon/" + a.ID
			req := a.Request
			req.Project = result.ProjectID
			req.Env = envID(e.Name)
			if err := c.EnableAddon(req); err != nil {
				refusedIn(refused, e.Name).addon = true
				if firstRefusal == nil {
					firstRefusal = err
				}
				result.Errors = append(result.Errors, ComponentError{Environment: e.Name, Component: label, Error: err.Error()})
				say(fmt.Sprintf("  %s %s in %s was not applied: %v", ui.ErrorStyle.Render(ui.SymbolError), label, e.Name, err))
				continue
			}
			result.Created = append(result.Created, e.Name+" "+label)
			verb := "enabled"
			if a.Action == ActionUpdate {
				verb = "updated"
			}
			say(fmt.Sprintf("  %s %s %s in %s", ui.SymbolSuccess, verb, label, e.Name))
		}
	}

	if err := deployEnvironments(ctx, c, p, plan, result, deployRun{
		runnerID: runnerID, envID: envID, refused: refused, wait: wait,
	}); err != nil {
		return result, err
	}
	if len(result.Errors) > 0 {
		lines := make([]string, len(result.Errors))
		for i, ce := range result.Errors {
			lines[i] = fmt.Sprintf("%s %s: %s", ce.Environment, ce.Component, ce.Error)
		}
		// A copy of the first refusal as the server classified it, under the sentence that lists
		// them all: a conflict stays a conflict (7) and a plan limit stays a plan limit (10).
		e := *clierr.From(firstRefusal)
		e.Message = fmt.Sprintf("%s not updated:\n  - %s",
			plural(len(result.Errors), "component"), strings.Join(lines, "\n  - "))
		if e.Hint == "" {
			e.Hint = "alethia plan   then apply again"
		}
		return result, &e
	}
	return result, nil
}

// deployRun is what the deploy half of an apply needs beside the plan: the runner, each
// environment's id, what was refused before it, and how to wait.
type deployRun struct {
	runnerID string
	envID    func(name string) string
	refused  map[string]*refusedKinds
	wait     waitFlags
}

// deployEnvironments deploys every environment the plan deploys, in file order, and follows each
// to its end when the run waits. Each job is added to result as soon as it is queued, so a wait
// that fails or times out still leaves the job named.
//
// A deploy applies a reviewed plan (decision M23), so each environment is previewed first: a PLAN
// job for the same environment and runner, waited for even under --no-wait, whose change counts are
// printed on stderr. The DEPLOY then names that plan. When the control plane answers that the
// deploy needs a person's approval, an approval is asked for the plan and waited for (approve.go);
// under --no-wait or in agent mode each environment's approval is asked for, nothing waits, and the
// run ends exit 9 naming every approval and the command that deploys each plan once approved.
//
// The deadline is over the whole run, not per job: `--timeout 30m` is thirty minutes from the
// first preview, however many environments there are.
func deployEnvironments(ctx context.Context, c applyClient, p *Printer, plan *ApplyPlan, result *ApplyResult, run deployRun) error {
	var deadline time.Time
	if run.wait.Timeout > 0 {
		deadline = time.Now().Add(run.wait.Timeout)
	}
	remaining := func() time.Duration {
		if deadline.IsZero() {
			return 0
		}
		// Never zero, which would mean "no deadline": a deadline that has already passed still
		// has to end the wait.
		return max(time.Until(deadline), time.Nanosecond)
	}
	var pending []string
	for _, e := range plan.Environments {
		if e.Deploy && run.refused[names.NormalizeEnvironmentName(e.Name)] == nil {
			pending = append(pending, e.Name)
		}
	}
	var awaiting []*clierr.Error
	for _, e := range plan.Environments {
		if !e.Deploy {
			continue
		}
		if r := run.refused[names.NormalizeEnvironmentName(e.Name)]; r != nil {
			fmt.Fprintln(p.Err, ui.MutedStyle.Render(fmt.Sprintf("  %s not deployed: %s", e.Name, r.sentence())))
			continue
		}
		pending = pending[1:]
		params := api.QueueJobParams{
			JobType: string(types.JobTypeDeploy), ConfigurationID: result.ProjectID, EnvironmentID: run.envID(e.Name),
		}
		if run.runnerID != "" {
			params.AssignedRunnerID = run.runnerID
		}
		planID, err := previewEnvironment(ctx, c, p, e.Name, params, remaining())
		if err != nil {
			return deployWaitError(err, e.Name, run.wait.Timeout, pending)
		}
		params.PlanJobID = planID
		rerun := fmt.Sprintf("alethia project deploy --project %s --env %s --plan-job-id %s --yes",
			plan.Manifest.Project, e.Name, planID)
		job, err := queueWithApproval(ctx, p, c, api.ApprovalOperationDeploy,
			func() (string, error) { return planID, nil },
			approvalWait{NoWait: !run.wait.Wait, Timeout: remaining(), Rerun: "run " + rerun},
			func(approvalID string) (*api.ProvisionJob, error) {
				queued := params
				queued.ApprovalID = approvalID
				return c.QueueJobWithParams(queued)
			})
		if err != nil {
			if ce := clierr.From(err); ce.Code == clierr.CodeApprovalRequired && !run.wait.Wait {
				// Not waiting: every environment's approval is asked for before the run ends.
				awaiting = append(awaiting, ce)
				continue
			}
			return fmt.Errorf("deploy %s: %w", e.Name, err)
		}
		result.Jobs = append(result.Jobs, projectJobEntry{
			ID: job.ID, Type: params.JobType, Status: job.Status, Environment: e.Name, Warnings: []string{},
		})
		entry := &result.Jobs[len(result.Jobs)-1]
		// A deploy held for an approval is said to wait on a person, with the page to approve it
		// at. Any other is named only when it is about to be followed: a run that does not wait
		// names every job in its result.
		if awaitsApproval(job.Status) {
			announceQueuedJob(p, c, entry)
		}
		if !run.wait.Wait {
			continue
		}
		if !entry.AwaitingApproval {
			fmt.Fprintf(p.Err, "%s Deploying %s (job %s)\n", ui.MutedStyle.Render(ui.SymbolPoint), e.Name, job.ID)
		}
		done, err := awaitJob(ctx, c, job.ID, waitOptions{JobType: params.JobType, Progress: p, Timeout: remaining()})
		if err != nil {
			return deployWaitError(err, e.Name, run.wait.Timeout, pending)
		}
		entry.Status = done.Status
		entry.AwaitingApproval = false
		// awaitJob has already said them on stderr; the result carries them for a program.
		entry.Warnings = jobWarnings(done)
	}
	return approvalsAwaited(awaiting)
}

// previewEnvironment queues the PLAN a deploy of one environment applies, waits for it (bounded by
// timeout when it is set), prints its change counts on stderr, and returns its id. A plan that does
// not succeed is an error naming the PLAN job, classified as its wait ended.
func previewEnvironment(ctx context.Context, c applyClient, p *Printer, env string, deploy api.QueueJobParams, timeout time.Duration) (string, error) {
	params := deploy
	params.JobType = string(types.JobTypePlan)
	job, err := c.QueueJobWithParams(params)
	if err != nil {
		return "", fmt.Errorf("preview %s: %w", env, err)
	}
	fmt.Fprintf(p.Err, "%s Previewing %s (job %s); a deploy applies a reviewed plan\n",
		ui.MutedStyle.Render(ui.SymbolPoint), env, job.ID)
	done, err := awaitJob(ctx, c, job.ID, waitOptions{JobType: params.JobType, Timeout: timeout})
	if err != nil {
		return "", fmt.Errorf("the preview of %s (PLAN job %s) did not finish successfully, so it was not deployed: %w",
			env, job.ID, err)
	}
	if changes := planChangeSummary(done.ExecutionMetadata); changes != "" {
		fmt.Fprintf(p.Err, "  %s %s\n", env, changes)
	}
	return job.ID, nil
}

// approvalsAwaited is how a run that did not wait for approvals ends: nil when none was asked for,
// the one refusal when one was, and one exit-9 error naming every approval when several were.
func approvalsAwaited(awaiting []*clierr.Error) error {
	switch len(awaiting) {
	case 0:
		return nil
	case 1:
		return awaiting[0]
	}
	messages := make([]string, len(awaiting))
	hints := make([]string, len(awaiting))
	for i, a := range awaiting {
		messages[i] = a.Message
		hints[i] = a.Hint
	}
	e := clierr.New(clierr.CodeApprovalRequired, fmt.Sprintf("%d deploys are waiting for a person's approval:\n  - %s",
		len(awaiting), strings.Join(messages, "\n  - ")))
	e.Hint = strings.Join(hints, "\n  ")
	e.Operation = awaiting[0].Operation
	return e
}

// deployWaitError says which environment's deploy ended the wait, and what that leaves undone. A
// timeout names the deadline the person gave rather than what was left of it for this job, and any
// ending names the environments whose deploy was therefore never queued.
func deployWaitError(err error, env string, timeout time.Duration, notQueued []string) error {
	e := *clierr.From(fmt.Errorf("deploy %s: %w", env, err))
	if e.Class == clierr.ClassWaitTimeout && e.Operation != nil {
		e.Message = fmt.Sprintf("timed out after %s waiting for the deploy of %s (job %s); it is still running",
			timeout, env, e.Operation.ID)
	}
	if len(notQueued) > 0 {
		e.Message += fmt.Sprintf(". Not deployed, because the deploys run in order: %s. Run `alethia apply` again once %s is up",
			strings.Join(notQueued, ", "), env)
	}
	return &e
}

// fillEnvironmentIDs completes ids — normalised environment name to id — for every environment the
// plan declares, reading the project's environments back once when any is missing (one this run
// created). An environment the server still does not list is refused BEFORE anything is written
// into it: there is no id to address it by, and a name could resolve to another environment.
func fillEnvironmentIDs(c applyClient, projectID string, envs []EnvPlan, ids map[string]string) error {
	missing := false
	for _, e := range envs {
		if ids[names.NormalizeEnvironmentName(e.Name)] == "" {
			missing = true
		}
	}
	if !missing {
		return nil
	}
	listed, err := c.ListEnvironments(projectID)
	if err != nil {
		return fmt.Errorf("list environments: %w", err)
	}
	for _, env := range listed {
		key := names.NormalizeEnvironmentName(env.Name)
		if ids[key] == "" {
			ids[key] = env.ID
		}
	}
	for _, e := range envs {
		if ids[names.NormalizeEnvironmentName(e.Name)] == "" {
			return fmt.Errorf("environment %s was declared but the server does not list it after apply", e.Name)
		}
	}
	return nil
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
	applyCmd.Flags().Bool(applyFlagWait, true,
		"Wait for the deploys to finish. This is the default; --wait=false is the same as --no-wait")
	planBinder = spec.RegisterFlags(planCmd, planSpec)
	rootCmd.AddCommand(applyCmd)
	rootCmd.AddCommand(planCmd)
}
