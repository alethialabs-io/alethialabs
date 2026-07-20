// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package aws

import "testing"

// TestRoleARNFromCallerARN locks the assumed-role → path-stripped-role mapping that the #551 EKS
// self-access entry depends on. The whole fix hinges on producing the role ARN in exactly the
// path-stripped form the IAM Authenticator matches, so a regression here silently reintroduces the
// "Unauthorized after a green apply" failure on pathed provisioning roles.
func TestRoleARNFromCallerARN(t *testing.T) {
	cases := []struct {
		name   string
		caller string
		want   string
	}{
		{
			// The #551 case: the provisioning role lives under an IAM path, but its STS
			// assumed-role ARN is path-stripped — which is exactly what we register.
			name:   "assumed role under an IAM path → path-stripped role ARN",
			caller: "arn:aws:sts::270587882865:assumed-role/alethia-e2e-nightly/GitHubActions",
			want:   "arn:aws:iam::270587882865:role/alethia-e2e-nightly",
		},
		{
			name:   "assumed role with a multi-segment session name",
			caller: "arn:aws:sts::111122223333:assumed-role/AlethiaProvisionerRole/alethia-runner",
			want:   "arn:aws:iam::111122223333:role/AlethiaProvisionerRole",
		},
		{
			name:   "govcloud partition is preserved",
			caller: "arn:aws-us-gov:sts::444455556666:assumed-role/Prov/sess",
			want:   "arn:aws-us-gov:iam::444455556666:role/Prov",
		},
		{
			name:   "plain IAM user is not an assumed role → empty",
			caller: "arn:aws:iam::270587882865:user/deployer",
			want:   "",
		},
		{
			name:   "root is not an assumed role → empty",
			caller: "arn:aws:iam::270587882865:root",
			want:   "",
		},
		{
			name:   "malformed ARN → empty (no panic)",
			caller: "not-an-arn",
			want:   "",
		},
		{
			name:   "empty → empty",
			caller: "",
			want:   "",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := RoleARNFromCallerARN(tc.caller); got != tc.want {
				t.Errorf("RoleARNFromCallerARN(%q) = %q, want %q", tc.caller, got, tc.want)
			}
		})
	}
}
