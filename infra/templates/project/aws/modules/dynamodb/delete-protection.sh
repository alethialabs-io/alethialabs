#!/bin/sh
set -e

CREDENTIALS=$(aws sts assume-role \
  --role-arn $IAM_ROLE \
  --role-session-name "dynamodb-cli" \
  --query "[Credentials.AccessKeyId,Credentials.SecretAccessKey,Credentials.SessionToken]" \
  --output text)

unset AWS_PROFILE
export AWS_ACCESS_KEY_ID=$(echo $CREDENTIALS | awk '{print $1}')
export AWS_SECRET_ACCESS_KEY=$(echo $CREDENTIALS | awk '{print $2}')
export AWS_SESSION_TOKEN=$(echo $CREDENTIALS | awk '{print $3}')

aws sts get-caller-identity
echo "Assumed IAM Role used by the terraform itself $IAM_ROLE"

for replica in $REPLICAS
do
    for run in {1..20}; do
        TABLE_STATUS=$(aws dynamodb describe-table --table-name $TABLE_NAME --region $replica --query "Table.TableStatus" --output text)
        if [[ $TABLE_STATUS == "ACTIVE" ]]; then
            break
        fi
        sleep 10
    done
    if [[ $TABLE_STATUS != "ACTIVE" ]]; then
        echo "Table \"$TABLE_NAME\" in region \"$replica\" seem to be in state that doesn't allow to be updated. Please try later.\nCurrent Status: $TABLE_STATUS"
        exit 1
    fi
    CURRENT_DELETION_PROTECTION_STATUS=$(aws dynamodb describe-table --table-name $TABLE_NAME --region $replica --query "Table.DeletionProtectionEnabled")
    if [[ $CURRENT_DELETION_PROTECTION_STATUS != $DELETION_PROTECTION_ENABLED ]]; then
        echo "CURRENT_DELETION_PROTECTION_STATUS:$CURRENT_DELETION_PROTECTION_STATUS does not match the intended value \"$DELETION_PROTECTION_ENABLED\" on table \"$TABLE_NAME\" in region \"$replica\" updating.."
        if [[ $DELETION_PROTECTION_ENABLED == true ]]
        then
            echo "Enabled deletion protection in table $TABLE_NAME in region $replica"
            aws dynamodb update-table --table-name $TABLE_NAME --region $replica --deletion-protection-enabled >/dev/null
        else
            echo "Disabled deletion protection in table $TABLE_NAME in region $replica"
            aws dynamodb update-table --table-name $TABLE_NAME --region $replica --no-deletion-protection-enabled >/dev/null
        fi
    else
        echo "CURRENT_DELETION_PROTECTION_STATUS:$CURRENT_DELETION_PROTECTION_STATUS matches the intended value \"$DELETION_PROTECTION_ENABLED\" on table \"$TABLE_NAME\" in region \"$replica\", no changes required."
    fi
done
