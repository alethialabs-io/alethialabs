// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"os"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/charmbracelet/huh"
	"github.com/spf13/cobra"
)

var initCmd = &cobra.Command{
	Use:   "init",
	Short: "Set up the CLI (control-plane URL) and log in",
	Long: `Guided one-time setup: choose the control-plane URL (the hosted
alethialabs.io by default, or a self-hosted / dev URL), persist it, then log in.`,
	Run: func(cmd *cobra.Command, args []string) {
		origin, err := promptWebOrigin()
		if err != nil {
			fail(err)
		}
		if err := runConfigSet(os.Stdout, "web-origin", origin); err != nil {
			fail(err)
		}
		fmt.Println()
		if err := performLoginFlow(); err != nil {
			fail(err)
		}
	},
}

// promptWebOrigin asks for the control-plane URL, defaulting to the hosted
// origin, via the grayscale themed form. Honors --no-input (returns the resolved
// origin without prompting).
func promptWebOrigin() (string, error) {
	current, _ := types.ResolveWebOrigin()
	if noInputMode {
		return current, nil
	}
	origin := current
	if origin == "" {
		origin = types.DefaultWebOrigin
	}
	err := ui.NewForm(
		huh.NewGroup(
			huh.NewInput().
				Title("Control-plane URL").
				Description("Use the hosted default, or your self-hosted / dev URL").
				Value(&origin),
		),
	).Run()
	if err != nil {
		return "", err
	}
	return origin, nil
}

func init() {
	rootCmd.AddCommand(initCmd)
}
