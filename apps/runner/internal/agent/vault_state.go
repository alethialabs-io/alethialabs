// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
)

// Cluster-side storage for the in-cluster Vault's unseal key and ESO token (#2432).
//
// These NEVER pass through argv and are never logged. Reads go through `kubectl get -o jsonpath`;
// writes go through `kubectl apply -f <0600 temp file>` — the same shape registry_token.go uses for
// the pull secret, and for the same reason: argv is world-readable through /proc.

// randomToken returns n bytes of entropy, URL-safe base64 encoded.
func randomToken(n int) (string, error) {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

// kubeSecretStore reads and writes one Opaque Secret through kubectl.
type kubeSecretStore struct {
	namespace string
	name      string
}

// Read returns the Secret's decoded data, or an EMPTY map when it does not exist.
//
// A missing Secret is the first run, not a failure. Distinguishing the two matters more here than
// anywhere else in this package: "absent" means initialise, while "present" is what stops the
// bootstrap re-initialising a Vault whose storage was lost.
func (k *kubeSecretStore) Read(ctx context.Context) (map[string]string, error) {
	cmd := exec.CommandContext(ctx, "kubectl", "get", "secret", k.name, "-n", k.namespace, "-o", "json")
	var stdout strings.Builder
	cmd.Stdout = &stdout
	cmd.Stderr = io.Discard
	if err := cmd.Run(); err != nil {
		return map[string]string{}, nil
	}
	var out struct {
		Data map[string]string `json:"data"`
	}
	if err := json.Unmarshal([]byte(stdout.String()), &out); err != nil {
		return nil, fmt.Errorf("decode secret %s/%s: %w", k.namespace, k.name, err)
	}
	decoded := make(map[string]string, len(out.Data))
	for key, b64 := range out.Data {
		raw, err := base64.StdEncoding.DecodeString(b64)
		if err != nil {
			return nil, fmt.Errorf("decode %s/%s key %q: %w", k.namespace, k.name, key, err)
		}
		decoded[key] = string(raw)
	}
	return decoded, nil
}

// Write applies the Secret, creating or replacing it.
func (k *kubeSecretStore) Write(ctx context.Context, data map[string]string) error {
	return writeOpaqueSecret(ctx, k.namespace, k.name, data)
}

// writeOpaqueSecret applies an Opaque Secret from a 0600 temp file.
//
// A file, never argv and never a heredoc: `kubectl create secret --from-literal` would put the
// unseal key in the process table, where any other process on the node can read it.
func writeOpaqueSecret(ctx context.Context, namespace, name string, data map[string]string) error {
	if namespace == "" || name == "" {
		return fmt.Errorf("refusing to write a secret with an empty name or namespace (%q/%q)", namespace, name)
	}
	for key, v := range data {
		if v == "" {
			return fmt.Errorf("refusing to write an empty value for %s/%s key %q", namespace, name, key)
		}
	}
	var b strings.Builder
	fmt.Fprintf(&b, "apiVersion: v1\nkind: Secret\nmetadata:\n  name: %s\n  namespace: %s\ntype: Opaque\ndata:\n", name, namespace)
	// Sorted so a re-apply of unchanged data produces an identical document and kubectl reports no
	// change, which keeps the job log readable across deploys.
	for _, key := range sortedKeys(data) {
		fmt.Fprintf(&b, "  %s: %s\n", key, base64.StdEncoding.EncodeToString([]byte(data[key])))
	}

	tmp, err := os.CreateTemp("", "vaultstate-*.yaml")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.WriteString(b.String()); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	cmd := exec.CommandContext(ctx, "kubectl", "apply", "-f", tmp.Name())
	cmd.Stdout = io.Discard
	var stderr strings.Builder
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("kubectl apply failed: %w: %s", err, strings.TrimSpace(stderr.String()))
	}
	return nil
}

// sortedKeys returns a map's keys in a stable order.
func sortedKeys(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j] < out[j-1]; j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out
}
