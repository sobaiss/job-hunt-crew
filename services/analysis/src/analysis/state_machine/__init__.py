"""AnalysisWorkflow Step Functions state machine (PRD Section 10 steps 3-7, M5-T2).

The ASL definition lives in analysis_workflow.asl.json (the state machine's
own definition, not IaC/provisioning — creating the actual AWS resource,
IAM role, etc. is out of this PRD's scope per Section 4/15). This module
renders that template with the 3 task Lambdas' ARNs and manages the state
machine's lifecycle against whatever `stepfunctions` endpoint is configured
(AWS in production, Step Functions Local for dev/tests).
"""

import json
import os
from importlib import resources

import boto3

STATE_MACHINE_NAME = "AnalysisWorkflow"

DEFAULT_ROLE_ARN = "arn:aws:iam::123456789012:role/AnalysisWorkflowRole"

# Local-dev defaults: `analysis.lambda_shim` (the local stand-in for real
# deployed Lambda functions, dispatching by the ARN's function-name suffix)
# resolves these exact names.
DEFAULT_ENSURE_CV_CONVERTED_ARN = (
    "arn:aws:lambda:us-east-1:123456789012:function:ensure-cv-converted"
)
DEFAULT_ENSURE_CV_PARSED_ARN = "arn:aws:lambda:us-east-1:123456789012:function:ensure-cv-parsed"
DEFAULT_ENSURE_OFFER_EXTRACTED_ARN = (
    "arn:aws:lambda:us-east-1:123456789012:function:ensure-offer-extracted"
)
DEFAULT_RUN_COMPARISON_CREW_ARN = (
    "arn:aws:lambda:us-east-1:123456789012:function:run-comparison-crew"
)
DEFAULT_MARK_ANALYSIS_FAILED_ARN = (
    "arn:aws:lambda:us-east-1:123456789012:function:mark-analysis-failed"
)


def render_definition(
    *,
    ensure_cv_converted_arn: str | None = None,
    ensure_cv_parsed_arn: str | None = None,
    ensure_offer_extracted_arn: str | None = None,
    run_comparison_crew_arn: str | None = None,
    mark_analysis_failed_arn: str | None = None,
) -> str:
    """Renders analysis_workflow.asl.json with the 3 task Lambdas' ARNs
    substituted in, returning the ASL definition as a JSON string (the shape
    CreateStateMachine's `definition` parameter expects). ARNs default to
    env vars (ENSURE_CV_PARSED_FUNCTION_ARN / ENSURE_OFFER_EXTRACTED_FUNCTION_ARN
    / RUN_COMPARISON_CREW_FUNCTION_ARN), falling back to the local-dev Lambda
    shim's fixed ARNs.

    Uses plain string replacement rather than Python's string.Template: the
    ASL file's own JSONPaths (`$.analysisId`, `$$.Task.Token`) already use
    `$`, which would collide with Template's `$`-based placeholder syntax.
    """
    template_text = resources.files(__package__).joinpath("analysis_workflow.asl.json").read_text()
    rendered = (
        template_text.replace(
            "__ENSURE_CV_CONVERTED_FUNCTION_ARN__",
            ensure_cv_converted_arn
            or os.environ.get(
                "ENSURE_CV_CONVERTED_FUNCTION_ARN", DEFAULT_ENSURE_CV_CONVERTED_ARN
            ),
        )
        .replace(
            "__ENSURE_CV_PARSED_FUNCTION_ARN__",
            ensure_cv_parsed_arn
            or os.environ.get("ENSURE_CV_PARSED_FUNCTION_ARN", DEFAULT_ENSURE_CV_PARSED_ARN),
        )
        .replace(
            "__ENSURE_OFFER_EXTRACTED_FUNCTION_ARN__",
            ensure_offer_extracted_arn
            or os.environ.get(
                "ENSURE_OFFER_EXTRACTED_FUNCTION_ARN", DEFAULT_ENSURE_OFFER_EXTRACTED_ARN
            ),
        )
        .replace(
            "__RUN_COMPARISON_CREW_FUNCTION_ARN__",
            run_comparison_crew_arn
            or os.environ.get(
                "RUN_COMPARISON_CREW_FUNCTION_ARN", DEFAULT_RUN_COMPARISON_CREW_ARN
            ),
        )
        .replace(
            "__MARK_ANALYSIS_FAILED_FUNCTION_ARN__",
            mark_analysis_failed_arn
            or os.environ.get(
                "MARK_ANALYSIS_FAILED_FUNCTION_ARN", DEFAULT_MARK_ANALYSIS_FAILED_ARN
            ),
        )
    )
    # Round-trip through json to fail fast on a malformed template rather than
    # handing CreateStateMachine invalid JSON.
    json.loads(rendered)
    return rendered


def make_sfn_client():
    return boto3.client(
        "stepfunctions",
        endpoint_url=os.environ.get("SFN_ENDPOINT") or None,
        region_name=os.environ.get("SFN_REGION", "us-east-1"),
        aws_access_key_id=os.environ.get("SFN_ACCESS_KEY_ID") or None,
        aws_secret_access_key=os.environ.get("SFN_SECRET_ACCESS_KEY") or None,
    )


def ensure_state_machine(
    client=None,
    *,
    name: str = STATE_MACHINE_NAME,
    definition: str | None = None,
    role_arn: str = DEFAULT_ROLE_ARN,
) -> str:
    """Idempotently ensures the AnalysisWorkflow state machine exists on the
    configured `stepfunctions` endpoint, returning its ARN. Used by local
    dev/test setup; a real deployment provisions the state machine as part
    of infra rollout (out of this PRD's scope), not by calling this at
    runtime.
    """
    sfn = client or make_sfn_client()
    body = definition or render_definition()
    try:
        response = sfn.create_state_machine(name=name, definition=body, roleArn=role_arn)
        return response["stateMachineArn"]
    except sfn.exceptions.StateMachineAlreadyExists:
        for machine in sfn.list_state_machines()["stateMachines"]:
            if machine["name"] == name:
                sfn.update_state_machine(
                    stateMachineArn=machine["stateMachineArn"], definition=body
                )
                return machine["stateMachineArn"]
        raise
