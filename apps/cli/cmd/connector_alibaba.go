// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/alethialabs-io/alethialabs/apps/cli/internal/cloudshell"
	"github.com/alethialabs-io/alethialabs/apps/cli/internal/connector"
	"github.com/charmbracelet/huh"
	"github.com/spf13/cobra"
)

var (
	connectorAlibabaRegion    string
	connectorAlibabaDir       string
	connectorAlibabaRoleArn   string
	connectorAlibabaManual    bool
	connectorAlibabaTerraform bool
)

const (
	defaultAlibabaRegion = "cn-hangzhou"
	alibabaCloudShellURL = "https://shell.aliyun.com"
)

// alibabaConnector is the Alibaba entry of the parent command's help. The catalog hides this
// cloud, so the entry is read only when an operator has re-enabled it.
var alibabaConnector = registerConnector(connectorInfo{
	Slug:    "alibaba",
	Keyless: "an Alibaba RAM role assumed with OIDC",
})

// connectorAlibabaCmd connects an Alibaba Cloud account. The command is kept and not offered:
// the registry leaves it out of help while the catalog hides the cloud, and running it, or
// asking for its help, is refused with the release's one sentence before anything is sent.
var connectorAlibabaCmd = &cobra.Command{
	Use:   "alibaba",
	Short: "Connect an Alibaba Cloud account",
	Long: `Connect an Alibaba Cloud account using keyless AssumeRoleWithOIDC.

Alethia is its own OIDC issuer. A setup script creates, in your Alibaba account, a RAM
OIDC provider trusting Alethia plus a RAM role; Alethia assumes the role with a
short-lived minted assertion — no AccessKey, nothing stored but the role ARN. Keyless +
account-free: Alethia holds no Alibaba account.

By default the setup runs with your local aliyun CLI. Use --manual to run it in the
Alibaba Cloud Shell and paste back the role ARN, or --terraform to apply the OpenTofu
module instead. Pass --role-arn to submit a role you already created — the flag form of
that same paste, so the command works under --no-input with no aliyun CLI on the
machine.`,
	Args: cobra.NoArgs,
	Run: func(cmd *cobra.Command, args []string) {
		if err := runConnect(cmd, alibabaConnectFlow()); err != nil {
			fail(err)
		}
	},
}

// alibabaConnectFlow is the Alibaba half of the connection pipeline, for the flags this
// invocation gave.
func alibabaConnectFlow() connectFlow {
	given := strings.TrimSpace(connectorAlibabaRoleArn)
	mode := "local"
	switch {
	case given != "":
		mode = "role-arn"
	case connectorAlibabaTerraform:
		mode = "terraform"
	case connectorAlibabaManual:
		mode = "manual"
	}

	var roleArn string
	return connectFlow{
		Provider: alibabaConnector.Slug,
		Mode:     mode,
		Steps:    []string{"Initialize", "Create RAM role", "Connection test"},
		Check: func() error {
			if err := refuseMultipleModes(
				modeFlag{"--role-arn", given != ""},
				modeFlag{"--terraform", connectorAlibabaTerraform},
				modeFlag{"--manual", connectorAlibabaManual},
			); err != nil {
				return err
			}
			switch mode {
			case "manual", "terraform":
				return requirePromptFor("--"+mode, "the role ARN", "--role-arn")
			case "local":
				if err := cloudshell.EnsureAliyun(); err != nil {
					return missingToolError(err,
						"Install it from https://www.alibabacloud.com/help/en/cli/install-cli. "+
							"Or re-run with --manual to set it up in the Alibaba Cloud Shell.")
				}
			}
			return nil
		},
		Capture: func(p *Printer, issuer string) (map[string]interface{}, error) {
			var err error
			switch mode {
			case "role-arn":
				// The flag half of the manual/terraform flows: the RAM role already exists, so
				// there is nothing to create and nothing to prompt for.
				roleArn = given
			case "terraform":
				roleArn, err = alibabaTerraformFlow(p, issuer)
			case "manual":
				roleArn, err = alibabaManualFlow(p, issuer)
			default:
				p.Progress("Running setup via the local aliyun CLI...")
				roleArn, err = cloudshell.RunAlibabaSetup(connector.AlibabaSetupScript, issuer)
			}
			if err != nil {
				return nil, err
			}
			return map[string]interface{}{"role_arn": roleArn}, nil
		},
		Connected: func() string { return fmt.Sprintf("Alibaba Cloud account connected (role %s)", roleArn) },
	}
}

// alibabaManualFlow guides the user through the Alibaba Cloud Shell and prompts for the
// resulting RAM role ARN.
func alibabaManualFlow(p *Printer, issuer string) (string, error) {
	p.Progress("Manual setup:")
	fmt.Fprintf(p.Err, "  Open the Alibaba Cloud Shell (%s) and run:\n\n", alibabaCloudShellURL)
	fmt.Fprintf(p.Err,
		"     curl -sO %s/alethia-alibaba-setup.sh && bash alethia-alibaba-setup.sh %s\n\n",
		connectorBaseURL, issuer,
	)
	fmt.Fprintln(p.Err, "  Then paste the role_arn it prints below.")

	return promptAlibabaRoleArn()
}

// alibabaTerraformFlow writes the connector module to a local directory, guides the user to apply
// it in their Alibaba account (with the issuer URL of THIS control plane), and prompts for the
// resulting RAM role ARN.
func alibabaTerraformFlow(p *Printer, issuer string) (string, error) {
	dir := connectorAlibabaDir
	if dir == "" {
		dir = "alethia-alibaba-connector"
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", fmt.Errorf("create module dir: %w", err)
	}
	modulePath := filepath.Join(dir, "main.tf")
	if err := os.WriteFile(modulePath, []byte(connector.AlibabaConnectorModule), 0o644); err != nil {
		return "", fmt.Errorf("write module: %w", err)
	}

	region := connectorAlibabaRegion
	if region == "" {
		region = defaultAlibabaRegion
	}

	p.Progress("Apply the connector module in your Alibaba account:")
	fmt.Fprintln(p.Err, "  1. Authenticate to Alibaba (aliyun CLI, or ALICLOUD_ACCESS_KEY / ALICLOUD_SECRET_KEY).")
	fmt.Fprintf(p.Err, "  2. Run:\n\n     cd %s\n     tofu init\n     tofu apply -var \"region=%s\" -var \"alethia_issuer_url=%s\"\n\n",
		dir, region, issuer)
	fmt.Fprintln(p.Err, "  3. Copy the role_arn output below.")

	return promptAlibabaRoleArn()
}

// promptAlibabaRoleArn asks the user to paste the RAM role ARN and validates it is non-empty.
func promptAlibabaRoleArn() (string, error) {
	var roleArn string
	if err := runHuhForm(huh.NewGroup(
		huh.NewInput().
			Title("RAM Role ARN").
			Placeholder("acs:ram::123456789012:role/AlethiaProvisioner").
			Value(&roleArn),
	)); err != nil {
		return "", formError(err)
	}
	roleArn = strings.TrimSpace(roleArn)
	if roleArn == "" {
		return "", invalidInputError("no role ARN provided")
	}
	return roleArn, nil
}

func init() {
	connectorCmd.AddCommand(connectorAlibabaCmd)
	refuseHelpForHiddenCloud(connectorAlibabaCmd, alibabaConnector.Slug)
	connectorAlibabaCmd.Flags().StringVar(&connectorAlibabaRegion, "region", "", "Alibaba region for the RAM provider (default cn-hangzhou)")
	connectorAlibabaCmd.Flags().StringVar(&connectorAlibabaRoleArn, "role-arn", "", "ARN of a RAM role you already created — submits it instead of prompting (the flag form of --manual)")
	connectorAlibabaCmd.Flags().StringVar(&connectorAlibabaDir, "dir", "", "Directory to write the OpenTofu module into (--terraform; default ./alethia-alibaba-connector)")
	connectorAlibabaCmd.Flags().BoolVar(&connectorAlibabaManual, "manual", false, "Run setup in the Alibaba Cloud Shell and paste the result")
	connectorAlibabaCmd.Flags().BoolVar(&connectorAlibabaTerraform, "terraform", false, "Apply the OpenTofu module instead of running the setup script")
}
