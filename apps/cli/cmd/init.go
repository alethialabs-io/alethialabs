// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/clierr"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/manifest"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/spec"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/charmbracelet/huh"
	"github.com/spf13/cobra"
)

// initWebOrigin is `alethia init --web-origin`. The form asks exactly one thing,
// so exactly one flag answers it: the flags are a COMPLETE contract, and
// `alethia init --no-input --web-origin https://…` is the scripted equivalent of
// the guided run.
//
// Without it `init --no-input` silently kept whatever origin was already
// resolved. That is a reasonable default and a terrible contract — the one field
// the command exists to set was the one field a script could not set, so an
// unattended first run pointed at the hosted default no matter what it was told.
var initWebOrigin string

var initCmd = &cobra.Command{
	Use:   "init",
	Short: "Set up the CLI on this machine and write an alethia.yaml for this directory",
	Long: `Guided setup, in three steps. Each one is skipped when it is already done, so it is safe to
run again.

  1. the control-plane URL    the hosted alethialabs.io by default, or a self-hosted or dev URL
  2. the sign-in              a browser approval of a device code
  3. alethia.yaml             written when this directory has none

Use it to point the CLI at a control plane, or to add a manifest to a second directory. The
manifest is what "alethia apply" reads: the project, the cloud account by its label, and every
environment with its placement. Pass --file to write it somewhere else, or --skip-manifest to
do the machine setup alone.

Pass --web-origin to supply the URL without the prompt; with --no-input and no --web-origin the
already-resolved origin is kept. Every value the manifest needs is a flag too, so the command
runs unattended. With --output json the result is one document on stdout, and the sign-in must
already be done: run "alethia login" first, or set ALETHIA_TOKEN.

"alethia up" is this command and "alethia apply" together.`,
	Args: cobra.NoArgs,
	Run: func(cmd *cobra.Command, _ []string) {
		// Read for its refusal: an --output value that is not a format stops here, before
		// anything is written.
		_ = outputFormat(cmd)
		result, err := runInit(printer)
		if err != nil {
			fail(err)
		}
		firstRunEmit(result, func(w io.Writer) { renderInitResult(w, result) })
		if result.Action == ResultCreated {
			printer.Note("Next: `alethia apply`, or `alethia up`, which signs in, writes the file and applies it.")
		}
	},
}

// The kinds of thing `init` reports having set up.
const (
	initKindManifest = "manifest"
	initKindConfig   = "cli_config"
)

// InitObject is the record `init` reports: where the CLI now points, and the manifest it wrote
// or found. Every key is always present; the manifest fields are empty when none was read.
type InitObject struct {
	// WebOrigin is the control-plane URL the CLI is set to.
	WebOrigin string `json:"web_origin"`
	// Manifest is the path of the manifest, or "" with --skip-manifest.
	Manifest string `json:"manifest"`
	// Project, Region and CloudAccount are what a manifest written by this run declares.
	Project      string `json:"project"`
	Region       string `json:"region"`
	CloudAccount string `json:"cloud_account"`
	// Environments and Addons are the names it declares, in file order.
	Environments []string `json:"environments"`
	Addons       []string `json:"addons"`
}

// renderInitResult writes the one line a person reads on stdout for an init result.
func renderInitResult(w io.Writer, r MutationResult) {
	switch {
	case r.Kind == initKindConfig:
		fmt.Fprintln(w, ui.FormatSuccess("The CLI is set up for "+r.ID))
	case r.Action == ResultUnchanged:
		fmt.Fprintln(w, ui.FormatSuccess(r.ID+" already exists and was left as it is"))
	default:
		fmt.Fprintln(w, ui.FormatSuccess("Wrote "+r.ID))
	}
}

// originHint is the next step for a control-plane URL that could not be used.
const originHint = "pass a full URL, for example --web-origin " + types.DefaultWebOrigin

// runInit is `init`: the control-plane URL, the sign-in, and the manifest. It returns what was
// set up as a mutation result; its progress goes to p's Err stream.
func runInit(p *Printer) (MutationResult, error) {
	none := MutationResult{}
	origin, err := promptWebOrigin(initWebOrigin)
	if err != nil {
		if initWebOrigin == "" {
			// The form was dismissed. That is not a value to correct, so it is reported as it is.
			return none, err
		}
		return none, firstRunErr(clierr.CodeInvalidFlag, err, originHint)
	}
	if err := runConfigSet(p.Err, "web-origin", origin); err != nil {
		return none, firstRunErr(clierr.CodeValidationFailed, err, originHint)
	}
	// SKIPPED WHEN ALREADY DONE, like every other step of the golden path. Re-running `init`
	// to add a manifest to a second directory is the ordinary case, and opening a browser at
	// a machine that is already signed in makes the command something people avoid re-running
	// — which is exactly when a half-finished setup stays half-finished. `alethia login
	// --force` is how a person deliberately signs in again.
	if token, err := getAuthTokenInternal(false); err == nil && token != "" {
		firstRunStep(p, "Already signed in. `alethia login --force` signs in again")
	} else if p.Format != ui.FormatTable {
		// The sign-in prints its device code on stdout, where this run's document goes.
		e := clierr.New(clierr.CodeAuthRequired, fmt.Sprintf(
			"not signed in, and --output %s cannot run the sign-in: it prints a device code that "+
				"would corrupt the document", p.Format))
		e.Hint = "alethia login   (or set " + ServiceTokenEnv + " to a service token)"
		return none, e
	} else if err := performLoginFlow(); err != nil {
		return none, firstRunErr(clierr.CodeAuthRequired, err, "alethia login")
	}

	object := InitObject{WebOrigin: origin, Environments: []string{}, Addons: []string{}}
	if skip, _ := initBinder.Bool("skip-manifest"); skip {
		return MutationResult{ID: origin, Kind: initKindConfig, Action: ResultUpdated, Object: object}, nil
	}

	// The manifest is authored AFTER the login, and only then, because naming a cloud
	// account means reading the ones this identity has. An `init` that asked first would
	// have to ask for the account as free text and find out it was wrong at apply time.
	values, err := spec.Resolve(initBinder, spec.Sources{Env: os.LookupEnv})
	if err != nil {
		return none, err
	}
	path := values.Get("file")
	object.Manifest = path
	if manifest.Exists(path) {
		return MutationResult{ID: path, Kind: initKindManifest, Action: ResultUnchanged, Object: object}, nil
	}
	token, err := getAuthToken()
	if err != nil {
		return none, firstRunErr(clierr.CodeAuthRequired, err, "alethia login")
	}
	client := api.NewClient(token)
	// The resolved account is passed, not "": that is what turns `ensureCloudAccount` from a
	// count into a REFUSAL. With "" a mistyped `--cloud-account prod-acount` writes the typo
	// into alethia.yaml, prints a success line, and surfaces at the next `alethia apply` as
	// `cloud.account "prod-acount" not found` — one command away from the flag that caused it.
	// `up` has always passed its own value here; `init` writing the file is the same promise.
	if _, err := ensureCloudAccount(client, p, values.Get("account")); err != nil {
		return none, err
	}
	addons, err := initAddons(client)
	if err != nil {
		return none, err
	}
	m, err := authorManifest(client, token, path, values, addons...)
	if err != nil {
		return none, err
	}
	object.Project, object.Region, object.CloudAccount = m.Project, m.Cloud.Region, m.Cloud.Account
	for _, e := range m.Environments {
		object.Environments = append(object.Environments, e.Name)
	}
	for _, a := range addons {
		object.Addons = append(object.Addons, a.ID)
	}
	return MutationResult{ID: path, Kind: initKindManifest, Action: ResultCreated, Object: object}, nil
}

// initManifestSpec is what `init` takes for the manifest it authors. It is `up`'s subset, declared
// separately rather than shared because the two commands' flag SETS differ — `init` has nothing to
// apply, so it takes no runner and no confirmation — and a spec that served both would register
// flags on `init` that do nothing.
//
// Its Command is "alethia init manifest" and NOT "alethia init", although both register on the same
// cobra command. `init` takes values from two places — the auth group's field table owns the
// control-plane URL, this one owns the manifest — and the docs marker convention is one table per
// Command string. Two markers say which table is which; one would make the guard compare six rows
// against a one-field spec, which is what it did before this name existed.
var initManifestSpec = spec.Spec{
	Command: "alethia init manifest",
	Fields: []spec.Field{
		{Command: "alethia init manifest", Key: "file", Title: "Manifest",
			Description: "Where to write the manifest (default: ./" + manifest.FileName + ")",
			Flag:        "file", Shorthand: "f", Default: manifest.FileName, Page: docsCliInitPage},
		{Command: "alethia init manifest", Key: "project", Title: "Project name",
			Description: "Name for the project the manifest declares (asked for on a terminal when omitted)",
			Flag:        "project", ManifestKey: "project", Page: docsCliInitPage},
		{Command: "alethia init manifest", Key: "region", Title: "Region",
			Description: "Cloud region to provision into", Flag: "region",
			EnvVar: "ALETHIA_REGION", ManifestKey: "cloud.region", Page: docsCliInitPage},
		{Command: "alethia init manifest", Key: "account", Title: "Cloud account",
			Description: "Cloud account to link, by its LABEL or its id", Flag: "cloud-account",
			Selector: "label", ManifestKey: "cloud.account", Page: docsCliInitPage},
		{Command: "alethia init manifest", Key: "stage", Title: "Stage",
			Description: "Stage for the environment it declares", Flag: "stage",
			Default: string(stageDevelopment), Options: "stages",
			ManifestKey: "stage", Page: docsCliInitPage},
		{Command: "alethia init manifest", Key: fieldKeyInstanceType, Title: "Machine type",
			Description: instanceTypeDescription, Flag: fieldKeyInstanceType, Page: docsCliInitPage},
		{Command: "alethia init manifest", Key: fieldKeyNodeSize, Title: "Node size",
			Description: nodeSizeDescription, Flag: fieldKeyNodeSize, Page: docsCliInitPage},
		{Command: "alethia init manifest", Key: "addon", Title: "Add-ons",
			Description: "Catalog add-on for the first environment: an id, or id@version to pin it (repeatable; asked for on a terminal when omitted)",
			Flag:        "addon", Repeated: true, Page: docsCliInitPage},
		{Command: "alethia init manifest", Key: "skip-manifest", Title: "Machine setup only",
			Description: "Set up the CLI without writing a manifest",
			Flag:        "skip-manifest", Bool: true, Page: docsCliInitPage},
	},
	Options: map[string][]string{"stages": environmentStages()},
}

// docsCliInitPage is the page `init`'s field table lives on.
const docsCliInitPage = "apps/docs/content/docs/reference/cli/init.mdx"

// initBinder holds the flag targets initManifestSpec generated. Set in init().
var initBinder *spec.Binder

// initAddons is the add-ons `init` writes into the new file's first environment (#5528): the
// --addon flags, or — on a terminal with none given — the ones picked from the catalog. Each entry is
// checked against the server's catalog before anything is written, so a mistyped id or a version
// range is refused here rather than at the first `alethia apply`.
//
// Neither path fetches anything when no add-on is wanted: `init --no-input` without --addon reads
// no catalog and writes a file with no `addons:` key, exactly as before.
func initAddons(c applyClient) ([]manifest.Addon, error) {
	flags, _ := initBinder.Strings("addon")
	if len(flags) == 0 && !canPromptForm() {
		return nil, nil
	}
	catalog, err := c.GetAddonCatalog()
	if err != nil {
		return nil, err
	}
	if len(flags) == 0 {
		flags, err = promptInitAddons(catalog)
		if err != nil {
			return nil, err
		}
	}
	addons, err := parseInitAddons(flags)
	if err != nil {
		return nil, firstRunErr(clierr.CodeInvalidFlag, err, "")
	}
	if err := manifest.ValidateAddons("--addon", addons, catalog, addonModeValues()); err != nil {
		return nil, firstRunErr(clierr.CodeValidationFailed, err,
			"leave --addon out on a terminal to pick from the catalog")
	}
	return addons, nil
}

// parseInitAddons reads `--addon <id>[@<version>]` values. `id@` with nothing after it is refused:
// omitting the version is how to ask for the catalog default, so an empty one is a typo.
func parseInitAddons(values []string) ([]manifest.Addon, error) {
	out := make([]manifest.Addon, 0, len(values))
	for _, raw := range values {
		id, version, pinned := strings.Cut(strings.TrimSpace(raw), "@")
		id = strings.TrimSpace(id)
		if id == "" {
			return nil, fmt.Errorf("--addon %q: an add-on needs its catalog id, e.g. --addon cert-manager", raw)
		}
		a := manifest.Addon{ID: id}
		if pinned {
			version = strings.TrimSpace(version)
			if version == "" {
				return nil, fmt.Errorf("--addon %q: nothing after @ — give a version (%s@1.15.0) or leave the @ out for the catalog default", raw, id)
			}
			a.Version = &version
		}
		out = append(out, a)
	}
	return out, nil
}

// promptInitAddons asks which catalog add-ons the first environment runs. None is a valid answer.
func promptInitAddons(catalog *api.AddonCatalogDocument) ([]string, error) {
	field, _ := initManifestSpec.Field("addon")
	options := make([]huh.Option[string], 0, len(catalog.Addons))
	for _, id := range catalog.IDs() {
		options = append(options, huh.NewOption(id, id))
	}
	var picked []string
	err := runHuhForm(huh.NewGroup(
		huh.NewMultiSelect[string]().
			Title(field.Title).
			Description("Optional — the first environment runs these. Pin a version with --addon <id>@<version>, or edit alethia.yaml.").
			Options(options...).
			Value(&picked),
	))
	if err != nil {
		return nil, err
	}
	return picked, nil
}

// promptWebOrigin resolves the control-plane URL `init` should persist.
//
// Three arms, in precedence order, and the order is the point: an explicitly
// supplied --web-origin wins over everything (validated here so a typo is
// reported before the browser opens), --no-input keeps the already-resolved
// origin rather than guessing, and an interactive run edits the current value in
// a form that validates with the SAME normalizeWebOrigin `config set` gates on.
func promptWebOrigin(flagValue string) (string, error) {
	if flagValue != "" {
		return normalizeWebOrigin(flagValue)
	}
	current, _ := types.ResolveWebOrigin()
	if !canPromptForm() {
		return current, nil
	}
	origin := current
	if origin == "" {
		origin = types.DefaultWebOrigin
	}
	spec := mustAuthField("alethia init", fieldKeyWebOrigin)
	err := runHuhForm(
		huh.NewGroup(
			huh.NewInput().
				Title(spec.Title).
				Description(spec.Description).
				Value(&origin).
				Validate(func(s string) error { _, err := normalizeWebOrigin(s); return err }),
		),
	)
	if err != nil {
		return "", err
	}
	return origin, nil
}

func init() {
	initCmd.Flags().StringVar(&initWebOrigin, "web-origin", "",
		"Control-plane URL to persist (skips the prompt; required with --no-input to change it)")
	initBinder = spec.RegisterFlags(initCmd, initManifestSpec)
	rootCmd.AddCommand(initCmd)
}
