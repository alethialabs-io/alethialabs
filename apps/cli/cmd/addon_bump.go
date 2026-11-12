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

var addonBumpAgain bool

// addonBumpPrompt is `bump`'s rendering of the add-on picker.
var addonBumpPrompt = addonPickPrompt{
	Title:       "Bump a GitOps Add-on",
	Description: "Installed in this environment",
	Empty:       "no add-ons are installed in this environment, so there is nothing to bump",
	Verb:        "bumping",
}

var addonBumpCmd = &cobra.Command{
	Use:   "bump [addon-id]",
	Short: "Open a pull request that moves a GitOps add-on to the chart version Alethia would seed",
	Args:  cobra.MaximumNArgs(1),
	Long: `Opens a pull request in the environment's apps repo that sets spec.source.targetRevision in
addons/<addon-id>.yaml to the version a deploy would seed: the catalog's version, or your pin.

Alethia seeds a GitOps add-on's file once and never rewrites it, so a newer catalog version does
not reach that add-on until the file changes. This command proposes that change as a pull request
for you to review and merge. It changes that one field and leaves every other byte of the file as
it is. It does not migrate values that the newer chart renamed or removed.

The pull request is opened with YOUR linked GitHub account. Running the command again returns the
pull request that is already open. If you closed one without merging it, the command says so and
opens nothing, unless you pass --again.

Only GitHub repositories are supported. On GitLab or Bitbucket, and whenever the command cannot open
a pull request, it prints the file, the field and the version to change yourself.

Omit the add-on id on a terminal and the environment's installed add-ons are offered.`,
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
		ref, err := resolveAddonID(client, args, project, env, addonBumpPrompt)
		if err != nil {
			fail(err)
		}
		announceResolvedAddon(ref, addonBumpPrompt.Verb)
		if err := runAddonBump(client, os.Stdout, project, env, ref.ID, addonBumpAgain); err != nil {
			failf("Failed to open the pull request: %v", err)
		}
	},
}

// gitopsBumper is the one API call `bump` makes.
type gitopsBumper interface {
	RequestGitopsBump(project, env, addonID string, again bool) (*api.GitopsBumpResult, error)
}

// runAddonBump requests the pull request and says what happened. A refusal is not an error: it is
// an answer, printed with the manual instruction, so the command exits 0 and a script can read it.
func runAddonBump(c gitopsBumper, out io.Writer, project, env, addonID string, again bool) error {
	if addonID == "" {
		return fmt.Errorf("an add-on id is required")
	}
	r, err := c.RequestGitopsBump(project, env, addonID, again)
	if err != nil {
		return err
	}
	link := func() string {
		if r.Number == nil || r.URL == nil {
			return ""
		}
		return fmt.Sprintf("#%d %s", *r.Number, *r.URL)
	}
	switch r.Status {
	case "open":
		verb := "is already open"
		if r.Created {
			verb = "opened"
		}
		fmt.Fprintln(out, ui.FormatSuccess(fmt.Sprintf("Pull request %s: %s", verb, link())))
		fmt.Fprintln(out, ui.MutedStyle.Render(fmt.Sprintf("It sets %s in %s to %s. Review and merge it in your repo.", r.Field, r.File, r.Version)))
	case "merged":
		fmt.Fprintln(out, ui.FormatSuccess(fmt.Sprintf("Pull request %s was merged.", link())))
		fmt.Fprintln(out, ui.MutedStyle.Render(fmt.Sprintf("The next deploy reads %s from %s.", r.Version, r.File)))
	case "declined":
		fmt.Fprintf(out, "You closed pull request %s without merging it, so nothing was opened.\n", link())
		fmt.Fprintln(out, ui.MutedStyle.Render("Run the command again with --again to open it once more."))
	default:
		msg := ""
		if r.Message != nil {
			msg = *r.Message
		}
		fmt.Fprintf(out, "No pull request was opened. %s\n", msg)
		fmt.Fprintf(out, "To move it yourself, set %s in %s to %s.\n", r.Field, r.File, r.Version)
	}
	return nil
}

func init() {
	addonBumpCmd.Flags().BoolVar(&addonBumpAgain, "again", false,
		"Open the pull request again after you closed the last one without merging it")
	addonCmd.AddCommand(addonBumpCmd)
}
