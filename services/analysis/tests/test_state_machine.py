import json

from analysis.state_machine import render_definition


def test_render_definition_substitutes_function_arns():
    definition = json.loads(
        render_definition(
            ensure_cv_converted_arn="arn:aws:lambda:us-east-1:1:function:convert",
            ensure_offer_extracted_arn="arn:aws:lambda:us-east-1:1:function:offer",
            run_comparison_crew_arn="arn:aws:lambda:us-east-1:1:function:crew",
            mark_analysis_failed_arn="arn:aws:lambda:us-east-1:1:function:failed",
        )
    )

    assert definition["StartAt"] == "EnsureCVConverted"
    assert (
        definition["States"]["EnsureCVConverted"]["Resource"]
        == "arn:aws:lambda:us-east-1:1:function:convert"
    )
    assert definition["States"]["EnsureCVConverted"]["Next"] == "EnsureOfferExtracted"
    assert "EnsureCVParsed" not in definition["States"]
    assert (
        definition["States"]["EnsureOfferExtracted"]["Resource"]
        == "arn:aws:lambda:us-east-1:1:function:offer"
    )
    assert definition["States"]["EnsureOfferExtracted"]["Next"] == "RunComparisonCrew"

    run_comparison_crew = definition["States"]["RunComparisonCrew"]
    assert run_comparison_crew["Resource"] == "arn:aws:states:::lambda:invoke.waitForTaskToken"
    assert run_comparison_crew["Parameters"]["FunctionName"] == "arn:aws:lambda:us-east-1:1:function:crew"
    assert run_comparison_crew["Parameters"]["Payload"]["analysisId.$"] == "$.analysisId"
    assert run_comparison_crew["Parameters"]["Payload"]["taskToken.$"] == "$$.Task.Token"
    assert run_comparison_crew["End"] is True

    mark_analysis_failed = definition["States"]["MarkAnalysisFailed"]
    assert mark_analysis_failed["Resource"] == "arn:aws:lambda:us-east-1:1:function:failed"
    assert mark_analysis_failed["Parameters"]["analysisId.$"] == "$.analysisId"
    assert mark_analysis_failed["End"] is True


def test_render_definition_defaults_to_local_lambda_shim_arns():
    definition = json.loads(render_definition())

    assert definition["States"]["EnsureCVConverted"]["Resource"].endswith(
        ":function:ensure-cv-converted"
    )
    assert definition["States"]["EnsureOfferExtracted"]["Resource"].endswith(
        ":function:ensure-offer-extracted"
    )
    assert definition["States"]["RunComparisonCrew"]["Parameters"]["FunctionName"].endswith(
        ":function:run-comparison-crew"
    )
    assert definition["States"]["MarkAnalysisFailed"]["Resource"].endswith(
        ":function:mark-analysis-failed"
    )


def test_render_definition_wires_retry_and_catch_on_every_task_state():
    # M5-T5: PRD Section 10 step 10 — "up to 3 retries with exponential
    # backoff (base 2s)" and a Catch that guarantees no step failure leaves
    # the Analysis stuck.
    definition = json.loads(render_definition())

    for state_name in (
        "EnsureCVConverted",
        "EnsureOfferExtracted",
        "RunComparisonCrew",
    ):
        state = definition["States"][state_name]
        retry = state["Retry"][0]
        assert retry["ErrorEquals"] == ["States.ALL"]
        assert retry["IntervalSeconds"] == 2
        assert retry["MaxAttempts"] == 3
        assert retry["BackoffRate"] == 2.0

        catch = state["Catch"][0]
        assert catch["ErrorEquals"] == ["States.ALL"]
        assert catch["Next"] == "MarkAnalysisFailed"

    assert "Retry" not in definition["States"]["MarkAnalysisFailed"]
