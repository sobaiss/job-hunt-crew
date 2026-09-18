"""Password hashing for the Credentials sign-in provider, alongside the
existing Google/LinkedIn/magic-link providers. Hand-written (not sqlacodegen
output), like `quota.py` and `pipeline_events.py`.

bcrypt rejects (rather than silently truncating) a password whose UTF-8
encoding exceeds 72 bytes, so callers should reject overlong passwords with a
clear error before calling `hash_password` rather than let this raise.
"""

import bcrypt

MIN_PASSWORD_LENGTH = 8
MAX_PASSWORD_BYTES = 72


def hash_password(password: str) -> str:
    """Hashes `password` with a fresh bcrypt salt. Raises `ValueError` if it's
    outside `MIN_PASSWORD_LENGTH`..`MAX_PASSWORD_BYTES` (UTF-8 bytes)."""
    encoded = password.encode("utf-8")
    if len(password) < MIN_PASSWORD_LENGTH or len(encoded) > MAX_PASSWORD_BYTES:
        raise ValueError(
            f"Password must be at least {MIN_PASSWORD_LENGTH} characters and at "
            f"most {MAX_PASSWORD_BYTES} bytes"
        )
    return bcrypt.hashpw(encoded, bcrypt.gensalt()).decode("utf-8")


def verify_password(password: str, password_hash: str) -> bool:
    """True if `password` matches `password_hash`. False (never raises) on a
    malformed hash or an overlong password, rather than erroring out a login
    attempt."""
    try:
        return bcrypt.checkpw(password.encode("utf-8")[:MAX_PASSWORD_BYTES], password_hash.encode("utf-8"))
    except ValueError:
        return False


# A valid bcrypt hash nothing will ever match, compared against when the
# looked-up User has no passwordHash (or doesn't exist at all) so that
# rejecting those cases costs the same bcrypt work as a real mismatch —
# without this, checking "does this email exist" would be measurably faster
# than checking a wrong password, leaking which emails have an account.
_DUMMY_HASH = bcrypt.hashpw(b"no-such-user-timing-safety-padding", bcrypt.gensalt()).decode("utf-8")


def verify_password_or_dummy(password: str, password_hash: str | None) -> bool:
    """`verify_password` when `password_hash` is set; otherwise still does a
    bcrypt comparison (against a fixed dummy hash) and returns False, so the
    caller's response time doesn't betray whether the account exists or has
    no password set."""
    return verify_password(password, password_hash if password_hash is not None else _DUMMY_HASH)
