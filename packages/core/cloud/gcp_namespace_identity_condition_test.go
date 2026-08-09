// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloud

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TestProvisionGKENamespaceIdentity_PreservesConditionsAndUnknownFields is #2027's repro, kept.
//
// The read-modify-write decoded the policy into a struct with no `condition` field, so json.Unmarshal
// dropped the condition of every existing binding and setIamPolicy wrote the policy back without it —
// silently converting a time-bounded or resource-scoped grant into a permanent unconditional one, on
// an ordinary namespace deploy, with nothing in the logs.
//
// Reuses gkeIAMStub/clientTo from the sibling tests rather than standing up a second fake IAM API.
func TestProvisionGKENamespaceIdentity_PreservesConditionsAndUnknownFields(t *testing.T) {
	const existing = `{
	  "version": 3,
	  "etag": "BwXyz",
	  "bindings": [
	    {
	      "role": "roles/iam.serviceAccountTokenCreator",
	      "members": ["user:breakglass@example.com"],
	      "condition": {
	        "title": "expires-2026-12-31",
	        "description": "break-glass, time bounded",
	        "expression": "request.time < timestamp(\"2026-12-31T00:00:00Z\")"
	      }
	    }
	  ],
	  "auditConfigs": [
	    {"service": "iam.googleapis.com", "auditLogConfigs": [{"logType": "DATA_WRITE"}]}
	  ]
	}`

	stub := &gkeIAMStub{createStatus: http.StatusOK, getPolicy: existing}
	srv := httptest.NewServer(stub.handler(t))
	defer srv.Close()
	client, _ := clientTo(srv)

	if _, err := ProvisionGKENamespaceIdentity(context.Background(), client, "wif-token", "proj-1", "cluster-1", "team-web"); err != nil {
		t.Fatalf("ProvisionGKENamespaceIdentity: %v", err)
	}
	if !stub.setCalled {
		t.Fatal("setIamPolicy was never called — nothing to assert on")
	}

	// The condition must survive the round trip. Asserted on the RAW body, because that is what GCP
	// receives; a struct-level check could pass while the wire form dropped it.
	if !strings.Contains(stub.setBody, "expires-2026-12-31") {
		t.Errorf("PRIVILEGE BROADENING: the break-glass binding was written back with its condition STRIPPED — a time-bounded grant became permanent:\n%s", stub.setBody)
	}
	// auditConfigs is not one of the managed fields; dropping it would turn OFF audit logging.
	if !strings.Contains(stub.setBody, "auditConfigs") {
		t.Errorf("auditConfigs was dropped by the round trip — audit logging on the GSA would be disabled:\n%s", stub.setBody)
	}
	// The pre-existing binding itself must still be there.
	if !strings.Contains(stub.setBody, "roles/iam.serviceAccountTokenCreator") {
		t.Errorf("the pre-existing binding disappeared entirely:\n%s", stub.setBody)
	}
	// And the binding we actually manage was added.
	member := gkeWorkloadIdentityMember("proj-1", "team-web")
	if !strings.Contains(stub.setBody, gkeWorkloadIdentityUserRole) || !strings.Contains(stub.setBody, member) {
		t.Errorf("the workloadIdentityUser binding was not added:\n%s", stub.setBody)
	}
}

// TestAddIAMMemberTargetsTheUnconditionalBinding covers the other half of the same defect. GCP allows
// several bindings with the SAME role and different conditions — they are different grants — so
// matching on role alone would append our member to whichever came first and silently constrain the
// workload-identity grant to that condition.
func TestAddIAMMemberTargetsTheUnconditionalBinding(t *testing.T) {
	role := gkeWorkloadIdentityUserRole
	bindings := []iamBinding{
		{Role: role, Members: []string{"user:old@example.com"}, Condition: json.RawMessage(`{"title":"t","expression":"false"}`)},
		{Role: role, Members: []string{"user:plain@example.com"}},
	}

	out := addIAMMember(bindings, role, "serviceAccount:new")

	if len(out) != 2 {
		t.Fatalf("binding count changed: got %d, want 2 (the member belongs in the existing unconditional binding)", len(out))
	}
	if strings.Contains(strings.Join(out[0].Members, ","), "serviceAccount:new") {
		t.Error("the member was added to the CONDITIONAL binding; the grant would only hold while that condition did")
	}
	if !strings.Contains(strings.Join(out[1].Members, ","), "serviceAccount:new") {
		t.Errorf("the member was not added to the unconditional binding: %+v", out[1])
	}
	if len(out[0].Condition) == 0 {
		t.Error("the conditional binding lost its condition")
	}
}

// TestAddIAMMemberCreatesAnUnconditionalBindingWhenOnlyConditionalOnesExist: with no unconditional
// binding for the role, a new one must be created rather than the conditional one reused.
func TestAddIAMMemberCreatesAnUnconditionalBindingWhenOnlyConditionalOnesExist(t *testing.T) {
	role := gkeWorkloadIdentityUserRole
	bindings := []iamBinding{
		{Role: role, Members: []string{"user:old@example.com"}, Condition: json.RawMessage(`{"title":"t","expression":"false"}`)},
	}

	out := addIAMMember(bindings, role, "serviceAccount:new")

	if len(out) != 2 {
		t.Fatalf("want a NEW unconditional binding alongside the conditional one; got %d binding(s)", len(out))
	}
	if len(out[1].Condition) != 0 {
		t.Error("the newly created binding carries a condition; it must be unconditional")
	}
}

// TestIamPolicyHasMemberIgnoresConditionalGrants: a member bound only under a condition is not
// unconditionally bound. Treating it as a match would make the deploy skip the write and leave
// workload identity broken as soon as the condition stopped holding.
func TestIamPolicyHasMemberIgnoresConditionalGrants(t *testing.T) {
	member := gkeWorkloadIdentityMember("proj-1", "team-web")
	pol := iamPolicy{Bindings: []iamBinding{
		{Role: gkeWorkloadIdentityUserRole, Members: []string{member}, Condition: json.RawMessage(`{"expression":"false"}`)},
	}}
	if iamPolicyHasMember(pol, gkeWorkloadIdentityUserRole, member) {
		t.Error("a conditional grant was read as an unconditional one; the reconcile would be skipped")
	}

	pol.Bindings = append(pol.Bindings, iamBinding{Role: gkeWorkloadIdentityUserRole, Members: []string{member}})
	if !iamPolicyHasMember(pol, gkeWorkloadIdentityUserRole, member) {
		t.Error("an unconditional grant was not recognised")
	}
}

// TestIamPolicyRoundTripPreservesUnknownFields pins the lossless contract directly. The original bug
// was a struct that modelled only what it managed; anything a future GCP policy field adds must ride
// through untouched rather than being deleted by the next deploy.
func TestIamPolicyRoundTripPreservesUnknownFields(t *testing.T) {
	const in = `{"version":3,"etag":"E","bindings":[{"role":"r","members":["m"]}],"auditConfigs":[{"service":"s"}],"someFutureField":{"a":1}}`

	var pol iamPolicy
	if err := json.Unmarshal([]byte(in), &pol); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	out, err := json.Marshal(pol)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	for _, want := range []string{`"auditConfigs"`, `"someFutureField"`, `"version":3`, `"etag":"E"`} {
		if !strings.Contains(string(out), want) {
			t.Errorf("round trip dropped %s:\n%s", want, out)
		}
	}
}
