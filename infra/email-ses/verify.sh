#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Verifies the live SES stack end-to-end: DKIM is verified, a real send returns a
# MessageId, and simulator bounce/complaint sends actually surface as Bounce /
# Complaint events on the configuration set → SNS path. The event check captures
# off SNS via a throwaway SQS queue, so it does NOT need the console webhook to be
# deployed — and asserts exactly the signal the app's /api/webhooks/ses handler
# turns into suppression rows. (The SES simulator never touches SES's own
# suppression list, so this SNS capture is the meaningful assertion.)
#
# Run with admin creds for the SES account, or as the scoped `alethia-ses-spike`
# user (iam.tf grants it the SES send + SNS subscribe + SQS perms this needs).
#
#   export AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=...
#   ./verify.sh            # from infra/email-ses (reads `tofu output`), or
#   SES_EVENTS_TOPIC_ARN=arn:aws:sns:eu-central-1:270587882865:alethia-ses-events ./verify.sh
set -euo pipefail

AWS_REGION="${AWS_REGION:-eu-central-1}"
export AWS_DEFAULT_REGION="$AWS_REGION"
DOMAIN="${DOMAIN:-alethialabs.io}"
AUTH_IDENTITY="auth.${DOMAIN}"
GENERAL_IDENTITY="mail.${DOMAIN}"
AUTH_FROM="${AUTH_FROM:-no-reply@${AUTH_IDENTITY}}"
GENERAL_FROM="${GENERAL_FROM:-hello@${GENERAL_IDENTITY}}"
CONFIG_SET_AUTH="${CONFIG_SET_AUTH:-alethia-auth}"
CONFIG_SET_GENERAL="${CONFIG_SET_GENERAL:-alethia-general}"
POLL_SECONDS="${POLL_SECONDS:-150}"

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
info()  { printf '\033[36m• %s\033[0m\n' "$*"; }

command -v aws >/dev/null || { red "aws CLI not found"; exit 1; }
command -v jq  >/dev/null || { red "jq not found"; exit 1; }
aws sts get-caller-identity >/dev/null || { red "no valid AWS credentials"; exit 1; }

# Resolve the events topic ARN (env wins, else tofu output from this dir).
TOPIC_ARN="${SES_EVENTS_TOPIC_ARN:-}"
if [[ -z "$TOPIC_ARN" ]] && command -v tofu >/dev/null; then
  TOPIC_ARN="$(tofu output -raw events_topic_arn 2>/dev/null || true)"
fi
[[ -n "$TOPIC_ARN" ]] || { red "set SES_EVENTS_TOPIC_ARN (or run from the stack dir after apply)"; exit 1; }

fail=0

# ── 1. DKIM verified + sending enabled ───────────────────────────────────────
for id in "$AUTH_IDENTITY" "$GENERAL_IDENTITY"; do
  out="$(aws sesv2 get-email-identity --email-identity "$id" \
    --query '{dkim:DkimAttributes.Status,sending:VerifiedForSendingStatus}' --output json 2>/dev/null || echo '{}')"
  dkim="$(jq -r '.dkim // "MISSING"' <<<"$out")"
  sending="$(jq -r '.sending // false' <<<"$out")"
  if [[ "$dkim" == "SUCCESS" && "$sending" == "true" ]]; then
    green "DKIM ✓ $id (verified, sending enabled)"
  else
    red "DKIM ✗ $id (dkim=$dkim sending=$sending)"; fail=1
  fi
done

# ── 2. Deliverability: a real send returns a MessageId ───────────────────────
msg_id="$(aws sesv2 send-email \
  --from-email-address "$AUTH_FROM" \
  --destination "ToAddresses=success@simulator.amazonses.com" \
  --configuration-set-name "$CONFIG_SET_AUTH" \
  --content 'Simple={Subject={Data=ses verify,Charset=UTF-8},Body={Text={Data=ok,Charset=UTF-8}}}' \
  --query MessageId --output text 2>/dev/null || true)"
if [[ -n "$msg_id" && "$msg_id" != "None" ]]; then
  green "send ✓ MessageId=$msg_id"
else
  red "send ✗ (no MessageId — sandbox? unverified from-address?)"; fail=1
fi

# ── 3. Events → SNS capture (throwaway SQS queue) ────────────────────────────
QUEUE_NAME="alethia-ses-verify-$$"
QURL=""; SUB_ARN=""
cleanup() {
  [[ -n "$SUB_ARN" && "$SUB_ARN" == arn:* ]] && aws sns unsubscribe --subscription-arn "$SUB_ARN" 2>/dev/null || true
  [[ -n "$QURL" ]] && aws sqs delete-queue --queue-url "$QURL" 2>/dev/null || true
}
trap cleanup EXIT

info "creating capture queue $QUEUE_NAME"
QURL="$(aws sqs create-queue --queue-name "$QUEUE_NAME" --query QueueUrl --output text)"
QARN="$(aws sqs get-queue-attributes --queue-url "$QURL" --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)"

# Allow the events topic to deliver to this queue.
POLICY="$(jq -nc --arg q "$QARN" --arg t "$TOPIC_ARN" \
  '{Version:"2012-10-17",Statement:[{Effect:"Allow",Principal:{Service:"sns.amazonaws.com"},Action:"sqs:SendMessage",Resource:$q,Condition:{ArnEquals:{"aws:SourceArn":$t}}}]}')"
aws sqs set-queue-attributes --queue-url "$QURL" --attributes "$(jq -nc --arg p "$POLICY" '{Policy:$p}')"

SUB_ARN="$(aws sns subscribe --topic-arn "$TOPIC_ARN" --protocol sqs \
  --notification-endpoint "$QARN" --attributes RawMessageDelivery=false \
  --return-subscription-arn --output text)"
info "subscribed $SUB_ARN"

info "sending simulator bounce + complaint"
aws sesv2 send-email --from-email-address "$AUTH_FROM" \
  --destination "ToAddresses=bounce@simulator.amazonses.com" \
  --configuration-set-name "$CONFIG_SET_AUTH" \
  --content 'Simple={Subject={Data=bounce,Charset=UTF-8},Body={Text={Data=x,Charset=UTF-8}}}' \
  --query MessageId --output text >/dev/null
aws sesv2 send-email --from-email-address "$GENERAL_FROM" \
  --destination "ToAddresses=complaint@simulator.amazonses.com" \
  --configuration-set-name "$CONFIG_SET_GENERAL" \
  --content 'Simple={Subject={Data=complaint,Charset=UTF-8},Body={Text={Data=x,Charset=UTF-8}}}' \
  --query MessageId --output text >/dev/null

info "waiting up to ${POLL_SECONDS}s for events…"
seen_bounce=0; seen_complaint=0
deadline=$(( SECONDS + POLL_SECONDS ))
while (( SECONDS < deadline )); do
  msgs="$(aws sqs receive-message --queue-url "$QURL" --max-number-of-messages 10 \
    --wait-time-seconds 20 --output json 2>/dev/null || echo '{}')"
  count="$(jq '.Messages | length // 0' <<<"$msgs")"
  (( count == 0 )) && continue
  while IFS= read -r row; do
    body="$(jq -r '.Body' <<<"$row")"
    etype="$(jq -r '(.Message | fromjson) | (.eventType // .notificationType // "")' <<<"$body" 2>/dev/null || echo "")"
    case "$etype" in
      Bounce)    seen_bounce=1;    info "← Bounce event" ;;
      Complaint) seen_complaint=1; info "← Complaint event" ;;
    esac
    rh="$(jq -r '.ReceiptHandle' <<<"$row")"
    aws sqs delete-message --queue-url "$QURL" --receipt-handle "$rh" 2>/dev/null || true
  done < <(jq -c '.Messages[]' <<<"$msgs")
  (( seen_bounce && seen_complaint )) && break
done

if (( seen_bounce && seen_complaint )); then
  green "events ✓ Bounce + Complaint captured on SNS"
else
  red "events ✗ (bounce=$seen_bounce complaint=$seen_complaint within ${POLL_SECONDS}s)"; fail=1
fi

echo
if (( fail == 0 )); then green "SES verification PASSED"; else red "SES verification FAILED"; fi
exit "$fail"
