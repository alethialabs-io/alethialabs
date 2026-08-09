// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloud

import (
	"context"
	"encoding/json"
	"net/http"
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

// TestIsRAMNoSuchEntity: only a RAM "role is gone" error is swallowed by the teardown. This is what
// makes DeprovisionACKNamespaceIdentity idempotent — a destroy re-run after a partial failure must
// converge, not fail on the half that already succeeded. A NoPermission must NOT be swallowed: that
// would report a reclaimed identity while the tenant's RAM role is still live.
func TestIsRAMNoSuchEntity(t *testing.T) {
	for _, code := range []string{"EntityNotExist.Role", "NoSuchEntity"} {
		if !isRAMNoSuchEntity(&ramError{code: code}) {
			t.Errorf("%s should be recognized as already-gone", code)
		}
	}
	if isRAMNoSuchEntity(&ramError{code: "NoPermission"}) {
		t.Error("NoPermission must NOT be swallowed as already-gone — the role would survive the teardown")
	}
	if isRAMNoSuchEntity(errNonRAM{}) {
		t.Error("a non-RAM error must not be treated as already-gone")
	}
}

// TestDeprovisionACKNamespaceIdentityFailsClosedWithoutTheKeylessSession mirrors the provision-side
// guard: the teardown refuses before it touches RAM when the keyless RRSA env is absent, rather than
// reporting a reclaimed identity it never reached.
func TestDeprovisionACKNamespaceIdentityFailsClosedWithoutTheKeylessSession(t *testing.T) {
	t.Setenv("ALIBABA_CLOUD_ROLE_ARN", "")
	t.Setenv("ALIBABA_CLOUD_OIDC_PROVIDER_ARN", "")
	t.Setenv("ALIBABA_CLOUD_OIDC_TOKEN_FILE", "")
	err := DeprovisionACKNamespaceIdentity(context.Background(), "cn-hangzhou", "c", "ns")
	if err == nil || !strings.Contains(err.Error(), "build keyless signing client") {
		t.Fatalf("unexpected error: %v", err)
	}
}

// TestDeleteACKNamespaceRoleClassifiesEveryRAMAnswer pins the three answers that matter to a
// teardown. The middle one is the whole point of the idempotence: a role someone already removed
// is the state we wanted, so it must not fail the destroy. The third is the one that must NOT be
// swallowed — reporting a reclaimed identity while the tenant's role is still assumable is the
// class of false success #2016 is about.
func TestDeleteACKNamespaceRoleClassifiesEveryRAMAnswer(t *testing.T) {
	t.Run("deleted", func(t *testing.T) {
		client := covClient(func(req *http.Request) (*http.Response, error) {
			if got := req.Header.Get("x-acs-action"); got != "DeleteRole" {
				t.Errorf("action = %q, want DeleteRole", got)
			}
			return covResponse(200, `{}`), nil
		})
		if err := deleteACKNamespaceRole(context.Background(), client, "alethia-ns-team-ns-abcd1234"); err != nil {
			t.Fatalf("a 200 DeleteRole must succeed: %v", err)
		}
	})

	t.Run("already gone is success", func(t *testing.T) {
		client := covClient(func(*http.Request) (*http.Response, error) {
			return covResponse(404, `{"Code":"EntityNotExist.Role"}`), nil
		})
		if err := deleteACKNamespaceRole(context.Background(), client, "r"); err != nil {
			t.Fatalf("an already-absent role must be success so a re-run converges: %v", err)
		}
	})

	t.Run("denied is NOT swallowed", func(t *testing.T) {
		client := covClient(func(*http.Request) (*http.Response, error) {
			return covResponse(403, `{"Code":"NoPermission"}`), nil
		})
		err := deleteACKNamespaceRole(context.Background(), client, "r")
		if err == nil {
			t.Fatal("a denied delete reported success — the tenant's RAM role would survive the teardown")
		}
		if !strings.Contains(err.Error(), `delete per-namespace RAM role "r"`) {
			t.Fatalf("the error should name the role it failed to delete, got: %v", err)
		}
	})
}

// TestACKNamespaceRoleNameIsDerivedNotStored pins the property the whole teardown design rests on:
// the role name is a pure function of (cluster, namespace), so a destroy job whose config snapshot
// never carried a handle can still reconstruct exactly what the deploy created.
func TestACKNamespaceRoleNameIsDerivedNotStored(t *testing.T) {
	a := ackNamespaceRoleName("cluster-a", "team-ns")
	if b := ackNamespaceRoleName("cluster-a", "team-ns"); a != b {
		t.Fatalf("not deterministic: %q vs %q", a, b)
	}
	if c := ackNamespaceRoleName("cluster-b", "team-ns"); a == c {
		t.Error("two clusters' same-named namespaces must not share one role")
	}
	if d := ackNamespaceRoleName("cluster-a", "other-ns"); a == d {
		t.Error("two namespaces on one cluster must not share one role")
	}
	if !IsValidACKRoleName(a) {
		t.Errorf("derived role name %q is not RAM-valid", a)
	}
}

type errNonRAM struct{}

func (errNonRAM) Error() string { return "boom" }
