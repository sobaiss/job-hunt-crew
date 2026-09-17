"""The shared QuotaAuditEvent write helper (`py_db.quotas.record_quota_audit_event`,
issue #138) — the provenance trail #139/#140's admin mutation endpoints
(QuotaOverride edit, PlanQuotaDefault edit, Plan reassignment) all write
through. Covers only the helper's own contract here (staging a row without
committing, so a caller's own transaction covers both); each admin endpoint's
own test only needs a thin case confirming a row lands as a side effect.
"""

import uuid
from datetime import UTC, datetime

import pytest
from py_db.models import QuotaAuditEvent, User
from py_db.quotas import record_quota_audit_event
from py_db.session import make_engine, make_session_factory
from sqlalchemy import delete, select


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


@pytest.mark.asyncio
async def test_record_quota_audit_event_stages_row_without_committing():
    engine = make_engine()
    session_factory = make_session_factory(engine)
    actor_id = str(uuid.uuid4())
    target_id = str(uuid.uuid4())
    try:
        async with session_factory() as session:
            session.add(User(id=actor_id, email=f"{actor_id}@example.com", updatedAt=_now()))
            session.add(User(id=target_id, email=f"{target_id}@example.com", updatedAt=_now()))
            await session.commit()

        async with session_factory() as session:
            record_quota_audit_event(
                session,
                actor_user_id=actor_id,
                target_user_id=target_id,
                field="quotaOverride:ANALYSES_DAILY",
                old_value=None,
                new_value="10",
            )
            # Never committed by the caller in this test — a fresh session
            # should see no row yet, proving the helper leaves committing to
            # its caller's own transaction (per the epic's "same transaction
            # as the change" requirement).
            async with session_factory() as other_session:
                assert (
                    await other_session.scalar(
                        select(QuotaAuditEvent).where(
                            QuotaAuditEvent.actorUserId == actor_id
                        )
                    )
                ) is None
            await session.commit()

        async with session_factory() as session:
            event = await session.scalar(
                select(QuotaAuditEvent).where(QuotaAuditEvent.actorUserId == actor_id)
            )
            assert event is not None
            assert event.targetUserId == target_id
            assert event.field == "quotaOverride:ANALYSES_DAILY"
            assert event.oldValue is None
            assert event.newValue == "10"
    finally:
        async with session_factory() as session:
            await session.execute(delete(QuotaAuditEvent).where(QuotaAuditEvent.actorUserId == actor_id))
            await session.execute(delete(User).where(User.id.in_([actor_id, target_id])))
            await session.commit()
        await engine.dispose()
