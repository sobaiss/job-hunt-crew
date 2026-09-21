"""The encryption of stored provider secrets (issue #178, docs/adr/0024). The
read path is covered through the resolver (test_llm_provider_resolver.py); this
covers what has no consumer until the Admin API writes secrets (#179): a write
without a usable key must fail loudly, and the last-four hint must not give a
short secret away.
"""

import pytest
from cryptography.fernet import Fernet
from py_db.settings_encryption import (
    SettingsEncryptionError,
    encrypt_secret,
    last_four_hint,
)


def test_encrypting_without_a_key_fails_with_an_explicit_error(monkeypatch):
    monkeypatch.delenv("SETTINGS_ENCRYPTION_KEY", raising=False)

    with pytest.raises(SettingsEncryptionError, match="SETTINGS_ENCRYPTION_KEY is not set"):
        encrypt_secret("sk-secret-0123456789")


def test_encrypting_with_an_unusable_key_fails_without_echoing_it(monkeypatch):
    monkeypatch.setenv("SETTINGS_ENCRYPTION_KEY", "not-a-fernet-key")

    with pytest.raises(SettingsEncryptionError) as excinfo:
        encrypt_secret("sk-secret-0123456789")

    assert "not-a-fernet-key" not in str(excinfo.value)
    assert "sk-secret-0123456789" not in str(excinfo.value)


def test_the_encrypted_value_is_not_the_plaintext(monkeypatch):
    monkeypatch.setenv("SETTINGS_ENCRYPTION_KEY", Fernet.generate_key().decode())

    assert "sk-secret-0123456789" not in encrypt_secret("sk-secret-0123456789")


def test_the_hint_is_the_last_four_characters_of_a_long_secret():
    assert last_four_hint("sk-secret-0123456789") == "6789"


@pytest.mark.parametrize("secret", ["", "abcd", "abcdefgh", "abcdefghijk"])
def test_the_hint_is_suppressed_for_a_short_secret(secret):
    assert last_four_hint(secret) is None
