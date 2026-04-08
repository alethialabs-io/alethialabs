import boto3

from modules.dataclasses import *
from modules.logs import LOGS

myLOGS = LOGS()

class AWS:
    profile = None
    session = None
    s3resource = None
    s3client = None

    def __init__(self, profile: str, region: str, dry_run: bool):
        self.profile = profile
        self.dry_run = dry_run
        self.session = boto3.Session(profile_name=self.profile, region_name=region)
        self.s3resource = self.session.resource('s3')
        self.s3client = self.session.client('s3')

    def s3_bucketExists(self, bucketProp: BucketOptions):
        myLOGS.log( "debug", f'Check if bucket exists: {bucketProp.name}' )
        bucket = self.s3resource.Bucket( bucketProp.name )
        if bucket.creation_date:
            return True
        else:
            return False

    def s3_createBucket(self, bucketProp: BucketOptions):
        if self.s3_bucketExists( bucketProp ):
            myLOGS.log("normal", f"Bucket '{bucketProp.name}' already exists.")
            return True

        if self.dry_run:
            myLOGS.log("normal", f"Dry-run mode: Skipping actual creation of bucket '{bucketProp.name}'.")
            return False


        try:
            self.s3resource.create_bucket(
                ACL = bucketProp.acl,
                Bucket = bucketProp.name,
                CreateBucketConfiguration = {
                    'LocationConstraint': bucketProp.region
                },
                ObjectLockEnabledForBucket = bucketProp.objectLockEnabledForBucket,
                ObjectOwnership = bucketProp.objectOwnership
            )
            myLOGS.log("normal", f"Bucket '{bucketProp.name}' created successfully.")
            return True
        except Exception as e:
            myLOGS.log("critical", f"Failed to create bucket '{bucketProp.name}': {str(e)}")
            return False

    def s3_listBucket(self):
        pass

    def s3_getFile(self, bucket: str, object: str, filename: str ):
        with open(filename, 'wb') as f:
            self.s3client.download_fileobj(bucket, object, f)
        f = open(filename, "r")
        return f.readable()

    def s3_checkIfFileExists(self, bucket: str, object: str):
        s3 = boto3.resource('s3')
        bucket = self.s3resource.Bucket(bucket)
        objs = list(bucket.objects.filter(Prefix=object))
        keys = {o.key for o in objs}
        if len(keys):
            return True
        else:
            return False

    def s3_uploadFile(self):
        pass

