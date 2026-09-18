"""The shared password-hashing helper (`py_db.passwords`), backing the
Credentials sign-in provider. HTTP-level behaviour of
`/internal/auth/verify-credentials` is covered by `test_internal_routes.py`;
this file pins the helper itself.
"""

import pytest
from py_db.passwords import (
    MAX_PASSWORD_BYTES,
    MIN_PASSWORD_LENGTH,
    hash_password,
    verify_password,
    verify_password_or_dummy,
)


def test_correct_password_verifies():
    hashed = hash_password("correct horse battery staple")
    assert verify_password("correct horse battery staple", hashed)


def test_wrong_password_does_not_verify():
    hashed = hash_password("correct horse battery staple")
    assert not verify_password("wrong password", hashed)


def test_hash_is_salted_and_never_stores_plaintext():
    hashed = hash_password("correct horse battery staple")
    assert "correct horse battery staple" not in hashed
    assert hash_password("correct horse battery staple") != hashed


def test_rejects_password_shorter_than_minimum():
    with pytest.raises(ValueError):
        hash_password("a" * (MIN_PASSWORD_LENGTH - 1))


def test_rejects_password_longer_than_bcrypt_limit():
    with pytest.raises(ValueError):
        hash_password("a" * (MAX_PASSWORD_BYTES + 1))


def test_verify_password_returns_false_rather_than_raising_on_malformed_hash():
    assert not verify_password("anything", "not-a-real-bcrypt-hash")


def test_verify_password_or_dummy_returns_false_when_hash_is_none():
    assert not verify_password_or_dummy("anything", None)
