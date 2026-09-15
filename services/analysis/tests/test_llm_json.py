import json

import pytest

from analysis.llm_json import parse_llm_json


def test_parse_llm_json_accepts_plain_valid_json():
    assert parse_llm_json('{"a": 1, "b": [1, 2]}') == {"a": 1, "b": [1, 2]}


def test_parse_llm_json_strips_markdown_fence():
    raw = '```json\n{"a": 1}\n```'
    assert parse_llm_json(raw) == {"a": 1}


def test_parse_llm_json_strips_bare_fence_without_json_tag():
    raw = "```\n{\"a\": 1}\n```"
    assert parse_llm_json(raw) == {"a": 1}


def test_parse_llm_json_repairs_dangling_array_closed_with_wrong_bracket():
    # The exact shape hit in production: an Ollama/qwen3.5 response under
    # response_format=json_object that closes a still-open array with "}"
    # instead of "]" and then just stops (see llm_json.py's docstring).
    raw = (
        '{"match_score": 72, "weaknesses": '
        '["Lack of Kubernetes experience", "No AWS certification"}'
    )
    assert parse_llm_json(raw) == {
        "match_score": 72,
        "weaknesses": ["Lack of Kubernetes experience", "No AWS certification"],
    }


def test_parse_llm_json_repairs_truncated_mid_object():
    # Generation cut off entirely mid-value: the array and its string
    # literal are both still open, plus the outer object.
    raw = '{"match_score": 72, "weaknesses": ["Lack of Kubernetes experience'
    assert parse_llm_json(raw) == {
        "match_score": 72,
        "weaknesses": ["Lack of Kubernetes experience"],
    }


def test_parse_llm_json_raises_original_error_when_unrepairable():
    with pytest.raises(json.JSONDecodeError):
        parse_llm_json("not valid json")


def test_parse_llm_json_raises_original_error_on_trailing_garbage():
    # A fully-closed, valid JSON value followed by extra content -- nothing
    # left open for the repair to close, so it's left alone.
    with pytest.raises(json.JSONDecodeError):
        parse_llm_json('{"a": 1} and here is some commentary')
