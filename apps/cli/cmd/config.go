// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"io"
	"net/url"
	"strings"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/clierr"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/charmbracelet/huh"
	"github.com/spf13/cobra"
)

var configCmd = &cobra.Command{
	Use:   "config",
	Short: "Show or edit CLI configuration",
	Long: `Show the configuration this CLI runs with: the control-plane URL and where it comes from
(the environment, the config file or the default), the active organization, and where the
credentials and the config file are on disk.

Use it to check which control plane and which organization a command will act on. It reads
local files only and sends nothing. "config get" prints one value for a script, and
"config set" changes one.`,
	Args: cobra.NoArgs,
	Run: func(cmd *cobra.Command, args []string) {
		credsPath, _ := getCredentialsPath()
		cfgPath, _ := types.CliConfigPath()
		origin, source := types.ResolveWebOrigin()
		p := printerFor(cmd)
		if err := runConfigShow(
			p.Out, p.Format,
			origin, source, types.LoadCliConfig(), credsPath, cfgPath,
		); err != nil {
			fail(err)
		}
	},
}

var configSetCmd = &cobra.Command{
	Use:   "set [key] [value]",
	Short: "Set a config value",
	Long: `Write one config value to the CLI's config file.

Use it to point the CLI at another control plane: "web-origin" is the one key it writes. The
active organization is written by "alethia org switch", which also checks that you belong to it.

Run it with no arguments on a terminal to pick the key from a list and edit the current value in
place. The arguments are the complete non-interactive contract: anything the form can ask,
` + "`set <key> <value>`" + ` can supply, so --no-input never needs a prompt. Setting a key to the
value it already has changes nothing and says so.`,
	Args: cobra.MaximumNArgs(2),
	Run: func(cmd *cobra.Command, args []string) {
		key, value := "", ""
		if len(args) > 0 {
			key = args[0]
		}
		if len(args) > 1 {
			value = args[1]
		}
		key, value, err := promptConfigSet(key, value)
		if err != nil {
			fail(err)
			return
		}
		change, err := setConfigValue(key, value)
		if err != nil {
			fail(err)
			return
		}
		p := printerFor(cmd)
		if err := p.Result(change.mutation(), func(w io.Writer) { fmt.Fprintln(w, change.sentence()) }); err != nil {
			fail(err)
			return
		}
		if note := change.Shadowed; note != "" {
			p.Warn(note)
		}
	},
}

var configGetCmd = &cobra.Command{
	Use:   "get [key]",
	Short: "Get a config value",
	Long: `Print one config value, or every one of them.

Use it in a script to read the value the CLI is using: with a key, stdout is that value and
nothing else. "web-origin" is the resolved control-plane URL, so it reflects the environment
variable when one is set.

The key is optional and its default is ALL of them, so a bare 'config get' answers
rather than asks. A key this CLI does not have is refused with the keys it does
have — or, on a terminal, replaced by a picker rather than a retype.`,
	Args: cobra.MaximumNArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		key := ""
		if len(args) > 0 {
			key = args[0]
		}
		key, err := resolveConfigGetKey(key)
		if err != nil {
			fail(err)
			return
		}
		p := printerFor(cmd)
		if err := runConfigGet(p.Out, p.Format, key); err != nil {
			fail(err)
		}
	},
}

var configClearContextCmd = &cobra.Command{
	Use:   "clear-context",
	Short: "Clear the active organization context",
	Long: `Remove the active organization from the CLI's config file, so commands act in your
personal scope until you choose an organization again.

Use it to leave an organization without switching to another one. It changes only the local
config file: nothing is sent, and no organization or membership is touched. Run
"alethia org switch" to choose an organization again. Clearing a context that is already clear
changes nothing and says so.`,
	Args: cobra.NoArgs,
	Run: func(cmd *cobra.Command, args []string) {
		cleared, err := clearActiveOrg()
		if err != nil {
			fail(err)
			return
		}
		if err := printerFor(cmd).Result(cleared.mutation(), func(w io.Writer) {
			fmt.Fprintln(w, cleared.sentence())
		}); err != nil {
			fail(err)
		}
	},
}

// clearedContext is what `config clear-context` did: the organization that was active, if any.
type clearedContext struct {
	// ActiveOrgID and ActiveOrgName are the organization that was active before. Both are empty
	// when none was.
	ActiveOrgID   string `json:"previous_org_id"`
	ActiveOrgName string `json:"previous_org_name"`
}

// mutation is the clearing as the one result shape every mutating command returns.
func (c clearedContext) mutation() MutationResult {
	action := ResultUpdated
	if c.ActiveOrgID == "" && c.ActiveOrgName == "" {
		action = ResultUnchanged
	}
	return MutationResult{ID: "active-org", Kind: "config", Action: action, Object: c}
}

// sentence says what happened, for a person.
func (c clearedContext) sentence() string {
	if c.ActiveOrgID == "" && c.ActiveOrgName == "" {
		return ui.MutedStyle.Render("No organization was active. Nothing changed.")
	}
	return ui.FormatSuccess("Active organization context cleared.")
}

// clearActiveOrg removes the active organization from the config file and reports which one it
// was.
func clearActiveOrg() (clearedContext, error) {
	cfg := types.LoadCliConfig()
	was := clearedContext{ActiveOrgID: cfg.ActiveOrgID, ActiveOrgName: cfg.ActiveOrgName}
	cfg.ActiveOrgID, cfg.ActiveOrgName, cfg.ActiveOrgSlug = "", "", ""
	if err := types.SaveCliConfig(cfg); err != nil {
		return was, fmt.Errorf("failed to clear context: %w", err)
	}
	return was, nil
}

// configExportCmd is the old name of `alethia export --format console-json`, kept so a script
// written against it still runs. It is hidden, says so once on stderr, and keeps the contract it
// always had: --out replaces an existing file without being asked.
var configExportCmd = &cobra.Command{
	Use:    "export [project]",
	Hidden: true,
	Short:  "Deprecated: use `alethia export --format console-json`",
	Long: `Deprecated: this is the old name of "alethia export --format console-json", which writes the
same document.

It exports one environment's design document as JSON: to stdout, to the file --out names, or
with --output json as an object that also carries the file name and the format. --env chooses the
environment (by id, name or stage; an exact name wins over a stage); without it the project's
default environment is exported.`,
	Args: cobra.MaximumNArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		renamedCommandNotice("config export", "export --format "+exportFormatConsoleJSON)
		token, err := getAuthToken()
		if err != nil {
			fail(err)
			return
		}
		project, err := exportProject(token, args)
		if err != nil {
			fail(err)
			return
		}
		contentFormat, _ := cmd.Flags().GetString("format")
		outFile, _ := cmd.Flags().GetString("out")
		env, _ := cmd.Flags().GetString("env")
		if err := runConsoleExport(api.NewClient(token), printerFor(cmd), consoleExport{
			project: project, env: env, out: outFile, force: true, contentFormat: contentFormat,
		}); err != nil {
			fail(err)
		}
	},
}

// configView is the json projection of the CLI config.
type configView struct {
	WebOrigin       string `json:"web_origin"`
	WebOriginSource string `json:"web_origin_source"`
	ActiveOrgName   string `json:"active_org_name"`
	ActiveOrgID     string `json:"active_org_id"`
	CredentialsPath string `json:"credentials_path"`
	ConfigPath      string `json:"config_path"`
}

// runConfigShow renders the resolved CLI configuration as a Field/Value view
// (table/csv) or a json object, annotating the web-origin with its source.
func runConfigShow(out io.Writer, format, webOrigin string, source types.WebOriginSource, cfg types.CliConfig, credsPath, cfgPath string) error {
	view := configView{
		WebOrigin:       webOrigin,
		WebOriginSource: string(source),
		ActiveOrgName:   cfg.ActiveOrgName,
		ActiveOrgID:     cfg.ActiveOrgID,
		CredentialsPath: credsPath,
		ConfigPath:      cfgPath,
	}
	rows := [][]string{
		{"web origin", fmt.Sprintf("%s (%s)", webOrigin, source)},
		{"active org", ui.OrDash(cfg.ActiveOrgName)},
		{"active org id", ui.OrDash(cfg.ActiveOrgID)},
		{"credentials", credsPath},
		{"config", cfgPath},
	}
	return ui.RenderCard(out, format, "alethia · config", rows, view)
}

// configField is ONE key of the CLI's on-disk configuration — what it is called,
// what it means, and how it is read and written.
//
// One spec, four renderings: `config get` reads through it, `config set` writes
// through it, `config set`'s interactive form builds its picker and its validator
// from it, and the "Config keys" table in
// apps/docs/content/docs/reference/cli/configuration.mdx carries the same rows. The docs
// half is not a convention — TestHygCliAuthForm_ConfigKeyDocsTableMirrorsTheSpec
// fails if the table and this slice disagree in either direction.
//
// Before this there were four hand-written lists and they already disagreed.
// `config set` accepted `web-origin`; `config get` accepted `web-origin` and
// `active-org`; each error message spelled its own "supported:" list; and the
// docs page named a third set. A reader who ran `alethia config set active-org
// acme` — a key `config get` had just told them existed — was answered "unknown
// config key", with no hint that `alethia org switch` is what writes it.
type configField struct {
	// Key is the canonical spelling, and the one the docs table carries.
	Key string
	// Aliases are additional accepted spellings. The underscore forms exist
	// because the on-disk JSON uses them and people type what they have read.
	Aliases []string
	// Summary is the one sentence that appears in the form's description AND in
	// the docs table. One sentence, one owner.
	Summary string
	// Normalize validates and canonicalizes a candidate value. It is the form's
	// live validator and the `config set` gate — the same function, so a value the
	// form accepted can never be refused a moment later. nil for a read-only key.
	Normalize func(string) (string, error)
	// Apply writes a normalized value into the config. nil for a read-only key.
	Apply func(cfg *types.CliConfig, normalized string)
	// SetVia names the command that writes a READ-ONLY key. A key that can be read
	// and not written needs to say what does write it; "unknown key" would be a
	// lie, and silence would be worse.
	SetVia string
	// Read returns the key's current value, RAW — no placeholder for an empty one.
	// `config get` feeds it to json and csv as well as to the table, so a `—` here
	// would be a presentation glyph a script has to test for; the table branch of
	// runConfigGet applies ui.OrDash instead.
	//
	// It takes an origin as well as the stored config because `web-origin`'s value
	// can come from the environment, which is not in the file — and the two callers
	// mean different origins on purpose. `config get` passes the RESOLVED one
	// (what commands actually talk to); `config set`'s form passes the STORED one,
	// because the form seeds what the write is about to replace.
	Read func(cfg types.CliConfig, origin string) string
}

// settable reports whether `config set` may write this key.
func (f configField) settable() bool { return f.Normalize != nil && f.Apply != nil }

// configFields is the spec. Order is the order the docs table and the `get all`
// output use.
var configFields = []configField{
	{
		Key:       "web-origin",
		Aliases:   []string{"web_origin"},
		Summary:   "The control-plane URL the CLI talks to (hosted, self-hosted or dev).",
		Normalize: normalizeWebOrigin,
		Apply:     func(cfg *types.CliConfig, v string) { cfg.WebOrigin = v },
		Read:      func(_ types.CliConfig, origin string) string { return origin },
	},
	{
		Key:     "active-org",
		Aliases: []string{"active_org"},
		Summary: "The organization every request is scoped to, sent as X-Alethia-Org.",
		// Deliberately read-only. Setting it by name would have to resolve the name
		// to an id and a slug — which is a server round-trip, i.e. `org switch`. A
		// `config set active-org` that wrote only the name would leave the id stale
		// and every request scoped to the PREVIOUS organization.
		SetVia: "alethia org switch",
		Read:   func(cfg types.CliConfig, _ string) string { return cfg.ActiveOrgName },
	},
}

// lookupConfigField resolves a user-typed key to its spec, honouring aliases and
// case. Returns nil for an unknown key.
func lookupConfigField(key string) *configField {
	k := strings.ToLower(strings.TrimSpace(key))
	for i := range configFields {
		if configFields[i].Key == k {
			return &configFields[i]
		}
		for _, a := range configFields[i].Aliases {
			if a == k {
				return &configFields[i]
			}
		}
	}
	return nil
}

// configKeyList renders the canonical key names for an error message. settableOnly
// narrows it to the keys `config set` can write, so the two error messages cannot
// drift apart the way the hand-written ones did.
func configKeyList(settableOnly bool) string {
	names := make([]string, 0, len(configFields))
	for _, f := range configFields {
		if settableOnly && !f.settable() {
			continue
		}
		names = append(names, f.Key)
	}
	return strings.Join(names, ", ")
}

// errUnknownConfigKey refuses a key this CLI does not have, naming the ones it does.
func errUnknownConfigKey(key string) error {
	return refusal(clierr.CodeInvalidUsage, "alethia config get",
		"unknown config key %q (supported: %s)", key, configKeyList(false))
}

// errReadOnlyConfigKey refuses to write a key another command owns, and names that command.
func errReadOnlyConfigKey(f *configField) error {
	return refusal(clierr.CodeInvalidUsage, f.SetVia,
		"config key %q is read-only — set it with `%s`", f.Key, f.SetVia)
}

// configChange is what `config set` did to one key.
type configChange struct {
	Key string `json:"key"`
	// Value is the value now stored, normalized.
	Value string `json:"value"`
	// Previous is the value that was stored before. Empty when none was.
	Previous string `json:"previous"`
	// Shadowed says, when it is not empty, that the stored value is not the one commands use,
	// and why.
	Shadowed string `json:"shadowed,omitempty"`
}

// mutation is the change as the one result shape every mutating command returns.
func (c configChange) mutation() MutationResult {
	action := ResultUpdated
	if c.Previous == c.Value {
		action = ResultUnchanged
	}
	return MutationResult{ID: c.Key, Kind: "config", Action: action, Object: c}
}

// sentence says what happened, for a person.
func (c configChange) sentence() string {
	if c.Previous == c.Value {
		return ui.MutedStyle.Render(c.Key + " is already " + c.Value + ". Nothing changed.")
	}
	return ui.FormatSuccess(c.Key + " set to " + c.Value)
}

// setConfigValue validates and persists a single config key, and returns what changed.
func setConfigValue(key, value string) (configChange, error) {
	f := lookupConfigField(key)
	if f == nil {
		return configChange{}, errUnknownConfigKey(key)
	}
	if !f.settable() {
		return configChange{}, errReadOnlyConfigKey(f)
	}
	normalized, err := f.Normalize(value)
	if err != nil {
		return configChange{}, err
	}
	cfg := types.LoadCliConfig()
	change := configChange{Key: f.Key, Value: normalized, Previous: f.Read(cfg, cfg.WebOrigin)}
	f.Apply(&cfg, normalized)
	if err := types.SaveCliConfig(cfg); err != nil {
		return change, fmt.Errorf("failed to save config: %w", err)
	}
	// The persisted value is not necessarily the EFFECTIVE one: $ALETHIA_WEB_ORIGIN
	// outranks the config file, so without this line `config set web-origin` reports
	// success and every subsequent command still talks to the environment's origin.
	if resolved, source := types.ResolveWebOrigin(); f.Key == "web-origin" &&
		source == types.WebOriginFromEnv && resolved != normalized {
		change.Shadowed = fmt.Sprintf(
			"$ALETHIA_WEB_ORIGIN is set to %s and outranks the config file, so commands still use it.",
			resolved)
	}
	return change, nil
}

// runConfigSet validates and persists a single config key, and says what it did on out. It is
// what the first-run commands call when they persist the control-plane URL as one of their steps;
// `config set` itself reports through the Printer.
func runConfigSet(out io.Writer, key, value string) error {
	change, err := setConfigValue(key, value)
	if err != nil {
		return err
	}
	fmt.Fprintln(out, ui.FormatSuccess(change.Key+" set to "+change.Value))
	if change.Shadowed != "" {
		fmt.Fprintln(out, ui.MutedStyle.Render("Note: "+change.Shadowed))
	}
	return nil
}

// runConfigGet prints one or all config values.
//
// The table format prints the BARE value and nothing else, because
// `$(alethia config get web-origin)` is the whole point of the command; json and
// csv render key/value pairs for a caller that wants them labelled. Before this
// the -o flag was accepted and silently ignored on every `config get`.
//
// ui.OrDash is applied HERE, in the table branches only. It is a placeholder for a
// person reading a column, and json and csv are read by programs: an unset key has
// to arrive as "" so an emptiness test answers "unset", rather than as an em dash
// that is non-empty and then flows into whatever the script feeds next.
func runConfigGet(out io.Writer, format, key string) error {
	cfg := types.LoadCliConfig()
	origin, _ := types.ResolveWebOrigin()

	if k := strings.ToLower(strings.TrimSpace(key)); k == "" || k == "all" {
		rows := make([][]string, 0, len(configFields))
		record := make(map[string]string, len(configFields))
		for _, f := range configFields {
			v := f.Read(cfg, origin)
			rows = append(rows, []string{f.Key, v})
			record[f.Key] = v
		}
		if format == "" || format == ui.FormatTable {
			for _, r := range rows {
				fmt.Fprintf(out, "%s: %s\n", r[0], ui.OrDash(r[1]))
			}
			return nil
		}
		return ui.Render(out, format, ui.TableSpec{Columns: []string{"Key", "Value"}, Rows: rows}, record)
	}

	f := lookupConfigField(key)
	if f == nil {
		return errUnknownConfigKey(key)
	}
	v := f.Read(cfg, origin)
	if format == "" || format == ui.FormatTable {
		fmt.Fprintln(out, ui.OrDash(v))
		return nil
	}
	return ui.Render(out, format,
		ui.TableSpec{Columns: []string{"Key", "Value"}, Rows: [][]string{{f.Key, v}}},
		map[string]string{f.Key: v})
}

// configGetKeyOptions is what the `config get` picker offers: every key in the spec,
// labelled with its own summary.
//
// It is a named function rather than a loop inside the form because the SET is the claim
// worth testing — huh exposes no way to read a Select's options back, so a picker built
// inline can only be checked by what it happens to return.
func configGetKeyOptions() []huh.Option[string] {
	opts := make([]huh.Option[string], 0, len(configFields))
	for _, f := range configFields {
		opts = append(opts, huh.NewOption(f.Key+" — "+f.Summary, f.Key))
	}
	return opts
}

// resolveConfigGetKey answers a `config get` key this CLI does not have, and leaves
// every other case exactly as it was.
//
// # It does NOT put a picker in front of a bare `config get`
//
// That argument has a default and the default is EVERY key, so the bare command already
// prints the fuller answer; a picker there would replace two printed rows with a keystroke
// and one of them. The recorded reason in hyg_cli_authform_test.go's authFormNoFieldSpec —
// "its only input is a key with a default (all of them), so there is no question to ask" —
// is about that case and still holds. What this asks about is a value the CLI has already
// REJECTED, which is a different question, and the only one the reader cannot answer
// without retyping the whole command.
//
// The shape is openProjectName's, deliberately: a reference outside a closed, known set
// buys a refusal that names the real members, or, on a terminal, a picker instead of a
// retype. With prompting disabled the refusal is the one runConfigGet would have produced,
// word for word, so nothing about `--no-input` changes — the argument remains the complete
// non-interactive contract.
//
// # Why the picker offers every key and not the settable ones
//
// promptConfigSet's picker filters on settable(), because a read-only key is nothing `set`
// can act on. `get` reads them all — `active-org` is read-only and is one of the two values
// a person runs this command for — so filtering here would hide a key the refusal it
// replaces had just named as supported.
//
// It is a package variable for the reason seams.go records: stubbing runHuhForm stops the
// prompt blocking, but no stub can answer through a pointer the huh group owns.
var resolveConfigGetKey = func(key string) (string, error) {
	k := strings.ToLower(strings.TrimSpace(key))
	if k == "" || k == "all" || lookupConfigField(k) != nil {
		return key, nil
	}
	if !canPromptForm() {
		return "", errUnknownConfigKey(key)
	}

	opts := configGetKeyOptions()
	if len(opts) == 0 {
		// Unreachable while the spec holds a key, and a real answer if that ever stops being
		// true: an empty picker is a box nobody can answer, and the empty string it would
		// return is what `config get` reads as "all of them" — so the miss would print a
		// whole configuration and read as a success.
		return "", refusal(clierr.CodeInvalidUsage, "",
			"unknown config key %q, and this CLI has no config key to offer", key)
	}
	chosen := opts[0].Value
	// The title is written here rather than resolved from authFields, because `alethia config
	// get` deliberately carries no row there and so there is nothing to resolve it from.
	// Adding a row purely to have a source would fail
	// TestHygCliAuthForm_InputTakingLeavesHaveFieldsOrAStatedReason unless the recorded
	// exemption went with it — which would trade a local string for the deletion of a
	// decision. openProjectName's picker is a local string for its own reason (its group's
	// spec has no Title column at all), and this is the second case of the same trade.
	if err := runHuhForm(huh.NewGroup(
		huh.NewSelect[string]().
			Title("Config key").
			Description(fmt.Sprintf("%q is not a config key — which one did you mean?", key)).
			Options(opts...).
			Value(&chosen),
	)); err != nil {
		return "", err
	}
	return chosen, nil
}

// promptConfigSet fills in a missing key or value from the interactive form, and
// returns what `config set` should act on.
//
// It is a package variable for the reason seams.go records: stubbing runHuhForm
// stops the prompt blocking, but no stub can answer through a pointer the huh
// group owns, so the ANSWERED branch is otherwise unreachable from a test.
//
// With prompting disabled it does not guess. `config set` with a missing argument
// under --no-input is a scripting mistake, and the error names the shape that
// works rather than silently writing a default.
var promptConfigSet = func(key, value string) (string, string, error) {
	if key != "" && value != "" {
		return key, value, nil
	}
	if !canPromptForm() {
		return "", "", refusal(clierr.CodeInputRequired,
			"alethia config set web-origin https://alethialabs.io",
			"config set needs a key and a value when prompts are disabled: alethia config set <%s> <value>",
			configKeyList(true))
	}

	if key == "" {
		opts := make([]huh.Option[string], 0, len(configFields))
		for _, f := range configFields {
			if !f.settable() {
				continue
			}
			opts = append(opts, huh.NewOption(f.Key+" — "+f.Summary, f.Key))
		}
		if len(opts) == 0 {
			// Unreachable while any key is settable, and a real answer if that ever
			// stops being true — an empty picker would otherwise render as a form with
			// nothing in it.
			return "", "", refusal(clierr.CodeInvalidUsage, "", "no config key can be set from the CLI")
		}
		spec := mustAuthField("alethia config set", fieldKeyConfigKey)
		key = opts[0].Value
		if err := runHuhForm(huh.NewGroup(
			huh.NewSelect[string]().
				Title(spec.Title).
				Description(spec.Description).
				Options(opts...).
				Value(&key),
		)); err != nil {
			return "", "", err
		}
	}

	f := lookupConfigField(key)
	if f == nil {
		return "", "", errUnknownConfigKey(key)
	}
	if !f.settable() {
		return "", "", errReadOnlyConfigKey(f)
	}
	if value == "" {
		// Seeded with the STORED value so the form is an edit, not a re-type, and
		// validated by the SAME function `config set` gates on — a value the form
		// accepted can never be refused a moment later.
		//
		// Stored, not RESOLVED: `config set` writes the file, and $ALETHIA_WEB_ORIGIN
		// outranks the file, so seeding from types.ResolveWebOrigin() would put the
		// environment's origin in the box and a bare Enter would persist it OVER the
		// self-hosted origin in config.json that the user never touched. The note
		// runConfigSet prints would not save them either: after such a write the
		// resolved and stored values agree, so the one line that would have warned them
		// is exactly the line the overwrite suppresses.
		cfg := types.LoadCliConfig()
		storedOrigin := cfg.WebOrigin
		if storedOrigin == "" {
			// Nothing written yet. The hosted default is what the CLI is already using,
			// so it keeps the form an edit rather than an empty box.
			storedOrigin = types.DefaultWebOrigin
		}
		value = f.Read(cfg, storedOrigin)
		// The helper line is the CHOSEN KEY's summary, not the field's — see the
		// exception named on authField.Description. "The new value" would tell a
		// reader nothing they did not know from the title. When the environment
		// outranks what this form writes, it says so, because the box is then showing
		// a value that is not the one commands are using.
		description := f.Summary
		if resolved, source := types.ResolveWebOrigin(); f.Key == "web-origin" &&
			source == types.WebOriginFromEnv && resolved != value {
			description += fmt.Sprintf(
				" ($ALETHIA_WEB_ORIGIN is %s and outranks the file, so this edits what is stored, not what commands use.)",
				resolved)
		}
		spec := mustAuthField("alethia config set", fieldKeyValue)
		if err := runHuhForm(huh.NewGroup(
			huh.NewInput().
				Title(spec.Title + " · " + f.Key).
				Description(description).
				Value(&value).
				Validate(func(s string) error { _, err := f.Normalize(s); return err }),
		)); err != nil {
			return "", "", err
		}
	}
	return f.Key, value, nil
}

// normalizeWebOrigin validates a control-plane URL and returns it without a
// trailing slash. It requires an http/https scheme and a host.
func normalizeWebOrigin(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return "", refusal(clierr.CodeValidationFailed, "alethia config set web-origin https://alethialabs.io",
			"invalid web-origin %q (want e.g. https://alethialabs.io)", raw)
	}
	return strings.TrimRight(raw, "/"), nil
}

// saveActiveOrg persists the chosen org as the active CLI context, preserving the
// rest of the config (e.g. web-origin).
func saveActiveOrg(o api.OrgSummary) error {
	cfg := types.LoadCliConfig()
	cfg.ActiveOrgID = o.ID
	cfg.ActiveOrgName = o.Name
	cfg.ActiveOrgSlug = o.Slug
	return types.SaveCliConfig(cfg)
}

func init() {
	configExportCmd.Flags().String("format", "json", "Configuration content format")
	configExportCmd.Flags().String("out", "", "Write the configuration to this file instead of stdout, replacing it if it exists")
	configExportCmd.Flags().String("env", "", "Environment to export, by id, name or stage — an exact name wins over a stage (default: the project's default environment)")
	configCmd.AddCommand(configSetCmd)
	configCmd.AddCommand(configGetCmd)
	configCmd.AddCommand(configClearContextCmd)
	configCmd.AddCommand(configExportCmd)
	rootCmd.AddCommand(configCmd)
}
