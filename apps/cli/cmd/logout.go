// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/alethialabs-io/alethialabs/apps/cli/internal/credstore"
	"github.com/alethialabs-io/alethialabs/apps/cli/internal/kubecache"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/clierr"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/spf13/cobra"
)

var logoutCmd = &cobra.Command{
	Use:   "logout",
	Short: "Sign out and delete the stored credential and cached kubeconfig credentials",
	Long: `Sign out of the current control plane on this machine.

Removes the stored credential from both places it can be — the operating system's
credential store and the owner-only credentials file — and deletes the kubeconfig
credential cache that "alethia cluster token" serves from, for every organization.
A kubeconfig the CLI wrote then stops working until you log in again. A static
kubeconfig file (--static) is not touched: it works until its credential expires.

Running it when you are not signed in changes nothing and succeeds. It does not
unset ALETHIA_TOKEN: a token supplied in the environment is never stored, so there
is nothing of it to remove, and commands keep using it until you unset it.`,
	Run: func(cmd *cobra.Command, args []string) {
		result, err := runLogout()
		if err != nil {
			fail(err)
			return
		}
		if err := printer.Result(result, func(w io.Writer) { printLogout(w, result) }); err != nil {
			fail(err)
		}
	},
}

// logoutInfo is what a sign-out removed.
type logoutInfo struct {
	// Origin is the control plane the sign-out was for.
	Origin string `json:"origin"`
	// Keychain reports that an entry was removed from the system keychain.
	Keychain bool `json:"keychain"`
	// File reports that the credentials file was removed.
	File bool `json:"file"`
	// KubeconfigCache reports that cached kubeconfig credentials were deleted.
	KubeconfigCache bool `json:"kubeconfig_cache"`
}

// runLogout removes the stored credential from the system keychain and from the credentials file,
// then deletes the kubeconfig credential cache. It reports what it removed.
//
// Every removal is attempted before any failure is reported, so one place that cannot be cleared
// does not leave the others untouched.
func runLogout() (MutationResult, error) {
	origin := WebOrigin()
	info := logoutInfo{Origin: normalizeOrigin(origin)}

	credsPath, err := getCredentialsPath()
	if err != nil {
		return MutationResult{}, fmt.Errorf("error getting credentials path: %w", err)
	}

	var failures []error

	removed, keychainErr := removeKeychainCredential(credentialAccount(origin))
	info.Keychain = removed
	if keychainErr != nil {
		failures = append(failures, keychainErr)
	}

	switch err := os.Remove(credsPath); {
	case err == nil:
		info.File = true
	case !errors.Is(err, os.ErrNotExist):
		failures = append(failures, fmt.Errorf("could not delete the credentials file: %w", err))
	}
	// A write that was interrupted before its rename leaves a copy beside the file. It is part of
	// the same credential, so it goes with it.
	leftover, err := removeCredentialTempFiles(filepath.Dir(credsPath))
	if err != nil {
		failures = append(failures, fmt.Errorf("could not delete an unfinished credentials file: %w", err))
	}
	info.File = info.File || leftover

	// The cache is cleared whether or not a session was found: a credential minted before the
	// session went away is still a credential (#5323).
	cleared, cacheErr := clearKubeCache()
	info.KubeconfigCache = cleared
	if cacheErr != nil {
		failures = append(failures, cacheErr)
	}

	if len(failures) > 0 {
		return MutationResult{}, errors.Join(failures...)
	}

	action := ResultUnchanged
	if info.Keychain || info.File || info.KubeconfigCache {
		action = ResultDeleted
	}
	return MutationResult{
		ID:     credentialAccount(origin),
		Kind:   sessionKind,
		Action: action,
		Object: info,
	}, nil
}

// removeKeychainCredential deletes the keychain entry for account and reports whether there was one.
//
// A keychain that cannot be asked holds nothing this CLI could have read, so it is passed over. An
// entry that is there and cannot be deleted is a failure: the person asked for their access to end.
func removeKeychainCredential(account string) (bool, error) {
	if _, err := credentialStore.Get(account); err != nil {
		return false, nil
	}
	if err := credentialStore.Delete(account); err != nil && !errors.Is(err, credstore.ErrNotFound) {
		return false, fmt.Errorf("could not delete the credential from the system keychain: %w", err)
	}
	return true, nil
}

// printLogout writes what a person reads for a sign-out: the outcome on w, and what else was removed
// or is still in force on stderr.
func printLogout(w io.Writer, result MutationResult) {
	info, _ := result.Object.(logoutInfo)
	signedOut := info.Keychain || info.File
	if signedOut {
		ui.SuccessTo(w, fmt.Sprintf("Successfully logged out of %s.", info.Origin))
	} else {
		ui.InfoTo(w, "You are not currently logged in.")
	}
	if info.KubeconfigCache {
		printer.Note("Deleted the cached kubeconfig credentials.")
	}
	if _, source := suppliedToken(); source == credentialFromEnv {
		printer.Warn(ServiceTokenEnv + " is still set in this environment, and commands keep using it until you unset it.")
	}
	if signedOut {
		printer.Note("To log back in, run alethia login")
	}
}

// clearKubeCache deletes the kubeconfig credential cache and reports whether there was one. A cache
// it cannot delete is an error: the user asked to end their access, and a credential left behind
// without a word is exactly what logout must not do.
func clearKubeCache() (bool, error) {
	dir, err := kubecache.DefaultDir()
	if err == nil {
		var cleared bool
		if cleared, err = kubecache.Clear(dir); err == nil {
			return cleared, nil
		}
	}
	failure := clierr.Wrap(clierr.CodeInternal,
		fmt.Errorf("could not delete the cached kubeconfig credentials: %w", err))
	failure.Hint = "They stay usable until they expire (at most 8h). " +
		"Delete the cache directory named above to end that access now."
	return false, failure
}

func init() {
	rootCmd.AddCommand(logoutCmd)
}
