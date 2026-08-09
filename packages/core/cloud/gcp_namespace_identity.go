// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloud

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

// GCP per-namespace tenant identity (#1127, the Workload-Identity twin of the AWS IRSA path in
// cloud/aws/tenant_identity.go). A `namespace`-placement tenant on a shared GKE Fabric must get its OWN
// least-priv GCP identity, never a path to the node/controller service account. The namespace-deploy
// path runs NO tofu, so this provisions the identity LIVE via the IAM REST API at deploy time, keyless
// (the runner's Workload-Identity-Federated OAuth token is injected — stdlib net/http only, no GCP SDK
// added to packages/core/go.mod, mirroring gcp_namespace_mint.go).
//
// The identity is a per-(cluster,namespace) Google service account with **NO project roles** (zero-perm,
// like the zero-perm IRSA role); the ONLY grant is `roles/iam.workloadIdentityUser` ON that GSA to the
// GKE Workload-Identity principal `serviceAccount:<project>.svc.id.goog[<ns>/default]`, so the tenant
// namespace's default KSA — and only it — may impersonate this GSA. The KSA is then annotated
// `iam.gke.io/gcp-service-account=<gsa-email>` (bindGKENamespaceIdentity, deploy_namespace.go).
//
// CAVEAT (documented, for the security review): GKE classic Workload Identity's principal is
// PROJECT-scoped — `[<ns>/<ksa>]`, the cluster is NOT part of it. Two clusters in the SAME project that
// share a namespace name therefore share the WI principal, so their per-cluster GSAs are not mutually
// isolated at the pool level. Alethia provisions one GKE Fabric per project, so this is an edge case;
// full cross-cluster isolation would need fleet WI (`<project>.svc.id.goog[<ns>/<ksa>]` scoped by
// membership) — a follow-up. Fail-closed + idempotent throughout.

const (
	// gkeIAMAPIBase is the GCP IAM REST base. A const in production; tests redirect via the injected
	// http.Client's transport, so URL construction is still exercised.
	gkeIAMAPIBase = "https://iam.googleapis.com"
	// gkeWorkloadIdentityUserRole is the ONLY role bound — on the GSA itself — letting the KSA impersonate
	// it. It grants no project permissions (zero-perm identity boundary).
	gkeWorkloadIdentityUserRole = "roles/iam.workloadIdentityUser"
)

// ErrGKEIdentity is the sentinel wrapping any non-recoverable IAM provisioning failure.
var ErrGKEIdentity = errors.New("gke namespace identity")

// gsaEmailRe matches a Google service-account email (shell-safe — it flows into `kubectl annotate ...`
// through bash -c). Defense-in-depth on top of the deterministic derivation.
var gsaEmailRe = regexp.MustCompile(`^[a-z][-a-z0-9]{4,28}[a-z0-9]@[a-z0-9-]+\.iam\.gserviceaccount\.com$`)

// IsValidGSAEmail reports whether s is a well-formed GSA email (shell-safe for the KSA annotation).
func IsValidGSAEmail(s string) bool { return gsaEmailRe.MatchString(s) }

// namespaceGSAAccountID derives a deterministic, GCP-valid service-account id (6–30 chars, `[a-z]([-a-z0-9]*[a-z0-9])`)
// for a (cluster, namespace) pair. Deterministic so a re-deploy reconciles the SAME GSA (idempotent); a
// short content hash keeps it unique + within the 30-char limit regardless of the input lengths.
func namespaceGSAAccountID(clusterName, namespace string) string {
	sum := sha256.Sum256([]byte(clusterName + "/" + namespace))
	return "nsid-" + hex.EncodeToString(sum[:])[:16] // 5 + 16 = 21 chars
}

// gkeWorkloadIdentityMember is the GKE Workload-Identity principal for the namespace's default KSA — the
// member that receives roles/iam.workloadIdentityUser on the per-namespace GSA.
func gkeWorkloadIdentityMember(projectID, namespace string) string {
	return fmt.Sprintf("serviceAccount:%s.svc.id.goog[%s/default]", projectID, namespace)
}

// gkeNamespaceGSAEmail is the GSA email for a project + account id.
func gkeNamespaceGSAEmail(projectID, accountID string) string {
	return fmt.Sprintf("%s@%s.iam.gserviceaccount.com", accountID, projectID)
}

// iamPolicy / iamBinding are the slices of the IAM Policy shape this code reads+writes (getIamPolicy /
// setIamPolicy on a service account). Only the workloadIdentityUser binding is managed; any other
// bindings on the resource are preserved.
// Both types round-trip LOSSLESSLY. This is a read-modify-write of somebody else's policy: every
// field the struct fails to model is a field setIamPolicy silently deletes, and the deletion is a
// privilege change made by an automated deploy with nothing in the logs to show for it (#2027).
//
// `other` carries the top-level fields not modelled here — `auditConfigs` above all, whose loss
// would turn OFF audit logging on the GSA. Modelling only what we manage and re-marshalling was the
// original mistake; unknown fields are now preserved rather than enumerated, so a future GCP policy
// field cannot reintroduce this by simply existing.
type iamPolicy struct {
	Version  int
	Etag     string
	Bindings []iamBinding

	other map[string]json.RawMessage
}

// managed top-level keys — everything else round-trips through `other`.
var iamPolicyManagedKeys = map[string]bool{"version": true, "etag": true, "bindings": true}

func (p *iamPolicy) UnmarshalJSON(b []byte) error {
	raw := map[string]json.RawMessage{}
	if err := json.Unmarshal(b, &raw); err != nil {
		return err
	}
	*p = iamPolicy{other: map[string]json.RawMessage{}}
	for k, v := range raw {
		switch k {
		case "version":
			if err := json.Unmarshal(v, &p.Version); err != nil {
				return err
			}
		case "etag":
			if err := json.Unmarshal(v, &p.Etag); err != nil {
				return err
			}
		case "bindings":
			if err := json.Unmarshal(v, &p.Bindings); err != nil {
				return err
			}
		default:
			p.other[k] = v
		}
	}
	return nil
}

func (p iamPolicy) MarshalJSON() ([]byte, error) {
	out := map[string]json.RawMessage{}
	for k, v := range p.other {
		if !iamPolicyManagedKeys[k] {
			out[k] = v
		}
	}
	if p.Version != 0 {
		b, err := json.Marshal(p.Version)
		if err != nil {
			return nil, err
		}
		out["version"] = b
	}
	if p.Etag != "" {
		b, err := json.Marshal(p.Etag)
		if err != nil {
			return nil, err
		}
		out["etag"] = b
	}
	if len(p.Bindings) > 0 {
		b, err := json.Marshal(p.Bindings)
		if err != nil {
			return nil, err
		}
		out["bindings"] = b
	}
	return json.Marshal(out)
}

// iamBinding models the two fields this code manages plus the condition it must NOT eat.
//
// Condition is json.RawMessage rather than a typed Expr: it is never read, only carried, and a
// typed struct would drop any sub-field GCP adds later — the same defect one level down.
type iamBinding struct {
	Role      string          `json:"role"`
	Members   []string        `json:"members"`
	Condition json.RawMessage `json:"condition,omitempty"`
}

// ProvisionGKENamespaceIdentity get-or-creates the per-namespace GSA and ensures the KSA has
// roles/iam.workloadIdentityUser on it, returning the GSA email. Idempotent: a re-deploy re-creates
// nothing (409 → get) and the binding is reconciled additively (get→merge→set). `accessToken` is a
// keyless WIF OAuth token with iam.serviceAccounts.create + setIamPolicy on the project (the runner's
// injected token); it is a bearer, never logged. `namespace` MUST already be DNS-1123 validated.
func ProvisionGKENamespaceIdentity(
	ctx context.Context,
	client *http.Client,
	accessToken, projectID, clusterName, namespace string,
) (string, error) {
	if strings.TrimSpace(accessToken) == "" {
		return "", fmt.Errorf("%w: empty access token (a keyless WIF OAuth token is required)", ErrGKEIdentity)
	}
	if projectID == "" || clusterName == "" || namespace == "" {
		return "", fmt.Errorf("%w: project, cluster and namespace must all be set (got %q / %q / %q)", ErrGKEIdentity, projectID, clusterName, namespace)
	}
	if client == nil {
		client = &http.Client{Timeout: 20 * time.Second}
	}
	accountID := namespaceGSAAccountID(clusterName, namespace)
	email := gkeNamespaceGSAEmail(projectID, accountID)

	if err := ensureGSA(ctx, client, accessToken, projectID, accountID, namespace); err != nil {
		return "", err
	}
	if err := ensureWorkloadIdentityBinding(ctx, client, accessToken, projectID, email, namespace); err != nil {
		return "", err
	}
	return email, nil
}

// ensureGSA creates the per-namespace service account, tolerating "already exists" (idempotent). Zero-perm:
// no project role is granted here — only the create.
func ensureGSA(ctx context.Context, client *http.Client, token, projectID, accountID, namespace string) error {
	body, _ := json.Marshal(map[string]any{
		"accountId": accountID,
		"serviceAccount": map[string]string{
			"displayName": "alethia ns tenant " + namespace,
			"description": "Alethia per-namespace tenant identity (fabric namespace placement, #957). Zero-perm least-priv.",
		},
	})
	createURL := fmt.Sprintf("%s/v1/projects/%s/serviceAccounts", gkeIAMAPIBase, url.PathEscape(projectID))
	status, _, err := iamJSON(ctx, client, http.MethodPost, createURL, token, body)
	if err != nil {
		return err
	}
	// 200 created, or 409 already-exists → both are success (idempotent get-or-create).
	if status == http.StatusOK || status == http.StatusConflict {
		return nil
	}
	return fmt.Errorf("%w: create service account %q: status %d", ErrGKEIdentity, accountID, status)
}

// ensureWorkloadIdentityBinding adds roles/iam.workloadIdentityUser for the namespace's KSA principal to
// the GSA's IAM policy, additively (get→merge→set) so it neither clobbers other bindings nor duplicates
// the member. The role is bound ON the GSA (impersonation), granting NO project permissions.
func ensureWorkloadIdentityBinding(ctx context.Context, client *http.Client, token, projectID, email, namespace string) error {
	saResource := fmt.Sprintf("%s/v1/projects/%s/serviceAccounts/%s", gkeIAMAPIBase, url.PathEscape(projectID), url.PathEscape(email))
	member := gkeWorkloadIdentityMember(projectID, namespace)

	// getIamPolicy
	status, getBody, err := iamJSON(ctx, client, http.MethodPost, saResource+":getIamPolicy", token, nil)
	if err != nil {
		return err
	}
	if status != http.StatusOK {
		return fmt.Errorf("%w: getIamPolicy %q: status %d", ErrGKEIdentity, email, status)
	}
	var pol iamPolicy
	if len(getBody) > 0 {
		if err := json.Unmarshal(getBody, &pol); err != nil {
			return fmt.Errorf("%w: decode iam policy: %v", ErrGKEIdentity, err)
		}
	}
	if iamPolicyHasMember(pol, gkeWorkloadIdentityUserRole, member) {
		return nil // already bound — nothing to do (idempotent)
	}
	pol.Bindings = addIAMMember(pol.Bindings, gkeWorkloadIdentityUserRole, member)

	// setIamPolicy
	setBody, _ := json.Marshal(map[string]any{"policy": pol})
	status, _, err = iamJSON(ctx, client, http.MethodPost, saResource+":setIamPolicy", token, setBody)
	if err != nil {
		return err
	}
	if status != http.StatusOK {
		return fmt.Errorf("%w: setIamPolicy %q: status %d", ErrGKEIdentity, email, status)
	}
	return nil
}

// iamPolicyHasMember reports whether role→member is already granted UNCONDITIONALLY.
//
// A member present only in a conditional binding is deliberately NOT a match: the grant this
// function gates is unconditional, and treating a time-bounded or resource-scoped grant as
// equivalent would make the deploy skip the write and leave workload identity broken the moment the
// condition stopped holding.
func iamPolicyHasMember(pol iamPolicy, role, member string) bool {
	for _, b := range pol.Bindings {
		if b.Role != role || len(b.Condition) > 0 {
			continue
		}
		for _, m := range b.Members {
			if m == member {
				return true
			}
		}
	}
	return false
}

// addIAMMember adds member to the UNCONDITIONAL binding for role, creating it if absent, and leaves
// every other binding — including conditional ones on the same role — untouched.
//
// The condition is part of a binding's identity: GCP allows several bindings with the same role and
// different conditions, and they are different grants. Matching on role alone (as this did) would
// append the member to whichever came first, so an existing time-bounded or resource-scoped grant
// could swallow the workload-identity binding and silently constrain it — the mirror image of #2027's
// other half, where a condition was dropped and a grant silently widened.
func addIAMMember(bindings []iamBinding, role, member string) []iamBinding {
	for i := range bindings {
		if bindings[i].Role == role && len(bindings[i].Condition) == 0 {
			bindings[i].Members = append(bindings[i].Members, member)
			return bindings
		}
	}
	return append(bindings, iamBinding{Role: role, Members: []string{member}})
}

// DeprovisionGKENamespaceIdentity best-effort deletes the per-namespace GSA (env/namespace teardown). A
// missing GSA is not an error. Deleting the GSA removes its IAM policy (the WI binding) with it.
func DeprovisionGKENamespaceIdentity(ctx context.Context, client *http.Client, accessToken, projectID, clusterName, namespace string) error {
	if client == nil {
		client = &http.Client{Timeout: 20 * time.Second}
	}
	email := gkeNamespaceGSAEmail(projectID, namespaceGSAAccountID(clusterName, namespace))
	delURL := fmt.Sprintf("%s/v1/projects/%s/serviceAccounts/%s", gkeIAMAPIBase, url.PathEscape(projectID), url.PathEscape(email))
	status, _, err := iamJSON(ctx, client, http.MethodDelete, delURL, accessToken, nil)
	if err != nil {
		return err
	}
	if status == http.StatusOK || status == http.StatusNotFound {
		return nil
	}
	return fmt.Errorf("%w: delete service account %q: status %d", ErrGKEIdentity, email, status)
}

// iamJSON performs a bearer-authenticated IAM REST call and returns (status, body, transportErr). The
// token is only ever placed in the Authorization header (never logged); a transport error is returned,
// while an HTTP error status is returned to the caller to classify (409/404 are success in places). The
// response body is bounded.
func iamJSON(ctx context.Context, client *http.Client, method, rawURL, token string, reqBody []byte) (int, []byte, error) {
	var r io.Reader
	if reqBody != nil {
		r = bytes.NewReader(reqBody)
	}
	req, err := http.NewRequestWithContext(ctx, method, rawURL, r)
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/json")
	if reqBody != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := client.Do(req)
	if err != nil {
		return 0, nil, fmt.Errorf("%w: %s %s: %v", ErrGKEIdentity, method, iamSafeURL(rawURL), err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	return resp.StatusCode, body, nil
}

// iamSafeURL strips a trailing `:action` suffix's query (there is none here) — the URL carries no
// credentials, but keep error messages tidy.
func iamSafeURL(u string) string {
	if i := strings.IndexByte(u, '?'); i >= 0 {
		return u[:i]
	}
	return u
}
