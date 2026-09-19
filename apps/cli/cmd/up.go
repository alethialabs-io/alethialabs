// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/manifest"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/spec"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/spf13/cobra"
)

// `alethia up` — the whole golden path (#3662) as one command: a person with a repository, or with
// nothing at all, reaches a running cluster.
//
// It is `init` and `apply` composed, and every step is SKIPPED WHEN ALREADY SATISFIED, which is
// what makes it resumable rather than a script that must be run exactly once:
//
//	1. a control-plane URL   — persisted already? skip
//	2. a login               — a live credential? skip
//	3. a cloud account       — one connected? skip; otherwise STOP and name the command, because
//	                           attaching one is a per-cloud keyless flow, not a question
//	4. alethia.yaml          — a file in this directory? skip; otherwise author one
//	5. apply                 — the plan, the confirmation, the deploys
//
// Step 3 is the only one that can stop the run, and that is deliberate. The other four either have
// an answer or can ask for one; a connector is `alethia connector aws|gcp|azure|alibaba|hetzner`,
// five different keyless flows with their own arguments, and re-implementing the choice inside `up`
// would be a sixth surface that drifts from the five.

// upSpec is what `up` takes. It is `apply`'s spec plus the manifest-authoring fields `init` takes,
// because `up` is the two commands composed and must be scriptable as either.
var upSpec = spec.Spec{
	Command: "alethia up",
	Fields: []spec.Field{
		{Command: "alethia up", Key: "file", Title: "Manifest",
			Description: "The alethia.yaml to apply, written when it does not exist yet",
			Flag:        "file", Shorthand: "f", Default: manifest.FileName, Page: docsPlanApplyPage},
		{Command: "alethia up", Key: "project", Title: "Project name",
			Description: "Name for a project this authors (asked for on a terminal when the file is missing)",
			Flag:        "project", ManifestKey: "project", Page: docsPlanApplyPage},
		{Command: "alethia up", Key: "region", Title: "Region",
			Description: "Cloud region for a project this authors", Flag: "region",
			EnvVar: "ALETHIA_REGION", ManifestKey: "cloud.region", Page: docsPlanApplyPage},
		{Command: "alethia up", Key: "account", Title: "Cloud account",
			Description: "Cloud account to link, by its LABEL or its id", Flag: "cloud-account",
			Selector: "label", ManifestKey: "cloud.account", Page: docsPlanApplyPage},
		{Command: "alethia up", Key: "stage", Title: "Stage",
			Description: "Stage for the environment this authors", Flag: "stage",
			Default: string(stageDevelopment), Options: "stages",
			ManifestKey: "stage", Page: docsPlanApplyPage},
		{Command: "alethia up", Key: "runner", Title: "Runner",
			Description: "Runner to deploy with, by NAME or id. Omitted: the only online runner, or asked on a terminal",
			Flag:        "runner", Selector: "name", Page: docsPlanApplyPage},
		{Command: "alethia up", Key: "yes", Title: "Confirm",
			Description: "Apply without asking (required with --no-input)",
			Flag:        "yes", Shorthand: "y", Bool: true, Page: docsPlanApplyPage},
		{Command: "alethia up", Key: "no-wait", Title: "Wait",
			Description: "Queue the deploys and return instead of waiting for them",
			Flag:        "no-wait", Bool: true, Page: docsPlanApplyPage},
	},
	Options: map[string][]string{"stages": environmentStages()},
}

var upBinder *spec.Binder

var upCmd = &cobra.Command{
	Use:   "up",
	Short: "From nothing to a running project: log in, author alethia.yaml, and apply it",
	Long: `The whole first run, in one command, resuming wherever the last one stopped.

Each step is skipped when it is already done: the control-plane URL and the login if this
machine has them, the manifest if this directory has one. What "up" cannot do for you is
attach a cloud account — that is a per-cloud keyless flow — so it stops and names the
command when there is none.

With alethia.yaml already present and an account connected, "alethia up" is "alethia apply".`,
	Args: cobra.NoArgs,
	Run: func(cmd *cobra.Command, _ []string) {
		values, err := spec.Resolve(upBinder, spec.Sources{Env: os.LookupEnv})
		if err != nil {
			fail(err)
		}
		format := outputFormat(cmd)

		// 1 and 2. A live credential is the whole of "is this machine set up": `getAuthToken`
		// reads the persisted one, refreshes it, or takes ALETHIA_TOKEN. Only when there is none
		// does the origin get asked for, because asking a logged-in person which control plane
		// they meant is a question with an answer already on disk.
		token, err := ensureLoggedIn(os.Stdout, format)
		if err != nil {
			fail(err)
		}
		client := api.NewClient(token)

		// 3. The one step that can stop the run.
		if err := ensureCloudAccount(client, os.Stdout, format, values.Get("account")); err != nil {
			fail(err)
		}

		// 4. The file, authored when this directory has none.
		path := values.Get("file")
		if !manifest.Exists(path) {
			if err := authorManifest(client, token, os.Stdout, format, path, values); err != nil {
				fail(err)
			}
		} else if err := refuseAuthoringFlags(cmd, path); err != nil {
			fail(err)
		}

		// 5. Everything `alethia apply` does, through the same code — a second implementation of
		// the plan, the confirmation and the deploy ordering is exactly what this epic exists to
		// stop having.
		yes, _ := upBinder.Bool("yes")
		noWait, _ := upBinder.Bool("no-wait")
		// No project name is passed: `runApply`'s closing line reads it from the manifest it just
		// applied, which is the project that actually came up. `values.Get("project")` is the
		// FLAG, and when the directory already held a manifest the two disagree.
		runApply(cmd, client, token, applyOptions{
			file:   path,
			runner: values.Get("runner"),
			yes:    yes,
			noWait: noWait,
			format: format,
		})
	},
}

// authoringFlags are the `up` flags that only ever reach `authorManifest`. Each is read solely to
// WRITE the manifest, so once a manifest exists none of them can change anything.
var authoringFlags = []string{"project", "region", "stage", "cloud-account"}

// refuseAuthoringFlags stops `up` when a manifest-authoring flag was passed for a manifest that
// already exists.
//
// Ignoring them silently is the failure this refuses: `alethia up --project boutique --region nbg1
// --cloud-account prod --yes` in a directory still holding `legacy-app`'s manifest would create and
// DEPLOY legacy-app without a word about the four flags it was handed — a flag that is silently
// dropped reads as a flag that worked. `--cloud-account` is the subtlest of the four, because it is
// validated a few lines above and then not applied, so it looks the most like it took effect.
//
// Only flags CHANGED on the command line count. The same keys also resolve from the environment and
// from the manifest itself (`ManifestKey`), and a value that came from the file cannot contradict
// it; `stage` additionally carries a default, so a non-empty value proves nothing.
func refuseAuthoringFlags(cmd *cobra.Command, path string) error {
	var given []string
	for _, f := range authoringFlags {
		if cmd.Flags().Changed(f) {
			given = append(given, "--"+f)
		}
	}
	if len(given) == 0 {
		return nil
	}
	list := strings.Join(given, ", ")
	return fmt.Errorf(
		"%s already exists, so %s would be ignored: those flags only ever author a new manifest, and "+
			"this run applies the one on disk.\n"+
			"Drop them and let the file speak, or point --file at a path that does not exist yet",
		path, list)
}

// ensureLoggedIn returns a usable token, running the first-run setup when there is none.
//
// It reports what it SKIPPED as well as what it did. "Already logged in" is the difference between
// a command that looks like it did nothing and one a person can trust to be resumable.
func ensureLoggedIn(out io.Writer, format string) (string, error) {
	if token, err := getAuthTokenInternal(false); err == nil && token != "" {
		say(out, format, fmt.Sprintf("%s Already signed in to %s", ui.SymbolSuccess, WebOrigin()))
		return token, nil
	}
	// A machine-readable run cannot carry the first-run setup. `promptWebOrigin`, `runConfigSet`
	// and `performLoginFlow` all write prose to stdout unconditionally — the device-code box is
	// the point of the flow, so it cannot be silenced — and that prose would land ahead of the
	// ApplyResult document and break the caller's parse.
	//
	// Checked BEFORE the terminal test because it does not depend on one: `up --output json` with
	// no credential cannot succeed on a terminal either, and this message names both remedies, so
	// nothing is lost by answering the output question first.
	if format != ui.FormatTable {
		return "", fmt.Errorf(
			"not signed in, and --output %s cannot run the first-run sign-in: it prints a device code "+
				"that would corrupt the document.\nRun `alethia login` once, then re-run this command "+
				"(or set %s to a service token)", format, ServiceTokenEnv)
	}
	if !canPromptForm() {
		return "", fmt.Errorf(
			"not signed in, and interactive prompts are unavailable (--no-input, or stdin is not a terminal): "+
				"set %s to a service token, or run `alethia login` on a terminal first", ServiceTokenEnv)
	}
	origin, err := promptWebOrigin("")
	if err != nil {
		return "", err
	}
	if err := runConfigSet(out, "web-origin", origin); err != nil {
		return "", err
	}
	if err := performLoginFlow(); err != nil {
		return "", err
	}
	return getAuthToken()
}

// ensureCloudAccount refuses, with the command to run, when the organization has no connector.
//
// It does not offer to attach one. `connector aws|gcp|azure|alibaba|hetzner` are five different
// keyless flows with five different arguments — cliDemoConnectorFlags in the e2e harness is the
// measurement of how different — so a sixth surface inside `up` would be one more thing to keep in
// step with them, and it would drift the way every other "one product, two implementations" pair in
// this epic drifted.
func ensureCloudAccount(c cloudIdentityLister, out io.Writer, format, wanted string) error {
	identities, err := c.GetCloudIdentities()
	if err != nil {
		return fmt.Errorf("list cloud accounts: %w", err)
	}
	if len(identities) == 0 {
		return fmt.Errorf(
			"no cloud account is connected — attach one first:\n" +
				"  alethia connector hetzner      # an API token, cheapest to try\n" +
				"  alethia connector aws          # keyless, one CloudFormation stack\n" +
				"  alethia connector gcp          # keyless, the Cloud Shell installer\n" +
				"  alethia connector azure        # keyless, a federated identity\n" +
				"  alethia connector alibaba      # keyless, RAM federation")
	}
	if wanted != "" {
		// Resolved HERE rather than at apply time, because the refusal is worth having before a
		// form asks for a project name: an unknown label is a typo, and finding out after five
		// questions is worse than finding out before them.
		if _, err := matchCloudIdentity(identities, wanted); err != nil {
			return err
		}
		say(out, format, fmt.Sprintf("%s Cloud account %s", ui.SymbolSuccess, wanted))
		return nil
	}
	say(out, format, fmt.Sprintf("%s %s connected", ui.SymbolSuccess, plural(len(identities), "cloud account")))
	return nil
}

// authorManifest writes the alethia.yaml `up` is about to apply.
//
// The values come through the SAME resolver every other command uses — flag, environment, manifest
// (there is none yet), form, default — so `up --no-input --project x --region y --cloud-account z`
// authors a file without a terminal, which is the contract that makes this scriptable at all.
func authorManifest(
	c applyClient,
	token string,
	out io.Writer,
	format, path string,
	values spec.Values,
) error {
	name, region, account := values.Get("project"), values.Get("region"), values.Get("account")
	if canPromptForm() {
		var err error
		if name == "" {
			if name, err = promptProjectName(); err != nil {
				return err
			}
		}
		if region == "" {
			if region, err = promptRegion(); err != nil {
				return err
			}
		}
		if account == "" {
			if account, err = promptCloudAccountLabel(c, token); err != nil {
				return err
			}
		}
	}
	var missing []string
	for _, f := range []struct{ flag, value string }{
		{"--project", name}, {"--region", region}, {"--cloud-account", account},
	} {
		if f.value == "" {
			missing = append(missing, f.flag)
		}
	}
	if len(missing) > 0 {
		return fmt.Errorf("%s does not exist and cannot be written without %v (or a terminal to ask on)", path, missing)
	}

	// The matrix is the one thing a flag cannot say — it is a list of records. On a terminal it is
	// asked for; scripted, one environment at the given stage is the honest minimum, and `alethia
	// project env add` is how a second one arrives.
	environments := []api.EnvironmentSpec{
		{Name: values.Get("stage"), Stage: values.Get("stage"), PlacementMode: "dedicated", IsDefault: true},
	}
	if canPromptForm() {
		// Declining leaves the one-element fallback above — NOT a server-seeded pair. `apply`
		// creates exactly what this file says, so the question must describe the file.
		asked, err := promptEnvMatrix(fmt.Sprintf(
			"Otherwise the file declares one %s environment, and `alethia project env add` is how a second arrives",
			values.Get("stage")))
		if err != nil {
			return err
		}
		if len(asked) > 0 {
			environments = asked
		}
	}

	m := manifestFromCreate(api.CreateProjectParams{
		ProjectName: name, Region: region, Environments: environments,
	}, account)
	if err := manifest.Write(path, m, false); err != nil {
		return err
	}
	say(out, format, fmt.Sprintf("%s Wrote %s", ui.SymbolSuccess, path))
	return nil
}

// promptCloudAccountLabel asks which connected account to use and returns its LABEL, so what lands
// in the file is the name a person recognises rather than the id the picker resolves.
func promptCloudAccountLabel(c applyClient, token string) (string, error) {
	identities, err := c.GetCloudIdentities()
	if err != nil {
		return "", err
	}
	if len(identities) == 1 {
		// One account is not a question. The picker would show a list of one and make the person
		// press enter to confirm what they already have.
		return identities[0].Label, nil
	}
	id, err := selectCloudIdentity(token)
	if err != nil {
		return "", err
	}
	for _, i := range identities {
		if i.ID == id {
			return i.Label, nil
		}
	}
	return id, nil
}

// say writes a progress line on the human output only — prose in a `--output json` stream corrupts
// the document the caller is piping into jq.
func say(out io.Writer, format, line string) {
	if format == ui.FormatTable {
		fmt.Fprintln(out, line)
	}
}

func init() {
	upBinder = spec.RegisterFlags(upCmd, upSpec)
	rootCmd.AddCommand(upCmd)
}
