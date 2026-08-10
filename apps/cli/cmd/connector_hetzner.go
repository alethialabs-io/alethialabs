// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/charmbracelet/huh"
	"github.com/spf13/cobra"
)

var (
	connectorHetznerToken       string
	connectorHetznerTokenStdin  bool
	connectorHetznerS3AccessKey string
	connectorHetznerS3SecretKey string
)

// hetznerTokenMinLength mirrors the server's own floor (saveTokenCloudIdentity rejects anything
// shorter) so an obvious paste error is caught before a round trip. Hetzner Cloud tokens are 64
// characters; the check stays loose because that length is Hetzner's to change, not ours.
const hetznerTokenMinLength = 16

var connectorHetznerCmd = &cobra.Command{
	Use:   "hetzner",
	Short: "Connect a Hetzner Cloud account",
	Long: `Connect a Hetzner Cloud account with a scoped API token.

Hetzner is the one supported cloud that cannot be connected keylessly, and the limit is
Hetzner's rather than Alethia's: Hetzner Cloud exposes no OIDC provider and no
role-assumption API, so a token is the only mechanism available. Alethia encrypts it at
rest server-side and never returns it.

Create the token in the Hetzner Cloud Console under your PROJECT (not the account):
  Security → API tokens → Generate API token, with Read & Write.

A token is scoped to ONE Hetzner project, which is the isolation boundary you get — use a
project dedicated to Alethia rather than one already holding infrastructure you value.

Object Storage (S3-compatible) uses a SEPARATE credential pair, which Hetzner issues
under Security → S3 credentials. It is optional: pass it only if this project's
environments declare storage buckets.`,
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		apiClient := api.NewClient(token)
		steps := []string{"Initialize", "Capture API token", "Connection test"}

		ui.PrintStepper(steps, 0)
		initResp, err := initProviderIdentity(apiClient, "hetzner")
		if err != nil {
			fail(err)
		}

		ui.PrintStepper(steps, 1)
		apiToken, err := resolveHetznerToken(os.Stdin)
		if err != nil {
			fail(err)
		}

		ui.PrintStepper(steps, 2)
		if err := finalizeConnection(apiClient, "hetzner", initResp.IdentityID, hetznerCreds(
			apiToken, connectorHetznerS3AccessKey, connectorHetznerS3SecretKey,
		)); err != nil {
			failf("Failed to connect Hetzner: %v", err)
		}
	},
}

// hetznerCreds builds the credentials payload. The S3 pair is OMITTED when unset rather than sent
// empty: the server treats absence as "this project has no buckets", and an empty string would be
// stored as a credential that cannot work.
func hetznerCreds(apiToken, s3Access, s3Secret string) map[string]interface{} {
	creds := map[string]interface{}{"api_token": apiToken}
	if s3Access != "" {
		creds["s3_access_key"] = s3Access
	}
	if s3Secret != "" {
		creds["s3_secret_key"] = s3Secret
	}
	return creds
}

// resolveHetznerToken picks the token up from --token, from stdin under --token-stdin, or by masked
// prompt. Reading stdin is what makes the command usable from a script or CI under --no-input, where
// a prompt would hang and --token would leak the secret into the process list and shell history.
func resolveHetznerToken(stdin io.Reader) (string, error) {
	if connectorHetznerTokenStdin {
		raw, err := io.ReadAll(stdin)
		if err != nil {
			return "", fmt.Errorf("read token from stdin: %w", err)
		}
		return validateHetznerToken(strings.TrimSpace(string(raw)))
	}
	if connectorHetznerToken != "" {
		return validateHetznerToken(strings.TrimSpace(connectorHetznerToken))
	}
	if err := requireInteractive(); err != nil {
		return "", fmt.Errorf("no token given: pass --token, or pipe it with --token-stdin (%w)", err)
	}
	var entered string
	if err := runHuhForm(
		huh.NewGroup(
			huh.NewInput().
				Title("Hetzner Cloud API token").
				Description("Console → Security → API tokens → Generate (Read & Write). Scoped to one project.").
				EchoMode(huh.EchoModePassword).
				Value(&entered),
		),
	); err != nil {
		return "", err
	}
	return validateHetznerToken(strings.TrimSpace(entered))
}

// validateHetznerToken rejects an obviously wrong value locally, so the common paste mistakes fail
// with a clear message instead of as a connection-test failure that reads like a cloud problem.
func validateHetznerToken(token string) (string, error) {
	if token == "" {
		return "", fmt.Errorf("a Hetzner Cloud API token is required")
	}
	if len(token) < hetznerTokenMinLength {
		return "", fmt.Errorf("that does not look like a Hetzner Cloud API token (%d characters; expected at least %d) — check you copied the whole value", len(token), hetznerTokenMinLength)
	}
	if strings.ContainsAny(token, " \t\n") {
		return "", fmt.Errorf("the token contains whitespace — copy it without line breaks")
	}
	return token, nil
}

func init() {
	connectorHetznerCmd.Flags().StringVar(&connectorHetznerToken, "token", "", "Hetzner Cloud API token (prefer --token-stdin: a flag lands in your shell history and the process list)")
	connectorHetznerCmd.Flags().BoolVar(&connectorHetznerTokenStdin, "token-stdin", false, "Read the API token from stdin")
	connectorHetznerCmd.Flags().StringVar(&connectorHetznerS3AccessKey, "s3-access-key", "", "Hetzner Object Storage access key (only needed for storage buckets)")
	connectorHetznerCmd.Flags().StringVar(&connectorHetznerS3SecretKey, "s3-secret-key", "", "Hetzner Object Storage secret key (only needed for storage buckets)")
	connectorCmd.AddCommand(connectorHetznerCmd)
}
