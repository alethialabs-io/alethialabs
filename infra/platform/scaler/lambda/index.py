import boto3
import json
import os
import urllib.request

SUPABASE_URL = os.environ['SUPABASE_URL']
SUPABASE_KEY = os.environ['SUPABASE_SERVICE_ROLE_KEY']
WORKERS = json.loads(os.environ['WORKERS'])
IDLE_THRESHOLD = 5

idle_counts = {}


def handler(event, context):
    queued = count_queued_jobs()

    for w in WORKERS:
        region = w['region']
        cluster = w['cluster']
        service = w['service']

        ecs = boto3.client('ecs', region_name=region)
        resp = ecs.describe_services(cluster=cluster, services=[service])
        current = resp['services'][0]['desiredCount'] if resp['services'] else 0

        key = f"{region}/{cluster}/{service}"

        if queued > 0 and current == 0:
            print(f"Scaling UP {key}: {queued} queued jobs")
            ecs.update_service(cluster=cluster, service=service, desiredCount=1)
            idle_counts[key] = 0
        elif queued == 0 and current > 0:
            idle_counts[key] = idle_counts.get(key, 0) + 1
            if idle_counts[key] >= IDLE_THRESHOLD:
                print(f"Scaling DOWN {key}: idle for {IDLE_THRESHOLD} checks")
                ecs.update_service(cluster=cluster, service=service, desiredCount=0)
            else:
                print(f"Idle check {idle_counts[key]}/{IDLE_THRESHOLD} for {key}")
        else:
            idle_counts[key] = 0

    return {'queued': queued}


def count_queued_jobs():
    url = f"{SUPABASE_URL}/rest/v1/provision_jobs?status=eq.QUEUED&select=id"
    req = urllib.request.Request(url, headers={
        'apikey': SUPABASE_KEY,
        'Authorization': f'Bearer {SUPABASE_KEY}',
        'Prefer': 'count=exact',
    })
    with urllib.request.urlopen(req) as resp:
        count = resp.headers.get('content-range', '*/0').split('/')[-1]
        return int(count) if count != '*' else 0
