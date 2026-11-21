// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/clierr"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/spf13/cobra"
)

var (
	addonEnableMode       string
	addonEnableSet        []string
	addonEnableValuesFile string
	addonEnableVersion    string
	addonDisableYes       bool
)

// addonEnablePrompt is `enable`'s rendering of the add-on picker.
//
// It lists what is INSTALLED, which serves the reconfigure case completely and the first-install
// case not at all: the CLI has no endpoint that enumerates the marketplace catalog, so an add-on
// nobody has enabled yet cannot be offered. That remaining handoff is named in the empty message
// rather than left for the reader to discover, and it is recorded on the docs page.
var addonEnablePrompt = addonPickPrompt{
	Title:       "Reconfigure Add-on",
	Description: "Installed in this environment",
	Empty: "no add-ons are installed in this environment, so there is nothing to reconfigure — " +
		"to install one, pass its catalog id (browse the marketplace in the console)",
	Verb: "reconfiguring",
}

var addonEnableCmd = &cobra.Command{
	Use:   "enable [addon-id]",
	Short: "Enable or reconfigure a catalog add-on in an environment",
	Args:  cobra.MaximumNArgs(1),
	Long: `Enables a marketplace add-on in one environment, or reconfigures one already enabled.

Re-running enable on an installed add-on UPDATES it, and a flag you leave out keeps what is stored:
the settings, the Advanced values override, the mode and the version pin.

--set settings are merged key by key over the stored ones, so you can change one value without
restating the rest; --set key=null resets that setting to the add-on's default. A secret you do not
resend is preserved rather than blanked.

--values-file replaces the stored Advanced override whole; --values-file "" removes it.

--version pins the add-on's chart version in this environment; --version "" removes the pin so the
catalog's default version applies again.

Omit the add-on id on a terminal and the add-ons installed in the environment are offered to
reconfigure. Installing one that is not yet enabled needs its catalog id, which the marketplace
in the console gives you. With nobody to ask, the id is required (exit 9).

--output json prints one result: the add-on, the environment, and the mode and pin this run set.`,
	Run: func(cmd *cobra.Command, args []string) {
		if err := runAddonEnableCmd(cmd, args); err != nil {
			fail(err)
		}
	},
}

// runAddonEnableCmd is `addon enable` from the command line to the printed result.
func runAddonEnableCmd(cmd *cobra.Command, args []string) error {
	token, err := getAuthToken()
	if err != nil {
		return err
	}
	p := printerFor(cmd)
	// Before anything is fetched or asked. Refusing a bad --mode after the operator has chosen an
	// add-on from a list makes them answer a question that was never going to be used.
	mode, err := canonicalAddonMode(addonEnableMode)
	if err != nil {
		return err
	}
	values, err := parseSetValues(addonEnableSet)
	if err != nil {
		return err
	}
	valuesYAML, err := addonValuesFileFlag(cmd)
	if err != nil {
		return err
	}
	project, err := projectOrAsk(cmd, token)
	if err != nil {
		return err
	}
	env, _ := cmd.Flags().GetString("env")
	client := api.NewClient(token)
	ref, err := resolveAddonID(client, args, project, env, addonEnablePrompt)
	if err != nil {
		return err
	}
	announceResolvedAddon(ref, addonEnablePrompt.Verb)
	result, err := addonEnable(client, api.EnableAddonParams{
		Project:    project,
		Env:        env,
		AddonID:    ref.ID,
		Mode:       mode,
		Values:     values,
		ValuesYAML: valuesYAML,
		Version:    addonVersionFlag(cmd),
	})
	if err != nil {
		return err
	}
	return printAddonEnable(p, result)
}

// printAddonEnable prints an enable or disable result and, for an enable, when it takes effect.
func printAddonEnable(p *Printer, r MutationResult) error {
	if err := p.Result(r, func(w io.Writer) { renderAddonEnable(w, r) }); err != nil {
		return err
	}
	if obj, _ := r.Object.(addonEnableObject); obj.Enabled {
		p.Note("It reaches the cluster on the next apply — ArgoCD syncs it from there.")
	}
	return nil
}

// addonVersionFlag returns the --version pin as the API's three-state value: nil when the flag was
// not given (the stored pin is kept), a pointer to "" when it was given empty (the pin is cleared),
// and the version otherwise. The value is NOT checked here: the server validates it through the one
// definition of a chart version the console also uses, so a local copy could only disagree with it.
func addonVersionFlag(cmd *cobra.Command) *string {
	if !cmd.Flags().Changed("version") {
		return nil
	}
	v := addonEnableVersion
	return &v
}

// addonValuesFileFlag returns the Advanced values override as the API's three-state value, the same
// rule --version follows (#5545): nil when the flag was not given (the stored override is kept), a
// pointer to "" when it was given empty (the override is removed), and the file's content otherwise.
// Before #5545 an absent flag and an empty one were both sent as "nothing", and the server read
// "nothing" as "remove" — so changing one --set key silently dropped the whole override.
//
// The content is NOT parsed here: the server validates it as a YAML mapping through the same action
// the console uses, so a local pre-parse would be a second opinion that can disagree with the one
// that decides. An empty file is sent as null by the API client (packages/core/api), and a
// whitespace-only file reaches the server as-is; either way the server removes the override exactly
// as --values-file "" does.
func addonValuesFileFlag(cmd *cobra.Command) (*string, error) {
	if !cmd.Flags().Changed("values-file") {
		return nil, nil
	}
	if addonEnableValuesFile == "" {
		cleared := ""
		return &cleared, nil
	}
	raw, err := os.ReadFile(addonEnableValuesFile)
	if err != nil {
		return nil, clierr.Wrap(clierr.CodeInvalidFlag, fmt.Errorf("read --values-file: %w", err))
	}
	content := string(raw)
	return &content, nil
}

// addonEnableObject is the `object` of an add-on enable result: where it was enabled and what the
// command changed. Mode is empty and Version is null when the stored value was kept.
type addonEnableObject struct {
	byoTarget
	Enabled bool    `json:"enabled"`
	Mode    string  `json:"mode"`
	Version *string `json:"version"`
}

// addonEnable enables (or reconfigures) the add-on and returns the result. Enable is an upsert, so
// the action is "updated" whether the add-on was new to the environment or not.
func addonEnable(c apiClient, p api.EnableAddonParams) (MutationResult, error) {
	result := MutationResult{ID: p.AddonID, Kind: addonKind, Action: ResultUpdated}
	if p.AddonID == "" {
		return result, refusal(clierr.CodeMissingArgument, "alethia addon list", "an add-on id is required")
	}
	if err := c.EnableAddon(p); err != nil {
		return result, byoNotFoundHint(fmt.Errorf("enable add-on %s: %w", p.AddonID, err), "alethia addon list")
	}
	result.Object = addonEnableObject{
		byoTarget: byoTarget{Project: p.Project, Env: p.Env},
		Enabled:   true, Mode: p.Mode, Version: p.Version,
	}
	return result, nil
}

// addonDisablePrompt is `disable`'s rendering of the add-on picker.
var addonDisablePrompt = addonPickPrompt{
	Title:       "Disable Add-on",
	Description: "Installed in this environment",
	Empty:       "no add-ons are installed in this environment, so there is nothing to disable",
	Verb:        "disabling",
}

var addonDisableCmd = &cobra.Command{
	Use:   "disable [addon-id]",
	Short: "Disable a catalog add-on in an environment",
	Args:  cobra.MaximumNArgs(1),
	Long: `Disables a marketplace add-on in one environment.

Omit the add-on id on a terminal and the environment's installed add-ons are offered. The
add-on the CLI resolved is named on stderr BEFORE the confirmation, so the thing being
confirmed is one you can read. Scripts pass the id and --yes; without --yes and with nobody to
ask, the command refuses (exit 9) and disables nothing.`,
	Run: func(cmd *cobra.Command, args []string) {
		if err := runAddonDisableCmd(cmd, args); err != nil {
			fail(err)
		}
	},
}

// runAddonDisableCmd is `addon disable` from the command line to the printed result.
func runAddonDisableCmd(cmd *cobra.Command, args []string) error {
	token, err := getAuthToken()
	if err != nil {
		return err
	}
	p := printerFor(cmd)
	project, err := projectOrAsk(cmd, token)
	if err != nil {
		return err
	}
	env, _ := cmd.Flags().GetString("env")
	client := api.NewClient(token)
	// Resolve BEFORE confirming, and announce what was resolved. "Disable this add-on?" is not a
	// question anyone can answer about a target the CLI picked and did not name — the jobs group
	// states the same rule for `jobs cancel --latest`.
	ref, err := resolveAddonID(client, args, project, env, addonDisablePrompt)
	if err != nil {
		return err
	}
	announceResolvedAddon(ref, addonDisablePrompt.Verb)
	ok, err := confirmOrRefuse(addonDisableYes, fmt.Sprintf("Disable add-on %s%s?", ref.ID, envSuffix(env)),
		"Its workloads are removed from the cluster on the next sync. Data in its volumes may not survive.")
	if err != nil || !ok {
		return err
	}
	result, err := addonDisable(client, project, env, ref.ID)
	if err != nil {
		return err
	}
	return printAddonEnable(p, result)
}

// renderAddonEnable is the person's line for an enable or a disable result, naming the environment
// when one was given.
func renderAddonEnable(w io.Writer, r MutationResult) {
	obj, _ := r.Object.(addonEnableObject)
	verb := "Disabled"
	if obj.Enabled {
		verb = "Enabled"
	}
	fmt.Fprintln(w, ui.FormatSuccess(fmt.Sprintf("%s add-on %s%s", verb, r.ID, envSuffix(obj.Env))))
}

// addonDisable disables the add-on and returns the result. The add-on's record stays — disabled —
// so the action is "updated", with enabled false in the object.
func addonDisable(c apiClient, project, env, addonID string) (MutationResult, error) {
	result := MutationResult{ID: addonID, Kind: addonKind, Action: ResultUpdated}
	if addonID == "" {
		return result, refusal(clierr.CodeMissingArgument, "alethia addon list", "an add-on id is required")
	}
	if err := c.DisableAddon(project, env, addonID); err != nil {
		return result, byoNotFoundHint(fmt.Errorf("disable add-on %s: %w", addonID, err), "alethia addon list")
	}
	result.Object = addonEnableObject{byoTarget: byoTarget{Project: project, Env: env}}
	return result, nil
}

func init() {
	// The vocabulary comes from the generated addon_mode mirror, so a mode added to the drizzle
	// enum reaches the help text and the refusal without anyone editing a list here.
	addonEnableCmd.Flags().StringVar(&addonEnableMode, "mode", "",
		"Delivery mode ("+strings.Join(addonModeValues(), ", ")+"): managed = Alethia applies it, gitops = written to your apps repo")
	addonEnableCmd.Flags().StringArrayVar(&addonEnableSet, "set", nil,
		"Add-on setting key=value (repeatable), merged over the stored settings; key=null resets it to the default (a stored secret is kept)")
	addonEnableCmd.Flags().StringVar(&addonEnableValuesFile, "values-file", "",
		`Path to a raw Helm values YAML override (Advanced); --values-file "" removes the stored override`)
	addonEnableCmd.Flags().StringVar(&addonEnableVersion, "version", "",
		`Pin the chart version, e.g. 58.2.1; --version "" removes the pin (catalog default)`)
	addYesFlag(addonDisableCmd, &addonDisableYes)
	addonCmd.AddCommand(addonEnableCmd)
	addonCmd.AddCommand(addonDisableCmd)
}
