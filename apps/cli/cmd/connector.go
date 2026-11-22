// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"errors"
	"fmt"
	"io"
	"slices"
	"strings"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/clierr"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/cmdmeta"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/catalog"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/charmbracelet/huh"
	"github.com/spf13/cobra"
)

const (
	// connectorBaseURL hosts the public copies of the setup artifacts used by
	// the guided-manual fallbacks (provisioned by infra/connector-assets).
	connectorBaseURL   = "https://alethia-connector-assets.s3.eu-west-1.amazonaws.com"
	gcpCloudShellURL   = "https://shell.cloud.google.com/cloudshell/open?shellonly=true&show=terminal"
	azureCloudShellURL = "https://shell.azure.com"
	awsCloudShellURL   = "https://console.aws.amazon.com/cloudshell/home"
)

// kindCloudIdentity is the kind every result of this family names: the record a connection is.
const kindCloudIdentity = "cloud_identity"

// connectorCmd is the parent of the connect, list and remove commands. Its Short and Long name the
// offered clouds, so they are written by applyCloudHelp rather than typed here.
var connectorCmd = &cobra.Command{
	Use: "connector",
}

func init() {
	rootCmd.AddCommand(connectorCmd)
	applyCloudHelp()
}

// --- The connectors this build has ---

// connectorInfo is what the parent command says about one cloud's connector.
type connectorInfo struct {
	// Slug is the cloud, and the name of the `connector` subcommand.
	Slug string
	// Keyless names the federation mechanism the connector sets up. It is empty for a cloud that
	// has none.
	Keyless string
	// Exception is the paragraph the parent's help adds for a cloud that is not keyless.
	Exception string
}

// connectorInfos holds one entry per `connector <cloud>` command, keyed by slug. Each connector
// file adds its own, so the parent's help is assembled from the connectors that exist and no file
// carries a second list of them.
var connectorInfos = map[string]connectorInfo{}

// registerConnector records a connector's entry and returns it. It is called from a package-level
// variable in the connector's own file, so every entry is in place before any init function runs.
func registerConnector(info connectorInfo) connectorInfo {
	connectorInfos[info.Slug] = info
	return info
}

// connectorProviderNames lists the clouds `alethia connector` can connect in this build: the
// offered clouds that have a connector, in the catalog's order. A cloud the catalog hides is
// absent unless the operator re-enabled it.
func connectorProviderNames() []string {
	var names []string
	for _, provider := range EnabledCloudProviders() {
		if _, ok := connectorInfos[string(provider)]; ok {
			names = append(names, string(provider))
		}
	}
	return names
}

// connectorHasProvider reports whether `alethia connector <name>` is a connector this build
// offers, which is a narrower question than "is this a cloud": the catalog lists clouds the CLI
// has no connector for.
func connectorHasProvider(name string) bool {
	return slices.Contains(connectorProviderNames(), name)
}

// isCloudProviderSlug reports whether ref names a cloud the catalog lists, offered or not.
//
// It is a parser and not an offer: an account on a cloud this build no longer offers is still
// addressed by that cloud's name, so the whole catalog is recognised here and what may be newly
// connected is decided by requireCloudOffered. Without it `alethia cloud inventory <cloud>` would
// be sent to the control plane as an identity id, which reads as "that account does not exist".
func isCloudProviderSlug(ref string) bool {
	_, listed := catalog.MustLoad().Availability(ref)
	return listed
}

// --- A cloud that is not offered ---

// cloudNotOfferedError is the one refusal for a cloud this build does not offer. The sentence is
// the control plane's own, so the CLI and the server answer the same request with the same words.
func cloudNotOfferedError(slug string) error {
	subject := "This cloud"
	if meta, ok := catalog.MustLoad().Provider(slug); ok && meta.Name != "" {
		subject = meta.Name
	}
	return clierr.New(clierr.CodeValidationFailed, subject+" is not available in this release.")
}

// requireCloudOffered refuses a cloud this build does not offer. It asks nothing of the control
// plane, so the refusal is made before any request.
func requireCloudOffered(slug string) error {
	if CloudEnabled(slug) {
		return nil
	}
	return cloudNotOfferedError(slug)
}

// refuseHelpForHiddenCloud makes the help of a cloud-specific command follow the offered set: a
// command for a cloud that is not offered answers `--help` with the same refusal as running it.
// For an offered cloud it prints what its parent would, so the command has no help of its own to
// keep in step.
func refuseHelpForHiddenCloud(cmd *cobra.Command, slug string) {
	cmd.SetHelpFunc(func(c *cobra.Command, args []string) {
		if err := requireCloudOffered(slug); err != nil {
			fail(err)
			return
		}
		c.Parent().HelpFunc()(c, args)
	})
}

// --- Help that names clouds ---

// applyCloudHelp writes every help text of this family that names clouds, from the offered set.
//
// It runs when the package is initialised, which is when the process has its environment, and it
// can be called again: a test that re-enables a hidden cloud applies it and sees the cloud named.
func applyCloudHelp() {
	names := connectorProviderNames()
	slugs := strings.Join(names, ", ")

	connectorCmd.Short = "Connect cloud accounts (" + enabledConnectorList() + ")"
	connectorCmd.Long = connectorLong(names)

	connectorRemoveCmd.Long = `Disconnect a cloud account. The connection goes back to a pending state, and every
project that used it is left without a cloud account until you connect one again.
Resources already provisioned in the cloud are not touched: destroy the projects
first if you want them gone.

Name the account by its cloud (` + slugs + `) or by its cloud-identity id, or
omit the argument for a picker. When more than one account is connected on a cloud,
pass the id. The command asks before it disconnects; pass --yes to skip the question.`

	providerStatusCmd.Long = `Show whether a cloud is connected, and the identity Alethia uses on it: the role,
service account or managed identity, and the account it belongs to.

Name the cloud (` + slugs + `), or omit it for a picker over the accounts you
have connected. Use it to check a connection before a deploy.`

	providerVerifyCmd.Long = `Run the control plane's health probe against a connected account again: it signs
in to the cloud with the stored identity and checks the permissions provisioning
needs. The result is recorded on the connection.

Name the cloud (` + slugs + `), or omit it for a picker over the accounts you
have connected. Use it after you change a role or a permission on the cloud side.
The command exits 13 when the probe fails.`

	cloudInventoryCmd.Long = `Show the networks, subnets and regions Alethia discovered in a connected cloud
account. Use it to find the network a project can be placed in.

Name the account by its cloud (` + slugs + `) or by its cloud-identity id, or
omit the argument for a picker. When more than one account is connected on a cloud,
pass the id.`
}

// enabledConnectorList returns the display names of the clouds a connector exists for, as one
// phrase: "AWS, GCP, Azure and Hetzner".
func enabledConnectorList() string {
	var out []string
	for _, c := range catalog.MustLoad().Live.Providers {
		if connectorHasProvider(c.Slug) {
			out = append(out, c.ShortName)
		}
	}
	return joinWithAnd(out)
}

// cloudShortName returns the catalog's short display name of a cloud, or the slug for a cloud the
// catalog does not list.
func cloudShortName(slug string) string {
	for _, c := range catalog.MustLoad().Live.Providers {
		if c.Slug == slug {
			return c.ShortName
		}
	}
	return slug
}

// connectorLong builds the parent command's description from the connectors on offer.
func connectorLong(names []string) string {
	var keyless, exceptions []string
	for _, name := range names {
		info := connectorInfos[name]
		if info.Keyless != "" {
			keyless = append(keyless, info.Keyless)
		}
		if info.Exception != "" {
			exceptions = append(exceptions, info.Exception)
		}
	}

	var b strings.Builder
	b.WriteString("Connect the cloud accounts Alethia provisions into (" + enabledConnectorList() + "),\n")
	b.WriteString("list them, and disconnect them. Run one `connector` command per account before\n")
	b.WriteString("the first deploy.\n")
	if len(keyless) > 0 {
		b.WriteString("\nA connection is keyless wherever the cloud allows it:\n")
		for _, mechanism := range keyless {
			b.WriteString("  - " + mechanism + "\n")
		}
		b.WriteString("Alethia stores no long-lived secret for those clouds.\n")
	}
	for _, paragraph := range exceptions {
		b.WriteString("\n")
		b.WriteString(paragraph)
		b.WriteString("\n")
	}
	return strings.TrimRight(b.String(), "\n")
}

// --- Errors of this family ---

// inputRequiredError is the refusal for a value nothing can ask for. format names what is missing
// and the flag that supplies it; cause is why no prompt can be opened.
func inputRequiredError(cause error, format string, args ...any) error {
	e := clierr.New(clierr.CodeInputRequired, fmt.Sprintf(format, args...)+" ("+cause.Error()+")")
	e.Cause = cause
	return e
}

// invalidInputError is the refusal for input that was read and cannot be right. Nothing has been
// sent when it is returned.
func invalidInputError(format string, args ...any) error {
	return clierr.New(clierr.CodeValidationFailed, fmt.Sprintf(format, args...))
}

// missingToolError is the refusal for a cloud CLI the default setup needs and the machine does not
// have. hint says how to go on without it.
func missingToolError(cause error, hint string) error {
	e := clierr.Wrap(clierr.CodeConflict, cause)
	e.Hint = hint
	return e
}

// formError classifies what a prompt returned. A prompt the person left with Ctrl+C is an
// interrupt; any other error keeps its own class.
func formError(err error) error {
	if errors.Is(err, huh.ErrUserAborted) {
		e := clierr.New(clierr.CodeInterrupted, "cancelled")
		e.Cause = err
		return e
	}
	return err
}

// --- Output of this family ---

// resultPrinter returns the invocation's Printer with the validated --output value. An invalid
// value ends the command on the fatal path before anything is fetched.
func resultPrinter(cmd *cobra.Command) *Printer {
	p := *printer
	p.Format = outputFormat(cmd)
	return &p
}

// printStep reports which stage of a connection is running, on stderr: the stepper for a person,
// one plain line for an agent.
func printStep(p *Printer, steps []string, current int) {
	if p.Mode.Agent {
		p.Progress(steps[current])
		return
	}
	fmt.Fprintln(p.Err, ui.RenderStepper(steps, current))
	fmt.Fprintln(p.Err)
}

// --- The connection pipeline ---

// connectFlow is one connector's part of the pipeline every connector shares.
type connectFlow struct {
	// Provider is the cloud's slug.
	Provider string
	// Mode names the setup this invocation chose, for the dry run: "role-arn", "manual", "local".
	Mode string
	// Steps are the three stages the stepper names.
	Steps []string
	// Check refuses a command line that cannot work, before anything exists server-side. It may be
	// nil.
	Check func() error
	// Prepare collects what must be known before the pending identity is opened, asking when it
	// can. It may be nil.
	Prepare func(p *Printer) error
	// Capture runs the provider's setup and returns the credentials to submit.
	Capture func(p *Printer, issuer string) (map[string]interface{}, error)
	// Connected is the sentence a person reads once the connection is verified.
	Connected func() string
}

// connectionRecord is the object of a connect result: the connection as the control plane left
// it.
type connectionRecord struct {
	Provider           string   `json:"provider"`
	Status             string   `json:"status"`
	Verified           bool     `json:"verified"`
	MissingPermissions []string `json:"missing_permissions"`
}

// connectPlan is the object of a connect dry run: what the command would do.
type connectPlan struct {
	Provider string `json:"provider"`
	// Mode is the setup the command line chose.
	Mode string `json:"mode"`
	// Requests are the control-plane calls a real run makes, in order.
	Requests []string `json:"requests"`
}

// runConnect connects one cloud account: it refuses a cloud that is not offered, checks the
// command line, opens the pending identity, captures credentials with the provider's own setup,
// submits them, and reports the control plane's verdict.
//
// Under --dry-run it stops after the checks and reports the plan. Nothing is created, in the
// control plane or in the cloud.
func runConnect(cmd *cobra.Command, flow connectFlow) error {
	if err := requireCloudOffered(flow.Provider); err != nil {
		return err
	}
	p := resultPrinter(cmd)
	if flow.Check != nil {
		if err := flow.Check(); err != nil {
			return err
		}
	}

	if cmdmeta.DryRunRequested(cmd) {
		plan := MutationResult{
			Kind: kindCloudIdentity, Action: ResultCreated, DryRun: true,
			Object: connectPlan{
				Provider: flow.Provider,
				Mode:     flow.Mode,
				Requests: []string{
					"POST /api/cli/providers/" + flow.Provider + "/init",
					"POST /api/cli/providers/" + flow.Provider + "/connect",
				},
			},
		}
		return p.Result(plan, func(w io.Writer) {
			ui.MutedTo(w, fmt.Sprintf(
				"Dry run: would connect %s with the %s setup. Nothing was changed.",
				cloudShortName(flow.Provider), flow.Mode,
			))
		})
	}

	token, err := getAuthToken()
	if err != nil {
		return err
	}
	client := api.NewClient(token)

	printStep(p, flow.Steps, 0)
	if flow.Prepare != nil {
		if err := flow.Prepare(p); err != nil {
			return err
		}
	}
	initResp, err := initProviderIdentity(client, flow.Provider)
	if err != nil {
		return err
	}

	// The customer's role trusts THIS control plane's issuer, derived from the web origin.
	origin, _ := types.ResolveWebOrigin()
	issuer := strings.TrimRight(origin, "/") + "/api/oidc"

	printStep(p, flow.Steps, 1)
	creds, err := flow.Capture(p, issuer)
	if err != nil {
		return err
	}

	printStep(p, flow.Steps, 2)
	verdict, err := finalizeConnection(client, flow.Provider, initResp.IdentityID, creds)
	if err != nil {
		return err
	}

	missing := verdict.MissingPermissions
	if missing == nil {
		missing = []string{}
	}
	if verdict.Status == "degraded" && len(missing) > 0 {
		p.Warn("Connected, but missing some provisioning permissions: " + strings.Join(missing, ", "))
	}
	result := MutationResult{
		ID: initResp.IdentityID, Kind: kindCloudIdentity, Action: ResultCreated,
		Object: connectionRecord{
			Provider:           flow.Provider,
			Status:             verdict.Status,
			Verified:           verdict.Verified,
			MissingPermissions: missing,
		},
	}
	return p.Result(result, func(w io.Writer) { ui.SuccessTo(w, flow.Connected()) })
}

// initProviderIdentity creates (or reuses) the user's pending identity for a
// provider, with a spinner.
func initProviderIdentity(apiClient *api.Client, provider string) (*api.InitIdentityResponse, error) {
	var resp *api.InitIdentityResponse
	var err error
	runSpinner("Initializing connection...", func() {
		resp, err = apiClient.InitProviderIdentity(provider)
	})
	return resp, err
}

// finalizeConnection submits the captured credentials and returns the verdict. The server
// verifies the identity INLINE (a synchronous health probe) and returns the result directly —
// there is no CONNECTION_TEST job to wait for.
//
// A probe that fails is an error of the operation-failed class: the request was accepted and what
// it started did not succeed, so repeating the command unchanged cannot help.
func finalizeConnection(
	apiClient *api.Client,
	provider, identityID string,
	creds map[string]interface{},
) (*api.ConnectIdentityResponse, error) {
	var resp *api.ConnectIdentityResponse
	var err error
	runSpinner("Submitting credentials & running connection test...", func() {
		resp, err = apiClient.ConnectProviderIdentity(provider, identityID, creds)
	})
	if err != nil {
		return nil, err
	}

	if !resp.Verified {
		message := fmt.Sprintf("connection test failed (%s)", resp.Status)
		if resp.Error != "" {
			message += ": " + resp.Error
		}
		failed := clierr.New(clierr.CodeOperationFailed, message)
		failed.Hint = "Check the access the setup created on the cloud side, then run the command again."
		return nil, failed
	}
	return resp, nil
}

// --- Naming a connected account ---

// resolveCloudIdentityRef turns the optional `[provider|cloud-identity-id]` argument of a
// read command into the identity id to operate on.
//
// This is the handoff removal. `alethia cloud inventory` used to take a bare
// `<cloud-identity-id>` — an opaque token a reader had to copy out of another command's
// output, which is exactly the class of manual step this programme exists to delete. It now
// takes a provider name, or nothing at all and shows a picker.
//
// An id is NEVER reshaped. A stored cloud-identity id is a lookup key: a resolver that
// trimmed, lower-cased or re-formatted one would rename a live record's address. So only a
// value that IS a provider slug is resolved; everything else is passed through byte for
// byte, and no request is made to list identities at all.
func resolveCloudIdentityRef(lister cloudIdentityLister, ref string) (string, error) {
	if ref != "" && !isCloudProviderSlug(ref) {
		return ref, nil
	}

	if ref == "" {
		if err := requireInteractiveForm(); err != nil {
			return "", inputRequiredError(err,
				"no cloud account given: pass a provider (%s) or a cloud-identity id as the argument",
				strings.Join(connectorProviderNames(), ", "))
		}
	}

	identities, err := listCloudIdentities(lister)
	if err != nil {
		return "", err
	}
	if len(identities) == 0 && ref == "" {
		return "", noCloudAccountsError()
	}

	if ref != "" {
		match, err := connectedAccountOn(identities, ref)
		if err != nil {
			return "", err
		}
		return match.ID, nil
	}

	return pickConnectedIdentity("Select a cloud account", identities)
}

// listCloudIdentities fetches the connected cloud accounts, with a spinner.
func listCloudIdentities(lister cloudIdentityLister) ([]api.CloudIdentity, error) {
	var identities []api.CloudIdentity
	var err error
	runSpinner("Fetching cloud connections...", func() {
		identities, err = lister.GetCloudIdentities()
	})
	if err != nil {
		return nil, fmt.Errorf("failed to fetch cloud connections: %w", err)
	}
	return identities, nil
}

// noCloudAccountsError is the answer when a command needs a connected account and there is none.
func noCloudAccountsError() error {
	e := clierr.New(clierr.CodeNotFound, "no cloud accounts connected")
	e.Hint = "Connect one with `alethia connector " + strings.Join(connectorProviderNames(), "|") + "`."
	return e
}

// connectedAccountOn finds the one connected account on a cloud.
//
// A cloud with no connected account has three different answers, and the order is the point. A
// cloud this build does not offer gets the one refusal, never a pointer to a command the help
// does not list. A cloud with no connector gets the list of the ones there are, because naming
// `alethia connector <cloud>` without checking it exists promised a command cobra then rejects.
// Only an offered cloud with a connector is told to run it.
//
// Ambiguity is reported, never guessed. Picking the first of two accounts would silently act on a
// different one than the user meant, and the two differ by nothing the output shows.
func connectedAccountOn(identities []api.CloudIdentity, provider string) (*api.CloudIdentity, error) {
	var matches []*api.CloudIdentity
	for i := range identities {
		if identities[i].Provider == provider {
			matches = append(matches, &identities[i])
		}
	}
	switch len(matches) {
	case 0:
		if err := requireCloudOffered(provider); err != nil {
			return nil, err
		}
		notFound := clierr.New(clierr.CodeNotFound, fmt.Sprintf("no connected %s account found", provider))
		if connectorHasProvider(provider) {
			notFound.Hint = fmt.Sprintf("Connect one with `alethia connector %s`.", provider)
		} else {
			notFound.Hint = "The CLI cannot connect one: `alethia connector` covers " +
				strings.Join(connectorProviderNames(), ", ") + "."
		}
		return nil, notFound
	case 1:
		return matches[0], nil
	}
	ids := make([]string, len(matches))
	for i, m := range matches {
		ids[i] = m.ID
	}
	ambiguous := clierr.New(clierr.CodeInvalidUsage,
		fmt.Sprintf("%d connected %s accounts: pass the cloud-identity id instead", len(matches), provider))
	ambiguous.Hint = "The ids are " + strings.Join(ids, ", ") + "."
	return nil, ambiguous
}

// pickConnectedIdentity shows the picker over already-fetched connections and returns the
// chosen identity id. The title is the caller's, because "Select a cloud account" and
// "Select a connection to REMOVE" are not the same question to answer.
func pickConnectedIdentity(title string, identities []api.CloudIdentity) (string, error) {
	options := make([]huh.Option[string], len(identities))
	for i, id := range identities {
		options[i] = huh.NewOption(
			fmt.Sprintf("%s — %s", strings.ToUpper(id.Provider), id.Label),
			id.ID,
		)
	}
	var chosen string
	if err := runHuhForm(huh.NewGroup(
		huh.NewSelect[string]().
			Title(title).
			Options(options...).
			Value(&chosen),
	)); err != nil {
		return "", formError(err)
	}
	if chosen == "" {
		return "", invalidInputError("no cloud account selected")
	}
	return chosen, nil
}

// --- Setup modes ---

// modeFlag pairs a setup-mode flag's name with whether this invocation gave it.
type modeFlag struct {
	name string
	on   bool
}

// refuseMultipleModes refuses more than one setup mode on a single command line.
//
// Every connector resolves its setup with a switch, and a switch settles a combination by
// PRECEDENCE rather than by refusing it: a flag that submits a role and a flag that asks for the
// setup which creates one used to connect and say nothing about the flag it ignored. The user
// asked for one thing and got another. An ignored flag is the same class of defect as a missing
// one, so the combination is named and refused — before anything is created server-side, since
// the flags alone show the mistake.
func refuseMultipleModes(modes ...modeFlag) error {
	given := make([]string, 0, len(modes))
	for _, m := range modes {
		if m.on {
			given = append(given, m.name)
		}
	}
	if len(given) < 2 {
		return nil
	}
	return clierr.New(clierr.CodeInvalidUsage, fmt.Sprintf(
		"%s cannot be combined — each asks for a different setup, so pass one of them",
		strings.Join(given, ", "),
	))
}

// requirePromptFor refuses a setup that ends in a paste when nothing can show the prompt. flags
// names the flag form of the same paste.
func requirePromptFor(mode, what, flags string) error {
	if err := requireInteractiveForm(); err != nil {
		return inputRequiredError(err, "%s needs a terminal to paste %s into: pass %s instead", mode, what, flags)
	}
	return nil
}
