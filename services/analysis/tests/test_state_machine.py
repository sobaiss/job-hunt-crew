import json

from analysis.state_machine import render_definition


def test_render_definition_substitutes_function_arns():
    definition = json.loads(
        render_definition(
            ensure_cv_parsed_arn="arn:aws:lambda:us-east-1:1:function:cv",
            ensure_offer_extracted_arn="arn:aws:lambda:us-east-1:1:function:offer",
            run_comparison_crew_arn="arn:aws:lambda:us-east-1:1:function:crew",
        )
    )

    assert definition["StartAt"] == "EnsureCVParsed"
    assert definition["States"]["EnsureCVParsed"]["Resource"] == "arn:aws:lambda:us-east-1:1:function:cv"
    assert definition["States"]["EnsureCVParsed"]["Next"] == "EnsureOfferExtracted"
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


def test_render_definition_defaults_to_local_lambda_shim_arns():
    definition = json.loads(render_definition())

    assert definition["States"]["EnsureCVParsed"]["Resource"].endswith(":function:ensure-cv-parsed")
    assert definition["States"]["EnsureOfferExtracted"]["Resource"].endswith(
        ":function:ensure-offer-extracted"
    )
    assert definition["States"]["RunComparisonCrew"]["Parameters"]["FunctionName"].endswith(
        ":function:run-comparison-crew"
    )
