import os
from urllib.parse import urlsplit, urlunsplit

from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker, create_async_engine


def _async_database_url() -> str:
    url = os.environ["DATABASE_URL"]
    # asyncpg doesn't accept Prisma's `?schema=` query param; the `public`
    # schema is Postgres's default search_path anyway, so drop it.
    scheme, netloc, path, _query, fragment = urlsplit(url)
    url = urlunsplit((scheme, netloc, path, "", fragment))
    return url.replace("postgresql://", "postgresql+asyncpg://", 1)


def make_engine() -> AsyncEngine:
    return create_async_engine(_async_database_url())


def make_session_factory(engine: AsyncEngine) -> async_sessionmaker[AsyncSession]:
    return async_sessionmaker(engine, expire_on_commit=False)
