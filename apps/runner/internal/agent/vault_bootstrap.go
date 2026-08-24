// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

// vault-bootstrap initialises, unseals and seeds the IN-CLUSTER Vault that delivers the `secret`
// kind on Hetzner (#2432).
//
// Hetzner sells no cloud secret store, so a canvas `secret` node cannot become a Secrets Manager /
// Secret Manager / Key Vault / KMS entry the way it does on the other four clouds. It becomes a KV
// v2 entry in a Vault this platform installs, read back through an ESO ClusterSecretStore.
//
// ── WHAT THIS DOES AND DOES NOT PROTECT — read before changing anything here ───────────────────
//
// Vault's awskms / gcpckms / azurekeyvault / transit seals all need an external KMS, and Hetzner
// sells none. So the seal is Shamir and SOMETHING must hold the unseal key across restarts. It is
// held in a Kubernetes Secret in this cluster.
//
// That means the unseal key sits in the same etcd that would otherwise hold the secret value. THE
// TRUST BOUNDARY DOES NOT MOVE. Against a cluster-admin, an etcd backup, a volume snapshot, or
// Hetzner with disk access, this buys nothing over a plain Secret. What it does buy is real but
// different: an audit log of every read, leases and revocation, rotation, and one uniform ESO read
// path with the other four clouds.
//
// Say that plainly wherever it is described. The failure this repo has already paid for is a claim
// nobody could reconcile with the product (#2371 removed a whole processing purpose for it), and
// "encrypted at rest in Vault" over a design where the unseal key sits beside the ciphertext is
// exactly that shape of claim.
//
// The root token IS revoked after setup, so no standing root credential exists. The remaining
// standing authority is the unseal key plus the ESO token — a speed bump, not a boundary.
//
// ── Why it runs in the cluster ────────────────────────────────────────────────────────────────
//
// Vault answers on the cluster network only; the runner has a kubeconfig and no route to it. Same
// constraint, same rail, and the same reason it is the better shape: the unseal key and the ESO
// token are generated, used and stored without ever entering the runner process, a log, or
// execution_metadata. See packages/core/argocd/vault.go and the #2431 precedent in harbor.go.

const (
	// vaultBootstrapMaxWait bounds the wait for Vault's API. A fresh Vault on a cold Hetzner cluster
	// waits on a PVC bind, so this is generous on purpose.
	vaultBootstrapMaxWait = 15 * time.Minute
	// vaultPollInterval is how often the health endpoint is retried while waiting.
	vaultPollInterval = 5 * time.Second
	// vaultKVMount is the KV v2 mount the project's secrets live under.
	vaultKVMount = "secret"
	// vaultESOPolicy is the read-only policy the ESO token is bound to.
	vaultESOPolicy = "alethia-eso-read"
	// vaultHTTPTimeout bounds a single API call.
	vaultHTTPTimeout = 30 * time.Second
	// vaultUnsealKeyField / vaultESOTokenField are the keys inside the state Secret.
	vaultUnsealKeyField = "unsealKey"
	vaultESOTokenField  = "esoToken"
	// vaultInitializedField records that init has happened, so a Vault that reports uninitialized
	// while we hold a key is treated as data loss rather than a fresh install.
	vaultInitializedField = "initialized"
)

// vaultClient is the slice of Vault's API this needs, as an interface so the ORDERING — which is the
// part that can be catastrophically wrong — is testable without a Vault.
type vaultClient interface {
	// Health reports (initialized, sealed) or an error when Vault is not answering yet.
	Health(ctx context.Context) (initialized bool, sealed bool, err error)
	// Init initialises with a single Shamir share and returns the unseal key and root token. Both
	// are shown exactly once; Vault never returns them again.
	Init(ctx context.Context) (unsealKey string, rootToken string, err error)
	// Unseal submits the key.
	Unseal(ctx context.Context, key string) error
	// EnableKV mounts KV v2 at the given path, tolerating one already mounted.
	EnableKV(ctx context.Context, root, mount string) error
	// PutSecret writes one KV v2 entry under the pinned `value` field convention.
	PutSecret(ctx context.Context, root, mount, name, value string) error
	// EnsureESOToken creates the read-only policy and mints a token bound to it.
	EnsureESOToken(ctx context.Context, root, policy, mount string) (string, error)
	// RevokeSelf revokes the token it is called with — used to destroy the root token.
	RevokeSelf(ctx context.Context, token string) error
}

// vaultStateStore persists the unseal key and ESO token. Swappable so tests never touch a cluster.
type vaultStateStore interface {
	// Read returns the stored state, or an empty map when the Secret does not exist yet.
	Read(ctx context.Context) (map[string]string, error)
	// Write stores the state, creating the Secret if absent.
	Write(ctx context.Context, data map[string]string) error
}

type vaultBootstrapOpts struct {
	APIBase        string
	StateSecret    string
	StateNamespace string
	// Secrets are the canvas `secret` nodes to seed, with the sizing each one asked for.
	Secrets []vaultSeedSpec
	// ESOCredSecret / ESOCredNamespace are where the ESO token is seeded for the ClusterSecretStore's
	// auth.secretRef to resolve.
	ESOCredSecret string
	ESONamespace  string
	ESOCredKey    string
}

// RunVaultBootstrap parses the flags and runs the bootstrap.
func RunVaultBootstrap(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("vault-bootstrap", flag.ContinueOnError)
	var o vaultBootstrapOpts
	var names string
	fs.StringVar(&o.APIBase, "api-base", "", "Vault API root (http://vault.vault.svc.cluster.local:8200)")
	fs.StringVar(&o.StateSecret, "state-secret", "", "Secret holding the unseal key and ESO token")
	fs.StringVar(&o.StateNamespace, "state-namespace", "", "namespace of the state Secret")
	fs.StringVar(&names, "secrets", "", "comma-separated secret specs: <name>:manual, or <name>:<length>:<0|1 special chars>")
	fs.StringVar(&o.ESOCredSecret, "eso-secret", "", "Secret the ClusterSecretStore reads the token from")
	fs.StringVar(&o.ESONamespace, "eso-namespace", "", "namespace of that Secret")
	fs.StringVar(&o.ESOCredKey, "eso-key", "token", "data key inside the ESO credential Secret")
	if err := fs.Parse(args); err != nil {
		return err
	}
	specs, sErr := parseVaultSeedSpecs(names)
	if sErr != nil {
		return sErr
	}
	o.Secrets = specs
	if err := o.validate(); err != nil {
		return err
	}
	client := &vaultAPI{base: strings.TrimRight(o.APIBase, "/"), http: &http.Client{Timeout: vaultHTTPTimeout}}
	return vaultBootstrap(ctx, o, client, &kubeSecretStore{namespace: o.StateNamespace, name: o.StateSecret},
		func(ctx context.Context, token string) error {
			return writeOpaqueSecret(ctx, o.ESONamespace, o.ESOCredSecret, map[string]string{o.ESOCredKey: token})
		})
}

func (o vaultBootstrapOpts) validate() error {
	missing := []string{}
	for name, v := range map[string]string{
		"--api-base": o.APIBase, "--state-secret": o.StateSecret,
		"--state-namespace": o.StateNamespace, "--eso-secret": o.ESOCredSecret,
		"--eso-namespace": o.ESONamespace, "--eso-key": o.ESOCredKey,
	} {
		if strings.TrimSpace(v) == "" {
			missing = append(missing, name)
		}
	}
	if len(missing) > 0 {
		return fmt.Errorf("vault-bootstrap: missing required flag(s): %s", strings.Join(missing, ", "))
	}
	return nil
}

// vaultBootstrap is the whole algorithm with its I/O injected.
//
// The ordering is the dangerous part, and one branch in particular: an UNINITIALIZED Vault while we
// already hold an unseal key is not a fresh install — it is a Vault whose storage was lost. Running
// init there would silently produce an empty Vault and a new key, discarding every secret and
// reporting success. It is a hard error instead.
func vaultBootstrap(
	ctx context.Context,
	o vaultBootstrapOpts,
	client vaultClient,
	state vaultStateStore,
	seedESOToken func(ctx context.Context, token string) error,
) error {
	stored, err := state.Read(ctx)
	if err != nil {
		return fmt.Errorf("vault-bootstrap: read state: %w", err)
	}

	initialized, sealed, err := waitForVault(ctx, client)
	if err != nil {
		return err
	}

	// ── the data-loss guard ──────────────────────────────────────────────────────────────────
	if !initialized && stored[vaultInitializedField] == "true" {
		return errors.New("vault-bootstrap: Vault reports UNINITIALIZED but this cluster holds an unseal key — " +
			"its storage has been lost or replaced. Refusing to re-initialise: that would create an empty Vault, " +
			"discard every stored secret, and report success. Restore the volume, or delete the state Secret " +
			"deliberately to accept the loss")
	}

	rootToken := ""
	if !initialized {
		key, root, iErr := client.Init(ctx)
		if iErr != nil {
			return fmt.Errorf("vault-bootstrap: init: %w", iErr)
		}
		if key == "" || root == "" {
			return errors.New("vault-bootstrap: Vault returned an empty unseal key or root token")
		}
		// Persist BEFORE unsealing. Vault shows these exactly once; a crash between init and write
		// leaves a Vault nobody can ever unseal, which is unrecoverable rather than merely broken.
		stored = map[string]string{vaultUnsealKeyField: key, vaultInitializedField: "true"}
		if wErr := state.Write(ctx, stored); wErr != nil {
			return fmt.Errorf("vault-bootstrap: persist unseal key: %w", wErr)
		}
		rootToken = root
		sealed = true
	}

	if sealed {
		key := stored[vaultUnsealKeyField]
		if key == "" {
			return errors.New("vault-bootstrap: Vault is sealed and no unseal key is stored — it cannot be opened")
		}
		if uErr := client.Unseal(ctx, key); uErr != nil {
			return fmt.Errorf("vault-bootstrap: unseal: %w", uErr)
		}
	}

	// Everything below needs root. On a re-run there is none — it was revoked — and there is nothing
	// to do: the mount exists, the secrets exist, and the ESO token is already seeded.
	if rootToken == "" {
		fmt.Fprintln(os.Stdout, "vault-bootstrap: already initialised and unsealed; nothing to configure")
		return nil
	}

	// Revoke root on EVERY exit path from here, including the failures. A half-configured Vault is
	// recoverable; a root token left alive in a cluster is a standing credential nobody meant to
	// create.
	defer func() {
		if rErr := client.RevokeSelf(ctx, rootToken); rErr != nil {
			fmt.Fprintf(os.Stderr, "vault-bootstrap: WARNING could not revoke the root token: %v\n", rErr)
		}
	}()

	if err := client.EnableKV(ctx, rootToken, vaultKVMount); err != nil {
		return fmt.Errorf("vault-bootstrap: enable kv: %w", err)
	}
	seeded := 0
	for _, spec := range o.Secrets {
		// MANUAL secrets are not written at all — the same semantics the four managed clouds carry
		// (`manual: true` ⇒ the secret resource exists with no version). Writing a placeholder would
		// look identical to a real value to every consumer, which is worse than an honest absence.
		if !spec.Generate {
			continue
		}
		value, gErr := generateSecretValue(spec)
		if gErr != nil {
			return fmt.Errorf("vault-bootstrap: generate %q: %w", spec.Name, gErr)
		}
		if pErr := client.PutSecret(ctx, rootToken, vaultKVMount, spec.Name, value); pErr != nil {
			return fmt.Errorf("vault-bootstrap: write %q: %w", spec.Name, pErr)
		}
		seeded++
	}
	token, tErr := client.EnsureESOToken(ctx, rootToken, vaultESOPolicy, vaultKVMount)
	if tErr != nil {
		return fmt.Errorf("vault-bootstrap: mint the ESO token: %w", tErr)
	}
	if token == "" {
		return errors.New("vault-bootstrap: Vault returned an empty ESO token")
	}
	if sErr := seedESOToken(ctx, token); sErr != nil {
		return fmt.Errorf("vault-bootstrap: seed the ESO credential: %w", sErr)
	}
	stored[vaultESOTokenField] = token
	if wErr := state.Write(ctx, stored); wErr != nil {
		return fmt.Errorf("vault-bootstrap: persist the ESO token: %w", wErr)
	}
	fmt.Fprintf(os.Stdout, "vault-bootstrap: initialised, unsealed, seeded %d of %d secret(s) (the rest are manual), root token revoked\n",
		seeded, len(o.Secrets))
	return nil
}

// waitForVault blocks until Vault answers, returning its initialized/sealed state.
func waitForVault(ctx context.Context, client vaultClient) (bool, bool, error) {
	deadline := time.Now().Add(vaultBootstrapMaxWait)
	for {
		initialized, sealed, err := client.Health(ctx)
		if err == nil {
			return initialized, sealed, nil
		}
		if time.Now().After(deadline) {
			return false, false, fmt.Errorf("vault-bootstrap: Vault did not answer within %s: %w", vaultBootstrapMaxWait, err)
		}
		select {
		case <-ctx.Done():
			return false, false, ctx.Err()
		case <-time.After(vaultPollInterval):
		}
	}
}

// vaultSeedSpec is one `secret` node as the Job receives it: a name, and what to put at it.
type vaultSeedSpec struct {
	Name         string
	Generate     bool
	Length       int
	SpecialChars bool
}

// vaultSeedDefaultLength is the length used when the canvas left it unset, matching the
// `length` default a `secret` node carries.
const vaultSeedDefaultLength = 32

// vaultSeedMaxLength bounds a generated value. Not a security limit — a bound so a mistyped or
// hostile length cannot ask the pod to allocate an unbounded string inside a Job with no memory
// limit of its own.
const vaultSeedMaxLength = 4096

// vaultSeedAlphabet / vaultSeedSpecials are the generated alphabets. The specials are the printable
// punctuation that survives being pasted into a shell, a YAML scalar and a URL query without
// quoting surprises — deliberately NOT the full ASCII punctuation set, because a secret nobody can
// transport is a secret nobody uses.
const (
	vaultSeedAlphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
	vaultSeedSpecials = "!#$%&*+-.:=?@^_~"
)

// parseVaultSeedSpecs decodes the Job's `--secrets` argument. Fail-closed and TOTAL: every entry
// must match one of the two forms the renderer emits (`<name>:manual`, `<name>:<length>:<0|1>`), and
// anything else is an error rather than a silently-skipped secret. A skipped secret is invisible —
// the deploy stays green and one ExternalSecret resolves nothing, days later.
func parseVaultSeedSpecs(arg string) ([]vaultSeedSpec, error) {
	var out []vaultSeedSpec
	for _, entry := range strings.Split(arg, ",") {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			continue
		}
		parts := strings.Split(entry, ":")
		if parts[0] == "" {
			return nil, fmt.Errorf("vault-bootstrap: secret spec %q has no name", entry)
		}
		switch {
		case len(parts) == 2 && parts[1] == "manual":
			out = append(out, vaultSeedSpec{Name: parts[0]})
		case len(parts) == 3:
			length, err := strconv.Atoi(parts[1])
			if err != nil || length < 0 {
				return nil, fmt.Errorf("vault-bootstrap: secret spec %q has an unreadable length %q", entry, parts[1])
			}
			if parts[2] != "0" && parts[2] != "1" {
				return nil, fmt.Errorf("vault-bootstrap: secret spec %q has an unreadable special-chars flag %q", entry, parts[2])
			}
			out = append(out, vaultSeedSpec{
				Name: parts[0], Generate: true, Length: length, SpecialChars: parts[2] == "1",
			})
		default:
			return nil, fmt.Errorf("vault-bootstrap: secret spec %q matches neither <name>:manual nor <name>:<length>:<0|1>", entry)
		}
	}
	return out, nil
}

// generateSecretValue produces the value a `secret` node's generated credential carries, honouring
// the `length` and `special_chars` the canvas offered — the same two knobs buildSecrets carries into
// Secrets Manager / Secret Manager / Key Vault / KMS on the four managed clouds. Ignoring them here
// would present three switches on the canvas that change nothing, which is exactly what the
// offer-parity guard refuses.
//
// The value is generated HERE, in the cluster, and never returned to the runner — the whole reason
// this is a Job. The pluggable-Vault tofu module writes the literal string "managed-by-alethia"
// instead (infra/templates/categories/secrets/vault/main.tf), which is a documented placeholder for
// an operator-supplied value; this path must never be refactored to route through it.
func generateSecretValue(spec vaultSeedSpec) (string, error) {
	length := spec.Length
	if length <= 0 {
		length = vaultSeedDefaultLength
	}
	if length > vaultSeedMaxLength {
		length = vaultSeedMaxLength
	}
	alphabet := vaultSeedAlphabet
	if spec.SpecialChars {
		alphabet += vaultSeedSpecials
	}
	return randomStringFrom(alphabet, length)
}

// randomStringFrom draws `length` characters uniformly from alphabet using crypto/rand.
//
// rand.Int over the alphabet length, NOT `b % len(alphabet)`: modulo over a byte biases the first
// 256%len characters, which for the 78-character special alphabet means 22 of them are ~1.4x more
// likely than the rest. That is a real, if modest, reduction in entropy, and it costs nothing to
// avoid.
func randomStringFrom(alphabet string, length int) (string, error) {
	if alphabet == "" || length <= 0 {
		return "", fmt.Errorf("refusing to generate a secret of length %d from a %d-character alphabet", length, len(alphabet))
	}
	max := big.NewInt(int64(len(alphabet)))
	out := make([]byte, length)
	for i := range out {
		n, err := rand.Int(rand.Reader, max)
		if err != nil {
			return "", err
		}
		out[i] = alphabet[n.Int64()]
	}
	return string(out), nil
}

// ── the real Vault client ──────────────────────────────────────────────────────────────────────

type vaultAPI struct {
	base string
	http *http.Client
}

func (v *vaultAPI) do(ctx context.Context, method, path, token string, body any) (int, []byte, error) {
	var rdr io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return 0, nil, err
		}
		rdr = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, v.base+path, rdr)
	if err != nil {
		return 0, nil, err
	}
	if token != "" {
		req.Header.Set("X-Vault-Token", token)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := v.http.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer res.Body.Close()
	out, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	return res.StatusCode, out, nil
}

// Health reads /v1/sys/health. Vault deliberately answers with a NON-200 for sealed (503) and
// uninitialized (501), so the status code is data here, not an error.
func (v *vaultAPI) Health(ctx context.Context) (bool, bool, error) {
	code, body, err := v.do(ctx, http.MethodGet, "/v1/sys/health?standbyok=true&sealedcode=200&uninitcode=200", "", nil)
	if err != nil {
		return false, false, err
	}
	if code != http.StatusOK {
		return false, false, fmt.Errorf("unexpected health status %d: %s", code, strings.TrimSpace(string(body)))
	}
	var h struct {
		Initialized bool `json:"initialized"`
		Sealed      bool `json:"sealed"`
	}
	if uErr := json.Unmarshal(body, &h); uErr != nil {
		return false, false, fmt.Errorf("decode health: %w", uErr)
	}
	return h.Initialized, h.Sealed, nil
}

// Init initialises with ONE Shamir share and a threshold of one.
//
// Splitting into N shares would be theatre: every share would be stored in the same Secret, so the
// threshold protects nothing and the only effect is more material to lose. The custody story is the
// Secret, and it is stated plainly rather than dressed up.
func (v *vaultAPI) Init(ctx context.Context) (string, string, error) {
	code, body, err := v.do(ctx, http.MethodPost, "/v1/sys/init", "", map[string]any{
		"secret_shares":    1,
		"secret_threshold": 1,
	})
	if err != nil {
		return "", "", err
	}
	if code != http.StatusOK {
		return "", "", fmt.Errorf("unexpected status %d: %s", code, strings.TrimSpace(string(body)))
	}
	var out struct {
		Keys      []string `json:"keys"`
		RootToken string   `json:"root_token"`
	}
	if uErr := json.Unmarshal(body, &out); uErr != nil {
		return "", "", fmt.Errorf("decode init: %w", uErr)
	}
	if len(out.Keys) == 0 {
		return "", out.RootToken, nil
	}
	return out.Keys[0], out.RootToken, nil
}

func (v *vaultAPI) Unseal(ctx context.Context, key string) error {
	code, body, err := v.do(ctx, http.MethodPost, "/v1/sys/unseal", "", map[string]any{"key": key})
	if err != nil {
		return err
	}
	if code != http.StatusOK {
		return fmt.Errorf("unexpected status %d: %s", code, strings.TrimSpace(string(body)))
	}
	var out struct {
		Sealed bool `json:"sealed"`
	}
	if uErr := json.Unmarshal(body, &out); uErr != nil {
		return fmt.Errorf("decode unseal: %w", uErr)
	}
	if out.Sealed {
		return errors.New("Vault is still sealed after submitting the key — it does not match this storage")
	}
	return nil
}

func (v *vaultAPI) EnableKV(ctx context.Context, root, mount string) error {
	code, body, err := v.do(ctx, http.MethodPost, "/v1/sys/mounts/"+mount, root, map[string]any{
		"type":    "kv",
		"options": map[string]string{"version": "2"},
	})
	if err != nil {
		return err
	}
	// 400 with "path is already in use" is the re-run case — Vault has no idempotent mount call.
	if code == http.StatusNoContent || code == http.StatusOK {
		return nil
	}
	if code == http.StatusBadRequest && strings.Contains(string(body), "already in use") {
		return nil
	}
	return fmt.Errorf("unexpected status %d: %s", code, strings.TrimSpace(string(body)))
}

// PutSecret writes under the pinned `value` field — the convention a secret-kind binding's
// ExternalSecret reads via remoteRef.property (manifests.RenderSecretBindingExternalSecret).
func (v *vaultAPI) PutSecret(ctx context.Context, root, mount, name, value string) error {
	code, body, err := v.do(ctx, http.MethodPost,
		fmt.Sprintf("/v1/%s/data/%s", mount, name), root,
		map[string]any{"data": map[string]string{"value": value}})
	if err != nil {
		return err
	}
	if code != http.StatusOK && code != http.StatusNoContent {
		return fmt.Errorf("unexpected status %d: %s", code, strings.TrimSpace(string(body)))
	}
	return nil
}

// EnsureESOToken creates a READ-ONLY policy over the mount and mints a token bound to it.
//
// Read-only and mount-scoped on purpose: this token lives in a Secret the operator can read, so it
// must not be able to write, delete, or reach sys/. A periodic token renews itself through ESO's
// use rather than expiring mid-deploy.
func (v *vaultAPI) EnsureESOToken(ctx context.Context, root, policy, mount string) (string, error) {
	rules := fmt.Sprintf(`path "%s/data/*" { capabilities = ["read"] }
path "%s/metadata/*" { capabilities = ["read", "list"] }`, mount, mount)
	code, body, err := v.do(ctx, http.MethodPut, "/v1/sys/policies/acl/"+policy, root,
		map[string]any{"policy": rules})
	if err != nil {
		return "", err
	}
	if code != http.StatusNoContent && code != http.StatusOK {
		return "", fmt.Errorf("write policy: unexpected status %d: %s", code, strings.TrimSpace(string(body)))
	}
	code, body, err = v.do(ctx, http.MethodPost, "/v1/auth/token/create", root, map[string]any{
		"policies":  []string{policy},
		"period":    "768h",
		"renewable": true,
		"no_parent": true,
	})
	if err != nil {
		return "", err
	}
	if code != http.StatusOK {
		return "", fmt.Errorf("create token: unexpected status %d: %s", code, strings.TrimSpace(string(body)))
	}
	var out struct {
		Auth struct {
			ClientToken string `json:"client_token"`
		} `json:"auth"`
	}
	if uErr := json.Unmarshal(body, &out); uErr != nil {
		return "", fmt.Errorf("decode token: %w", uErr)
	}
	return out.Auth.ClientToken, nil
}

func (v *vaultAPI) RevokeSelf(ctx context.Context, token string) error {
	code, body, err := v.do(ctx, http.MethodPost, "/v1/auth/token/revoke-self", token, nil)
	if err != nil {
		return err
	}
	if code != http.StatusNoContent && code != http.StatusOK {
		return fmt.Errorf("unexpected status %d: %s", code, strings.TrimSpace(string(body)))
	}
	return nil
}
