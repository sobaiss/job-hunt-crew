"""The judgement `make verify-sites` passes on a live answer, and the result
counts it reads off each site. The live command itself is never run here
(#209): these are the parts whose mistake would make it lie.
"""

from ingestion.site_verification import (
    Count,
    Verdict,
    france_travail_count,
    hellowork_count,
    judge,
    linkedin_count,
    linkedin_offers,
)


def test_a_filter_the_adapter_does_not_send_is_not_honoured():
    verdict, detail = judge(Count(100), None, sent=False)
    assert verdict is Verdict.NOT_HONOURED
    assert "sends nothing" in detail


def test_a_rejected_parameter_is_not_honoured_whatever_the_counts():
    verdict, detail = judge(
        Count(100), None, sent=True, rejection="Valeur du paramètre « commune » incorrecte."
    )
    assert verdict is Verdict.NOT_HONOURED
    assert "commune" in detail


def test_fewer_results_with_the_filter_means_honoured():
    assert judge(Count(1030), Count(424), sent=True)[0] is Verdict.HONOURED


def test_the_same_count_means_the_site_ignored_the_filter():
    assert judge(Count(3285), Count(3285), sent=True)[0] is Verdict.NOT_HONOURED


def test_more_results_with_the_filter_cannot_tell():
    # A filter never widens a search, so more offers means the site answered
    # a different search — LinkedIn pads a thin one — or the listing moved.
    assert judge(Count(992), Count(5000, at_least=True), sent=True)[0] is (
        Verdict.COULD_NOT_TELL
    )


def test_two_capped_counts_that_agree_cannot_tell():
    verdict, _ = judge(Count(9000, at_least=True), Count(9000, at_least=True), sent=True)
    assert verdict is Verdict.COULD_NOT_TELL


def test_two_capped_counts_over_the_very_same_offers_are_not_honoured():
    verdict, detail = judge(
        Count(1000, at_least=True), Count(1000, at_least=True), sent=True, same_offers=True
    )
    assert verdict is Verdict.NOT_HONOURED
    assert "same offers" in detail


def test_capped_counts_that_differ_still_show_the_filter():
    verdict, _ = judge(Count(9000, at_least=True), Count(5000, at_least=True), sent=True)
    assert verdict is Verdict.HONOURED


def test_an_empty_search_is_reported_as_empty_not_as_an_error():
    assert judge(Count(0), Count(0), sent=True)[0] is Verdict.EMPTY
    assert judge(Count(120), Count(0), sent=True)[0] is Verdict.EMPTY


def test_an_unreadable_count_cannot_tell():
    assert judge(Count(100), None, sent=True)[0] is Verdict.COULD_NOT_TELL
    assert judge(None, Count(100), sent=True)[0] is Verdict.COULD_NOT_TELL


def test_hellowork_count_reads_the_heading():
    html = '<h1 class="typo-l-bold">\n  1&#x202F;030 offres\n</h1>'
    assert hellowork_count(html) == Count(1030)
    assert hellowork_count("<h1>0 offre</h1>") == Count(0)
    assert hellowork_count("<html>no heading</html>") is None


def test_linkedin_count_reads_a_capped_count_as_a_lower_bound():
    capped = '<span class="results-context-header__job-count">Plus de 9 000</span>'
    exact = '<span class="results-context-header__job-count">174</span>'
    assert linkedin_count(capped) == Count(9000, at_least=True)
    assert linkedin_count(exact) == Count(174)
    assert linkedin_count("<html></html>") is None


def test_france_travail_count_reads_content_range():
    assert france_travail_count(206, "offres 0-149/3285") == Count(3285)
    assert france_travail_count(204, "*/0") == Count(0)
    assert france_travail_count(200, None) is None


def test_linkedin_offers_ignore_the_per_request_tracking_parameters():
    first = '<a href="https://fr.linkedin.com/jobs/view/dev-at-acme-123?refId=a&trackingId=b">'
    again = '<a href="https://fr.linkedin.com/jobs/view/dev-at-acme-123?refId=c&trackingId=d">'
    assert linkedin_offers(first) == linkedin_offers(again) == frozenset(
        {"jobs/view/dev-at-acme-123"}
    )
