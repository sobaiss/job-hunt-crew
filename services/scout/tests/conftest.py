import os

os.environ.setdefault(
    "DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/job_hunt_crew?schema=public"
)
os.environ.setdefault("SQS_ENDPOINT", "http://localhost:9324")
os.environ.setdefault("SQS_REGION", "us-east-1")
os.environ.setdefault(
    "SQS_INGESTION_INTAKE_QUEUE_URL", "http://localhost:9324/000000000000/ingestion-intake"
)
os.environ.setdefault(
    "SQS_SCOUT_INTAKE_QUEUE_URL", "http://localhost:9324/000000000000/scout-intake"
)
os.environ.setdefault("SQS_ACCESS_KEY_ID", "x")
os.environ.setdefault("SQS_SECRET_ACCESS_KEY", "x")
