import os

os.environ.setdefault("DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/job_hunt_crew?schema=public")
os.environ.setdefault("S3_ENDPOINT", "http://localhost:9000")
os.environ.setdefault("S3_REGION", "us-east-1")
os.environ.setdefault("S3_BUCKET", "job-hunt-crew")
os.environ.setdefault("S3_FORCE_PATH_STYLE", "true")
os.environ.setdefault("S3_ACCESS_KEY_ID", "minioadmin")
os.environ.setdefault("S3_SECRET_ACCESS_KEY", "minioadmin")
os.environ.setdefault("SFN_ENDPOINT", "http://localhost:8083")
os.environ.setdefault("SFN_REGION", "us-east-1")
os.environ.setdefault("SFN_ACCESS_KEY_ID", "local")
os.environ.setdefault("SFN_SECRET_ACCESS_KEY", "local")
