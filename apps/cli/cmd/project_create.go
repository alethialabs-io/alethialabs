// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/manifest"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/names"
	"github.com/spf13/cobra"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/spec"
)

// projectCreateSpec is what `project create` takes from a person, declared ONCE and rendered four
// ways: the flags below are generated from it, the form reads its titles and descriptions, the
// manifest keys are its ManifestKey column, and the docs table on project.mdx is generated from it.
//
// This is the command the programme was started over, and the first consumer of the kit. Before it,
// the seven flag usages were hand-typed here while the form's questions were hand-typed in the
// prompt helpers below — two lists nothing compared.
//
// The literal is DATA ONLY, which is measured rather than stylistic: see the pkg/spec package doc.
// docsProjectPage is the reference page `project create`'s field table lives on. It is the one big
// command that had NO fieldspec marker at all — its flag table on project.mdx was hand-written and
// outside every guard.
const docsProjectPage = "apps/docs/content/docs/cli/commands/project.mdx"

var projectCreateSpec = spec.Spec{
	Command: "alethia project create",
	Fields: []spec.Field{
		{Command: "alethia project create", Key: "name", Title: "Project name",
			Description: "What to call the project", Arg: "[name]", Required: true,
			ManifestKey: "project", Page: docsProjectPage},
		{Command: "alethia project create", Key: "region", Title: "Region",
			Description: "Cloud region to provision into (asked for on a terminal when omitted)",
			Flag:        "region", Required: true, EnvVar: "ALETHIA_REGION",
			ManifestKey: "cloud.region", Page: docsProjectPage},
		{Command: "alethia project create", Key: "account", Title: "Cloud account",
			Description: "Cloud account to link, by its LABEL or its id (asked for on a terminal when omitted)",
			Flag:        "cloud-account", Selector: "label", ManifestKey: "cloud.account", Page: docsProjectPage},
		{Command: "alethia project create", Key: "stage", Title: "Stage",
			Description: "Initial environment stage", Flag: "stage",
			Default: string(stageDevelopment), Options: "stages",
			ManifestKey: "stage", Page: docsProjectPage},
		{Command: "alethia project create", Key: "iac-version", Title: "OpenTofu version",
			Description: "OpenTofu version to pin (defaults server-side)", Flag: "iac-version",
			ManifestKey: "iac.version", Page: docsProjectPage},
		{Command: "alethia project create", Key: "placement", Title: "Placement",
			Description: "Placement of the default environment (default dedicated)",
			Flag:        "placement-mode", Options: "placements",
			ManifestKey: "placement", Page: docsProjectPage},
		{Command: "alethia project create", Key: "file", Title: "Manifest",
			Description: "alethia.yaml to take the values and the environment matrix from (the one in the current directory when present)",
			Flag:        "file", Shorthand: "f", Page: docsProjectPage},
	},
	// Derived from the generated enums rather than listed, so a new stage or placement mode reaches
	// the flag help, the refusal message and the docs table together.
	Options: map[string][]string{
		"stages":     environmentStages(),
		"placements": placementModes(),
	},
}

// projectCreateBinder holds the flag targets projectCreateSpec generated. Set in init().
var projectCreateBinder *spec.Binder

// projectCreatePrompt is the form adapter used by the shared resolver. It is a seam so command
// tests can answer a field by key; huh owns the destination pointer inside askLine, so merely
// stubbing the form runner can open an input but cannot supply its value.
var projectCreatePrompt = defaultProjectCreatePrompt

// defaultProjectCreatePrompt renders one unresolved project-create field through the existing
// project forms. Optional fields return an empty answer and fall through to their defaults.
func defaultProjectCreatePrompt(f spec.Field, token string) (string, error) {
	switch f.Key {
	case "name":
		return promptProjectName()
	case "region":
		return promptRegion()
	case "account":
		id, _ := selectCloudIdentity(token)
		return id, nil
	}
	return "", nil
}

// This is the command the programme was started over. The complaint, verbatim:
//
//	alethia project create boutique \
//	  --region <your-region> --cloud-identity-id <your-identity-id> \
//	  --env prod:production:dedicated \
//	  --env dev-1:development:namespace:boutique-dev-1
//
// A four-field colon tuple typed three times, with two opaque ids copied out of other
// commands' output. Three things changed, and the tuple and the id flag are GONE rather than
// kept beside their replacements:
//
//   - the environment matrix comes from `alethia.yaml` — or is ASKED FOR, one environment at
//     a time, from pickers built out of the generated enums, and the file those answers add
//     up to is printed back, so the answer to "what do I commit to my repo" is on screen;
//   - `--cloud-account` takes the account's LABEL (or its id), so the identity id never has to
//     be copied out of `alethia connector list`;
//   - a mis-typed rung or stage is refused HERE, against the same generated enum the
//     server's zod enum is generated from, instead of coming back as an opaque 400.
//
// What did not change: every question has a non-interactive answer, so `--no-input` still
// drives the whole command. TestHygCliProject_EveryLeafThatAsksCanBeScripted holds that.

var projectCreateCmd = &cobra.Command{
	Use:   "create [name]",
	Short: "Create a new project",
	Long: `Create a new project (an infrastructure app) in the active organization.

Pass --region and --cloud-account, or omit them on a terminal to be asked. The environment
matrix — every environment and how it is placed — comes from alethia.yaml when there is one
(--file, or the file in the current directory); omit it on a terminal and each environment is
asked for in turn, then printed back as the alethia.yaml that would produce the same project.

To create the project AND deploy it from the file in one step, use "alethia apply".`,
	Args: cobra.MaximumNArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		client := api.NewClient(token)
		b := projectCreateBinder

		// The positional is seeded as if it were a flag, so the resolver cannot tell
		// `project create boutique` and a `--name boutique` apart: both are the most explicit
		// thing the person did and must win the same rung.
		if len(args) == 1 {
			b.SetArg("name", strings.TrimSpace(args[0]))
		}

		m, manifestPath, err := manifestForCreate(b)
		if err != nil {
			fail(err)
		}

		// The form is a source like any other, and the kit asks it only for what the flags, the
		// environment and the manifest left unset — in the ruled order. `ask` is
		// canPromptForm()'s answer through promptsEnabled(); a nil Prompt IS --no-input, so
		// there is no second predicate here and the hygiene guard that forbids one stays happy.
		src := spec.Sources{Env: os.LookupEnv, Manifest: m.Lookup}
		if promptsEnabled() {
			src.Prompt = func(f spec.Field) (string, error) {
				return projectCreatePrompt(f, token)
			}
		}

		values, err := spec.Resolve(b, src)
		if err != nil {
			// A MissingError names EVERY unresolved required field rather than the first, which
			// is what a scripted run needs: one round trip, not one per flag. The region is the
			// field that makes this matter — it is required and has no server-side default, so
			// before the kit a scripted run with no --region sent an empty region and the server
			// answered "Invalid request body".
			fail(err)
		}

		name := values.Get("name")
		region := values.Get("region")
		accountRef := values.Get("account")
		asked := values.Asked()

		identity, err := resolveCloudIdentityID(client, accountRef)
		if err != nil {
			fail(err)
		}

		// The matrix is the one thing the flags cannot say: it is a list of records, and a flag
		// is a scalar. So it comes from the file, or from the form, or the server creates its
		// default pair.
		var environments []api.EnvironmentSpec
		matrixAsked := false
		// fileRef is the path only when the file is what SUPPLIED the matrix, so the replay names
		// `--file` exactly when running the line without it would produce a different project.
		fileRef := ""
		if m != nil && len(m.Environments) > 0 {
			environments = m.EnvironmentSpecs()
			fileRef = manifestPath
		} else if promptsEnabled() {
			if environments, err = promptEnvMatrix(
				"Otherwise the server creates its default Production + Preview pair"); err != nil {
				fail(err)
			}
			matrixAsked = len(environments) > 0
		}

		params := api.CreateProjectParams{
			ProjectName:     name,
			Region:          region,
			CloudIdentityID: identity,
			Stage:           values.Get("stage"),
			IacVersion:      values.Get("iac-version"),
			Placement:       values.Get("placement"),
			Environments:    environments,
		}
		// `--stage` and `--placement-mode` describe the DEFAULT environment, and a matrix's first
		// entry IS the default environment, so when only one of them speaks the matrix is the more
		// specific statement and the top-level fields are taken from it. That keeps a form-declared
		// matrix and a file-declared one putting the same bytes on the wire.
		//
		// AN EXPLICIT FLAG STILL WINS, which the first cut got wrong: it took the matrix
		// unconditionally, so `--file x.yaml --stage production` sent `development` because that is
		// what `environments[0]` said — silently, and contradicting project.mdx's own "a flag
		// overrides the file for one run". The resolver already records WHERE each value came from,
		// which is what `Origin` is for, so the question is answerable rather than guessable.
		if len(environments) > 0 {
			if values.Origin("stage") != spec.FromFlag {
				params.Stage = environments[0].Stage
			}
			if values.Origin("placement") != spec.FromFlag {
				params.Placement = environments[0].PlacementMode
			}
		}
		if err := runProjectCreate(client, os.Stdout, outputFormat(cmd), params); err != nil {
			failf("Failed to create project: %v", err)
		}
		if matrixAsked {
			printManifestReplay(os.Stdout, outputFormat(cmd), params, accountRef)
			return
		}
		printReplay(os.Stdout, outputFormat(cmd), asked, createReplayArgs(params, accountRef, fileRef)...)
	},
}

// manifestForCreate finds the manifest `project create` reads: --file when passed (and then it
// must exist), else alethia.yaml in the current directory when there is one, else nothing.
//
// It is normalised and validated here, with no component schema — `project create` creates the
// project and its environments and leaves components to `alethia apply`, so the only rules that
// apply are the ones the create route itself enforces.
// It returns the PATH it read alongside the manifest, because the replay line has to name it:
// a run whose matrix came from a file and whose name was asked for prints "same result, without
// the questions" over a command with no --file in it, which reproduces the server's default
// environment pair instead of the file's matrix.
func manifestForCreate(b *spec.Binder) (*manifest.Manifest, string, error) {
	path, _ := b.String("file")
	explicit := path != ""
	if path == "" {
		found, ok := manifest.Find(".")
		if !ok {
			return nil, "", nil
		}
		path = found
	}
	m, err := manifest.Load(path)
	if err != nil {
		return nil, "", err
	}
	m.Normalize()
	// RequireDedicated: `project create` is the front door that brings a project's first Fabric
	// into being, which is exactly the case the server applies that rule to.
	if err := m.Validate(manifest.Rules{
		Stages:           environmentStages(),
		Placements:       placementModes(),
		RequireDedicated: true,
	}); err != nil {
		if !explicit {
			// A file nobody asked for, refused. Saying so is the difference between "your command
			// is wrong" and "the directory you ran in holds a broken file" — a scripted caller
			// that never passed `--file` would otherwise read this as a defect in its invocation.
			return nil, "", fmt.Errorf("%s in this directory was read because no --file was given, and it cannot be used: %w", path, err)
		}
		return nil, "", err
	}
	return m, path, nil
}

// createReplayArgs renders the `project create` that would have produced this project.
//
// It takes the SENT params rather than a hand-picked subset of them, because a replay line is
// only worth printing if running it reproduces the run: --stage, --placement-mode and
// --iac-version each change the project that comes out, and a line that dropped them invited
// the reader to commit a command that creates a `development` project on the server's default
// placement with an unpinned OpenTofu version.
//
// It prefers the LABEL the caller (or the picker) used over the resolved identity id, because a
// replay line carrying a UUID is the thing this command exists to stop printing. The id appears
// only when that is all we have — the picker returns one — and `--cloud-account` takes it too.
func createReplayArgs(params api.CreateProjectParams, accountRef, fileRef string) []string {
	args := []string{"alethia", "project", "create", params.ProjectName}
	if fileRef != "" {
		// The matrix came from the file, and a list of records has no flag spelling — so a replay
		// line without it reproduces the SERVER's default environment pair, not the project that
		// was just made. `--file` is named even when it is the discovered ./alethia.yaml, because
		// the line is meant to be pasted into a script that runs in some other directory.
		args = append(args, "--file", fileRef)
	}
	if params.Region != "" {
		args = append(args, "--region", params.Region)
	}
	switch {
	case accountRef != "":
		args = append(args, "--cloud-account", accountRef)
	case params.CloudIdentityID != "":
		args = append(args, "--cloud-account", params.CloudIdentityID)
	}
	if params.Stage != "" {
		args = append(args, "--stage", params.Stage)
	}
	if params.Placement != "" {
		args = append(args, "--placement-mode", params.Placement)
	}
	if params.IacVersion != "" {
		args = append(args, "--iac-version", params.IacVersion)
	}
	return args
}

// manifestFromCreate renders the create that just ran as the alethia.yaml that reproduces it.
//
// This is the replay for a run that declared a matrix through the form: a list of records has no
// flag spelling, so the thing a person commits is the file, and `alethia apply` reads it.
func manifestFromCreate(params api.CreateProjectParams, accountRef string) *manifest.Manifest {
	account := accountRef
	if account == "" {
		account = params.CloudIdentityID
	}
	return &manifest.Manifest{
		Project:      params.ProjectName,
		Cloud:        manifest.Cloud{Account: account, Region: params.Region},
		IaC:          manifest.IaC{Version: params.IacVersion},
		Environments: manifest.FromEnvironmentSpecs(params.Environments),
	}
}

// printManifestReplay prints the file a form-declared matrix adds up to, under the same
// conditions printReplay applies: only after questions were asked, and only on human output.
func printManifestReplay(out io.Writer, format string, params api.CreateProjectParams, accountRef string) {
	if format != ui.FormatTable {
		return
	}
	data, err := manifest.Render(manifestFromCreate(params, accountRef))
	if err != nil {
		return
	}
	fmt.Fprintln(out, ui.MutedStyle.Render("Same result, without the questions — save this as "+manifest.FileName+" and run `alethia apply`:"))
	for _, line := range strings.Split(strings.TrimRight(string(data), "\n"), "\n") {
		fmt.Fprintln(out, ui.MutedStyle.Render("  "+line))
	}
}

// promptEnvMatrix asks for the environment matrix one environment at a time and returns it as
// the wire shape — the same shape a manifest's environments render to, so the form and the file
// are one spec with two entry points rather than two grammars.
//
// declineNote says what NOT declaring a matrix leaves you with, and it is a parameter because the
// two callers give different answers. `project create` posts no environments and the server seeds
// its Production + Preview pair; `up` writes a manifest whose fallback is one environment at the
// chosen stage, and `apply` then creates exactly that. Sharing one sentence meant `up` promised a
// preview environment it never created.
func promptEnvMatrix(declineNote string) ([]api.EnvironmentSpec, error) {
	if err := requireInteractiveForm(); err != nil {
		return nil, err
	}
	declare, err := askYesNo("Declare the environment matrix now?", declineNote)
	if err != nil {
		return nil, err
	}
	if !declare {
		return nil, nil
	}

	var specs []api.EnvironmentSpec
	seen := map[string]bool{}
	for {
		a := envAnswers{}
		if err := askEnvironmentSpec(&a, len(specs) == 0); err != nil {
			return nil, err
		}
		// Reported while the person is still answering rather than after the last question,
		// against the same normalisation the server's uniqueness applies.
		key := names.NormalizeEnvironmentName(a.Name)
		if seen[key] {
			return nil, fmt.Errorf("the matrix lists %q twice", a.Name)
		}
		seen[key] = true
		specs = append(specs, envSpecFrom(a, len(specs) == 0))

		var summary []string
		for _, s := range specs {
			summary = append(summary, fmt.Sprintf("%s (%s, %s)", s.Name, s.Stage, s.PlacementMode))
		}
		more, err := askYesNo("Add another environment?", "So far: "+strings.Join(summary, "  "))
		if err != nil {
			return nil, err
		}
		if !more {
			return specs, nil
		}
	}
}

// promptProjectName asks for the project's name when it was not passed as the argument.
func promptProjectName() (string, error) {
	if err := requireInteractiveForm(); err != nil {
		return "", err
	}
	name, err := askLine("Project name", "The app this infrastructure belongs to, e.g. boutique")
	if err != nil {
		return "", err
	}
	if name == "" {
		return "", fmt.Errorf("a project name is required")
	}
	return name, nil
}

// promptRegion asks for the project's region when it wasn't passed (TTY only).
//
// An empty answer is NOT refused here the way an empty project name is: the server's own
// error for a missing region names the field, and refusing locally would turn a dismissed
// form into a message about a flag the person was in the middle of answering.
func promptRegion() (string, error) {
	if err := requireInteractiveForm(); err != nil {
		return "", err
	}
	return askLine("Region", "The cloud region to provision into (e.g. eu-west-1)")
}

// runProjectCreate creates the project and renders it as a card (non-interactive path).
func runProjectCreate(c apiClient, out io.Writer, format string, params api.CreateProjectParams) error {
	project, err := c.CreateProject(params)
	if err != nil {
		return err
	}
	return renderProjectCard(out, format, project)
}

// renderProjectCard renders a single project as a Field/Value card (table/csv) or the typed
// object (json).
func renderProjectCard(out io.Writer, format string, p *api.Project) error {
	provider := ui.SymbolDash
	if p.CloudProvider != "" {
		provider = strings.ToUpper(p.CloudProvider)
	}
	rows := [][]string{
		{"Project", p.ProjectName},
		{"Slug", ui.OrDash(p.Slug)},
		{"Status", p.Status},
		{"Provider", provider},
		{"Region", p.Region},
		{"Env", p.EnvironmentStage},
		{"IaC", p.IacVersion},
		{"ID", p.ID},
	}
	return ui.RenderCard(out, format, "alethia · project", rows, p)
}

func init() {
	// The seven hand-written registrations these replace each repeated a usage string the form also
	// held, in a different file, with nothing comparing them. Generating them makes "anything a form
	// can ask, a flag can set" true by construction rather than by assertion.
	projectCreateBinder = spec.RegisterFlags(projectCreateCmd, projectCreateSpec)
	projectCmd.AddCommand(projectCreateCmd)
}
