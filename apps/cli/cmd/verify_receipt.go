// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"crypto/ed25519"
	"fmt"
	"io"
	"os"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/verify"
	"github.com/spf13/cobra"
)

var verifyReceiptCmd = &cobra.Command{
	Use:   "receipt",
	Short: "Fetch a job's evidence receipt and check its signature",
	Long: `Pulls the signed evidence receipt from a PLAN or DEPLOY job and verifies it.

The signature is checked against a key the control plane vouches for — the organization's own
recorded signing key, or the Alethia platform key — and NOT merely against the public key the
receipt carries about itself. A receipt always verifies under its own embedded key, whoever made
it, so self-verification alone proves the document was not altered in transit and nothing more.

Exit status is part of the contract: anything short of a signature verified against a vouched-for
key exits non-zero, so this can gate a pipeline. Use --allow-unsigned or --allow-untrusted to
downgrade a specific failure to a warning.`,
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		jobID, err := currentJob(cmd)
		if err != nil {
			fail(err)
		}
		opts, err := verifyOptsFrom(cmd)
		if err != nil {
			fail(err)
		}
		if err := runVerifyReceipt(api.NewClient(token), os.Stdout, outputFormat(cmd), jobID, opts); err != nil {
			fail(err)
		}
	},
}

// verifyOpts carries the verification-policy flags, resolved once so the run function stays
// testable without a cobra.Command.
type verifyOpts struct {
	pinned         ed25519.PublicKey
	allowUnsigned  bool
	allowUntrusted bool
}

// verifyOptsFrom reads the policy flags off the command.
func verifyOptsFrom(cmd *cobra.Command) (verifyOpts, error) {
	keyB64, _ := cmd.Flags().GetString("key")
	keyFile, _ := cmd.Flags().GetString("key-file")
	pub, err := pinnedKey(keyB64, keyFile)
	if err != nil {
		return verifyOpts{}, err
	}
	allowUnsigned, _ := cmd.Flags().GetBool("allow-unsigned")
	allowUntrusted, _ := cmd.Flags().GetBool("allow-untrusted")
	return verifyOpts{pinned: pub, allowUnsigned: allowUnsigned, allowUntrusted: allowUntrusted}, nil
}

// receiptVerification is the verdict this command exists to produce.
type receiptVerification struct {
	JobID     string                `json:"job_id"`
	OK        bool                  `json:"ok"`
	Signature signatureVerdict      `json:"signature"`
	Receipt   *verify.SignedReceipt `json:"receipt"`
}

// signatureVerdict is the answer to "is this signed, by whom, and did it check out".
type signatureVerdict struct {
	Algorithm string `json:"algorithm"`
	KeyID     string `json:"key_id"`
	Verified  bool   `json:"verified"`
	Trust     string `json:"trust"`
	Reason    string `json:"reason"`
}

// verifyReceipt is the whole decision, pure over its inputs: it takes the receipt and a way to
// fetch the trusted-key set, and returns the verdict plus the error that must set a non-zero exit
// (nil when the policy flags forgive the shortfall). Separating it from rendering is what lets the
// output be printed BEFORE the command exits non-zero — a gate that prints nothing on failure is
// useless for diagnosing why.
func verifyReceipt(sr *verify.SignedReceipt, fetchKeys func() ([]api.SigningKey, error), opts verifyOpts) (signatureVerdict, error) {
	// An unsigned receipt is a real, documented state: the runner attaches one when no signing
	// key is configured. It is not a verification FAILURE, but it is not evidence either.
	if sr.Algorithm != "ed25519" {
		v := signatureVerdict{
			Algorithm: sr.Algorithm,
			KeyID:     sr.KeyID,
			Verified:  false,
			Trust:     string(trustNone),
			Reason:    "receipt is unsigned — the runner had no ALETHIA_RECEIPT_SIGNING_KEY configured when it ran",
		}
		if opts.allowUnsigned {
			return v, nil
		}
		return v, fmt.Errorf("receipt is unsigned (algorithm %q) — there is no signature to verify. "+
			"Configure ALETHIA_RECEIPT_SIGNING_KEY on the runner, or pass --allow-unsigned to accept this", sr.Algorithm)
	}

	// Self-consistency first. A failure here means the document does not match its own signature:
	// it was altered after signing, and no flag forgives that.
	if err := sr.VerifySelf(); err != nil {
		return signatureVerdict{
				Algorithm: sr.Algorithm,
				KeyID:     sr.KeyID,
				Verified:  false,
				Trust:     string(trustNone),
				Reason:    err.Error(),
			}, fmt.Errorf("receipt FAILED verification: %w\n"+
				"The receipt does not match its own signature — it was altered after it was signed", err)
	}

	// An operator-supplied key beats anything the control plane says about itself.
	if opts.pinned != nil {
		if err := sr.Verify(opts.pinned); err != nil {
			return signatureVerdict{
					Algorithm: sr.Algorithm,
					KeyID:     sr.KeyID,
					Verified:  false,
					Trust:     string(trustNone),
					Reason:    err.Error(),
				}, fmt.Errorf("receipt FAILED verification against the key you supplied: %w\n"+
					"The receipt is internally consistent, so it was signed — but by key %s, not by yours", err, sr.KeyID)
		}
		return signatureVerdict{
			Algorithm: sr.Algorithm,
			KeyID:     sr.KeyID,
			Verified:  true,
			Trust:     string(trustPinned),
			Reason:    "signature verified against the key you supplied",
		}, nil
	}

	keys, err := fetchKeys()
	if err != nil {
		// The control plane could not tell us which keys it vouches for — an older console
		// without this endpoint, or an outage. Degrade to the self-verified result and SAY so;
		// do not silently present it as trusted.
		v := signatureVerdict{
			Algorithm: sr.Algorithm,
			KeyID:     sr.KeyID,
			Verified:  true,
			Trust:     string(trustSelf),
			Reason:    fmt.Sprintf("signature is self-consistent, but the trusted-key set was unavailable: %v", err),
		}
		if opts.allowUntrusted {
			return v, nil
		}
		return v, fmt.Errorf("could not establish who signed this receipt: %w\n"+
			"The signature is internally consistent, but that only proves the document was not altered — "+
			"not that Alethia signed it. Pass --key/--key-file to pin a key you trust, or --allow-untrusted "+
			"to accept a self-consistent receipt", err)
	}

	tk := newTrustedKeys(keys)
	if err := sr.VerifyTrusted(tk); err != nil {
		v := signatureVerdict{
			Algorithm: sr.Algorithm,
			KeyID:     sr.KeyID,
			Verified:  true,
			Trust:     string(trustSelf),
			Reason:    fmt.Sprintf("signature is self-consistent, but %v", err),
		}
		if opts.allowUntrusted {
			return v, nil
		}
		return v, fmt.Errorf("receipt is signed by a key this organization does not vouch for: %w\n"+
			"The signature is internally consistent, so the document is intact — but key %s is not in the "+
			"trusted set, which is what a forged receipt also looks like", err, sr.KeyID)
	}

	trust := tk.sourceFor(sr.KeyID)
	var reason string
	switch trust {
	case trustOrg:
		reason = "signature verified against your organization's own recorded key"
	case trustPlatform:
		reason = "signature verified against the Alethia platform key"
	case trustNone, trustSelf, trustPinned:
		// A contradiction: VerifyTrusted just resolved this key_id against the fetched set, so
		// sourceFor cannot honestly report that nothing vouches for it — and pinned/self are
		// decided earlier and never reach here. Rather than invent a reason for a state that
		// should not exist, fail closed.
		return signatureVerdict{
				Algorithm: sr.Algorithm,
				KeyID:     sr.KeyID,
				Verified:  true,
				Trust:     string(trustSelf),
				Reason:    "signature is self-consistent, but the trusted-key set answered inconsistently about who owns this key",
			}, fmt.Errorf("could not establish who signed this receipt: key %s verified against the trusted set "+
				"but that set does not say who vouches for it", sr.KeyID)
	default:
		// The control plane vouched for the key under a custody model this CLI does not know.
		// Report what it said rather than implying a familiar one.
		reason = fmt.Sprintf("signature verified against a key your control plane vouches for (source %q)", trust)
	}
	return signatureVerdict{
		Algorithm: sr.Algorithm,
		KeyID:     sr.KeyID,
		Verified:  true,
		Trust:     string(trust),
		Reason:    reason,
	}, nil
}

// runVerifyReceipt fetches a job's receipt, verifies it, renders the result, and returns the
// error that sets a non-zero exit. json emits the whole verdict object plus the receipt;
// table/csv render the summary card.
func runVerifyReceipt(c apiClient, out io.Writer, format, jobID string, opts verifyOpts) error {
	job, err := c.GetJob(jobID)
	if err != nil {
		return err
	}
	sr, err := receiptFromJob(job)
	if err != nil {
		return err
	}

	verdict, verifyErr := verifyReceipt(sr, c.GetSigningKeys, opts)
	result := receiptVerification{
		JobID:     jobID,
		OK:        verifyErr == nil,
		Signature: verdict,
		Receipt:   sr,
	}

	if format == ui.FormatJSON {
		if err := ui.Render(out, format, ui.TableSpec{}, result); err != nil {
			return err
		}
		return verifyErr
	}
	if err := ui.RenderCard(out, format, "alethia · verify receipt", receiptRows(sr, verdict), result); err != nil {
		return err
	}
	return verifyErr
}

// receiptRows projects a receipt and its signature verdict into field/value cells. Status reads
// by glyph, never by colour — the CLI palette is grayscale.
func receiptRows(sr *verify.SignedReceipt, v signatureVerdict) [][]string {
	mark := ui.SymbolError
	if v.Verified {
		mark = ui.SymbolSuccess
	}
	rows := [][]string{
		{"Signature", fmt.Sprintf("%s %s", mark, v.Reason)},
		{"Trust", v.Trust},
		{"Algorithm", sr.Algorithm},
	}
	if sr.KeyID != "" {
		rows = append(rows, []string{"Key ID", sr.KeyID})
	}
	rows = append(rows,
		[]string{"Verdict", string(sr.Receipt.Verdict)},
		[]string{"Sealed to plan", sr.Receipt.PlanSHA256},
	)
	if sr.Receipt.Provider != "" {
		rows = append(rows, []string{"Provider", sr.Receipt.Provider})
	}
	if sr.Receipt.CatalogVersion != "" {
		rows = append(rows, []string{"Control catalog", sr.Receipt.CatalogVersion})
	}
	if sr.Receipt.TofuVersion != "" {
		rows = append(rows, []string{"OpenTofu", sr.Receipt.TofuVersion})
	}
	if sr.Receipt.Runner != "" {
		rows = append(rows, []string{"Runner", sr.Receipt.Runner})
	}
	if sr.Receipt.EvaluatedAt != "" {
		rows = append(rows, []string{"Evaluated", sr.Receipt.EvaluatedAt})
	}
	if r := sr.Receipt.Report; r != nil {
		rows = append(rows, []string{"Controls", fmt.Sprintf("%d pass, %d fail, %d warn, %d n/a",
			r.Summary.Pass, r.Summary.Fail, r.Summary.Warn, r.Summary.NotEvaluable)})
	}
	if e := sr.Receipt.Exception; e != nil {
		rows = append(rows, []string{"Waiver", fmt.Sprintf("%d control(s) waived by %s — %s",
			len(e.Controls), e.By, e.Reason)})
	}
	if sr.Rekor != nil && sr.Rekor.LogURL != "" {
		rows = append(rows, []string{"Transparency log", sr.Rekor.LogURL})
	}
	return rows
}

func init() {
	verifyReceiptCmd.Flags().String("key", "", "Verify against this base64(std) ed25519 public key instead of the control plane's trusted set")
	verifyReceiptCmd.Flags().String("key-file", "", "Verify against the base64(std) ed25519 public key in this file")
	verifyReceiptCmd.Flags().Bool("allow-unsigned", false, "Exit zero when the receipt carries no signature")
	verifyReceiptCmd.Flags().Bool("allow-untrusted", false, "Exit zero when the signature is self-consistent but its key is not vouched for")
}
