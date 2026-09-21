"""Encryption of the secrets an Administrator stores in Postgres (issue #178,
docs/adr/0024): Fernet, keyed by `SETTINGS_ENCRYPTION_KEY`.

The key is read when a secret is actually encrypted or decrypted, never at
import, so a process that never touches a secret does not need it. Failure is
asymmetric on purpose. A **write** without a usable key raises
`SettingsEncryptionError` and the caller stores nothing; a **read** that cannot
decrypt (missing key, rotated key, corrupt payload) treats the secret as absent
-- the caller then falls back to the environment -- and logs one structured
error line, so a key-management mistake degrades instead of halting every
Analysis.

Nothing here ever logs, or puts in an exception message, a secret or its
ciphertext.
"""

import os

from cryptography.fernet import Fernet, InvalidToken

from .structured_logging import get_logger

ENCRYPTION_KEY_ENV_VAR = "SETTINGS_ENCRYPTION_KEY"

# Below this many characters the last four would reveal too large a fraction
# of the secret to be worth showing as a hint.
_MIN_LENGTH_FOR_HINT = 12

logger = get_logger(__name__)


class SettingsEncryptionError(Exception):
    """A secret cannot be encrypted: `SETTINGS_ENCRYPTION_KEY` is missing or
    not a valid Fernet key. The message says which, and never contains a
    secret."""


def _fernet() -> Fernet:
    key = os.environ.get(ENCRYPTION_KEY_ENV_VAR)
    if not key:
        raise SettingsEncryptionError(
            f"{ENCRYPTION_KEY_ENV_VAR} is not set; a secret cannot be encrypted "
            "or decrypted without it"
        )
    try:
        return Fernet(key)
    except ValueError as error:
        # Fernet's own message is about the key's shape, never its value, but
        # a fixed message keeps that guarantee independent of the library.
        raise SettingsEncryptionError(
            f"{ENCRYPTION_KEY_ENV_VAR} is not a valid Fernet key (expected 32 "
            "url-safe base64-encoded bytes)"
        ) from error


def encrypt_secret(plaintext: str) -> str:
    """The Fernet token for `plaintext`, safe to store. Raises
    `SettingsEncryptionError` when there is no usable key."""
    return _fernet().encrypt(plaintext.encode()).decode()


def decrypt_secret(ciphertext: str, *, provider: str, parameter: str) -> str | None:
    """The plaintext of a stored token, or None -- with a structured error log
    line naming `provider` and `parameter` -- when it cannot be decrypted."""
    try:
        return _fernet().decrypt(ciphertext.encode()).decode()
    except SettingsEncryptionError as error:
        reason = str(error)
    except InvalidToken:
        reason = "payload could not be decrypted with the current key (rotated key or corrupt value)"
    logger.error(
        "Stored LLM provider secret is unreadable; treating it as not set",
        extra={
            "fields": {
                "event": "llm_provider_secret_undecryptable",
                "provider": provider,
                "parameter": parameter,
                "reason": reason,
            }
        },
    )
    return None


def last_four_hint(secret: str) -> str | None:
    """The plaintext hint stored beside a secret so that showing it never
    needs the key: its last four characters, or None for a secret too short
    for four characters to be a meaningful fraction of it."""
    return secret[-4:] if len(secret) >= _MIN_LENGTH_FOR_HINT else None
