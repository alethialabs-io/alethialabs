// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"io"
	"os"
	"strings"

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
in the console gives you.`,
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		project, err := projectFromFlag(cmd, token)
		if err != nil {
			fail(err)
		}
		env, _ := cmd.Flags().GetString("env")
		// Before anything is fetched or asked. Refusing a bad --mode after the operator has
		// chosen an add-on from a list makes them answer a question that was never going to be
		// used.
		mode, err := canonicalAddonMode(addonEnableMode)
		if err != nil {
			fail(err)
		}
		values, err := parseSetValues(addonEnableSet)
		if err != nil {
			fail(err)
		}
		valuesYAML, err := addonValuesFileFlag(cmd)
		if err != nil {
			fail(err)
		}
		client := api.NewClient(token)
		ref, err := resolveAddonID(client, args, project, env, addonEnablePrompt)
		if err != nil {
			fail(err)
		}
		announceResolvedAddon(ref, addonEnablePrompt.Verb)
		if err := runAddonEnable(client, os.Stdout, api.EnableAddonParams{
			Project:    project,
			Env:        env,
			AddonID:    ref.ID,
			Mode:       mode,
			Values:     values,
			ValuesYAML: valuesYAML,
			Version:    addonVersionFlag(cmd),
		}); err != nil {
			failf("Failed to enable add-on: %v", err)
		}
	},
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
// that decides. A file that is empty or only whitespace therefore reaches the server as-is, where it
// removes the override exactly as --values-file "" does.
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
		return nil, fmt.Errorf("read --values-file: %w", err)
	}
	content := string(raw)
	return &content, nil
}

// runAddonEnable enables the add-on and confirms it, naming the environment when one was given.
func runAddonEnable(c apiClient, out io.Writer, p api.EnableAddonParams) error {
	if p.AddonID == "" {
		return fmt.Errorf("an add-on id is required")
	}
	if err := c.EnableAddon(p); err != nil {
		return err
	}
	fmt.Fprintln(out, ui.FormatSuccess(fmt.Sprintf("Enabled add-on %s%s", p.AddonID, envSuffix(p.Env))))
	fmt.Fprintln(out, ui.MutedStyle.Render("It reaches the cluster on the next apply — ArgoCD syncs it from there."))
	return nil
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
confirmed is one you can read.`,
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		project, err := projectFromFlag(cmd, token)
		if err != nil {
			fail(err)
		}
		env, _ := cmd.Flags().GetString("env")
		client := api.NewClient(token)
		// Resolve BEFORE confirming, and announce what was resolved. "Disable this add-on?" is
		// not a question anyone can answer about a target the CLI picked and did not name — the
		// jobs group states the same rule for `jobs cancel --latest`.
		ref, err := resolveAddonID(client, args, project, env, addonDisablePrompt)
		if err != nil {
			fail(err)
		}
		announceResolvedAddon(ref, addonDisablePrompt.Verb)
		if !confirmDestructive(addonDisableYes, "Disable this add-on?",
			"Its workloads are removed from the cluster on the next sync. Data in its volumes may not survive.") {
			return
		}
		if err := runAddonDisable(client, os.Stdout, project, env, ref.ID); err != nil {
			failf("Failed to disable add-on: %v", err)
		}
	},
}

// runAddonDisable disables the add-on and confirms it.
func runAddonDisable(c apiClient, out io.Writer, project, env, addonID string) error {
	if addonID == "" {
		return fmt.Errorf("an add-on id is required")
	}
	if err := c.DisableAddon(project, env, addonID); err != nil {
		return err
	}
	fmt.Fprintln(out, ui.FormatSuccess(fmt.Sprintf("Disabled add-on %s%s", addonID, envSuffix(env))))
	return nil
}

func init() {
	// The vocabulary comes from the generated addon_mode mirror, so a mode added to the drizzle
	// enum reaches the help text and the refusal without anyone editing a list here.
	addonEnableCmd.Flags().StringVar(&addonEnableMode, "mode", "",
		"Delivery mode ("+strings.Join(addonModeValues(), ", ")+"): managed = Alethia applies it, gitops = written to your apps repo")
	addonEnableCmd.Flags().StringArrayVar(&addonEnableSet, "set", nil,
		"Add-on setting key=value (repeatable), merged over the stored settings; key=null resets it to the default")
	addonEnableCmd.Flags().StringVar(&addonEnableValuesFile, "values-file", "",
		`Path to a raw Helm values YAML override (Advanced); --values-file "" removes the stored override`)
	addonEnableCmd.Flags().StringVar(&addonEnableVersion, "version", "",
		`Pin the chart version, e.g. 58.2.1; --version "" removes the pin (catalog default)`)
	addYesFlag(addonDisableCmd, &addonDisableYes)
	addonCmd.AddCommand(addonEnableCmd)
	addonCmd.AddCommand(addonDisableCmd)
}
