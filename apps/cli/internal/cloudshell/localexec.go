// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloudshell

import (
	"fmt"
	"os"
	"strings"
)

// EnsureAws verifies the aws CLI is installed.
func EnsureAws() error {
	if !have("aws") {
		return ErrAwsNotFound
	}
	return nil
}

// EnsureAz verifies the az CLI is installed.
func EnsureAz() error {
	if !have("az") {
		return ErrAzNotFound
	}
	return nil
}

// RunAwsBootstrap writes the CloudFormation template to a temp file, deploys it
// with the supplied external id, and returns the created role ARN from the
// stack outputs. Uses the user's locally configured aws credentials.
func RunAwsBootstrap(template, externalID, region, roleName, stackName string) (string, error) {
	path, cleanup, err := writeTemp("alethia-bootstrap-*.yaml", template)
	if err != nil {
		return "", err
	}
	defer cleanup()

	deployArgs := []string{
		"cloudformation", "deploy",
		"--template-file", path,
		"--stack-name", stackName,
		"--capabilities", "CAPABILITY_NAMED_IAM",
		"--parameter-overrides",
		fmt.Sprintf("ExternalId=%s", externalID),
		fmt.Sprintf("RoleName=%s", roleName),
	}
	if region != "" {
		deployArgs = append(deployArgs, "--region", region)
	}
	if _, err := runStreaming("aws", deployArgs...); err != nil {
		return "", fmt.Errorf("cloudformation deploy failed: %w", err)
	}

	queryArgs := []string{
		"cloudformation", "describe-stacks",
		"--stack-name", stackName,
		"--query", "Stacks[0].Outputs[?OutputKey=='RoleArn'].OutputValue",
		"--output", "text",
	}
	if region != "" {
		queryArgs = append(queryArgs, "--region", region)
	}
	roleArn, err := runCapture("aws", queryArgs...)
	if err != nil {
		return "", fmt.Errorf("failed to read stack outputs: %w", err)
	}
	if roleArn == "" {
		return "", fmt.Errorf("stack did not produce a RoleArn output")
	}
	return roleArn, nil
}

// AzureIDs holds the federated identity values captured from the Azure setup.
type AzureIDs struct {
	TenantID       string
	ClientID       string
	SubscriptionID string
}

// RunAzureSetup writes the embedded installer to a temp file, runs it against
// the given subscription using the user's local az login, and returns the
// captured tenant/client/subscription IDs.
func RunAzureSetup(script, subscriptionID string) (*AzureIDs, error) {
	path, cleanup, err := writeTemp("alethia-azure-setup-*.sh", script)
	if err != nil {
		return nil, err
	}
	defer cleanup()

	output, err := runStreaming("bash", path, subscriptionID)
	if err != nil {
		return nil, fmt.Errorf("azure setup failed: %w", err)
	}

	block, ok := extractBetweenMarkers(output)
	if !ok {
		return nil, fmt.Errorf("could not find config in setup output")
	}

	values := parseKeyValues(block)
	ids := &AzureIDs{
		TenantID:       values["tenant_id"],
		ClientID:       values["client_id"],
		SubscriptionID: values["subscription_id"],
	}
	if ids.TenantID == "" || ids.ClientID == "" || ids.SubscriptionID == "" {
		return nil, fmt.Errorf("azure setup did not return all required IDs")
	}
	return ids, nil
}

// writeTemp writes content to a temp file and returns its path plus a cleanup func.
func writeTemp(pattern, content string) (string, func(), error) {
	f, err := os.CreateTemp("", pattern)
	if err != nil {
		return "", nil, err
	}
	if _, err := f.WriteString(content); err != nil {
		f.Close()
		os.Remove(f.Name())
		return "", nil, err
	}
	f.Close()
	return f.Name(), func() { os.Remove(f.Name()) }, nil
}

// parseKeyValues parses simple "key=value" lines into a map.
func parseKeyValues(block string) map[string]string {
	result := map[string]string{}
	for _, line := range strings.Split(block, "\n") {
		line = strings.TrimSpace(line)
		if i := strings.IndexByte(line, '='); i != -1 {
			result[strings.TrimSpace(line[:i])] = strings.TrimSpace(line[i+1:])
		}
	}
	return result
}
