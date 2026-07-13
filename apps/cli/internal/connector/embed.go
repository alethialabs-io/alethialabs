// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
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

// AwsBootstrapTemplate is the CloudFormation template that creates, in the user's AWS account, an IAM OIDC
// provider trusting the Alethia issuer + a role Alethia assumes via AssumeRoleWithWebIdentity. Deployed with
// an IssuerUrl parameter (keyless, no external id); outputs RoleArn.
//
//go:embed aws-bootstrap.yaml
var AwsBootstrapTemplate string

// AlibabaConnectorModule is the OpenTofu/Terraform module that registers, in the user's
// Alibaba account, a RAM OIDC provider trusting the Alethia issuer + a RAM role. Applied
// with `terraform apply` (auth via the user's aliyun creds); outputs role_arn. Keyless +
// account-free — Alethia never receives Alibaba credentials.
//
//go:embed alibaba-connector.tf
var AlibabaConnectorModule string

// AlibabaSetupScript uses the aliyun CLI to register, in the user's Alibaba account,
// a RAM OIDC provider trusting the Alethia issuer + a RAM role, then prints the role
// ARN between "--- START CONFIG --- / --- END CONFIG ---" markers. Takes the issuer
// URL as its first argument (or ALETHIA_ISSUER_URL). Keyless + account-free.
//
//go:embed alibaba-setup.sh
var AlibabaSetupScript string
