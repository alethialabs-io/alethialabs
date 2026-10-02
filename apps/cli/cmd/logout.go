// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"os"

	"github.com/alethialabs-io/alethialabs/apps/cli/internal/kubecache"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/spf13/cobra"
)

var logoutCmd = &cobra.Command{
	Use:   "logout",
	Short: "Log out from the platform and delete cached kubeconfig credentials",
	Long: `Log out from the platform.

Deletes the stored session and the kubeconfig credential cache that "alethia cluster token" serves
from, for every organization. A kubeconfig the CLI wrote then stops working until you log in again.
A static kubeconfig file (--static) is not touched: it works until its credential expires.`,
	Run: func(cmd *cobra.Command, args []string) {
		credsPath, err := getCredentialsPath()
		if err != nil {
			failf("Error getting credentials path: %v", err)
		}

		_, statErr := os.Stat(credsPath)
		loggedIn := !os.IsNotExist(statErr)
		if loggedIn {
			if err := os.Remove(credsPath); err != nil {
				failf("Error logging out: %v", err)
			}
		}

		// The cache is cleared whether or not a session was found: a credential minted before the
		// session file went away is still a credential (#5323).
		cleared := clearKubeCache()

		if !loggedIn {
			ui.Info("You are not currently logged in.")
		} else {
			ui.Success("Successfully logged out.")
		}
		if cleared {
			ui.Info("Deleted the cached kubeconfig credentials.")
		}
		if loggedIn {
			ui.Info("To log back in, run " + ui.CyanStyle.Render("alethia login"))
		}
	},
}

// clearKubeCache deletes the kubeconfig credential cache and reports whether there was one. A cache
// it cannot delete is fatal: the user asked to end their access, and a credential left behind
// without a word is exactly what logout must not do.
func clearKubeCache() bool {
	dir, err := kubecache.DefaultDir()
	if err == nil {
		var cleared bool
		if cleared, err = kubecache.Clear(dir); err == nil {
			return cleared
		}
	}
	// Stderr, not ui.Error's stdout: this is the line a script that runs logout must not lose.
	fmt.Fprintf(os.Stderr, "alethia logout: could not delete the cached kubeconfig credentials: %v\n"+
		"They stay usable until they expire (at most 8h). Delete the cache directory named above to end that access now.\n", err)
	exitFunc(1)
	return false
}

func init() {
	rootCmd.AddCommand(logoutCmd)
}
