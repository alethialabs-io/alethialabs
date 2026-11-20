// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"io"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/clierr"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/cmdmeta"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/spf13/cobra"
)

var (
	// runnerRemoveRef is --runner: the runner to remove, by NAME or id.
	runnerRemoveRef string
	// runnerRemoveYes is the --yes opt-in: skip the confirmation prompt (and make the
	// command usable with --no-input).
	runnerRemoveYes bool
)

// runnerProvisioningDeployed is the provisioning of a runner Alethia built in a cloud account.
const runnerProvisioningDeployed = "deployed"

var runnerRemoveCmd = &cobra.Command{
	Use:   "remove [runner-id]",
	Short: "Delete a runner's record (tears nothing down)",
	Args:  cobra.MaximumNArgs(1),
	Long: `Deletes the runner's record from the control plane. Its token stops working and it takes no
more jobs. No cloud resource is touched.

Use it for a runner you registered and no longer run, or after "alethia runner destroy" has torn
a deployed runner down. Removing a deployed runner first leaves its cloud resources running with
nothing left to tear them down: destroy it first.

Name the runner with --runner, which takes its name as "alethia runner list" shows it; the
argument still takes the id. On a terminal you type the runner's name to confirm. With nobody to
ask, pass --yes; without it the command refuses and changes nothing. --dry-run checks the input
and prints the request without sending it.`,
	Run: func(cmd *cobra.Command, args []string) {
		if err := runRunnerRemove(cmd, args); err != nil {
			fail(err)
		}
	},
}

// runnerRemoveClient is what `runner remove` asks the control plane.
type runnerRemoveClient interface {
	runnerLister
	RemoveRunner(runnerID string) error
}

// runnerRemoveObject is the `object` of a runner remove result.
type runnerRemoveObject struct {
	// Name is the runner's name, or empty when it was named by an id no listed runner has.
	Name string `json:"name"`
	// Provisioning is how the runner came to exist: deployed, registered, or empty.
	Provisioning string `json:"provisioning,omitempty"`
	// Request is what would be sent. It is present only on a dry run.
	Request *runnerRemoveRequest `json:"request,omitempty"`
}

// runnerRemoveRequest is the request a remove sends, as the dry run reports it.
type runnerRemoveRequest struct {
	Method string `json:"method"`
	Path   string `json:"path"`
}

// runRunnerRemove is `runner remove` up to authentication.
func runRunnerRemove(cmd *cobra.Command, args []string) error {
	token, err := getAuthToken()
	if err != nil {
		return err
	}
	positional := ""
	if len(args) > 0 {
		positional = args[0]
	}
	result, ok, err := removeRunner(api.NewClient(token), token, positional, cmdmeta.DryRunRequested(cmd))
	if err != nil || !ok {
		return err
	}
	return printerFor(cmd).Result(result, func(w io.Writer) {
		name := result.ID
		if obj, isObj := result.Object.(runnerRemoveObject); isObj && obj.Name != "" {
			name = obj.Name
		}
		if result.DryRun {
			fmt.Fprintln(w, ui.MutedStyle.Render(fmt.Sprintf("Would remove the record of runner %s. Nothing was sent.", name)))
			return
		}
		fmt.Fprintln(w, ui.FormatSuccess(fmt.Sprintf("Removed the record of runner %s (%s)", name, result.ID)))
	})
}

// removeRunner resolves the runner, confirms, and deletes its record — or, on a dry run, returns
// the request it would have sent. The bool is false when the person declined the confirmation.
func removeRunner(c runnerRemoveClient, token, positional string, dryRun bool) (MutationResult, bool, error) {
	result := MutationResult{Kind: "runner", Action: ResultDeleted, DryRun: dryRun}

	list, err := c.GetRunners()
	if err != nil {
		return result, false, fmt.Errorf("list runners: %w", err)
	}
	runnerID, err := runnerIDFrom(runnerList(list), runnerRemoveRef, positional, "--runner", "the runner-id argument")
	if err != nil {
		return result, false, err
	}
	if runnerID == "" {
		if runnerID, err = pickRunnerToEnd(token, "remove", "--runner (its name or its id), or the runner id as the argument"); err != nil {
			return result, false, err
		}
	}
	result.ID = runnerID

	obj := runnerRemoveObject{}
	description := "This deletes the record only. No cloud resource is torn down."
	if r, ok := runnerByID(list, runnerID); ok {
		obj.Name, obj.Provisioning = r.Name, r.Provisioning
		if r.Provisioning == runnerProvisioningDeployed {
			// Said on stderr as well as in the dialog: with --yes there is no dialog, and the
			// log of a scripted removal should still carry it.
			printer.Warn(fmt.Sprintf(
				"Runner %s was deployed by Alethia. Removing its record leaves its cloud resources running; "+
					"`alethia runner destroy --runner %s` tears them down first.", r.Name, r.Name))
			description = "This runner was deployed by Alethia. Its cloud resources are NOT torn down and will keep running."
		}
	}
	if dryRun {
		obj.Request = &runnerRemoveRequest{Method: "DELETE", Path: "/api/cli/runners/" + runnerID}
		result.Object = obj
		return result, true, nil
	}

	ok, err := confirmDestructiveByName(runnerRemoveYes, "Remove this runner's record?", description,
		func() string { return runnerConfirmName(list, runnerID) })
	if err != nil || !ok {
		return result, false, err
	}

	runSpinner("Removing runner...", func() {
		err = c.RemoveRunner(runnerID)
	})
	if err != nil {
		e := *clierr.From(err)
		if e.Hint == "" && e.Class == clierr.ClassNotFound {
			e.Hint = "alethia runner list"
		}
		return result, false, &e
	}
	result.Object = obj
	return result, true, nil
}

func init() {
	addYesFlag(runnerRemoveCmd, &runnerRemoveYes)
	runnerCmd.AddCommand(runnerRemoveCmd)
	runnerRemoveCmd.Flags().StringVar(&runnerRemoveRef, "runner", "",
		"Runner to remove, by NAME or id (asked for on a terminal when omitted)")
	addDryRunFlag(runnerRemoveCmd)
}
