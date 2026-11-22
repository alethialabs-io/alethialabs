// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"context"
	"errors"
	"fmt"
	"io"

	"github.com/alethialabs-io/alethialabs/apps/cli/internal/update"
	"github.com/alethialabs-io/alethialabs/apps/cli/internal/version"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/clierr"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/spf13/cobra"
)

// installDocsURL is where a person installs the CLI by hand.
const installDocsURL = docsURL + "/get-started/install-the-cli"

var updateCmd = &cobra.Command{
	Use:   "update",
	Short: "Update this CLI to the newest release",
	Long: `Install the newest release of the CLI over this one, through the channel it was installed
from. The channel is detected, never asked for: Homebrew and Scoop run their own upgrade, and a
standalone binary is downloaded, checked against the release's checksums and replaced in place.

A package install (deb, rpm, apk) or a container image is not changed by this command. It stops
and prints the exact command for that channel.

Being on the newest release already is a success and changes nothing. To learn whether a newer
release exists without installing it, run "alethia version": it names the newest release, and
"alethia version --output json" carries it as update_available.`,
	Args:        cobra.NoArgs,
	Annotations: map[string]string{skipUpdateNoticeAnnotation: "true"},
	Run: func(cmd *cobra.Command, _ []string) {
		_ = outputFormat(cmd)
		outcome, err := runUpdate(cmd.Context(), printer.Err, version.Version, WebOrigin())
		if err != nil {
			fail(err)
		}
		firstRunEmit(updateResult(outcome), func(w io.Writer) { renderUpdate(w, outcome) })
	},
}

// updateResult is an update as the mutation result every changing command returns. The subject is
// the CLI itself.
func updateResult(outcome update.Outcome) MutationResult {
	action := ResultUnchanged
	if outcome.Updated || outcome.Deferred {
		action = ResultUpdated
	}
	return MutationResult{ID: "alethia", Kind: "cli", Action: action, Object: outcome}
}

// renderUpdate writes the one line a person reads for an update.
func renderUpdate(w io.Writer, o update.Outcome) {
	switch {
	case o.Updated:
		fmt.Fprintln(w, ui.FormatSuccess(fmt.Sprintf("Updated alethia to v%s.", o.To)))
	case o.Deferred:
		fmt.Fprintf(w, "alethia v%s finishes installing when this process exits.\n", o.To)
	default:
		fmt.Fprintf(w, "alethia v%s is already up to date.\n", o.From)
	}
}

// runUpdate checks the canonical release API and updates through the detected install channel.
// What the update says while it works goes to progress.
func runUpdate(ctx context.Context, progress io.Writer, current, origin string) (update.Outcome, error) {
	if current == "" || current == "dev" {
		e := clierr.New(clierr.CodeConflict, "this is a development build, and a development build cannot update itself")
		e.Hint = "install a release: " + installDocsURL
		return update.Outcome{}, e
	}
	release, err := update.FetchLatest(origin)
	if err != nil {
		e := clierr.Wrap(clierr.CodeServiceUnavailable, fmt.Errorf("check the latest alethia release at %s: %w", origin, err))
		e.Hint = "try again, or install the release by hand: " + installDocsURL
		return update.Outcome{}, e
	}
	outcome, err := update.Apply(ctx, current, *release, progress)
	return outcome, updateError(err)
}

// updateError classifies what an update failed with. An install channel this command does not
// change is a failed precondition whose message is the command to run instead; anything else
// went wrong while installing, and the answer is the manual install.
func updateError(err error) error {
	if err == nil {
		return nil
	}
	var manual *update.ManualUpdateError
	if errors.As(err, &manual) {
		e := clierr.Wrap(clierr.CodeConflict, err)
		e.Hint = "run the command above; `alethia version` then shows the new release"
		return e
	}
	return firstRunErr(clierr.CodeInternal, err, "install the release by hand: "+installDocsURL)
}

func init() {
	rootCmd.AddCommand(updateCmd)
}
