// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/clierr"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/spf13/cobra"
)

var orgSwitchCmd = &cobra.Command{
	Use:   "switch [org]",
	Short: "Switch the active organization",
	Long: `Set the organization your commands act in. Pass its id, slug or name; with no
argument on a terminal, pick one from the list.

The choice is stored on this machine and sent with every later command. Nothing changes
on the control plane. To act in another organization for one command only, pass --org to
that command instead.`,
	Args: cobra.MaximumNArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		p := resultPrinter(cmd)
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		target := ""
		if len(args) > 0 {
			target = args[0]
		}
		if err := runOrgSwitch(api.NewClient(token), p, target); err != nil {
			fail(governanceError(err))
		}
	},
}

// runOrgSwitch resolves target (id/slug/name, or an interactive pick when empty)
// to one of the caller's orgs and persists it as the active context.
func runOrgSwitch(c apiClient, p *Printer, target string) error {
	// Refused BEFORE the fetch: whether a scripted caller may be asked to pick does not depend on
	// what the server holds, so asking it would only slow the refusal down — and "no organizations
	// available" is a badly wrong thing to tell someone whose real problem is --no-input.
	if target == "" && !canPromptForm() {
		e := refuseNoForm(mustOrgField("alethia org switch", orgFieldKeyOrg))
		e.Hint = "alethia org list"
		return e
	}
	orgs, err := c.ListOrgs()
	if err != nil {
		return err
	}
	if len(orgs) == 0 {
		return refusal(clierr.CodeNotFound, "create an organization in the console, or ask an owner to invite you",
			"no organizations available")
	}

	var chosen *api.OrgSummary
	if target == "" {
		// The form gate and not requireInteractive: the picker needs somewhere to DRAW, which is
		// stderr and not stdout (ui.InteractiveOutput records the measurement). Without it
		// `alethia org switch 2> log` from an interactive shell sent the form's ANSI frames into
		// the log and looked hung. Already answered above, before the fetch.
		chosen, err = selectOrgInteractive(orgs)
		if err != nil {
			return err
		}
	} else {
		chosen = matchOrg(orgs, target)
		if chosen == nil {
			return refusal(clierr.CodeNotFound, "alethia org list", "no organization matching %q", target)
		}
	}

	// Switching to the organization that is already active writes nothing and says so: the result
	// is "unchanged", which is what makes the command safe to repeat in a script.
	action := ResultUpdated
	if types.LoadCliConfig().ActiveOrgID == chosen.ID {
		action = ResultUnchanged
	} else if err := saveActiveOrg(*chosen); err != nil {
		return fmt.Errorf("failed to save active organization: %w", err)
	}
	sentence := "Active organization set to " + chosen.Name
	if action == ResultUnchanged {
		sentence = chosen.Name + " is already the active organization"
	}
	return printChange(p, MutationResult{
		ID: chosen.ID, Kind: govKindOrganization, Action: action, Object: chosen,
	}, sentence)
}

// matchOrg returns the org whose id, slug, or name equals target, or nil.
func matchOrg(orgs []api.OrgSummary, target string) *api.OrgSummary {
	for i := range orgs {
		if orgs[i].ID == target || orgs[i].Slug == target || orgs[i].Name == target {
			return &orgs[i]
		}
	}
	return nil
}

func init() {
	orgCmd.AddCommand(orgSwitchCmd)
}
