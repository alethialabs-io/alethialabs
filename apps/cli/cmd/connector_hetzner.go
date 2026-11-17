// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"io"
	"os"
	"strings"

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

// hetznerConnector is the Hetzner entry of the parent command's help.
var hetznerConnector = registerConnector(connectorInfo{
	Slug: "hetzner",
	Exception: `Hetzner is the exception, and the exception is the cloud's, not Alethia's: Hetzner
Cloud offers no OIDC or role-assumption mechanism, so it authenticates with a scoped
API token. The token is encrypted at rest server-side and never returned.`,
})

var connectorHetznerCmd = &cobra.Command{
	Use:   "hetzner",
	Short: "Connect a Hetzner Cloud account",
	Long: `Connect a Hetzner Cloud account with a scoped API token. Run it once per Hetzner
project, before the first deploy into that project.

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
environments declare storage buckets. It is a pair — give both keys or neither.`,
	Args: cobra.NoArgs,
	Run: func(cmd *cobra.Command, args []string) {
		if err := runConnect(cmd, hetznerConnectFlow(os.Stdin)); err != nil {
			fail(err)
		}
	},
}

// hetznerConnectFlow is the Hetzner half of the connection pipeline, for the flags this
// invocation gave. stdin is where --token-stdin reads from.
//
// The token and the storage keys are collected BEFORE the pending identity is opened. A token
// that cannot be right, and half a storage pair, are complaints about the input: refusing them
// after the identity existed left it orphaned, to be removed by hand before a retry.
func hetznerConnectFlow(stdin io.Reader) connectFlow {
	mode := "prompt"
	switch {
	case connectorHetznerTokenStdin:
		mode = "token-stdin"
	case connectorHetznerToken != "":
		mode = "token"
	}

	var apiToken, s3Access, s3Secret string
	return connectFlow{
		Provider: hetznerConnector.Slug,
		Mode:     mode,
		Steps:    []string{"API token", "Initialize", "Connection test"},
		Check: func() error {
			if _, _, err := validateHetznerS3Pair(
				strings.TrimSpace(connectorHetznerS3AccessKey),
				strings.TrimSpace(connectorHetznerS3SecretKey),
			); err != nil {
				return err
			}
			switch mode {
			case "token":
				_, err := validateHetznerToken(strings.TrimSpace(connectorHetznerToken))
				return err
			case "prompt":
				if err := requireInteractiveForm(); err != nil {
					return inputRequiredError(err, "no token given: pass --token, or pipe it with --token-stdin")
				}
			}
			return nil
		},
		Prepare: func(_ *Printer) error {
			var err error
			if apiToken, err = resolveHetznerToken(stdin); err != nil {
				return err
			}
			s3Access, s3Secret, err = resolveHetznerS3(connectorHetznerS3AccessKey, connectorHetznerS3SecretKey)
			return err
		},
		Capture: func(_ *Printer, _ string) (map[string]interface{}, error) {
			return hetznerCreds(apiToken, s3Access, s3Secret), nil
		},
		Connected: func() string { return "Hetzner Cloud account connected" },
	}
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

// resolveHetznerS3 resolves the Object-Storage credential PAIR: from the flags, or by prompt when
// the command is already prompting and neither flag was given.
//
// Two rules, both learned from what the pair actually is.
//
// It is a PAIR, so half of one is refused rather than sent. hetznerCreds omits an empty member,
// so `--s3-access-key AK` alone used to be accepted and stored as an access key with no secret —
// a credential that cannot work, discovered later as a bucket that will not provision.
//
// It is OPTIONAL, so under --no-input its absence is an answer and not an error. Only the
// interactive path asks, and it asks through a Confirm first: most Hetzner projects declare no
// buckets, and two mandatory blank prompts in the common path is a worse command than a Yes/No.
func resolveHetznerS3(access, secret string) (string, string, error) {
	access, secret = strings.TrimSpace(access), strings.TrimSpace(secret)
	if access != "" || secret != "" {
		return validateHetznerS3Pair(access, secret)
	}
	if requireInteractiveForm() != nil {
		return "", "", nil
	}

	var wanted bool
	if err := runHuhForm(huh.NewGroup(
		huh.NewConfirm().
			Title("Add Hetzner Object Storage credentials?").
			Description("Only needed if this project's environments declare storage buckets. Console → Security → S3 credentials.").
			Affirmative("Yes").
			Negative("No").
			Value(&wanted),
	)); err != nil {
		return "", "", formError(err)
	}
	if !wanted {
		return "", "", nil
	}

	if err := runHuhForm(huh.NewGroup(
		huh.NewInput().
			Title("S3 access key").
			Value(&access),
		huh.NewInput().
			Title("S3 secret key").
			EchoMode(huh.EchoModePassword).
			Value(&secret),
	)); err != nil {
		return "", "", formError(err)
	}
	return validateHetznerS3Pair(strings.TrimSpace(access), strings.TrimSpace(secret))
}

// validateHetznerS3Pair refuses HALF a pair, naming the missing half.
//
// Both blank is "neither", which is a valid answer for an optional field and not half of
// anything. The flag path never reaches here with both empty, but the prompt path does: the
// Yes/No offer is answered Yes and then both inputs are submitted blank (neither has a
// Validate), and reporting "an S3 secret key was given without an access key" there describes
// a mistake the user did not make — and aborts the whole connector run over it.
func validateHetznerS3Pair(access, secret string) (string, string, error) {
	switch {
	case access == "" && secret == "":
		return "", "", nil
	case access == "":
		return "", "", invalidInputError("an S3 secret key was given without an access key — pass --s3-access-key too, or neither")
	case secret == "":
		return "", "", invalidInputError("an S3 access key was given without a secret key — pass --s3-secret-key too, or neither")
	}
	return access, secret, nil
}

// resolveHetznerToken picks the token up from --token, from stdin under --token-stdin, or by masked
// prompt. Reading stdin is what makes the command usable from a script or CI under --no-input, where
// a prompt would hang and --token would leak the secret into the process list and shell history.
func resolveHetznerToken(stdin io.Reader) (string, error) {
	if connectorHetznerTokenStdin {
		raw, err := io.ReadAll(stdin)
		if err != nil {
			return "", invalidInputError("read token from stdin: %v", err)
		}
		return validateHetznerToken(strings.TrimSpace(string(raw)))
	}
	if connectorHetznerToken != "" {
		return validateHetznerToken(strings.TrimSpace(connectorHetznerToken))
	}
	if err := requireInteractiveForm(); err != nil {
		return "", inputRequiredError(err, "no token given: pass --token, or pipe it with --token-stdin")
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
		return "", formError(err)
	}
	return validateHetznerToken(strings.TrimSpace(entered))
}

// validateHetznerToken rejects an obviously wrong value locally, so the common paste mistakes fail
// with a clear message instead of as a connection-test failure that reads like a cloud problem.
func validateHetznerToken(token string) (string, error) {
	if token == "" {
		return "", invalidInputError("a Hetzner Cloud API token is required")
	}
	if len(token) < hetznerTokenMinLength {
		return "", invalidInputError("that does not look like a Hetzner Cloud API token (%d characters; expected at least %d) — check you copied the whole value", len(token), hetznerTokenMinLength)
	}
	if strings.ContainsAny(token, " \t\n") {
		return "", invalidInputError("the token contains whitespace — copy it without line breaks")
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
