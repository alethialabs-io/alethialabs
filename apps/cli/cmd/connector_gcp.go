// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/alethialabs-io/alethialabs/apps/cli/internal/cloudshell"
	"github.com/alethialabs-io/alethialabs/apps/cli/internal/connector"
	"github.com/charmbracelet/huh"
	"github.com/spf13/cobra"
)

var (
	connectorGcpProject   string
	connectorGcpWifConfig string
	connectorGcpManual    bool
)

// gcpConnector is the GCP entry of the parent command's help.
var gcpConnector = registerConnector(connectorInfo{
	Slug:    "gcp",
	Keyless: "GCP Workload Identity Federation",
})

var connectorGcpCmd = &cobra.Command{
	Use:   "gcp",
	Short: "Connect a Google Cloud project",
	Long: `Connect a Google Cloud project with Workload Identity Federation. Run it once per
project, before the first deploy into that project.

The installer runs inside your Google Cloud Shell (authenticated as you), creates
a provisioner service account and a workload identity pool that trusts Alethia,
and returns a credential config — no service account keys are ever created.

The default needs a local, authenticated gcloud. Use --manual to instead run the
installer in the browser Cloud Shell and paste the result, or --wif-config to submit
a credential config you already have — the flag form of that same paste, so the
command works under --no-input with no gcloud on the machine.`,
	Args: cobra.NoArgs,
	Run: func(cmd *cobra.Command, args []string) {
		if err := runConnect(cmd, gcpConnectFlow(os.Stdin)); err != nil {
			fail(err)
		}
	},
}

// gcpConnectFlow is the GCP half of the connection pipeline, for the flags this invocation gave.
// stdin is where `--wif-config -` reads from.
func gcpConnectFlow(stdin io.Reader) connectFlow {
	mode := "local"
	switch {
	case connectorGcpWifConfig != "":
		mode = "wif-config"
	case connectorGcpManual:
		mode = "manual"
	}

	return connectFlow{
		Provider: gcpConnector.Slug,
		Mode:     mode,
		Steps:    []string{"Project", "Cloud Shell setup", "Connection test"},
		Check: func() error {
			if err := refuseMultipleModes(
				modeFlag{"--wif-config", strings.TrimSpace(connectorGcpWifConfig) != ""},
				modeFlag{"--manual", connectorGcpManual},
			); err != nil {
				return err
			}
			if strings.TrimSpace(connectorGcpProject) == "" {
				if err := requireInteractiveForm(); err != nil {
					return inputRequiredError(err, "no project given: pass --project")
				}
			}
			switch mode {
			case "manual":
				return requirePromptFor("--manual", "the WIF config", "--wif-config <path|->")
			case "local":
				return requireGcloud()
			}
			return nil
		},
		Prepare: func(_ *Printer) error {
			if connectorGcpProject == "" {
				if err := runHuhForm(huh.NewGroup(
					huh.NewInput().
						Title("GCP Project ID").
						Description("The project Alethia should provision into").
						Value(&connectorGcpProject),
				)); err != nil {
					return formError(err)
				}
			}
			connectorGcpProject = strings.TrimSpace(connectorGcpProject)
			if connectorGcpProject == "" {
				return invalidInputError("a project ID is required")
			}
			return nil
		},
		Capture: func(p *Printer, _ string) (map[string]interface{}, error) {
			var wifJSON string
			var err error
			switch mode {
			case "wif-config":
				// The flag half of the manual flow: the pool and provisioner already exist, so
				// there is nothing to install and nothing to paste.
				wifJSON, err = readWifConfig(connectorGcpWifConfig, stdin)
			case "manual":
				wifJSON, err = gcpManualFlow(p, connectorGcpProject)
			default:
				p.Progress("Running installer via gcloud Cloud Shell (the first run can take a minute)...")
				wifJSON, err = cloudshell.RunGcpSetupInCloudShell(connector.GcpSetupScript, connectorGcpProject)
			}
			if err != nil {
				return nil, err
			}

			var wif interface{}
			if err := json.Unmarshal([]byte(wifJSON), &wif); err != nil {
				return nil, invalidInputError("the WIF config is not valid JSON: %v", err)
			}
			return map[string]interface{}{"wif_config": wif}, nil
		},
		Connected: func() string { return fmt.Sprintf("GCP project %q connected", connectorGcpProject) },
	}
}

// requireGcloud refuses the default setup on a machine with no usable gcloud, telling a missing
// CLI apart from one that is not signed in.
func requireGcloud() error {
	err := cloudshell.EnsureGcloud()
	const otherwise = "Or re-run with --manual to set it up in the browser Cloud Shell."
	switch {
	case err == nil:
		return nil
	case errors.Is(err, cloudshell.ErrGcloudNotAuthed):
		return missingToolError(err, "Run `gcloud auth login`, then retry. "+otherwise)
	}
	return missingToolError(err, "Install it from https://cloud.google.com/sdk/docs/install. "+otherwise)
}

// gcpManualFlow guides the user through running the installer in the browser
// Cloud Shell and pasting the resulting WIF config.
func gcpManualFlow(p *Printer, projectID string) (string, error) {
	p.Progress("Manual setup:")
	fmt.Fprintf(p.Err, "  1. Open Cloud Shell: %s\n", gcpCloudShellURL)
	fmt.Fprintf(p.Err,
		"  2. Run:\n\n     curl -sO %s/alethia-gcp-setup.sh && bash alethia-gcp-setup.sh %s\n\n",
		connectorBaseURL, projectID,
	)
	fmt.Fprintln(p.Err, "  3. Paste the config it prints (between START CONFIG and END CONFIG) below.")

	var wifJSON string
	if err := runHuhForm(huh.NewGroup(
		huh.NewText().
			Title("WIF credential config JSON").
			Value(&wifJSON),
	)); err != nil {
		return "", formError(err)
	}
	if strings.TrimSpace(wifJSON) == "" {
		return "", invalidInputError("no WIF config provided")
	}
	return wifJSON, nil
}

// readWifConfig loads the WIF credential config the --wif-config flag names: a file path, or
// "-" for stdin.
//
// A PATH rather than the JSON itself, deliberately. The form asks for a pasted blob of about
// a kilobyte; the same value on a command line lands in the shell history and the process
// list, and every shell in the world would need it quoted correctly. A path (or a pipe) is
// the same field in the form a script can actually supply.
func readWifConfig(ref string, stdin io.Reader) (string, error) {
	if ref == "-" {
		raw, err := io.ReadAll(stdin)
		if err != nil {
			return "", invalidInputError("read WIF config from stdin: %v", err)
		}
		if strings.TrimSpace(string(raw)) == "" {
			return "", invalidInputError("no WIF config on stdin")
		}
		return string(raw), nil
	}
	raw, err := os.ReadFile(ref)
	if err != nil {
		return "", invalidInputError("read WIF config %q: %v", ref, err)
	}
	if strings.TrimSpace(string(raw)) == "" {
		return "", invalidInputError("WIF config %q is empty", ref)
	}
	return string(raw), nil
}

func init() {
	connectorCmd.AddCommand(connectorGcpCmd)
	connectorGcpCmd.Flags().StringVar(&connectorGcpProject, "project", "", "GCP project ID")
	connectorGcpCmd.Flags().StringVar(&connectorGcpWifConfig, "wif-config", "", "Path to a WIF credential config JSON you already have (or - for stdin) — the flag form of --manual")
	connectorGcpCmd.Flags().BoolVar(&connectorGcpManual, "manual", false, "Run the installer in the browser Cloud Shell and paste the result")
}
