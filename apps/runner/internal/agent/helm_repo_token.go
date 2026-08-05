// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"time"

	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/ecrpublic"
)

// helm-repo-token is the KEYLESS cross-account OCI Helm chart-repo credential refresher (#1185) — the
// helm_registry analogue of registry-token. Amazon ECR / ECR Public issue a ~12h token, not a stable
// password, so a static ArgoCD repository-credential Secret would silently expire mid-day. This runs as
// a STANDALONE in-cluster Deployment (the repo-cred Secret must exist before ArgoCD pulls a chart), mints
// a short-lived ECR token from the cluster's Workload Identity — assuming the customer's cross-account
// target role (private ECR) or reading ECR Public under the cluster's OWN IRSA — and PATCHES the
// pre-seeded repo-helm-<hash> Secret's username/password. It loops and re-mints before expiry so the
// credential is always fresh.
//
// The token NEVER touches argv (kubectl `--patch-file` from a 0600 temp file) and is NEVER logged. Unlike
// registry-token (a .dockerconfigjson imagePullSecret in the app namespace), this patches an Opaque
// ArgoCD repo-cred Secret (type=helm, username=AWS, password=<token>) in the argocd namespace; the
// immutable fields (type/url/enableOCI) are pre-seeded and never patched.

// helmRepoTokenMinter mints an ECR (username, password) + expiry. Swappable in tests (the real minters
// need in-cluster Workload Identity + cross-account trust that only exists live).
type helmRepoTokenMinter func(ctx context.Context) (user, pass string, exp time.Time, err error)

// RunHelmRepoToken parses the helm-repo-token flags and runs the refresh loop until the context is
// cancelled. Invoked as a one-shot subcommand from main (the refresher Deployment's entrypoint).
func RunHelmRepoToken(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("helm-repo-token", flag.ContinueOnError)
	secret := fs.String("secret", "", "name of the ArgoCD repo-cred Secret to patch")
	namespace := fs.String("namespace", "argocd", "namespace of the Secret")
	region := fs.String("region", "", "cloud region (private ECR)")
	targetRoleArn := fs.String("target-role-arn", "", "cross-account role to assume (private ECR)")
	public := fs.Bool("public", false, "ECR Public (public.ecr.aws) — mint under the cluster's own identity, no target role")
	once := fs.Bool("once", false, "mint + patch once and exit (no refresh loop)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *secret == "" {
		return fmt.Errorf("helm-repo-token: --secret is required")
	}

	var mint helmRepoTokenMinter
	switch {
	case *public:
		mint = func(ctx context.Context) (string, string, time.Time, error) {
			return mintECRPublicAuth(ctx)
		}
	default:
		if *region == "" {
			return fmt.Errorf("helm-repo-token: --region is required for private ECR")
		}
		if *targetRoleArn == "" {
			return fmt.Errorf("helm-repo-token: --target-role-arn is required for private ECR")
		}
		mint = func(ctx context.Context) (string, string, time.Time, error) {
			return mintECRAuth(ctx, *region, *targetRoleArn)
		}
	}
	return runHelmRepoTokenLoop(ctx, mint, patchHelmRepoSecret, *namespace, *secret, *once)
}

// helmRepoSecretPatcher writes username/password into the named repo-cred Secret. patchHelmRepoSecret is
// the real (kubectl) implementation; tests inject a fake so the loop is exercised without a cluster.
type helmRepoSecretPatcher func(ctx context.Context, namespace, name, username, password string) error

// runHelmRepoTokenLoop mirrors runRegistryTokenLoop: mint (user,pass), patch, sleep until just before
// expiry, repeat. The FIRST mint failing is fatal (fail fast — the refresher is misconfigured or the
// target account doesn't trust this cluster); a later refresh failure keeps the last good Secret and
// retries on the floor interval (a transient blip must not break chart pulls for a running app).
func runHelmRepoTokenLoop(ctx context.Context, mint helmRepoTokenMinter, patch helmRepoSecretPatcher, namespace, secret string, once bool) error {
	user, pass, exp, err := mint(ctx)
	if err != nil {
		return fmt.Errorf("helm-repo-token: initial mint: %w", err)
	}
	if err := patch(ctx, namespace, secret, user, pass); err != nil {
		return fmt.Errorf("helm-repo-token: patch %s/%s: %w", namespace, secret, err)
	}
	if once {
		return nil
	}
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-refreshTimer(refreshAfter(exp, time.Now())):
		}
		user, pass, exp, err = mint(ctx)
		if err != nil {
			fmt.Fprintf(os.Stderr, "helm-repo-token: refresh failed (keeping last secret): %v\n", err)
			exp = time.Now().Add(tokenRefreshFloor + tokenRefreshLead)
			continue
		}
		if err := patch(ctx, namespace, secret, user, pass); err != nil {
			return fmt.Errorf("helm-repo-token: patch %s/%s: %w", namespace, secret, err)
		}
	}
}

// helmRepoPatchJSON builds the strategic-merge patch that updates an ArgoCD repo-cred Secret's rotating
// username/password. Both are base64'd into the Secret data exactly like any Secret value; they never
// appear in plaintext here. The pre-seeded placeholder already carries the immutable fields
// (type=helm, url, enableOCI) — only the credentials are patched.
func helmRepoPatchJSON(username, password string) string {
	data := map[string]any{
		"username": base64.StdEncoding.EncodeToString([]byte(username)),
		"password": base64.StdEncoding.EncodeToString([]byte(password)),
	}
	// The map is closed/known; marshal cannot fail.
	b, _ := json.Marshal(map[string]any{"data": data})
	return string(b)
}

// patchHelmRepoSecret patches the pre-seeded repo-cred Secret via `kubectl patch --patch-file` — the
// token stays in a 0600 temp file, NEVER on argv (world-readable via /proc) and NEVER in the logs.
// kubectl uses the pod's in-cluster service-account (the refresher KSA), whose Role grants get+patch on
// ONLY this Secret. Requires the Secret to already exist (the wiring seeds a placeholder) — patch, not
// apply, so no create permission is needed.
func patchHelmRepoSecret(ctx context.Context, namespace, name, username, password string) error {
	tmp, err := os.CreateTemp("", "helmrepopatch-*.json")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.WriteString(helmRepoPatchJSON(username, password)); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	cmd := exec.CommandContext(ctx, "kubectl", "patch", "secret", name,
		"-n", namespace, "--type", "merge", "--patch-file", tmp.Name())
	// Discard stdout ("secret/... patched"); surface stderr on failure only.
	cmd.Stdout = io.Discard
	var stderr strings.Builder
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("kubectl patch failed: %w: %s", err, strings.TrimSpace(stderr.String()))
	}
	return nil
}

// mintECRPublicAuth fetches an ECR Public authorization token under the pod's OWN Workload Identity (the
// cluster IRSA granted ecr-public:GetAuthorizationToken) and returns the decoded docker username/password
// + expiry. ECR Public is a global service reached via the us-east-1 endpoint; no cross-account role is
// assumed. The token IS base64("AWS:<password>"), exactly like private ECR.
func mintECRPublicAuth(ctx context.Context) (user, pass string, exp time.Time, err error) {
	cfg, err := awsconfig.LoadDefaultConfig(ctx, awsconfig.WithRegion("us-east-1"))
	if err != nil {
		return "", "", time.Time{}, fmt.Errorf("load AWS config: %w", err)
	}
	out, err := ecrpublic.NewFromConfig(cfg).GetAuthorizationToken(ctx, &ecrpublic.GetAuthorizationTokenInput{})
	if err != nil {
		return "", "", time.Time{}, fmt.Errorf("ecr-public GetAuthorizationToken: %w", err)
	}
	if out.AuthorizationData == nil || out.AuthorizationData.AuthorizationToken == nil {
		return "", "", time.Time{}, fmt.Errorf("ecr-public returned no authorization data")
	}
	user, pass, err = decodeECRAuth(*out.AuthorizationData.AuthorizationToken)
	if err != nil {
		return "", "", time.Time{}, err
	}
	exp = time.Now().Add(ecrTokenTTLFallback)
	if out.AuthorizationData.ExpiresAt != nil {
		exp = *out.AuthorizationData.ExpiresAt
	}
	return user, pass, exp, nil
}
