// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/clierr"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/cmdmeta"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/charmbracelet/huh"
	"github.com/spf13/cobra"
)

var channelsCmd = &cobra.Command{
	Use:     "channels",
	Aliases: []string{"channel"},
	Short:   "Manage notification channels",
	Long: `Notification channels are delivery destinations (webhook, email, Slack,
PagerDuty, and more) that alert rules fan out to. List, create, verify, and delete
the active organization's channels.

Commands that act on one channel take its NAME or its id — or nothing at all, and
ask on a terminal.`,
}

var channelsListCmd = &cobra.Command{
	Use:   "list",
	Short: "List notification channels",
	Long: `List the active organization's notification channels: the integration each one
delivers through, whether its endpoint has been verified, and whether it is enabled.
No destination secret is ever printed.`,
	Args: cobra.NoArgs,
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		client := api.NewClient(token)
		if err := runListCommand(cmd, channelListView, client.ListChannels); err != nil {
			fail(err)
		}
	},
}

// channelListView is how `channels list` is drawn.
var channelListView = listView[api.Channel]{
	Spinner: "Fetching channels...",
	Title:   "channels",
	Empty:   "No notification channels found. Create one with `alethia channels create`.",
	Columns: channelListColumns,
	Rows:    channelRows,
}

var channelListColumns = []string{"Name", "Type", "Verified", "Enabled", "ID"}

// channelRows projects channels into plain table rows.
func channelRows(channels []api.Channel, outFmt string) [][]string {
	rows := make([][]string, len(channels))
	for i, c := range channels {
		rows[i] = []string{c.Name, c.Type, ui.Cell(outFmt, ui.WireBool(c.IsVerified), ui.YesNo(c.IsVerified)), ui.Cell(outFmt, ui.WireBool(c.Enabled), ui.YesNo(c.Enabled)), c.ID}
	}
	return rows
}

// runChannelsList fetches and renders the channels (non-interactive path).
func runChannelsList(c apiClient, out io.Writer, format string) error {
	channels, err := c.ListChannels()
	if err != nil {
		return governanceError(err)
	}
	return renderList(out, format, channelListView, channels)
}

// resolveChannel answers "which channel?" for `verify` and `delete`.
//
// It LISTS first, on every path including the one where an id was given. Two reasons, and the
// second is the one that matters:
//
//   - `delete` then names the channel it is about to remove ("Delete channel Ops Slack (slack)?")
//     instead of asking about "this channel". A destructive command that resolved its own target
//     must say what the target was.
//   - refusing an id that is not in the list is SOUND, not merely convenient. Both the list and
//     the delete are scoped to the active organization, so an id absent from the list is one this
//     caller could not have acted on anyway — the CLI is refusing only what the server would
//     certainly refuse, which is the bound the programme puts on client-side validation.
func resolveChannel(c apiClient, args []string) (govRef, error) {
	channels, err := c.ListChannels()
	if err != nil {
		return govRef{}, err
	}
	return resolveGovRef(channelSelect, govRefsFromChannels(channels), args)
}

var (
	channelType               string
	channelRecipients         []string
	channelURL                string
	channelSigningSecret      string
	channelSigningSecretStdin bool
	channelRoutingKey         string
	channelRoutingKeyStdin    bool
)

var channelTypes = []string{"webhook", "email", "slack", "rocketchat", "discord", "teams", "mattermost", "googlechat", "pagerduty"}

var channelsCreateCmd = &cobra.Command{
	Use:   "create [name]",
	Short: "Create a notification channel",
	Long: `Create a notification channel. The destination depends on --type:
  email             one or more --recipient flags
  slack/webhook/... a --url (with an optional signing secret)
  pagerduty         a routing key

Omit anything on a terminal and you are asked for it; every question has a flag,
so --no-input can still create any channel this form can.

The signing secret and the routing key are secrets. Pipe one in with
--signing-secret-stdin or --routing-key-stdin rather than passing it as a flag value:
a flag value lands in your shell history and in the process list. Neither is ever
printed back, in any output format.

The endpoint is verified before the channel is saved (a channel never exists
unverified). --dry-run checks the input, calls nothing, and creates nothing.

Notification channels require a Pro plan or higher.`,
	Args: cobra.MaximumNArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		if err := runChannelsCreateCmd(cmd, args, os.Stdin); err != nil {
			fail(governanceError(err))
		}
	},
}

// runChannelsCreateCmd is `channels create`: it reads a secret from stdin when one was asked for
// that way, fills the channel from the flags and the form, and creates it.
func runChannelsCreateCmd(cmd *cobra.Command, args []string, stdin io.Reader) error {
	p := resultPrinter(cmd)
	token, err := getAuthToken()
	if err != nil {
		return err
	}
	secrets, err := readChannelSecrets(stdin)
	if err != nil {
		return err
	}
	draft, err := resolveChannelDraft(args, secrets)
	if err != nil {
		return err
	}
	return runChannelsCreate(api.NewClient(token), p, draft, cmdmeta.DryRunRequested(cmd))
}

// channelSecrets are the two secret values a channel can carry, from whichever source gave them.
type channelSecrets struct {
	SigningSecret string
	RoutingKey    string
}

// readChannelSecrets returns the signing secret and the routing key: each from its flag, or from
// stdin when its -stdin flag was given.
//
// Stdin is one stream, so it can carry one secret: asking for both from it is refused, and so is
// naming one secret twice. No channel type takes both, so nothing a caller can create is lost.
func readChannelSecrets(stdin io.Reader) (channelSecrets, error) {
	secrets := channelSecrets{SigningSecret: channelSigningSecret, RoutingKey: channelRoutingKey}
	if channelSigningSecretStdin && channelRoutingKeyStdin {
		return secrets, refusal(clierr.CodeInvalidUsage, "",
			"--signing-secret-stdin and --routing-key-stdin both read stdin: pass one of them")
	}
	if channelSigningSecretStdin {
		if channelSigningSecret != "" {
			return secrets, refusal(clierr.CodeInvalidUsage, "",
				"--signing-secret and --signing-secret-stdin both name the signing secret: pass one of them")
		}
		secret, err := readSecretLine(stdin, "signing-secret-stdin")
		if err != nil {
			return secrets, err
		}
		secrets.SigningSecret = secret
	}
	if channelRoutingKeyStdin {
		if channelRoutingKey != "" {
			return secrets, refusal(clierr.CodeInvalidUsage, "",
				"--routing-key and --routing-key-stdin both name the routing key: pass one of them")
		}
		secret, err := readSecretLine(stdin, "routing-key-stdin")
		if err != nil {
			return secrets, err
		}
		secrets.RoutingKey = secret
	}
	return secrets, nil
}

// channelDraft is one answered `channels create` form: the same four values whether they arrived
// as flags or as answers.
//
// One struct rather than the six package-level flag variables read directly, because the form
// writes into it too — and a form that wrote back into the flag globals would leave `--type`
// "changed" for every later command in the same process, which is exactly the leak
// hyg_cli_confirm_test.go has to clean up around `--yes`.
type channelDraft struct {
	Name          string
	Type          string
	Recipients    []string
	URL           string
	SigningSecret string
	RoutingKey    string
}

// config assembles the create payload's `config` bag, translating the CLI's flags into the wire
// shape. Only the keys the chosen type uses are sent.
func (d channelDraft) config() map[string]interface{} {
	config := map[string]interface{}{}
	if len(d.Recipients) > 0 {
		config["recipients"] = d.Recipients
	}
	if d.URL != "" {
		config["url"] = d.URL
	}
	if d.SigningSecret != "" {
		config["signing_secret"] = d.SigningSecret
	}
	if d.RoutingKey != "" {
		config["routing_key"] = d.RoutingKey
	}
	return config
}

// channelDestination classifies a channel type by the destination it needs.
//
// It is derived from the type, not asked separately, so the form cannot present a webhook URL
// question for a PagerDuty channel — the mismatch the old flag-only surface allowed, and which the
// server answered with a validation error after the user had typed everything.
type channelDestination int

const (
	// channelDestEmail takes recipients.
	channelDestEmail channelDestination = iota
	// channelDestRoutingKey takes a PagerDuty Events API routing key.
	channelDestRoutingKey
	// channelDestURL takes a webhook URL. The default: every chat integration Alethia ships
	// (Slack, Discord, Teams, Mattermost, Rocket.Chat, Google Chat) and the generic webhook
	// deliver to a URL, so a NEW chat type added to the enum gets the right question without
	// anyone editing this switch.
	channelDestURL
)

// destinationFor returns the destination a channel type needs.
func destinationFor(channelType string) channelDestination {
	switch strings.ToLower(strings.TrimSpace(channelType)) {
	case "email":
		return channelDestEmail
	case "pagerduty":
		return channelDestRoutingKey
	default:
		return channelDestURL
	}
}

// errChannelTypeRequired is the refusal when no --type was given and nothing may be asked.
var errChannelTypeRequired error = refusal(clierr.CodeInputRequired, channelsCreateExample,
	"--type is required (%s) — with --no-input there is nowhere to ask",
	strings.Join(channelTypeNames(), ", "))

// channelsCreateExample is the complete command line the missing-value refusals offer.
const channelsCreateExample = `alethia channels create "Ops Slack" --type slack --url https://hooks.slack.com/services/T000/B000/XXXX`

// errChannelNameRequired is the refusal when no name was given and nothing may be asked.
var errChannelNameRequired error = refusal(clierr.CodeInputRequired, channelsCreateExample,
	"a channel name is required — pass it as the argument, or run on a terminal to be asked")

// resolveChannelDraft fills a draft from the flags, then asks for whatever is still missing.
//
// The order is deliberate: the TYPE is settled before the destination question, because the type
// is what decides which destination question there is.
func resolveChannelDraft(args []string, secrets channelSecrets) (channelDraft, error) {
	draft := channelDraft{
		Type:          channelType,
		Recipients:    channelRecipients,
		URL:           channelURL,
		SigningSecret: secrets.SigningSecret,
		RoutingKey:    secrets.RoutingKey,
	}
	if len(args) > 0 && strings.TrimSpace(args[0]) != "" {
		draft.Name = strings.TrimSpace(args[0])
	}

	if draft.complete() {
		return draft, nil
	}
	if err := requireInteractiveForm(); err != nil {
		// The specific missing value, not a generic "interactive input required". A caller who
		// passed a --type and forgot the --url should be told about the url.
		if strings.TrimSpace(draft.Name) == "" {
			return draft, errChannelNameRequired
		}
		if strings.TrimSpace(draft.Type) == "" {
			return draft, errChannelTypeRequired
		}
		return draft, draft.missingDestinationErr()
	}
	return askChannelDraft(draft)
}

// complete reports whether the draft can be sent without asking anything: a name, a type, and the
// destination that type needs.
func (d channelDraft) complete() bool {
	if strings.TrimSpace(d.Name) == "" || strings.TrimSpace(d.Type) == "" {
		return false
	}
	return d.hasDestination()
}

// hasDestination reports whether the draft carries the destination its type needs.
func (d channelDraft) hasDestination() bool {
	switch destinationFor(d.Type) {
	case channelDestEmail:
		return len(d.Recipients) > 0
	case channelDestRoutingKey:
		return strings.TrimSpace(d.RoutingKey) != ""
	case channelDestURL:
		return strings.TrimSpace(d.URL) != ""
	}
	// Unreachable: destinationFor returns one of the three. Named rather than left to `default`
	// so `exhaustive` fails when a fourth destination is added instead of silently routing it to
	// the URL arm — a new destination reported as "needs --url" is the wrong refusal.
	return strings.TrimSpace(d.URL) != ""
}

// missingDestinationErr names the flag this type needs, rather than listing all three.
func (d channelDraft) missingDestinationErr() error {
	switch destinationFor(d.Type) {
	case channelDestEmail:
		return refusal(clierr.CodeInputRequired, "", "an %s channel needs at least one --recipient", d.Type)
	case channelDestRoutingKey:
		return refusal(clierr.CodeInputRequired, "",
			"a %s channel needs --routing-key, or --routing-key-stdin to read it from stdin", d.Type)
	case channelDestURL:
		return refusal(clierr.CodeInputRequired, "", "a %s channel needs --url", d.Type)
	}
	return refusal(clierr.CodeInputRequired, "", "a %s channel needs --url", d.Type)
}

// askChannelDraft opens the create form for whatever the flags did not supply.
//
// TWO forms, not one, and the split is load-bearing: huh builds a group's fields when the group is
// built, so a single form cannot decide which destination question to show based on a type the
// user has not chosen yet. The type is settled first; the destination question is then the one
// question that type has.
func askChannelDraft(draft channelDraft) (channelDraft, error) {
	var fields []huh.Field
	if strings.TrimSpace(draft.Name) == "" {
		f := mustGovField("alethia channels create", fieldKeyChannelName)
		fields = append(fields, huh.NewInput().
			Title(f.Title).Description(f.Description).Value(&draft.Name))
	}
	if strings.TrimSpace(draft.Type) == "" {
		f := mustGovField("alethia channels create", fieldKeyChannelType)
		options := make([]huh.Option[string], len(channelTypeNames()))
		for i, name := range channelTypeNames() {
			options[i] = huh.NewOption(name, name)
		}
		fields = append(fields, huh.NewSelect[string]().
			Title(f.Title).Description(f.Description).Options(options...).Value(&draft.Type))
	}
	if len(fields) > 0 {
		if err := runHuhForm(huh.NewGroup(fields...)); err != nil {
			return draft, err
		}
	}

	if draft.hasDestination() {
		return draft, nil
	}
	return askChannelDestination(draft)
}

// askChannelDestination asks the one destination question the chosen type has.
func askChannelDestination(draft channelDraft) (channelDraft, error) {
	switch destinationFor(draft.Type) {
	case channelDestEmail:
		f := mustGovField("alethia channels create", fieldKeyChannelRecipient)
		var joined string
		if err := runHuhForm(huh.NewGroup(huh.NewInput().
			Title(f.Title).Description(f.Description).Value(&joined))); err != nil {
			return draft, err
		}
		draft.Recipients = splitList(joined)
	case channelDestRoutingKey:
		f := mustGovField("alethia channels create", fieldKeyChannelRoutingKey)
		// Masked: the key is a credential, and an unmasked field leaves it on the screen and in
		// the terminal's scrollback.
		if err := runHuhForm(huh.NewGroup(huh.NewInput().
			Title(f.Title).Description(f.Description).EchoMode(huh.EchoModePassword).
			Value(&draft.RoutingKey))); err != nil {
			return draft, err
		}
	case channelDestURL:
		f := mustGovField("alethia channels create", fieldKeyChannelURL)
		if err := runHuhForm(huh.NewGroup(huh.NewInput().
			Title(f.Title).Description(f.Description).Value(&draft.URL))); err != nil {
			return draft, err
		}
	}
	return draft, nil
}

// splitList parses a comma- or space-separated answer into its entries, dropping the empties a
// trailing separator leaves behind.
//
// One place, because a form that asks for "one or more" of anything gets an answer in whatever
// separator the person reached for. `strings.Split` alone yields a trailing "" for "a@b.com," —
// which reaches the server as an empty recipient and fails the create with a message about a
// value the user cannot see in what they typed.
func splitList(raw string) []string {
	parts := strings.FieldsFunc(raw, func(r rune) bool {
		return r == ',' || r == ' ' || r == '\t' || r == '\n' || r == ';'
	})
	var out []string
	for _, p := range parts {
		if v := strings.TrimSpace(p); v != "" {
			out = append(out, v)
		}
	}
	return out
}

// channelRequest is the request `channels create` sends, as a dry run reports it. A secret is
// reported as present or absent, never by value.
type channelRequest struct {
	Name             string   `json:"name"`
	Type             string   `json:"type"`
	Recipients       []string `json:"recipients,omitempty"`
	URL              string   `json:"url,omitempty"`
	HasSigningSecret bool     `json:"has_signing_secret"`
	HasRoutingKey    bool     `json:"has_routing_key"`
}

// runChannelsCreate creates a channel and confirms it.
func runChannelsCreate(c apiClient, p *Printer, draft channelDraft, dryRun bool) error {
	canonical, err := canonicalOneOf("type", draft.Type, channelTypes)
	if err != nil {
		return err
	}
	if dryRun {
		return printDryRun(p, MutationResult{
			ID: draft.Name, Kind: govKindChannel, Action: ResultCreated,
			Object: plannedRequest{Request: channelRequest{
				Name: draft.Name, Type: canonical, Recipients: draft.Recipients, URL: draft.URL,
				HasSigningSecret: draft.SigningSecret != "", HasRoutingKey: draft.RoutingKey != "",
			}},
		}, fmt.Sprintf("Would create %s channel %s", canonical, draft.Name))
	}
	ch, err := c.CreateChannel(draft.Name, canonical, draft.config())
	if err != nil {
		return err
	}
	if ch == nil {
		return errNoRecord("channel")
	}
	return printChange(p, MutationResult{ID: ch.ID, Kind: govKindChannel, Action: ResultCreated, Object: ch},
		fmt.Sprintf("Created %s channel %s (%s)", ch.Type, ch.Name, ch.ID))
}

var channelsVerifyCmd = &cobra.Command{
	Use:   "verify [channel]",
	Short: "Send a test event through a channel and mark it verified",
	Long: `Send a synthetic event through a channel and mark it verified. Use it after the
destination changed, or to check that a channel still delivers. Each run sends one test
event to the real destination.

Name the channel by its name or its id; omit it on a terminal and you are asked which.
--dry-run names the channel that would be tested and sends nothing.`,
	Args: cobra.MaximumNArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		if err := runChannelsVerifyCmd(cmd, args); err != nil {
			fail(governanceError(err))
		}
	},
}

// runChannelsVerifyCmd is `channels verify`: it resolves the channel and sends the test event.
func runChannelsVerifyCmd(cmd *cobra.Command, args []string) error {
	p := resultPrinter(cmd)
	token, err := getAuthToken()
	if err != nil {
		return err
	}
	client := api.NewClient(token)
	ref, err := resolveChannel(client, args)
	if err != nil {
		return err
	}
	if cmdmeta.DryRunRequested(cmd) {
		return printDryRun(p, MutationResult{
			ID: ref.ID, Kind: govKindChannel, Action: ResultUpdated,
			Object: removedRecord{ID: ref.ID, Name: ref.Name},
		}, "Would send a test event through channel "+ref.Name)
	}
	return runChannelsVerify(client, p, ref.ID)
}

// runChannelsVerify verifies a channel and confirms it.
//
// The nil check is not defensive padding. VerifyChannel decodes `{"channel": …}` out of a 200 and
// returns a POINTER, so a success response that carries no channel object — a partial deploy, a
// proxy that rewrote the body, a server that changed the envelope key — yields (nil, nil), and the
// confirmation line below dereferenced it. That was a panic with a Go stack trace where the honest
// answer is "the control plane said yes and did not say what it verified". Found by driving the
// command against a fake control plane whose envelope had no channel key.
func runChannelsVerify(c apiClient, p *Printer, id string) error {
	ch, err := c.VerifyChannel(id)
	if err != nil {
		return notFoundHint(err, channelSelect.ListCmd)
	}
	if ch == nil {
		return clierr.New(clierr.CodeInternal, "the control plane accepted the verification but returned no channel")
	}
	return printChange(p, MutationResult{ID: ch.ID, Kind: govKindChannel, Action: ResultUpdated, Object: ch},
		"Verified channel "+ch.Name)
}

// channelsDeleteYes is the --yes opt-in: skip the confirmation prompt (and make the
// command usable with --no-input).
var channelsDeleteYes bool

var channelsDeleteCmd = &cobra.Command{
	Use:   "delete [channel]",
	Short: "Delete a notification channel",
	Long: `Delete a notification channel. Alert rules that route to it lose this destination.
This cannot be undone; create the channel again to restore it.

Name the channel by its name or its id; omit it on a terminal and you are asked which.
The command asks before it deletes; with nobody to ask, pass --yes. --dry-run names the
channel that would be deleted and deletes nothing.`,
	Args: cobra.MaximumNArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		if err := runChannelsDeleteCmd(cmd, args); err != nil {
			fail(governanceError(err))
		}
	},
}

// runChannelsDeleteCmd is `channels delete`: it resolves the channel, confirms, and deletes it.
func runChannelsDeleteCmd(cmd *cobra.Command, args []string) error {
	p := resultPrinter(cmd)
	token, err := getAuthToken()
	if err != nil {
		return err
	}
	client := api.NewClient(token)
	ref, err := resolveChannel(client, args)
	if err != nil {
		return err
	}
	if cmdmeta.DryRunRequested(cmd) {
		return printDryRun(p, govRefRemoval(govKindChannel, ref), "Would delete channel "+ref.Name)
	}
	ok, err := confirmChange(channelsDeleteYes, "alethia channels delete "+shellQuote(ref.ID),
		"Delete "+ref.Label+"?", "Alert rules bound to it will lose this destination. This cannot be undone.")
	if err != nil || !ok {
		return err
	}
	return runChannelsDelete(client, p, ref)
}

// runChannelsDelete deletes a channel and confirms it.
func runChannelsDelete(c apiClient, p *Printer, ref govRef) error {
	if err := c.DeleteChannel(ref.ID); err != nil {
		return notFoundHint(err, channelSelect.ListCmd)
	}
	return printChange(p, govRefRemoval(govKindChannel, ref), "Deleted channel "+ref.Name)
}

func init() {
	addYesFlag(channelsDeleteCmd, &channelsDeleteYes)
	channelsCreateCmd.Flags().StringVar(&channelType, "type", "",
		"Channel type ("+strings.Join(channelTypeNames(), ", ")+")")
	channelsCreateCmd.Flags().StringArrayVar(&channelRecipients, "recipient", nil, "Email recipient (repeatable; email channels)")
	channelsCreateCmd.Flags().StringVar(&channelURL, "url", "", "Destination webhook URL (slack/webhook/…)")
	channelsCreateCmd.Flags().StringVar(&channelSigningSecret, "signing-secret", "",
		"Optional webhook signing secret (prefer --signing-secret-stdin: a flag lands in your shell history and the process list)")
	channelsCreateCmd.Flags().BoolVar(&channelSigningSecretStdin, "signing-secret-stdin", false,
		"Read the webhook signing secret from stdin")
	channelsCreateCmd.Flags().StringVar(&channelRoutingKey, "routing-key", "",
		"PagerDuty Events API routing key (prefer --routing-key-stdin: a flag lands in your shell history and the process list)")
	channelsCreateCmd.Flags().BoolVar(&channelRoutingKeyStdin, "routing-key-stdin", false,
		"Read the PagerDuty routing key from stdin")

	channelsCmd.AddCommand(channelsListCmd)
	channelsCmd.AddCommand(channelsCreateCmd)
	channelsCmd.AddCommand(channelsVerifyCmd)
	channelsCmd.AddCommand(channelsDeleteCmd)
	rootCmd.AddCommand(channelsCmd)
}
