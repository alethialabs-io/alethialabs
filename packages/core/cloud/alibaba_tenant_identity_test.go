// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloud

import (
	"encoding/json"
	"strings"
	"testing"
)

// TestBuildACKNamespaceTrustPolicy locks the RRSA trust scoping — the security-critical boundary: the
// role is assumable ONLY by a ServiceAccount in the tenant namespace, on the cluster's own RRSA provider,
// with the mandatory sts.aliyuncs.com audience.
func TestBuildACKNamespaceTrustPolicy(t *testing.T) {
	providerARN := "acs:ram::1234567890:oidc-provider/ack-rrsa-cabc123"
	got, err := buildACKNamespaceTrustPolicy(providerARN, "team-web")
	if err != nil {
		t.Fatalf("buildACKNamespaceTrustPolicy: %v", err)
	}

	var doc struct {
		Version   string `json:"Version"`
		Statement []struct {
			Effect    string `json:"Effect"`
			Action    string `json:"Action"`
			Principal struct {
				Federated []string `json:"Federated"`
			} `json:"Principal"`
			Condition map[string]map[string]string `json:"Condition"`
		} `json:"Statement"`
	}
	if err := json.Unmarshal([]byte(got), &doc); err != nil {
		t.Fatalf("trust policy is not valid JSON: %v\n%s", err, got)
	}
	if doc.Version != "1" || len(doc.Statement) != 1 {
		t.Fatalf("unexpected doc shape: %s", got)
	}
	st := doc.Statement[0]
	if st.Effect != "Allow" || st.Action != "sts:AssumeRole" {
		t.Errorf("effect/action = %q/%q", st.Effect, st.Action)
	}
	if len(st.Principal.Federated) != 1 || st.Principal.Federated[0] != providerARN {
		t.Errorf("Principal.Federated = %v, want [%q]", st.Principal.Federated, providerARN)
	}
	if st.Condition["StringLike"]["oidc:sub"] != "system:serviceaccount:team-web:*" {
		t.Errorf("oidc:sub = %q, want system:serviceaccount:team-web:*", st.Condition["StringLike"]["oidc:sub"])
	}
	if st.Condition["StringEquals"]["oidc:aud"] != ackRRSAAudience {
		t.Errorf("oidc:aud = %q, want %q", st.Condition["StringEquals"]["oidc:aud"], ackRRSAAudience)
	}

	if _, err := buildACKNamespaceTrustPolicy("", "ns"); err == nil {
		t.Error("empty provider ARN must error")
	}
	if _, err := buildACKNamespaceTrustPolicy(providerARN, ""); err == nil {
		t.Error("empty namespace must error")
	}
}

// TestACKNamespaceRoleName: deterministic, bounded (≤64), shell-safe.
func TestACKNamespaceRoleName(t *testing.T) {
	a := ackNamespaceRoleName("proj-prod", "team-web")
	b := ackNamespaceRoleName("proj-prod", "team-web")
	if a != b {
		t.Errorf("role name not deterministic: %q != %q", a, b)
	}
	if ackNamespaceRoleName("proj-prod", "team-web") == ackNamespaceRoleName("proj-prod", "team-api") {
		t.Error("different namespaces must yield different role names")
	}
	long := ackNamespaceRoleName("a-very-long-cluster-name-xxxxxx", strings.Repeat("n", 80))
	if len(long) > 64 || !IsValidACKRoleName(long) {
		t.Errorf("role name %q (len %d) is not bounded/shell-safe", long, len(long))
	}
}

// TestAlibabaAccountIDFromEnv extracts the account id from the ambient role ARN and rejects a malformed one.
func TestAlibabaAccountIDFromEnv(t *testing.T) {
	t.Setenv("ALIBABA_CLOUD_ROLE_ARN", "acs:ram::1234567890:role/alethia-runner")
	acct, err := alibabaAccountIDFromEnv()
	if err != nil || acct != "1234567890" {
		t.Fatalf("account id = %q, err = %v, want 1234567890", acct, err)
	}
	t.Setenv("ALIBABA_CLOUD_ROLE_ARN", "not-an-arn")
	if _, err := alibabaAccountIDFromEnv(); err == nil {
		t.Error("malformed role ARN must error")
	}
}

// TestIsRAMAlreadyExists: only a RAM EntityAlreadyExists error is idempotent-swallowed.
func TestIsRAMAlreadyExists(t *testing.T) {
	if !isRAMAlreadyExists(&ramError{code: "EntityAlreadyExists.Role"}) {
		t.Error("EntityAlreadyExists.Role should be recognized")
	}
	if isRAMAlreadyExists(&ramError{code: "NoPermission"}) {
		t.Error("NoPermission must NOT be swallowed as already-exists")
	}
	if isRAMAlreadyExists(errNonRAM{}) {
		t.Error("a non-RAM error must not be treated as already-exists")
	}
}

type errNonRAM struct{}

func (errNonRAM) Error() string { return "boom" }
