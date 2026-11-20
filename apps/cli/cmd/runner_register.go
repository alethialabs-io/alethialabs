// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"io"
	"strings"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/clierr"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/cmdmeta"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/runners"
	"github.com/charmbracelet/huh"
	"github.com/spf13/cobra"
)

var (
	registerRunnerName    string
	registerCloudAccount  string
	registerCloudIdentity string
)

var runnerRegisterCmd = &cobra.Command{
	Use:   "register [name]",
	Short: "Register a runner you run yourself, on any cloud",
	Args:  cobra.MaximumNArgs(1),
	Long: fmt.Sprintf(`Creates a runner record and prints its id and its token, once. Nothing is provisioned: you
start the runner process yourself, anywhere that can reach the control plane — a VM on any
cloud, a container, or your own hardware.

This is the first runner of an organization that has none, and the way to run one on %s:
"alethia runner deploy" builds runners in %s only, and needs a runner that is already online
to do it.

On a terminal the name is asked for when omitted, and an optional cloud account is offered.
Both are flags too, so the command runs unattended: pass the name (as the argument or --name)
and, to record which account the runner works in, --cloud-account by its label.

The two values are written on standard output as ALETHIA_RUNNER_ID=… and
ALETHIA_RUNNER_TOKEN=… lines and nothing else is, so the output can be redirected straight
into an env file; with --output json they are the "id" and "token" fields. Everything said
about them goes to standard error.

The token is a credential and is shown once. Only its SHA-256 is stored, so it cannot be read
again: if you lose it, register another runner and remove this one.`,
		runnerRegisterOnlyClouds(), runners.DeployProvidersLabel()),
	Run: func(cmd *cobra.Command, args []string) {
		if err := runRunnerRegisterCmd(cmd, args); err != nil {
			fail(err)
		}
	},
}

// runRunnerRegisterCmd is `runner register`: it resolves the name and the optional cloud account,
// then registers the runner and prints its credentials.
func runRunnerRegisterCmd(cmd *cobra.Command, args []string) error {
	token, err := getAuthToken()
	if err != nil {
		return err
	}
	apiClient := api.NewClient(token)

	name := registerRunnerName
	if len(args) == 1 && args[0] != "" {
		if name != "" && name != args[0] {
			return refusal(clierr.CodeInvalidUsage, "",
				"the name argument (%q) and --name (%q) disagree: pass one", args[0], name)
		}
		name = args[0]
	}
	if name == "" {
		if !canPromptForm() {
			return errRunnerNameRequired()
		}
		if err := runHuhForm(
			huh.NewGroup(
				huh.NewInput().
					Title("Runner name").
					Description("How this runner appears in `alethia runner list`").
					Value(&name).
					Placeholder("my-box-1"),
			),
		); err != nil {
			return err
		}
		name = strings.TrimSpace(name)
	}

	identityID, err := registerIdentityID(apiClient, registerCloudAccount, registerCloudIdentity)
	if err != nil {
		return err
	}
	dryRun := cmdmeta.DryRunRequested(cmd)
	if identityID == "" && canPromptForm() && !dryRun {
		if identityID, err = offerRunnerCloudBinding(apiClient); err != nil {
			return err
		}
	}

	p := printerFor(cmd)
	if dryRun {
		return printRunnerRegisterDryRun(p, name, identityID)
	}
	return runRunnerRegister(apiClient, p, name, identityID)
}

// errRunnerNameRequired is the refusal for a registration with no name and nobody to ask.
func errRunnerNameRequired() error {
	return refusal(clierr.CodeInputRequired, "alethia runner register my-box-1",
		"a runner name is required: pass it as the argument, or --name. "+
			"Nothing can ask for it (--no-input, stdin is not a terminal, or stderr is redirected)")
}

// registerIdentityID resolves the cloud account a registration binds to, from the LABEL-or-id
// ref or the raw id form. A registered runner may bind to ANY cloud — it is not narrowed the way
// `runner deploy` is, because nothing is provisioned and no runner template is involved.
func registerIdentityID(c cloudIdentityLister, ref, id string) (string, error) {
	if ref != "" && id != "" {
		return "", errBothCloudAccountForms()
	}
	if ref != "" {
		return resolveCloudIdentityID(c, ref)
	}
	return id, nil
}

// offerRunnerCloudBinding asks, on a terminal, whether to bind the new runner to a cloud
// account, and returns the chosen id ("" for none).
//
// A listing failure is a WARNING here and not a fatal error, because the binding is optional and
// the registration is not: refusing to register a runner because an optional offer could not be
// rendered would be a worse answer than registering it unbound, which is what omitting the flag
// already means. The warning is printed so the skip is visible rather than silent.
func offerRunnerCloudBinding(c cloudIdentityLister) (string, error) {
	var identities []api.CloudIdentity
	var err error
	runSpinner("Fetching cloud accounts...", func() {
		identities, err = c.GetCloudIdentities()
	})
	if err != nil {
		printer.Warn(fmt.Sprintf(
			"Could not list cloud accounts (%v) — registering the runner unbound. "+
				"Pass --cloud-account to bind it.", err))
		return "", nil
	}
	if len(identities) == 0 {
		return "", nil
	}

	options := make([]huh.Option[string], 0, len(identities)+1)
	// The "none" option is first and is the default: a registered runner does not need a cloud
	// account, and a picker whose first entry is an account would make the common answer the one
	// that takes extra keystrokes to avoid.
	options = append(options, huh.NewOption("— none (the runner is not bound to a cloud account) —", ""))
	for _, id := range identities {
		options = append(options, huh.NewOption(
			fmt.Sprintf("%s — %s", strings.ToUpper(id.Provider), id.Label), id.ID))
	}
	var chosen string
	if err := runHuhForm(
		huh.NewGroup(
			huh.NewSelect[string]().
				Title("Bind to a cloud account?").
				Description("Optional — it records which account this runner operates in").
				Options(options...).
				Value(&chosen),
		),
	); err != nil {
		return "", err
	}
	return chosen, nil
}

// runnerRegistration is the result of `runner register`: the two values the runner process is
// started with, and where it reports to.
//
// It is a credential document and not a mutation result. The token is in it exactly once, and it
// is the only place the token is ever written: no note, warning, debug line or error carries it.
type runnerRegistration struct {
	// ID is the new runner's id, the value of ALETHIA_RUNNER_ID.
	ID string `json:"id"`
	// Name is the runner's name.
	Name string `json:"name"`
	// Token is the runner's token, the value of ALETHIA_RUNNER_TOKEN. It is shown once.
	Token string `json:"token"`
	// CloudIdentityID is the cloud account the runner was bound to, when one was named.
	CloudIdentityID string `json:"cloud_identity_id,omitempty"`
	// WebOrigin is the control plane the runner reports to, the value of ALETHIA_WEB_ORIGIN.
	WebOrigin string `json:"web_origin"`
}

// Table returns the registration as one csv row.
func (r runnerRegistration) Table() ui.TableSpec {
	return ui.TableSpec{
		Columns: []string{"id", "name", "token", "web_origin"},
		Rows:    [][]string{{r.ID, r.Name, r.Token, r.WebOrigin}},
	}
}

// The environment variables a self-run runner is started with.
const (
	runnerEnvID       = "ALETHIA_RUNNER_ID"
	runnerEnvToken    = "ALETHIA_RUNNER_TOKEN"
	runnerEnvOrigin   = "ALETHIA_WEB_ORIGIN"
	runnerEnvOperator = "ALETHIA_RUNNER_OPERATOR"
)

// runnerGuideURL is the page that says how to run the runner process.
func runnerGuideURL() string { return docsURL + "/guides/runners/self-operated" }

// runnerRegisterClient is the one call a registration makes.
type runnerRegisterClient interface {
	RegisterRunner(name, cloudIdentityID string) (*api.RunnerRegistration, error)
}

// runRunnerRegister registers the runner and prints the credentials the operator must copy.
//
// For a person, standard output carries exactly two lines — the id and the token as
// `KEY=value` assignments — because the next thing that happens to them is being pasted or
// redirected into an env file, and a value a reader has to extract from a sentence is a value
// they can get wrong. Everything said about them goes to p.Err. For a program the document is
// the runnerRegistration.
func runRunnerRegister(c runnerRegisterClient, p *Printer, name, cloudIdentityID string) error {
	if name == "" {
		return errRunnerNameRequired()
	}
	reg, err := c.RegisterRunner(name, cloudIdentityID)
	if err != nil {
		return err
	}
	if reg == nil || reg.RunnerToken == "" {
		return clierr.New(clierr.CodeInternal, "the control plane registered no runner: it returned no token")
	}

	result := runnerRegistration{
		ID: reg.Runner.ID, Name: reg.Runner.Name, Token: reg.RunnerToken,
		CloudIdentityID: cloudIdentityID, WebOrigin: WebOrigin(),
	}
	human := p.Format == ui.FormatTable
	if human {
		ui.SuccessTo(p.Err, fmt.Sprintf("Registered runner %s (%s)", result.Name, result.ID))
		p.Note("The token below is shown once: only its hash is stored. Copy it now.")
		fmt.Fprintln(p.Err)
	}
	// The credential is written before anything else that could fail. The runner exists by now
	// and this is the one moment its token is shown.
	if err := p.Result(result, func(w io.Writer) {
		fmt.Fprintf(w, "%s=%s\n", runnerEnvID, result.ID)
		fmt.Fprintf(w, "%s=%s\n", runnerEnvToken, result.Token)
	}); err != nil {
		return err
	}
	if human {
		fmt.Fprintln(p.Err)
		p.Note("Start the runner process with those two set, and with:")
		p.Note(fmt.Sprintf("  %s=%s", runnerEnvOrigin, result.WebOrigin))
		p.Note(fmt.Sprintf("  %s=self", runnerEnvOperator))
		p.Note("How to run it: " + runnerGuideURL())
		p.Note("Then `alethia runner list` shows it ONLINE with a recent heartbeat.")
	}
	return nil
}

// runnerRegisterRequest is the request a registration sends, as its dry run reports it.
type runnerRegisterRequest struct {
	Name            string `json:"name"`
	CloudIdentityID string `json:"cloud_identity_id,omitempty"`
}

// printRunnerRegisterDryRun reports the registration that would be made. Nothing is sent, so no
// runner and no token exist.
func printRunnerRegisterDryRun(p *Printer, name, cloudIdentityID string) error {
	result := MutationResult{
		Kind: "runner", Action: ResultCreated, DryRun: true,
		Object: runnerRegisterRequest{Name: name, CloudIdentityID: cloudIdentityID},
	}
	return p.Result(result, func(w io.Writer) {
		fmt.Fprintln(w, ui.MutedStyle.Render(fmt.Sprintf(
			"Would register a runner named %s. Nothing was sent, so there is no token.", name)))
	})
}

func init() {
	runnerRegisterCmd.Flags().StringVar(&registerRunnerName, "name", "", "Runner name (or pass it as the argument)")
	runnerRegisterCmd.Flags().StringVar(&registerCloudAccount, "cloud-account", "",
		"Bind the runner to a cloud account, by LABEL or id (optional)")
	runnerRegisterCmd.Flags().StringVar(&registerCloudIdentity, "cloud-identity-id", "",
		"Cloud identity id to bind to (prefer --cloud-account, which also takes the label)")
	addDryRunFlag(runnerRegisterCmd)
	runnerCmd.AddCommand(runnerRegisterCmd)
}
