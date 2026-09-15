"""Shared "parse an LLM's JSON response" step for every agent that asks an
LLM for ONLY a JSON object (comparison/recommendation/extraction agents,
StyleProfile's layout classification).

Every one of those prompts ends with a "Respond with ONLY a single JSON
object, no markdown fences" instruction, but models don't always follow it to
the letter — some wrap the object in a ```/```json fence anyway, which
`parse_llm_json` strips before decoding.

It also makes one repair attempt when the JSON itself is invalid. This
exists because of a real dev-local failure mode: Ollama's `response_format=
{"type": "json_object"}` (see `llm_provider.OllamaProvider.generate`) is
supposed to grammar-constrain decoding to valid JSON, but qwen3.5 (the dev
default)'s custom renderer/parser doesn't always honour that constraint —
observed in production-shaped local runs emitting e.g. `..."}` where
`...]}` was meant (a still-open array closed with `}` instead of `]`, then
generation just stopped). Anthropic/OpenAI don't get `response_format` and
haven't shown this shape of break, so this is a local-Ollama-shaped repair,
but it's cheap and provider-agnostic: it only ever runs after `json.loads`
has already failed.
"""

import json
from typing import Any


def parse_llm_json(raw: str) -> Any:
    """Strips a leading ```/```json fence (if any) and parses the rest as
    JSON, making one repair attempt on failure: closes whatever strings/
    objects/arrays are still open at the point parsing broke, then retries.
    Raises the *original* json.JSONDecodeError if the repair doesn't produce
    valid JSON either -- every caller's bounded retry loop keys on that
    exception type, so a repair failure must surface the same way a raw
    parse failure always has.
    """
    text = raw.strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.startswith("json"):
            text = text[len("json") :]
        text = text.strip()

    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:
        repaired = _close_dangling(text, exc)
        if repaired is not None:
            try:
                return json.loads(repaired)
            except json.JSONDecodeError:
                pass
        raise exc


def _close_dangling(text: str, exc: json.JSONDecodeError) -> str | None:
    """Scans the prefix `json.loads` accepted before breaking, tracking
    object/array nesting outside of quoted strings, and returns that prefix
    with whatever's still open closed -- innermost first, closing a
    dangling string first if the break was mid-string. Returns None when
    nothing was left open (the break isn't this shape of error, so there's
    nothing this repair can do).

    `exc.pos` is normally that prefix's end -- except for "Unterminated
    string starting at", where the stdlib points `pos` at the string's
    *opening* quote instead of end-of-input; cutting there would drop the
    (truncated but real) string content, so that one case scans the whole
    text instead.
    """
    cutoff = len(text) if exc.msg.startswith("Unterminated string") else exc.pos
    closers: list[str] = []
    in_string = False
    escape = False
    for ch in text[:cutoff]:
        if in_string:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
        elif ch == "{":
            closers.append("}")
        elif ch == "[":
            closers.append("]")
        elif ch in "}]":
            if closers and closers[-1] == ch:
                closers.pop()

    if not in_string and not closers:
        return None

    prefix = text[:cutoff]
    suffix = ('"' if in_string else "") + "".join(reversed(closers))
    return prefix + suffix
