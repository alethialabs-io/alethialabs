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
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/azcore/policy"
	"github.com/Azure/azure-sdk-for-go/sdk/azidentity"
	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials/stscreds"
	"github.com/aws/aws-sdk-go-v2/service/ecr"
	"github.com/aws/aws-sdk-go-v2/service/sts"
	"golang.org/x/oauth2/google"
)

// registry-token is the KEYLESS cross-account container-registry pull-secret refresher (PR B). Unlike
// db-token (a sidecar handing a token file to a co-located proxy), this runs as a STANDALONE in-cluster
// Deployment — an imagePullSecret must exist BEFORE an app pod schedules, so it cannot live in the app
// pod. It mints a short-lived registry pull token from the pod's own Workload Identity — assuming the
// customer's target-account role (ECR), using a target-granted service account (GAR), or exchanging an
// AAD token for an ACR refresh token — builds the dockerconfigjson, and PATCHES the pre-seeded
// <slug>-pull Secret. It loops and re-mints before expiry so the pull secret is always fresh.
//
// The token NEVER touches argv (kubectl `--patch-file` from a 0600 temp file) and is NEVER logged.

const (
	// ecrTokenTTLFallback is used only if ECR does not return an expiry (it normally does, ~12h).
	ecrTokenTTLFallback = 12 * time.Hour
	// acrTokenTTL is the assumed ACR refresh-token validity (~3h); the exchange response carries no
	// machine-readable expiry, so we derive the refresh cadence from it.
	acrTokenTTL = 3 * time.Hour
	// gcpRegistryScope is the OAuth scope for an Artifact Registry / GCR pull token.
	gcpRegistryScope = "https://www.googleapis.com/auth/cloud-platform"
	// acrAADScope is the AAD resource whose token is exchanged for an ACR refresh token.
	acrAADScope = "https://management.azure.com/.default"
	// acrTokenUser is the fixed docker username for an ACR refresh-token login.
	acrTokenUser = "00000000-0000-0000-0000-000000000000"
	// garTokenUser is the fixed docker username for a GAR/GCR OAuth-token login.
	garTokenUser = "oauth2accesstoken"
)

// registryTokenMinter mints a full ".dockerconfigjson" payload + its expiry. Swappable in tests (the
// real minters need in-cluster Workload-Identity env + cross-account trust that only exists live).
type registryTokenMinter func(ctx context.Context) (dockerConfigJSON string, exp time.Time, err error)

// RunRegistryToken parses the registry-token flags and runs the refresh loop until the context is
// cancelled. Invoked as a one-shot subcommand from main (the refresher Deployment's entrypoint).
func RunRegistryToken(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("registry-token", flag.ContinueOnError)
	provider := fs.String("provider", "", "cloud provider (aws|gcp|azure)")
	secret := fs.String("secret", "", "name of the dockerconfigjson Secret to patch")
	namespace := fs.String("namespace", "default", "namespace of the Secret")
	host := fs.String("registry-host", "", "registry host (the dockerconfig auths key)")
	region := fs.String("region", "", "cloud region (AWS/ECR)")
	targetRoleArn := fs.String("target-role-arn", "", "cross-account role to assume (AWS/ECR)")
	once := fs.Bool("once", false, "mint + patch once and exit (no refresh loop)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *secret == "" || *host == "" {
		return fmt.Errorf("registry-token: --secret and --registry-host are required")
	}

	var mint registryTokenMinter
	switch *provider {
	case "aws":
		if *region == "" {
			return fmt.Errorf("registry-token aws: --region is required")
		}
		mint = func(ctx context.Context) (string, time.Time, error) {
			return mintECRDockerConfig(ctx, *region, *targetRoleArn, *host)
		}
	case "gcp":
		mint = func(ctx context.Context) (string, time.Time, error) {
			return mintGARDockerConfig(ctx, *host)
		}
	case "azure":
		mint = func(ctx context.Context) (string, time.Time, error) {
			return mintACRDockerConfig(ctx, *host)
		}
	default:
		return fmt.Errorf("registry-token: unsupported provider %q (want aws|gcp|azure)", *provider)
	}
	return runRegistryTokenLoop(ctx, mint, patchPullSecret, *namespace, *secret, *once)
}

// secretPatcher writes the dockerconfigjson into the named Secret. patchPullSecret is the real
// (kubectl) implementation; tests inject a fake so the loop is exercised without a cluster.
type secretPatcher func(ctx context.Context, namespace, name, dockerConfigJSON string) error

// runRegistryTokenLoop mints a dockerconfigjson, patches the Secret, then sleeps until just before
// expiry and repeats. The FIRST mint failing is fatal (fail fast — the refresher is misconfigured or
// the target account doesn't trust this cluster); a later refresh failure keeps the last good secret
// and retries on the floor interval (a transient blip must not break pulls for a running workload).
func runRegistryTokenLoop(ctx context.Context, mint registryTokenMinter, patch secretPatcher, namespace, secret string, once bool) error {
	dcj, exp, err := mint(ctx)
	if err != nil {
		return fmt.Errorf("registry-token: initial mint: %w", err)
	}
	if err := patch(ctx, namespace, secret, dcj); err != nil {
		return fmt.Errorf("registry-token: patch %s/%s: %w", namespace, secret, err)
	}
	if once {
		return nil
	}
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(refreshAfter(exp, time.Now())):
		}
		dcj, exp, err = mint(ctx)
		if err != nil {
			fmt.Fprintf(os.Stderr, "registry-token: refresh failed (keeping last secret): %v\n", err)
			exp = time.Now().Add(tokenRefreshFloor + tokenRefreshLead)
			continue
		}
		if err := patch(ctx, namespace, secret, dcj); err != nil {
			return fmt.Errorf("registry-token: patch %s/%s: %w", namespace, secret, err)
		}
	}
}

// registryPatchJSON builds the strategic-merge patch that updates a dockerconfigjson Secret's
// .dockerconfigjson key with the base64 of the payload. The payload (which carries the pull token) is
// base64'd into the Secret data exactly like any Secret value; it never appears in plaintext here.
func registryPatchJSON(dockerConfigJSON string) string {
	b64 := base64.StdEncoding.EncodeToString([]byte(dockerConfigJSON))
	// The map is closed/known; marshal cannot fail.
	b, _ := json.Marshal(map[string]any{"data": map[string]any{".dockerconfigjson": b64}})
	return string(b)
}

// patchPullSecret patches the pre-seeded Secret via `kubectl patch --patch-file` — the token stays in
// a 0600 temp file, NEVER on argv (which is world-readable via /proc) and NEVER in the logs. kubectl
// uses the pod's in-cluster service-account (the refresher KSA), whose Role grants get+patch on ONLY
// this Secret. Requires the Secret to already exist (the wiring PR seeds a placeholder) — patch, not
// apply, so no create permission is needed.
func patchPullSecret(ctx context.Context, namespace, name, dockerConfigJSON string) error {
	tmp, err := os.CreateTemp("", "regpatch-*.json")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.WriteString(registryPatchJSON(dockerConfigJSON)); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	cmd := exec.CommandContext(ctx, "kubectl", "patch", "secret", name,
		"-n", namespace, "--type", "merge", "--patch-file", tmp.Name())
	// Discard stdout ("secret/... patched"); surface stderr on failure only (kubectl never echoes the
	// patched data, but be conservative and don't stream it anywhere token-bearing regardless).
	cmd.Stdout = io.Discard
	var stderr strings.Builder
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("kubectl patch failed: %w: %s", err, strings.TrimSpace(stderr.String()))
	}
	return nil
}

// dockerConfigJSON renders the ".dockerconfigjson" payload for a single registry host/credential.
func dockerConfigJSON(host, username, password string) string {
	doc := map[string]any{"auths": map[string]any{host: map[string]any{
		"username": username,
		"password": password,
		"auth":     base64.StdEncoding.EncodeToString([]byte(username + ":" + password)),
	}}}
	b, _ := json.Marshal(doc)
	return string(b)
}

// mintECRDockerConfig assumes the customer's cross-account target role (which trusts this cluster's
// IRSA and grants ECR pull), fetches an ECR authorization token in the target account, and renders the
// dockerconfigjson. The ECR authorization token IS base64("AWS:<password>") — exactly the dockerconfig
// `auth` field — so we decode it to username/password for a well-formed entry.
func mintECRDockerConfig(ctx context.Context, region, targetRoleArn, host string) (string, time.Time, error) {
	cfg, err := awsconfig.LoadDefaultConfig(ctx, awsconfig.WithRegion(region))
	if err != nil {
		return "", time.Time{}, fmt.Errorf("load AWS config: %w", err)
	}
	if targetRoleArn != "" {
		// Cross-account: assume the target-account role (base creds = this pod's IRSA identity).
		prov := stscreds.NewAssumeRoleProvider(sts.NewFromConfig(cfg), targetRoleArn)
		cfg.Credentials = aws.NewCredentialsCache(prov)
	}
	out, err := ecr.NewFromConfig(cfg).GetAuthorizationToken(ctx, &ecr.GetAuthorizationTokenInput{})
	if err != nil {
		return "", time.Time{}, fmt.Errorf("ecr GetAuthorizationToken: %w", err)
	}
	if len(out.AuthorizationData) == 0 || out.AuthorizationData[0].AuthorizationToken == nil {
		return "", time.Time{}, fmt.Errorf("ecr returned no authorization data")
	}
	user, pass, err := decodeECRAuth(*out.AuthorizationData[0].AuthorizationToken)
	if err != nil {
		return "", time.Time{}, err
	}
	exp := time.Now().Add(ecrTokenTTLFallback)
	if out.AuthorizationData[0].ExpiresAt != nil {
		exp = *out.AuthorizationData[0].ExpiresAt
	}
	return dockerConfigJSON(host, user, pass), exp, nil
}

// decodeECRAuth splits ECR's base64("user:password") authorization token.
func decodeECRAuth(authToken string) (user, pass string, err error) {
	raw, err := base64.StdEncoding.DecodeString(authToken)
	if err != nil {
		return "", "", fmt.Errorf("decode ecr authorization token: %w", err)
	}
	u, p, ok := strings.Cut(string(raw), ":")
	if !ok {
		return "", "", fmt.Errorf("malformed ecr authorization token")
	}
	return u, p, nil
}

// mintGARDockerConfig mints a GCP OAuth access token from the pod's Workload-Identity service account
// (which the target project granted artifactregistry.reader) and renders the dockerconfigjson. The
// token works cross-project because the SA carries the target-project grant.
func mintGARDockerConfig(ctx context.Context, host string) (string, time.Time, error) {
	creds, err := google.FindDefaultCredentials(ctx, gcpRegistryScope)
	if err != nil {
		return "", time.Time{}, fmt.Errorf("find GCP credentials: %w", err)
	}
	tok, err := creds.TokenSource.Token()
	if err != nil {
		return "", time.Time{}, fmt.Errorf("obtain GCP access token: %w", err)
	}
	return dockerConfigJSON(host, garTokenUser, tok.AccessToken), tok.Expiry, nil
}

// mintACRDockerConfig obtains an AAD token via the pod's Azure Workload Identity, exchanges it at the
// registry's /oauth2/exchange endpoint for an ACR refresh token (the target ACR granted this identity
// AcrPull), and renders the dockerconfigjson.
func mintACRDockerConfig(ctx context.Context, host string) (string, time.Time, error) {
	// The AAD token below is sent to https://<host>/oauth2/exchange. `host` comes from provider_config,
	// so fail closed unless it is a clean ACR hostname — otherwise a wrong/tampered host would receive
	// the (management-scoped) AAD token. This is the only path that sends a token to a config-supplied
	// host (ECR/GAR mint via cloud SDKs), so the allowlist lives here.
	if !isACRHost(host) {
		return "", time.Time{}, fmt.Errorf("refusing ACR token exchange with non-ACR host %q (must be a *.azurecr.io hostname)", host)
	}
	cred, err := azidentity.NewWorkloadIdentityCredential(nil)
	if err != nil {
		return "", time.Time{}, fmt.Errorf("azure workload identity credential: %w", err)
	}
	aad, err := cred.GetToken(ctx, policy.TokenRequestOptions{Scopes: []string{acrAADScope}})
	if err != nil {
		return "", time.Time{}, fmt.Errorf("obtain AAD token: %w", err)
	}
	refresh, err := exchangeACRRefreshToken(ctx, http.DefaultClient, host, aad.Token)
	if err != nil {
		return "", time.Time{}, err
	}
	return dockerConfigJSON(host, acrTokenUser, refresh), time.Now().Add(acrTokenTTL), nil
}

// isACRHost reports whether host is a clean Azure Container Registry hostname (a single hostname
// ending in .azurecr.io, no path/port/userinfo) — the only hosts the ACR AAD token may be sent to.
func isACRHost(host string) bool {
	if host == "" || strings.ContainsAny(host, "/@:?# ") {
		return false
	}
	return strings.HasSuffix(strings.ToLower(host), ".azurecr.io")
}

// exchangeACRRefreshToken POSTs an AAD access token to https://<host>/oauth2/exchange and returns the
// ACR refresh token.
func exchangeACRRefreshToken(ctx context.Context, client *http.Client, host, aadToken string) (string, error) {
	return exchangeACRRefreshTokenAt(ctx, client, "https://"+host+"/oauth2/exchange", host, aadToken)
}

// exchangeACRRefreshTokenAt is the explicit-endpoint variant (unit-testable against a stub server
// without live Azure Workload Identity).
func exchangeACRRefreshTokenAt(ctx context.Context, client *http.Client, endpoint, host, aadToken string) (string, error) {
	form := url.Values{
		"grant_type":   {"access_token"},
		"service":      {host},
		"access_token": {aadToken},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("acr token exchange: %w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("acr token exchange: status %d", resp.StatusCode)
	}
	var out struct {
		RefreshToken string `json:"refresh_token"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return "", fmt.Errorf("acr token exchange: decode: %w", err)
	}
	if out.RefreshToken == "" {
		return "", fmt.Errorf("acr token exchange: empty refresh_token")
	}
	return out.RefreshToken, nil
}
