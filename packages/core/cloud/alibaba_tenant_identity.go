// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloud

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"
)

// Per-namespace tenant cloud identity for Alibaba (#1129, the ACK analog of the AWS IRSA lane in
// cloud/aws/tenant_identity.go). A `namespace`-placement tenant on a shared ACK Fabric gets its OWN
// zero-permission RAM role, assumable ONLY by a ServiceAccount in its namespace via ACK RRSA
// (RAM Roles for Service Accounts) — never the cluster-wide node/controller role. The namespace-deploy
// path runs NO tofu, so this provisions the role live at deploy time via the keyless RRSA-signing RAM API
// client (alibaba_sign.go), against the cluster's EXISTING RRSA OIDC provider.
//
// Keyless + least-priv: the role carries NO permission policy (a pure identity boundary — grants are
// explicit later). Idempotent get-or-create; the trust is scoped to system:serviceaccount:<ns>:* and the
// mandatory sts.aliyuncs.com audience. The RRSA OIDC provider ACK auto-creates per cluster is
// `ack-rrsa-<clusterId>`, so the provider ARN is derivable output-free from the account id + cluster id.
//
// This file adds no cloud SDK to packages/core — the RAM calls go through the same hand-rolled ACS3
// signing http.Client the ACK resolve lane uses.

const (
	// ramAPIHost is the (central, non-regional) RAM OpenAPI host.
	ramAPIHost = "https://ram.aliyuncs.com"
	// ramAPIVersion is the RAM OpenAPI version for CreateRole/GetRole.
	ramAPIVersion = "2015-05-01"
	// ackRRSAProviderPrefix is the OIDC-provider name ACK creates when RRSA is enabled on a cluster.
	ackRRSAProviderPrefix = "ack-rrsa-"
	// ackRRSAAudience is the mandatory OIDC audience for an RRSA assume-role trust.
	ackRRSAAudience = "sts.aliyuncs.com"
)

// ackRAMRoleResponse is the slice of a CreateRole / GetRole response this lane reads.
type ackRAMRoleResponse struct {
	Role struct {
		Arn      string `json:"Arn"`
		RoleName string `json:"RoleName"`
	} `json:"Role"`
	Code string `json:"Code"`
}

// ProvisionACKNamespaceIdentity ensures a zero-perm per-namespace RRSA RAM role for (clusterName, ns) on
// the ambient keyless session and returns its ROLE NAME (the RRSA SA annotation references the name, not
// the ARN). It resolves the cluster id (DescribeClustersV1), derives the RRSA OIDC provider ARN, builds
// the <ns>:*-scoped zero-perm trust, and get-or-creates the role. `namespace` MUST already be validated
// (DNS-1123) by the caller.
func ProvisionACKNamespaceIdentity(ctx context.Context, region, clusterName, namespace string) (string, error) {
	client, err := newAlibabaSigningClient(ctx, region)
	if err != nil {
		return "", fmt.Errorf("ack namespace identity: build keyless signing client: %w", err)
	}
	clusterID, err := ResolveACKClusterID(ctx, client, region, clusterName)
	if err != nil {
		return "", fmt.Errorf("ack namespace identity: resolve cluster id for %q: %w", clusterName, err)
	}
	accountID, err := alibabaAccountIDFromEnv()
	if err != nil {
		return "", err
	}
	providerARN := fmt.Sprintf("acs:ram::%s:oidc-provider/%s%s", accountID, ackRRSAProviderPrefix, clusterID)
	trust, err := buildACKNamespaceTrustPolicy(providerARN, namespace)
	if err != nil {
		return "", err
	}
	roleName := ackNamespaceRoleName(clusterName, namespace)
	if err := ensureACKNamespaceRole(ctx, client, roleName, trust); err != nil {
		return "", err
	}
	return roleName, nil
}

// alibabaAccountIDFromEnv extracts the RAM account id from the ambient ALIBABA_CLOUD_ROLE_ARN
// (acs:ram::<accountId>:role/<name>) the runner set — the same account the RRSA provider + role live in.
func alibabaAccountIDFromEnv() (string, error) {
	roleArn := os.Getenv("ALIBABA_CLOUD_ROLE_ARN")
	// acs:ram::<accountId>:role/<name> → split on ":" → index 3 is the account id.
	parts := strings.Split(roleArn, ":")
	if len(parts) < 5 || parts[0] != "acs" || parts[3] == "" {
		return "", fmt.Errorf("ack namespace identity: cannot extract account id from ALIBABA_CLOUD_ROLE_ARN %q", roleArn)
	}
	return parts[3], nil
}

// ackTrustDoc shapes (marshalled, never string-concatenated, so a namespace value can't break the JSON —
// the namespace is already DNS-1123-validated upstream; this is defense-in-depth).
type ackTrustDoc struct {
	Version   string              `json:"Version"`
	Statement []ackTrustStatement `json:"Statement"`
}
type ackTrustStatement struct {
	Effect    string                       `json:"Effect"`
	Action    string                       `json:"Action"`
	Principal ackTrustPrincipal            `json:"Principal"`
	Condition map[string]map[string]string `json:"Condition"`
}
type ackTrustPrincipal struct {
	Federated []string `json:"Federated"`
}

// buildACKNamespaceTrustPolicy renders the RRSA assume-role trust: a federation to the cluster's RRSA OIDC
// provider, scoped to any ServiceAccount in the tenant namespace (StringLike oidc:sub
// system:serviceaccount:<ns>:*) with the mandatory sts.aliyuncs.com audience (StringEquals oidc:aud).
// Mirrors the AWS IRSA trust idiom in aws/tenant_identity.go.
func buildACKNamespaceTrustPolicy(providerARN, namespace string) (string, error) {
	if providerARN == "" || namespace == "" {
		return "", fmt.Errorf("ack trust policy needs a provider ARN and namespace")
	}
	doc := ackTrustDoc{
		Version: "1",
		Statement: []ackTrustStatement{{
			Effect:    "Allow",
			Action:    "sts:AssumeRole",
			Principal: ackTrustPrincipal{Federated: []string{providerARN}},
			Condition: map[string]map[string]string{
				"StringLike": {
					"oidc:sub": "system:serviceaccount:" + namespace + ":*",
				},
				"StringEquals": {
					"oidc:aud": ackRRSAAudience,
				},
			},
		}},
	}
	b, err := json.Marshal(doc)
	if err != nil {
		return "", fmt.Errorf("marshal ack trust policy: %w", err)
	}
	return string(b), nil
}

// ackNamespaceRoleName derives a deterministic, RAM-valid (≤64 char) role name for a (cluster, namespace)
// pair. Deterministic so re-deploys reconcile the SAME role (idempotent); a short content hash keeps it
// unique + bounded. Mirrors aws.namespaceRoleName.
func ackNamespaceRoleName(clusterName, namespace string) string {
	sum := sha256.Sum256([]byte(clusterName + "/" + namespace))
	short := hex.EncodeToString(sum[:])[:8]
	ns := namespace
	if len(ns) > 20 {
		ns = ns[:20]
	}
	return "alethia-ns-" + ns + "-" + short // ≤ 11 + 20 + 1 + 8 = 40
}

// ensureACKNamespaceRole get-or-creates the per-namespace RAM role with the given trust policy. Idempotent:
// an already-exists CreateRole is treated as success (the trust is deterministic for a given cluster/ns, so
// a re-create would be identical). NO permission policy is attached — zero-perm.
func ensureACKNamespaceRole(ctx context.Context, client *http.Client, roleName, trustPolicy string) error {
	createParams := url.Values{}
	createParams.Set("RoleName", roleName)
	createParams.Set("AssumeRolePolicyDocument", trustPolicy)
	createParams.Set("Description", "Alethia per-namespace tenant identity (ACK RRSA, #1129). Zero-perm least-priv.")

	resp, err := ramRPC(ctx, client, "CreateRole", createParams)
	if err == nil {
		return nil
	}
	// Already exists → treat as success (deterministic trust). Any other error is fatal.
	if !isRAMAlreadyExists(err) {
		return fmt.Errorf("create per-namespace RAM role %q: %w", roleName, err)
	}
	_ = resp
	return nil
}

// DeprovisionACKNamespaceIdentity best-effort deletes the per-namespace RRSA RAM role (env/namespace
// teardown). A missing role is NOT an error — the teardown is idempotent and a role someone already
// removed is the state we wanted. The role name is derived the same deterministic way the provision
// side derives it (ackNamespaceRoleName), so this needs no stored handle: teardown can reconstruct
// what deploy created from (clusterName, namespace) alone. Zero-perm roles carry no attached policy,
// so DeleteRole needs no detach pass. Mirrors DeprovisionGKENamespaceIdentity / aws.DeprovisionNamespaceIdentity.
func DeprovisionACKNamespaceIdentity(ctx context.Context, region, clusterName, namespace string) error {
	client, err := newAlibabaSigningClient(ctx, region)
	if err != nil {
		return fmt.Errorf("ack namespace identity teardown: build keyless signing client: %w", err)
	}
	return deleteACKNamespaceRole(ctx, client, ackNamespaceRoleName(clusterName, namespace))
}

// deleteACKNamespaceRole deletes the per-namespace RAM role. Idempotent: an already-absent role is
// success, so a destroy re-run after a partial teardown converges rather than wedging on the half
// that already succeeded. Split from the exported entrypoint for the same reason
// ensureACKNamespaceRole is on the provision side — it takes the http.Client, so the RAM answers
// that matter (deleted / already gone / denied) are testable without a keyless session.
func deleteACKNamespaceRole(ctx context.Context, client *http.Client, roleName string) error {
	params := url.Values{}
	params.Set("RoleName", roleName)
	if _, err := ramRPC(ctx, client, "DeleteRole", params); err != nil {
		if isRAMNoSuchEntity(err) {
			return nil
		}
		return fmt.Errorf("delete per-namespace RAM role %q: %w", roleName, err)
	}
	return nil
}

// isRAMNoSuchEntity reports whether err is a RAM EntityNotExist.Role — the delete counterpart of
// isRAMAlreadyExists, and the reason a teardown can run twice without failing the second time.
func isRAMNoSuchEntity(err error) bool {
	var re *ramError
	if !asRAMError(err, &re) {
		return false
	}
	return strings.Contains(re.code, "EntityNotExist") || strings.Contains(re.code, "NoSuchEntity")
}

// ramRPC performs a V3-signed RAM RPC call (POST, params in the form body) and returns the decoded role
// response. A non-2xx is wrapped as an error carrying the RAM Code (so the caller can detect
// EntityAlreadyExists.Role). The signing http.Client sets host/date/nonce/authorization; this sets the
// action/version headers it folds into the signature.
func ramRPC(ctx context.Context, client *http.Client, action string, params url.Values) (*ackRAMRoleResponse, error) {
	if client == nil {
		client = &http.Client{Timeout: 20 * time.Second}
	}
	body := params.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, ramAPIHost+"/", strings.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("content-type", "application/x-www-form-urlencoded")
	req.Header.Set("x-acs-action", action)
	req.Header.Set("x-acs-version", ramAPIVersion)

	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("ram %s: %w", action, err)
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))

	var parsed ackRAMRoleResponse
	_ = json.Unmarshal(respBody, &parsed)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return &parsed, &ramError{action: action, status: resp.StatusCode, code: parsed.Code, snippet: ackErrSnippet(respBody)}
	}
	return &parsed, nil
}

// ramError carries the RAM error Code so idempotent handling can detect EntityAlreadyExists.Role.
type ramError struct {
	action  string
	status  int
	code    string
	snippet string
}

func (e *ramError) Error() string {
	return fmt.Sprintf("ram %s: status %d (code %q): %s", e.action, e.status, e.code, e.snippet)
}

// isRAMAlreadyExists reports whether err is a RAM EntityAlreadyExists.Role (idempotent create).
func isRAMAlreadyExists(err error) bool {
	var re *ramError
	if !asRAMError(err, &re) {
		return false
	}
	return strings.Contains(re.code, "EntityAlreadyExists")
}

// asRAMError is a tiny errors.As for *ramError (kept local to avoid importing errors just for one use).
func asRAMError(err error, target **ramError) bool {
	if re, ok := err.(*ramError); ok {
		*target = re
		return true
	}
	return false
}

// ackRoleNameRe matches the RAM role-name grammar Alethia emits (shell-safe for the SA annotation).
var ackRoleNameRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)

// IsValidACKRoleName reports whether s is a well-formed, shell-safe RAM role name (for the SA annotation).
func IsValidACKRoleName(s string) bool { return ackRoleNameRe.MatchString(s) }
