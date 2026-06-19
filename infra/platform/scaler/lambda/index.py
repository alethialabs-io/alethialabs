import boto3
import json
import os
import urllib.request

API_SECRET = os.environ['ALETHIA_API_SECRET']
RUNNERS = json.loads(os.environ['RUNNERS'])
IDLE_THRESHOLD = 5

idle_counts = {}


def handler(event, context):
    for w in RUNNERS:
        region = w['region']
        cluster = w['cluster']
        service = w['service']
        alethia_url = w['alethia_url']

        # Each runner owns its own console + DB; ask it for its own queue depth.
        # The probe also requeues stale jobs server-side (recover_stale_jobs).
        stats = queue_stats(alethia_url)
        queued = stats.get('queued', 0)
        recovered = stats.get('recovered', 0)
        if recovered > 0:
            print(f"Recovered {recovered} stale job(s) on {alethia_url}")

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

    return {'ok': True}


def queue_stats(alethia_url):
    """Ask a runner's console for its queue depth (and requeue stale jobs).

    Returns {"recovered": int, "queued": int}; on any error returns zeros so a
    single unreachable runner never blocks scaling decisions for the others.
    """
    url = f"{alethia_url}/api/platform/queue"
    req = urllib.request.Request(
        url,
        data=b'{}',
        headers={
            'Authorization': f'Bearer {API_SECRET}',
            'Content-Type': 'application/json',
        },
        method='POST',
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            body = json.loads(resp.read())
            return {
                'recovered': int(body.get('recovered', 0)),
                'queued': int(body.get('queued', 0)),
            }
    except Exception as e:
        print(f"Warning: queue_stats failed for {alethia_url}: {e}")
        return {'recovered': 0, 'queued': 0}
