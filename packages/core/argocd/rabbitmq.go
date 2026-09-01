// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"io"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/alethialabs-io/alethialabs/packages/core/utils"
)

// Credentials for an in-cluster RabbitMQ (a Hetzner `queue` node) — #3304.
//
// Hetzner sells no queue service, so a canvas `queue` node becomes a `cloudpirates/rabbitmq`
// release. Left to itself that chart MINTS both `auth.password` and `auth.erlangCookie` at RENDER
// time, so every render produces a different Secret. Under ArgoCD, where a marketplace-class
// Application runs `automated: {prune: true, selfHeal: true}`, that is not cosmetic: the
// Application is permanently OutOfSync and rewrites both values on every reconcile, forever.
//
// Neither value survives that treatment:
//
//   - the erlang cookie is the cluster's SHARED SECRET. Every node must present the same one;
//     rotating it partitions the cluster and the nodes refuse to re-form.
//   - the password is the credential the customer's `queue` binding already handed to their
//     application. Rotating it invalidates every client that resolved the binding.
//
// So this file is the runner half: the credentials are generated ONCE, here, into a Secret the
// chart only READS (`auth.existingSecret` in hetznerQueueValues). No credential reaches a rendered
// manifest, and none lands in `config_snapshot` — the cluster is the store of record, exactly as it
// is for Harbor's admin password (harbor.go).
//
// The same rule as registry_secrets.go applies to what is written: the Secret carries the
// marketplace labels so PruneAddOnSecrets can remove it when the `queue` node is deleted, but
// deliberately NO ArgoCD tracking metadata. A Secret carrying `app.kubernetes.io/instance` becomes
// a resource the Application OWNS, and an owned resource that is not in the rendered manifest is
// exactly what `prune: true` deletes.

const (
	// hetznerQueueNamespace mirrors the console's NS.queue (hetzner-services.ts). Duplicated rather
	// than imported because Go cannot read the TS mapper, and asserted against the generated fixture
	// by test so it cannot drift silently.
	hetznerQueueNamespace = "queues"
	// rabbitmqPasswordKey / rabbitmqErlangCookieKey are the data keys the chart reads. They pair
	// with `auth.existingPasswordKey` / `auth.existingErlangCookieKey` in the rendered values — the
	// two must agree or the pod starts with an empty credential.
	rabbitmqPasswordKey     = "password"
	rabbitmqErlangCookieKey = "erlang-cookie"
	// rabbitmqCredentialBytes is the entropy of each generated value before encoding.
	rabbitmqCredentialBytes = 24
)

// HetznerQueue is one in-cluster RabbitMQ the runner must credential.
type HetznerQueue struct {
	// Name is the canvas `queue` node's name.
	Name string
	// Namespace is where the RabbitMQ release lives (the console's NS.queue).
	Namespace string
	// AddOnID is the synthesized add-on id the console gave this release (`queue-<name>`). It is
	// what PruneAddOnSecrets matches against the enabled set, so the Secret is swept exactly when
	// the node it belongs to is removed.
	AddOnID string
}

// CredentialSecretName is the Secret holding this queue's password and erlang cookie. It MUST equal
// the `auth.existingSecret` hetznerQueueValues() renders; a mismatch is silent in the manifest and
// surfaces only as a pod that will not start.
func (q HetznerQueue) CredentialSecretName() string { return "rabbitmq-" + q.Name + "-credentials" }

// valid reports whether every interpolated name is a safe RFC-1123 label. Fail-closed: these reach a
// kubectl command line and a rendered manifest, and they arrive via the DB-persisted config
// snapshot.
func (q HetznerQueue) valid() bool {
	return k8sNameRe.MatchString(q.Name) &&
		k8sNameRe.MatchString(q.Namespace) &&
		k8sNameRe.MatchString(q.AddOnID)
}

// HetznerQueues derives the in-cluster queues a deploy must credential.
//
// Hetzner only. Every other cloud provisions a real queue (SQS, Pub/Sub, Service Bus, MNS) whose
// credentials are the cloud's own; there is no chart there and nothing to seed, so returning a
// non-empty list would write Secrets nothing reads.
func HetznerQueues(vc *types.ProjectConfig) []HetznerQueue {
	if vc == nil || vc.Provider != types.CloudProviderHetzner {
		return nil
	}
	out := make([]HetznerQueue, 0, len(vc.Queues))
	for _, q := range vc.Queues {
		queue := HetznerQueue{
			Name:      q.Name,
			Namespace: hetznerQueueNamespace,
			// MUST equal the id hetznerDataServicesToAddOns() gives this release, because that is
			// the id PruneAddOnSecrets sees in the enabled set. A test pins the shape against the
			// generated fixture.
			AddOnID: "queue-" + q.Name,
		}
		if !queue.valid() {
			continue
		}
		out = append(out, queue)
	}
	return out
}

// EnsureQueueCredentialSecret creates a queue's credential Secret if it does not already exist, and
// leaves an existing one completely alone.
//
// CREATE-ONCE, NOT APPLY-EVERY-DEPLOY, and the difference is the whole point. EnsureAddOnSecrets
// re-applies on every deploy because the values it writes come from the database and a rotation
// there SHOULD reach the cluster. These values exist nowhere but here: re-generating them would
// hand a running RabbitMQ a new erlang cookie, which partitions the cluster, and a new password,
// which every client that resolved the binding is still using.
func EnsureQueueCredentialSecret(q HetznerQueue, stdout, stderr io.Writer) error {
	if !q.valid() {
		return fmt.Errorf("refusing to seed credentials for invalid queue %q/%q", q.Namespace, q.Name)
	}
	name := q.CredentialSecretName()
	// `kubectl get` decides idempotency. `create --dry-run | apply` would also be idempotent in the
	// "no error" sense and would REPLACE both values every deploy, which is the partition above.
	if err := utils.ExecuteCommand(
		fmt.Sprintf("kubectl get secret %s -n %s", name, q.Namespace),
		".", nil, io.Discard, io.Discard,
	); err == nil {
		fmt.Fprintf(stdout, "Queue credential secret %s/%s already exists; leaving it in place\n", q.Namespace, name)
		return nil
	}
	// ADOPT BEFORE GENERATING. On a cluster that deployed before this change the chart minted its
	// own Secret, and the chart marks it `helm.sh/resource-policy: keep` — so it is still there
	// after the chart stops rendering it. Generating fresh values here would hand a RUNNING
	// RabbitMQ a new erlang cookie and a new password: exactly the one-time breakage this whole
	// change exists to prevent, delivered by the fix itself. Carrying the live values across makes
	// the migration invisible.
	password, cookie, adopted := adoptChartMintedQueueCredentials(q, stderr)
	if adopted {
		fmt.Fprintf(stdout, "Adopting the chart-minted credentials for %s into %s/%s (no rotation)...\n",
			q.Name, q.Namespace, name)
	} else {
		var err error
		if password, err = rabbitmqCredential(); err != nil {
			return fmt.Errorf("generate RabbitMQ password for %s: %w", q.Name, err)
		}
		if cookie, err = rabbitmqCredential(); err != nil {
			return fmt.Errorf("generate RabbitMQ erlang cookie for %s: %w", q.Name, err)
		}
		fmt.Fprintf(stdout, "Seeding queue credential secret %s/%s...\n", q.Namespace, name)
	}
	// The credentials ride a 0600 temporary manifest into `kubectl apply -f <file>`, never argv.
	return ApplyManifest(queueCredentialSecretManifest(q, password, cookie), stdout, stderr)
}

// adoptChartMintedQueueCredentials returns the password and erlang cookie a PREVIOUS release of
// this queue's chart minted for itself, when both are still readable.
//
// Found by the chart's own release label rather than by a derived name, for the reason
// data_endpoints.go states: every chart names its Secrets with its own `fullname` template, so a
// derived name is a guess, and a guess that misses here silently rotates a live cluster's cookie.
//
// BOTH OR NEITHER. Half a pair is not a migration — adopting the password while generating a new
// cookie still partitions the cluster, and it would do so while reporting that nothing rotated.
// Harbor's completeHarborCredentials refuses a half pair for the same reason.
//
// The lookup is RELIABLE rather than lucky, and the ordering in deploy.go is why: this runs before
// ApplyAddOnsInWaves, so on the one deploy where adoption matters the old render — and its Secret —
// is still what the cluster is running. (ArgoCD honours the chart's `resource-policy: keep`, but
// nothing here depends on that.)
//
// Best-effort by contract: no old Secret, an unreadable one, or a partial one all mean "generate",
// which is the correct answer for a queue that has never deployed. The values are read into memory
// and rendered into a 0600 manifest; they are never logged (kubectlJSON captures stdout rather
// than echoing it, which is what keeps a Secret listing out of the job log).
func adoptChartMintedQueueCredentials(q HetznerQueue, stderr io.Writer) (password, cookie string, ok bool) {
	release := AddOnAppName(q.AddOnID)
	if !k8sNameRe.MatchString(release) {
		return "", "", false
	}
	var list struct {
		Items []struct {
			Metadata struct {
				Name string `json:"name"`
			} `json:"metadata"`
			Type string            `json:"type"`
			Data map[string]string `json:"data"`
		} `json:"items"`
	}
	cmd := fmt.Sprintf("kubectl get secret -n %s -l app.kubernetes.io/instance=%s -o json", q.Namespace, release)
	if err := kubectlJSON(cmd, &list, stderr); err != nil {
		return "", "", false
	}
	for _, item := range list.Items {
		// Helm's own release secrets are not credentials.
		if item.Type == "helm.sh/release.v1" {
			continue
		}
		pw, pwOK := decodeSecretValue(item.Data[rabbitmqPasswordKey])
		ck, ckOK := decodeSecretValue(item.Data[rabbitmqErlangCookieKey])
		if pwOK && ckOK {
			return pw, ck, true
		}
	}
	return "", "", false
}

// decodeSecretValue decodes one base64 Secret value, reporting whether it held anything.
func decodeSecretValue(encoded string) (string, bool) {
	if encoded == "" {
		return "", false
	}
	raw, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil || len(raw) == 0 {
		return "", false
	}
	return string(raw), true
}

// rabbitmqRandReader is the entropy source, swappable so the failure path is testable. A credential
// generated from a failed reader must never be emitted: falling back to something weaker is how a
// "random" secret becomes guessable, and nothing downstream would notice.
var rabbitmqRandReader io.Reader = rand.Reader

// rabbitmqCredential returns one URL-safe credential.
//
// URL-safe rather than raw base64 because the password reaches applications through an AMQP URI,
// where a `+` or a `/` would have to be percent-encoded by every client that builds one.
func rabbitmqCredential() (string, error) {
	buf := make([]byte, rabbitmqCredentialBytes)
	if _, err := io.ReadFull(rabbitmqRandReader, buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

// queueCredentialSecretManifest renders the namespace + the credential Secret.
//
// The namespace is included (like addonSecretManifest and harborAdminSecretManifest) because this
// Secret must exist BEFORE the queue's Application first syncs and creates the namespace itself
// via CreateNamespace=true.
func queueCredentialSecretManifest(q HetznerQueue, password, cookie string) string {
	b64 := base64.StdEncoding.EncodeToString
	return fmt.Sprintf(`apiVersion: v1
kind: Namespace
metadata:
  name: %[1]s
---
apiVersion: v1
kind: Secret
metadata:
  name: %[2]s
  namespace: %[1]s
  labels:
    alethia.io/managed-by: addon-marketplace
    %[3]s: %[4]s
type: Opaque
data:
  %[5]s: %[6]s
  %[7]s: %[8]s
`,
		q.Namespace,              // 1
		q.CredentialSecretName(), // 2
		addonSecretLabelKey,      // 3
		q.AddOnID,                // 4
		rabbitmqPasswordKey,      // 5
		b64([]byte(password)),    // 6
		rabbitmqErlangCookieKey,  // 7
		b64([]byte(cookie)),      // 8
	)
}
