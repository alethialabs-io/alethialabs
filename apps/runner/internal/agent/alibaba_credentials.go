// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"context"
	"fmt"
	"os"

	"github.com/aliyun/alibaba-cloud-sdk-go/sdk/requests"
	"github.com/aliyun/alibaba-cloud-sdk-go/services/sts"
)

// ActivateAlibabaRole assumes the customer's RAM role via Alibaba STS, using
// Alethia's PLATFORM Alibaba credentials (a single platform secret — never the
// customer's, which are never stored). It exports the short-lived credentials to the
// env vars the Terraform alicloud provider + aliyun CLI read. This is the genuine
// zero-trust path: the customer stores zero credentials in Alethia, exactly like AWS.
//
// Platform credentials come from ALETHIA_ALIBABA_ACCESS_KEY_ID / _ACCESS_KEY_SECRET
// (and an optional ALETHIA_ALIBABA_REGION for the STS endpoint). The customer's RAM
// role trust policy trusts Alethia's account with the ExternalId condition.
func ActivateAlibabaRole(_ context.Context, roleArn, externalID, sessionName string) (func(), error) {
	accessKeyID := os.Getenv("ALETHIA_ALIBABA_ACCESS_KEY_ID")
	accessKeySecret := os.Getenv("ALETHIA_ALIBABA_ACCESS_KEY_SECRET")
	if accessKeyID == "" || accessKeySecret == "" {
		return nil, fmt.Errorf(
			"platform Alibaba credentials not configured (set ALETHIA_ALIBABA_ACCESS_KEY_ID and ALETHIA_ALIBABA_ACCESS_KEY_SECRET on the runner)",
		)
	}

	region := os.Getenv("ALETHIA_ALIBABA_REGION")
	if region == "" {
		region = "cn-hangzhou"
	}

	client, err := sts.NewClientWithAccessKey(region, accessKeyID, accessKeySecret)
	if err != nil {
		return nil, fmt.Errorf("failed to create Alibaba STS client: %w", err)
	}

	request := sts.CreateAssumeRoleRequest()
	request.Scheme = "https"
	request.RoleArn = roleArn
	request.RoleSessionName = sessionName
	request.DurationSeconds = requests.NewInteger(3600)
	if externalID != "" {
		request.ExternalId = externalID
	}

	response, err := client.AssumeRole(request)
	if err != nil {
		return nil, fmt.Errorf("failed to assume Alibaba RAM role %s: %w", roleArn, err)
	}

	creds := response.Credentials
	_ = os.Setenv("ALICLOUD_ACCESS_KEY", creds.AccessKeyId)
	_ = os.Setenv("ALICLOUD_SECRET_KEY", creds.AccessKeySecret)
	_ = os.Setenv("ALICLOUD_SECURITY_TOKEN", creds.SecurityToken)

	cleanup := func() {
		_ = os.Unsetenv("ALICLOUD_ACCESS_KEY")
		_ = os.Unsetenv("ALICLOUD_SECRET_KEY")
		_ = os.Unsetenv("ALICLOUD_SECURITY_TOKEN")
	}
	return cleanup, nil
}
