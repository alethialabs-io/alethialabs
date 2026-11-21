// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"io"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/clierr"
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

Omit the add-on id on a terminal and the environment's installed add-ons are offered.

With --output json the answer is one result whose object carries the pull request as fields:
status (open, merged, declined or refused), number, url, and the file, field and version. A
refusal is an answer, not a failure: the command exits 0 and the object says why.`,
	Run: func(cmd *cobra.Command, args []string) {
		if err := runAddonBumpCmd(cmd, args); err != nil {
			fail(err)
		}
	},
}

// runAddonBumpCmd is `addon bump` from the command line to the printed result.
func runAddonBumpCmd(cmd *cobra.Command, args []string) error {
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
	ref, err := resolveAddonID(client, args, project, env, addonBumpPrompt)
	if err != nil {
		return err
	}
	announceResolvedAddon(ref, addonBumpPrompt.Verb)
	result, err := addonBump(client, project, env, ref.ID, addonBumpAgain)
	if err != nil {
		return err
	}
	return printAddonBump(p, result)
}

// printAddonBump prints a bump result and, on stderr, the next step it leaves.
func printAddonBump(p *Printer, r MutationResult) error {
	bump, _ := r.Object.(addonBumpObject)
	if err := p.Result(r, func(w io.Writer) { renderAddonBump(w, bump.GitopsBumpResult) }); err != nil {
		return err
	}
	if note := addonBumpNote(bump.GitopsBumpResult); note != "" {
		p.Note(note)
	}
	return nil
}

// gitopsBumper is the one API call `bump` makes.
type gitopsBumper interface {
	RequestGitopsBump(project, env, addonID string, again bool) (*api.GitopsBumpResult, error)
}

// addonBumpObject is the `object` of a bump result: the control plane's answer as it sent it — the
// pull request's status, number and url as fields — and where it was asked.
type addonBumpObject struct {
	byoTarget
	api.GitopsBumpResult
}

// The statuses a bump answers with.
const (
	bumpStatusOpen     = "open"
	bumpStatusMerged   = "merged"
	bumpStatusDeclined = "declined"
)

// addonBump requests the pull request and returns the result. A refusal is not an error: it is an
// answer — status "refused" with the manual instruction in the object — so the command exits 0 and a
// script reads it. Only a pull request opened by THIS run is "created"; every other answer is
// "unchanged".
func addonBump(c gitopsBumper, project, env, addonID string, again bool) (MutationResult, error) {
	result := MutationResult{ID: addonID, Kind: addonKind, Action: ResultUnchanged}
	if addonID == "" {
		return result, refusal(clierr.CodeMissingArgument, "alethia addon list", "an add-on id is required")
	}
	r, err := c.RequestGitopsBump(project, env, addonID, again)
	if err != nil {
		return result, byoNotFoundHint(fmt.Errorf("open the pull request for %s: %w", addonID, err), "alethia addon list")
	}
	if r == nil {
		r = &api.GitopsBumpResult{}
	}
	if r.Status == bumpStatusOpen && r.Created {
		result.Action = ResultCreated
	}
	result.Object = addonBumpObject{byoTarget: byoTarget{Project: project, Env: env}, GitopsBumpResult: *r}
	return result, nil
}

// bumpLink renders the pull request as `#12 https://…`, or "" when the answer named none.
func bumpLink(r api.GitopsBumpResult) string {
	if r.Number == nil || r.URL == nil {
		return ""
	}
	return fmt.Sprintf("#%d %s", *r.Number, *r.URL)
}

// renderAddonBump is the person's reading of a bump answer: what happened to the pull request, or —
// when none was opened — the file, the field and the version to change by hand.
func renderAddonBump(w io.Writer, r api.GitopsBumpResult) {
	switch r.Status {
	case bumpStatusOpen:
		verb := "is already open"
		if r.Created {
			verb = "opened"
		}
		fmt.Fprintln(w, ui.FormatSuccess(fmt.Sprintf("Pull request %s: %s", verb, bumpLink(r))))
	case bumpStatusMerged:
		fmt.Fprintln(w, ui.FormatSuccess(fmt.Sprintf("Pull request %s was merged.", bumpLink(r))))
	case bumpStatusDeclined:
		fmt.Fprintf(w, "You closed pull request %s without merging it, so nothing was opened.\n", bumpLink(r))
	default:
		msg := ""
		if r.Message != nil {
			msg = *r.Message
		}
		fmt.Fprintf(w, "No pull request was opened. %s\n", msg)
		fmt.Fprintf(w, "To move it yourself, set %s in %s to %s.\n", r.Field, r.File, r.Version)
	}
}

// addonBumpNote is the next step after a bump answer, said on stderr, or "" when the result says
// everything.
func addonBumpNote(r api.GitopsBumpResult) string {
	switch r.Status {
	case bumpStatusOpen:
		return fmt.Sprintf("It sets %s in %s to %s. Review and merge it in your repo.", r.Field, r.File, r.Version)
	case bumpStatusMerged:
		return fmt.Sprintf("The next deploy reads %s from %s.", r.Version, r.File)
	case bumpStatusDeclined:
		return "Run the command again with --again to open it once more."
	}
	return ""
}

func init() {
	addonBumpCmd.Flags().BoolVar(&addonBumpAgain, "again", false,
		"Open the pull request again after you closed the last one without merging it")
	addonCmd.AddCommand(addonBumpCmd)
}
