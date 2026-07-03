// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Package connector embeds the cloud-provider setup artifacts the CLI runs on
// the user's behalf (GCP/Azure shell installers, the AWS CloudFormation
// template). Keeping copies in the binary avoids a network dependency at
// connect time.
package connector

import _ "embed"

// GcpSetupScript creates the Workload Identity Federation resources and prints
// the WIF credential config JSON between "--- START CONFIG --- / --- END
// CONFIG ---" markers. Takes the GCP project id as its first argument.
//
//go:embed gcp-setup.sh
var GcpSetupScript string

// AzureSetupScript creates the app registration, federated credential, and role
// assignment, then prints tenant_id/client_id/subscription_id between
// "--- START CONFIG --- / --- END CONFIG ---" markers. Takes the subscription
// id as its first argument.
//
//go:embed azure-setup.sh
var AzureSetupScript string

// AwsBootstrapTemplate is the CloudFormation template that creates the
// cross-account IAM role. Deployed with an ExternalId parameter; outputs RoleArn.
//
//go:embed aws-bootstrap.yaml
var AwsBootstrapTemplate string
