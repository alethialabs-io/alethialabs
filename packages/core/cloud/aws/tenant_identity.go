// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package aws

// Per-namespace tenant cloud identity (#957) for `namespace`-placement fabric envs. A shared-cluster
// namespace tenant must get its OWN least-priv AWS identity, never a path to the cluster-wide controller
// or node role. Cluster IRSA is provisioned by tofu at Fabric creation (infra/templates/project/aws/irsa.tf),
// but the namespace-deploy path runs NO tofu — so this replicates that OIDC-trust pattern via the IAM SDK
// at deploy time, against the Fabric's EXISTING EKS OIDC provider.
//
// The role's trust is scoped to `system:serviceaccount:<ns>:*` (any SA in the tenant's namespace, none
// elsewhere) and it carries NO permissions policy — a pure, least-priv identity boundary (grants are
// explicit later). Idempotent get-or-create; tagged so it's identifiable + cleanable. AWS-only; other
// clouds' per-namespace identity (GCP Workload-Identity, Azure federated) is a documented follow-up (#1013).

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"

	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/eks"
	"github.com/aws/aws-sdk-go-v2/service/iam"
	iamtypes "github.com/aws/aws-sdk-go-v2/service/iam/types"
)

// IAMRoleAPI is the slice of the IAM client the per-namespace identity lifecycle uses — an interface so
// EnsureNamespaceIRSARole / DeleteNamespaceIRSARole are unit-testable against a fake. *iam.Client satisfies it.
type IAMRoleAPI interface {
	CreateRole(context.Context, *iam.CreateRoleInput, ...func(*iam.Options)) (*iam.CreateRoleOutput, error)
	GetRole(context.Context, *iam.GetRoleInput, ...func(*iam.Options)) (*iam.GetRoleOutput, error)
	UpdateAssumeRolePolicy(context.Context, *iam.UpdateAssumeRolePolicyInput, ...func(*iam.Options)) (*iam.UpdateAssumeRolePolicyOutput, error)
	DeleteRole(context.Context, *iam.DeleteRoleInput, ...func(*iam.Options)) (*iam.DeleteRoleOutput, error)
}

// accountIDFromClusterARN extracts the 12-digit account id from an EKS cluster ARN
// (`arn:aws:eks:<region>:<account>:cluster/<name>`).
func accountIDFromClusterARN(arn string) (string, error) {
	parts := strings.Split(arn, ":")
	if len(parts) < 6 || parts[0] != "arn" || parts[4] == "" {
		return "", fmt.Errorf("cannot extract account id from cluster ARN %q", arn)
	}
	return parts[4], nil
}

// oidcConditionKey strips the scheme from an EKS OIDC issuer URL, yielding the host+path used both as the
// IAM OIDC-provider name and as the trust-condition key prefix (`oidc.eks.<region>.amazonaws.com/id/<id>`).
func oidcConditionKey(issuer string) (string, error) {
	if !strings.HasPrefix(issuer, "https://") {
		return "", fmt.Errorf("OIDC issuer %q is not an https URL", issuer)
	}
	key := strings.TrimPrefix(issuer, "https://")
	if key == "" {
		return "", fmt.Errorf("OIDC issuer %q has no host", issuer)
	}
	return key, nil
}

// oidcProviderARN builds the IAM OIDC identity-provider ARN for a cluster's issuer.
func oidcProviderARN(accountID, conditionKey string) string {
	return fmt.Sprintf("arn:aws:iam::%s:oidc-provider/%s", accountID, conditionKey)
}

// trust-policy document shapes (marshalled, never string-concatenated, so a namespace value can't break
// the JSON — the namespace is already DNS-1123-validated upstream, this is defense-in-depth).
type trustDoc struct {
	Version   string           `json:"Version"`
	Statement []trustStatement `json:"Statement"`
}
type trustStatement struct {
	Effect    string                       `json:"Effect"`
	Principal trustPrincipal               `json:"Principal"`
	Action    string                       `json:"Action"`
	Condition map[string]map[string]string `json:"Condition"`
}
type trustPrincipal struct {
	Federated string `json:"Federated"`
}

// buildNamespaceTrustPolicy renders the assume-role trust policy: a web-identity federation to the
// cluster's OIDC provider, scoped to any ServiceAccount in the tenant namespace (`<ns>:*`) with the
// mandatory `sts.amazonaws.com` audience — the EKS IRSA idiom, generalized from the per-KSA cluster role.
func buildNamespaceTrustPolicy(providerARN, conditionKey, namespace string) (string, error) {
	if providerARN == "" || conditionKey == "" || namespace == "" {
		return "", fmt.Errorf("trust policy needs providerARN, conditionKey and namespace")
	}
	doc := trustDoc{
		Version: "2012-10-17",
		Statement: []trustStatement{{
			Effect:    "Allow",
			Principal: trustPrincipal{Federated: providerARN},
			Action:    "sts:AssumeRoleWithWebIdentity",
			Condition: map[string]map[string]string{
				"StringLike": {
					conditionKey + ":sub": "system:serviceaccount:" + namespace + ":*",
				},
				"StringEquals": {
					conditionKey + ":aud": "sts.amazonaws.com",
				},
			},
		}},
	}
	b, err := json.Marshal(doc)
	if err != nil {
		return "", fmt.Errorf("marshal trust policy: %w", err)
	}
	return string(b), nil
}

// namespaceRoleName derives a deterministic, IAM-valid (≤64 char, `[\w+=,.@-]`) role name for a
// (cluster, namespace) pair. Deterministic so re-deploys reconcile the SAME role (idempotent); a short
// content hash keeps it unique + bounded when the namespace/cluster names are long.
func namespaceRoleName(clusterName, namespace string) string {
	sum := sha256.Sum256([]byte(clusterName + "/" + namespace))
	short := hex.EncodeToString(sum[:])[:8]
	ns := namespace
	if len(ns) > 20 {
		ns = ns[:20]
	}
	return "alethia-ns-" + ns + "-" + short // ≤ 11 + 20 + 1 + 8 = 40
}

// namespaceRoleTags identifies the managed role so it is discoverable + cleanable out of band.
func namespaceRoleTags(clusterName, namespace string) []iamtypes.Tag {
	return []iamtypes.Tag{
		{Key: strptr("alethia:managed-by"), Value: strptr("fabric-namespace")},
		{Key: strptr("alethia:cluster"), Value: strptr(clusterName)},
		{Key: strptr("alethia:namespace"), Value: strptr(namespace)},
	}
}

func strptr(s string) *string { return &s }

// EnsureNamespaceIRSARole get-or-creates the per-namespace role with the given trust policy and returns
// its ARN. Idempotent: a re-deploy re-creates nothing but reconciles the trust policy on the existing
// role (so a namespace-name/OIDC change is picked up). NO permissions policy is attached — zero-perm.
func EnsureNamespaceIRSARole(ctx context.Context, api IAMRoleAPI, roleName, trustPolicy string, tags []iamtypes.Tag) (string, error) {
	out, err := api.CreateRole(ctx, &iam.CreateRoleInput{
		RoleName:                 &roleName,
		AssumeRolePolicyDocument: &trustPolicy,
		Description:              strptr("Alethia per-namespace tenant identity (fabric namespace placement, #957). Zero-perm least-priv."),
		Tags:                     tags,
	})
	if err == nil {
		if out.Role == nil || out.Role.Arn == nil {
			return "", fmt.Errorf("CreateRole %q returned no ARN", roleName)
		}
		return *out.Role.Arn, nil
	}

	// Already exists → reconcile its trust policy and return the existing ARN.
	var exists *iamtypes.EntityAlreadyExistsException
	if !errors.As(err, &exists) {
		return "", fmt.Errorf("create per-namespace role %q: %w", roleName, err)
	}
	if _, uerr := api.UpdateAssumeRolePolicy(ctx, &iam.UpdateAssumeRolePolicyInput{
		RoleName:       &roleName,
		PolicyDocument: &trustPolicy,
	}); uerr != nil {
		return "", fmt.Errorf("reconcile trust policy on existing role %q: %w", roleName, uerr)
	}
	got, gerr := api.GetRole(ctx, &iam.GetRoleInput{RoleName: &roleName})
	if gerr != nil {
		return "", fmt.Errorf("get existing role %q: %w", roleName, gerr)
	}
	if got.Role == nil || got.Role.Arn == nil {
		return "", fmt.Errorf("GetRole %q returned no ARN", roleName)
	}
	return *got.Role.Arn, nil
}

// DeleteNamespaceIRSARole best-effort deletes the per-namespace role (the role carries no attached
// policies — it is zero-perm — so a plain DeleteRole suffices). A missing role is not an error.
func DeleteNamespaceIRSARole(ctx context.Context, api IAMRoleAPI, roleName string) error {
	_, err := api.DeleteRole(ctx, &iam.DeleteRoleInput{RoleName: &roleName})
	if err == nil {
		return nil
	}
	var notFound *iamtypes.NoSuchEntityException
	if errors.As(err, &notFound) {
		return nil
	}
	return fmt.Errorf("delete per-namespace role %q: %w", roleName, err)
}

// ProvisionNamespaceIdentity ensures a per-namespace IRSA role for (clusterName, namespace) on the ambient
// keyless session and returns its ARN. It resolves the cluster's OIDC provider (EKS DescribeCluster), builds
// the `<ns>:*`-scoped zero-perm trust, and get-or-creates the role. AWS-only (the deploy dispatcher fail-
// closes other clouds). `namespace` MUST already be validated (DNS-1123) by the caller.
func ProvisionNamespaceIdentity(ctx context.Context, region, clusterName, namespace string) (string, error) {
	cfg, err := awsconfig.LoadDefaultConfig(ctx, awsconfig.WithRegion(region))
	if err != nil {
		return "", fmt.Errorf("load aws config: %w", err)
	}
	conn, err := ResolveEKSClusterConn(ctx, eks.NewFromConfig(cfg), clusterName)
	if err != nil {
		return "", err
	}
	roleName, trust, err := namespaceRoleAndTrust(conn, clusterName, namespace)
	if err != nil {
		return "", err
	}
	return EnsureNamespaceIRSARole(ctx, iam.NewFromConfig(cfg), roleName, trust, namespaceRoleTags(clusterName, namespace))
}

// DeprovisionNamespaceIdentity best-effort removes the per-namespace role (env/namespace teardown).
func DeprovisionNamespaceIdentity(ctx context.Context, region, clusterName, namespace string) error {
	cfg, err := awsconfig.LoadDefaultConfig(ctx, awsconfig.WithRegion(region))
	if err != nil {
		return fmt.Errorf("load aws config: %w", err)
	}
	return DeleteNamespaceIRSARole(ctx, iam.NewFromConfig(cfg), namespaceRoleName(clusterName, namespace))
}

// namespaceRoleAndTrust derives the role name + trust policy for a cluster/namespace from a resolved
// cluster connection (pure once conn is known — the unit-testable core of ProvisionNamespaceIdentity).
func namespaceRoleAndTrust(conn EKSClusterConn, clusterName, namespace string) (roleName, trustPolicy string, err error) {
	if conn.OIDCIssuer == "" {
		return "", "", fmt.Errorf("cluster %q reports no OIDC issuer — IRSA is not enabled on this Fabric, cannot provision a per-namespace identity", clusterName)
	}
	accountID, err := accountIDFromClusterARN(conn.ARN)
	if err != nil {
		return "", "", err
	}
	key, err := oidcConditionKey(conn.OIDCIssuer)
	if err != nil {
		return "", "", err
	}
	trust, err := buildNamespaceTrustPolicy(oidcProviderARN(accountID, key), key, namespace)
	if err != nil {
		return "", "", err
	}
	return namespaceRoleName(clusterName, namespace), trust, nil
}

// roleARNRe matches an IAM role ARN. The role ARN returned by IAM is trusted, but it flows into a shell
// command (`kubectl annotate ... eks.amazonaws.com/role-arn=<arn>` via `bash -c`), so the deploy path
// validates it defensively — an unexpected value can never inject a command.
var roleARNRe = regexp.MustCompile(`^arn:aws[a-z-]*:iam::[0-9]{12}:role/[A-Za-z0-9+=,.@_/-]+$`)

// IsValidRoleARN reports whether s is a well-formed IAM role ARN (shell-safe for the SA annotation).
func IsValidRoleARN(s string) bool { return roleARNRe.MatchString(s) }
