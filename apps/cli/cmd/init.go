// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"os"

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
	Short: "Set up the CLI and write an alethia.yaml for this directory",
	Long: `Guided setup: choose the control-plane URL (the hosted alethialabs.io by
default, or a self-hosted / dev URL), persist it, log in, and — when this directory
has no alethia.yaml — author one.

The manifest is what "alethia apply" reads: the project, the cloud account by its
label, and every environment with its placement. Pass --file to write it somewhere
else, or --skip-manifest to do the machine setup alone.

Pass --web-origin to supply the URL without the prompt; with --no-input and no
--web-origin the already-resolved origin is kept.

"alethia up" is this command and "alethia apply" together.`,
	Run: func(cmd *cobra.Command, args []string) {
		origin, err := promptWebOrigin(initWebOrigin)
		if err != nil {
			fail(err)
		}
		if err := runConfigSet(os.Stdout, "web-origin", origin); err != nil {
			fail(err)
		}
		fmt.Println()
		// SKIPPED WHEN ALREADY DONE, like every other step of the golden path. Re-running `init`
		// to add a manifest to a second directory is the ordinary case, and opening a browser at
		// a machine that is already signed in makes the command something people avoid re-running
		// — which is exactly when a half-finished setup stays half-finished. `alethia login
		// --force` is how a person deliberately signs in again.
		if token, err := getAuthTokenInternal(false); err == nil && token != "" {
			say(os.Stdout, outputFormat(cmd), fmt.Sprintf("%s Already signed in — `alethia login --force` to sign in again", ui.SymbolSuccess))
		} else if err := performLoginFlow(); err != nil {
			fail(err)
		}
		if skip, _ := initBinder.Bool("skip-manifest"); skip {
			return
		}

		// The manifest is authored AFTER the login, and only then, because naming a cloud
		// account means reading the ones this identity has. An `init` that asked first would
		// have to ask for the account as free text and find out it was wrong at apply time.
		format := outputFormat(cmd)
		values, err := spec.Resolve(initBinder, spec.Sources{Env: os.LookupEnv})
		if err != nil {
			fail(err)
		}
		path := values.Get("file")
		if manifest.Exists(path) {
			say(os.Stdout, format, fmt.Sprintf("%s %s already exists — left as it is", ui.SymbolSuccess, path))
			return
		}
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		client := api.NewClient(token)
		if err := ensureCloudAccount(client, os.Stdout, format, ""); err != nil {
			fail(err)
		}
		if err := authorManifest(client, token, os.Stdout, format, path, values); err != nil {
			fail(err)
		}
		say(os.Stdout, format, fmt.Sprintf("\n%s Next: `alethia apply` — or `alethia up`, which does both.", ui.MutedStyle.Render(ui.SymbolPoint)))
	},
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
		{Command: "alethia init manifest", Key: "skip-manifest", Title: "Machine setup only",
			Description: "Set up the CLI without writing a manifest",
			Flag:        "skip-manifest", Bool: true, Page: docsCliInitPage},
	},
	Options: map[string][]string{"stages": environmentStages()},
}

// docsCliInitPage is the page `init`'s field table lives on.
const docsCliInitPage = "apps/docs/content/docs/cli/commands/init.mdx"

// initBinder holds the flag targets initManifestSpec generated. Set in init().
var initBinder *spec.Binder

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
