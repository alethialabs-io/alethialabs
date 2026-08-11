// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"io"
	"os"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/runners"
	"github.com/spf13/cobra"
)

var (
	registerRunnerName    string
	registerCloudIdentity string
)

var runnerRegisterCmd = &cobra.Command{
	Use:   "register <name>",
	Short: "Register a runner you run yourself, on any cloud",
	Args:  cobra.MaximumNArgs(1),
	Long: fmt.Sprintf(`Registers a self-operated runner and prints its token once.

Nothing is provisioned: you run the runner, anywhere that can reach the control plane —
a VM on any cloud, a container, or your own hardware. That is what makes this the answer
for the clouds `+"`runner deploy`"+` cannot reach. Deployed runners are %s only, because
Alethia holds runner infrastructure templates for no other cloud; a registered runner has
no such limit.

The token is shown ONCE. Only its SHA-256 is stored, so it cannot be recovered — if you
lose it, register another runner and remove this one.`, runners.DeployProvidersLabel()),
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		name := registerRunnerName
		if len(args) == 1 && args[0] != "" {
			name = args[0]
		}
		if err := runRunnerRegister(api.NewClient(token), os.Stdout, name, registerCloudIdentity); err != nil {
			failf("Failed to register runner: %v", err)
		}
	},
}

// runRunnerRegister registers the runner and prints the credentials the operator must copy.
//
// The token goes to STDOUT as `ALETHIA_RUNNER_ID` / `ALETHIA_RUNNER_TOKEN` assignments rather than as
// prose, because the next thing that happens to it is being pasted into an env file or a systemd
// unit — and a value a reader has to extract from a sentence is a value they can get wrong.
func runRunnerRegister(c apiClient, out io.Writer, name, cloudIdentityID string) error {
	if name == "" {
		return fmt.Errorf("a runner name is required (pass it as the argument, or --name)")
	}
	reg, err := c.RegisterRunner(name, cloudIdentityID)
	if err != nil {
		return err
	}
	if reg == nil {
		return fmt.Errorf("the server returned no runner registration")
	}

	fmt.Fprintln(out, ui.FormatSuccess(fmt.Sprintf("Registered runner %s (%s)", reg.Runner.Name, reg.Runner.ID)))
	fmt.Fprintln(out)
	fmt.Fprintf(out, "ALETHIA_RUNNER_ID=%s\n", reg.Runner.ID)
	fmt.Fprintf(out, "ALETHIA_RUNNER_TOKEN=%s\n", reg.RunnerToken)
	fmt.Fprintln(out)
	fmt.Fprintln(out, ui.MutedStyle.Render("The token is shown once — only its hash is stored. Copy it now."))
	fmt.Fprintln(out, ui.MutedStyle.Render("Give both to the runner process, then check `alethia runner list` for its heartbeat."))
	return nil
}

func init() {
	runnerRegisterCmd.Flags().StringVar(&registerRunnerName, "name", "", "Runner name (or pass it as the argument)")
	runnerRegisterCmd.Flags().StringVar(&registerCloudIdentity, "cloud-identity-id", "", "Bind the runner to a cloud account (optional)")
	runnerCmd.AddCommand(runnerRegisterCmd)
}
