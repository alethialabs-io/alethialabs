// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"net/url"
	"strings"

	"github.com/alethialabs-io/alethialabs/apps/cli/internal/cloudshell"
	"github.com/alethialabs-io/alethialabs/apps/cli/internal/connector"
	"github.com/charmbracelet/huh"
	"github.com/spf13/cobra"
)

var (
	connectorAwsRegion   string
	connectorAwsRoleName string
	connectorAwsRoleArn  string
	connectorAwsManual   bool
	connectorAwsScript   bool
)

const defaultAwsRoleName = "AlethiaProvisionerRole"

// awsConnector is the AWS entry of the parent command's help.
var awsConnector = registerConnector(connectorInfo{
	Slug:    "aws",
	Keyless: "an AWS role assumed with a web identity",
})

var connectorAwsCmd = &cobra.Command{
	Use:   "aws",
	Short: "Connect an AWS account",
	Long: `Connect an AWS account with a keyless IAM role. Run it once per account, before
the first deploy into that account.

Alethia deploys a CloudFormation stack that creates an IAM OIDC provider trusting
the Alethia issuer and a role Alethia assumes via AssumeRoleWithWebIdentity — no
access keys and no external id.

By default the stack is deployed with your local aws CLI. Use --script to run the
aws-CLI setup script instead, --manual to deploy from the AWS console and paste
back the role ARN, or --role-arn to submit a role you already created — the flag
form of that same paste, so the command works under --no-input with no aws CLI on
the machine.`,
	Args: cobra.NoArgs,
	Run: func(cmd *cobra.Command, args []string) {
		if err := runConnect(cmd, awsConnectFlow()); err != nil {
			fail(err)
		}
	},
}

// awsConnectFlow is the AWS half of the connection pipeline, for the flags this invocation gave.
func awsConnectFlow() connectFlow {
	given := strings.TrimSpace(connectorAwsRoleArn)
	mode := "local"
	switch {
	case given != "":
		mode = "role-arn"
	case connectorAwsManual:
		mode = "manual"
	case connectorAwsScript:
		mode = "script"
	}

	var roleArn string
	return connectFlow{
		Provider: awsConnector.Slug,
		Mode:     mode,
		Steps:    []string{"Initialize", "Create IAM role", "Connection test"},
		Check: func() error {
			if err := refuseMultipleModes(
				modeFlag{"--role-arn", given != ""},
				modeFlag{"--manual", connectorAwsManual},
				modeFlag{"--script", connectorAwsScript},
			); err != nil {
				return err
			}
			switch mode {
			case "manual":
				return requirePromptFor("--manual", "the role ARN", "--role-arn")
			case "local":
				return requireAwsCLI("Or re-run with --manual to deploy from the AWS console.")
			case "script":
				return requireAwsCLI(fmt.Sprintf("Or run it in AWS CloudShell (%s) with --manual.", awsCloudShellURL))
			}
			return nil
		},
		Capture: func(p *Printer, issuer string) (map[string]interface{}, error) {
			var err error
			switch mode {
			case "role-arn":
				// The flag half of the manual flow: the role already exists, so there is nothing to
				// create and nothing to prompt for.
				roleArn = given
			case "manual":
				roleArn, err = awsManualFlow(p, issuer)
			case "script":
				p.Progress("Running the setup script via the local aws CLI...")
				roleArn, err = cloudshell.RunAwsSetupScript(connector.AwsSetupScript, issuer)
			default:
				roleArn, err = awsLocalFlow(p, issuer)
			}
			if err != nil {
				return nil, err
			}
			return map[string]interface{}{"role_arn": roleArn}, nil
		},
		Connected: func() string { return fmt.Sprintf("AWS account connected (role %s)", roleArn) },
	}
}

// requireAwsCLI refuses a setup that needs the aws CLI on a machine that does not have it, saying
// where to get it and how to go on without it.
func requireAwsCLI(otherwise string) error {
	if err := cloudshell.EnsureAws(); err != nil {
		return missingToolError(err,
			"Install it from https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html. "+otherwise)
	}
	return nil
}

// awsLocalFlow deploys the CloudFormation stack with the local aws CLI and
// returns the created role ARN.
func awsLocalFlow(p *Printer, issuerURL string) (string, error) {
	roleName := connectorAwsRoleName
	if roleName == "" {
		roleName = defaultAwsRoleName
	}

	p.Progress("Deploying the CloudFormation stack via the local aws CLI...")
	return cloudshell.RunAwsBootstrap(
		connector.AwsBootstrapTemplate,
		issuerURL,
		connectorAwsRegion,
		roleName,
		"AlethiaConnect",
	)
}

// awsManualFlow prints a CloudFormation quick-create link and prompts for the
// resulting role ARN.
func awsManualFlow(p *Printer, issuerURL string) (string, error) {
	templateURL := connectorBaseURL + "/alethia-bootstrap.yaml"
	quickCreate := fmt.Sprintf(
		"https://console.aws.amazon.com/cloudformation/home#/stacks/quickcreate?templateURL=%s&stackName=AlethiaConnect&param_IssuerUrl=%s",
		url.QueryEscape(templateURL), url.QueryEscape(issuerURL),
	)

	p.Progress("Manual setup:")
	fmt.Fprintf(p.Err, "  1. Open the CloudFormation quick-create link:\n\n     %s\n\n", quickCreate)
	fmt.Fprintln(p.Err, "  2. Create the stack (it trusts the Alethia issuer — no external id), then copy its RoleArn output below.")

	var roleArn string
	if err := runHuhForm(huh.NewGroup(
		huh.NewInput().
			Title("Role ARN").
			Placeholder("arn:aws:iam::123456789012:role/AlethiaProvisionerRole-...").
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
	connectorCmd.AddCommand(connectorAwsCmd)
	connectorAwsCmd.Flags().StringVar(&connectorAwsRegion, "region", "", "AWS region for the CloudFormation stack")
	connectorAwsCmd.Flags().StringVar(&connectorAwsRoleName, "role-name", defaultAwsRoleName, "Name for the IAM role the stack creates")
	connectorAwsCmd.Flags().StringVar(&connectorAwsRoleArn, "role-arn", "", "ARN of a role you already created — submits it instead of prompting (the flag form of --manual)")
	connectorAwsCmd.Flags().BoolVar(&connectorAwsManual, "manual", false, "Deploy from the AWS console and paste the role ARN")
	connectorAwsCmd.Flags().BoolVar(&connectorAwsScript, "script", false, "Use the aws-CLI setup script instead of the CloudFormation stack")
}
