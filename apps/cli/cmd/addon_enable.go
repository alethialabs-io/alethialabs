// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"io"
	"os"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/spf13/cobra"
)

var (
	addonEnableMode       string
	addonEnableSet        []string
	addonEnableValuesFile string
	addonDisableYes       bool
)

var addonEnableCmd = &cobra.Command{
	Use:   "enable <addon-id>",
	Short: "Enable or reconfigure a catalog add-on in an environment",
	Args:  cobra.ExactArgs(1),
	Long: `Enables a marketplace add-on in one environment, or reconfigures one already enabled.

Re-running enable on an installed add-on UPDATES it — the knobs you pass are merged over what
is stored, so you can change one value without restating the rest. A secret you do not resend
is preserved rather than blanked.

Run "alethia addon list" for what is installed. Browsing the full catalog stays in the console.`,
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		project, err := currentProject(cmd)
		if err != nil {
			fail(err)
		}
		env, _ := cmd.Flags().GetString("env")
		values, err := parseSetValues(addonEnableSet)
		if err != nil {
			fail(err)
		}
		valuesYAML, err := readAddonValuesFile(addonEnableValuesFile)
		if err != nil {
			fail(err)
		}
		if err := runAddonEnable(api.NewClient(token), os.Stdout, api.EnableAddonParams{
			Project:    project,
			Env:        env,
			AddonID:    args[0],
			Mode:       addonEnableMode,
			Values:     values,
			ValuesYAML: valuesYAML,
		}); err != nil {
			failf("Failed to enable add-on: %v", err)
		}
	},
}

// readAddonValuesFile reads the raw Helm-values override, or returns "" when no file was named.
// The content is NOT parsed here: the server validates it as a YAML mapping through the same action
// the console uses, so a local pre-parse would be a second opinion that can disagree with the one
// that decides.
func readAddonValuesFile(path string) (string, error) {
	if path == "" {
		return "", nil
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("read --values-file: %w", err)
	}
	return string(raw), nil
}

// runAddonEnable enables the add-on and confirms it, naming the environment when one was given.
func runAddonEnable(c apiClient, out io.Writer, p api.EnableAddonParams) error {
	if p.AddonID == "" {
		return fmt.Errorf("an add-on id is required (see `alethia addon list`)")
	}
	if err := c.EnableAddon(p); err != nil {
		return err
	}
	fmt.Fprintln(out, ui.FormatSuccess(fmt.Sprintf("Enabled add-on %s%s", p.AddonID, envSuffix(p.Env))))
	fmt.Fprintln(out, ui.MutedStyle.Render("It reaches the cluster on the next apply — ArgoCD syncs it from there."))
	return nil
}

var addonDisableCmd = &cobra.Command{
	Use:   "disable <addon-id>",
	Short: "Disable a catalog add-on in an environment",
	Args:  cobra.ExactArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		project, err := currentProject(cmd)
		if err != nil {
			fail(err)
		}
		env, _ := cmd.Flags().GetString("env")
		if !confirmDestructive(addonDisableYes, "Disable this add-on?",
			"Its workloads are removed from the cluster on the next sync. Data in its volumes may not survive.") {
			return
		}
		if err := runAddonDisable(api.NewClient(token), os.Stdout, project, env, args[0]); err != nil {
			failf("Failed to disable add-on: %v", err)
		}
	},
}

// runAddonDisable disables the add-on and confirms it.
func runAddonDisable(c apiClient, out io.Writer, project, env, addonID string) error {
	if addonID == "" {
		return fmt.Errorf("an add-on id is required (see `alethia addon list`)")
	}
	if err := c.DisableAddon(project, env, addonID); err != nil {
		return err
	}
	fmt.Fprintln(out, ui.FormatSuccess(fmt.Sprintf("Disabled add-on %s%s", addonID, envSuffix(env))))
	return nil
}

func init() {
	addonEnableCmd.Flags().StringVar(&addonEnableMode, "mode", "", "Delivery mode: managed (Alethia applies it) or gitops (written to your apps repo)")
	addonEnableCmd.Flags().StringArrayVar(&addonEnableSet, "set", nil, "Add-on setting key=value (repeatable)")
	addonEnableCmd.Flags().StringVar(&addonEnableValuesFile, "values-file", "", "Path to a raw Helm values YAML override (Advanced)")
	addYesFlag(addonDisableCmd, &addonDisableYes)
	addonCmd.AddCommand(addonEnableCmd)
	addonCmd.AddCommand(addonDisableCmd)
}
