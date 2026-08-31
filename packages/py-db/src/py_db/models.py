from typing import Optional
import datetime
import enum

from sqlalchemy import Boolean, Column, DateTime, Enum, ForeignKeyConstraint, Index, Integer, PrimaryKeyConstraint, String, Table, Text, text
from sqlalchemy.dialects.postgresql import JSONB, TIMESTAMP
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

class Base(DeclarativeBase):
    pass


class Analysisstatus(str, enum.Enum):
    PENDING = 'PENDING'
    QUEUED = 'QUEUED'
    RUNNING_CREW = 'RUNNING_CREW'
    AWAITING_RESULT = 'AWAITING_RESULT'
    PERSISTING = 'PERSISTING'
    COMPLETED = 'COMPLETED'
    FAILED = 'FAILED'


class Cvconversionstatus(str, enum.Enum):
    PENDING = 'PENDING'
    CONVERTING = 'CONVERTING'
    CONVERTED = 'CONVERTED'
    FAILED = 'FAILED'


class Cvfiletype(str, enum.Enum):
    PDF = 'PDF'
    DOCX = 'DOCX'
    MD = 'MD'
    TXT = 'TXT'


class Ingestionjobstatus(str, enum.Enum):
    PENDING = 'PENDING'
    RUNNING = 'RUNNING'
    PARTIALLY_COMPLETED = 'PARTIALLY_COMPLETED'
    COMPLETED = 'COMPLETED'
    FAILED = 'FAILED'


class Ingestionmode(str, enum.Enum):
    SINGLE_URL = 'SINGLE_URL'
    LISTING_URL = 'LISTING_URL'
    SITE_SEARCH = 'SITE_SEARCH'


class Jobofferextractionstatus(str, enum.Enum):
    PENDING = 'PENDING'
    SCRAPING = 'SCRAPING'
    SCRAPED = 'SCRAPED'
    EXTRACTING = 'EXTRACTING'
    READY = 'READY'
    FAILED = 'FAILED'


class Joboffersourcesite(str, enum.Enum):
    LINKEDIN = 'LINKEDIN'
    INDEED = 'INDEED'
    FRANCE_TRAVAIL = 'FRANCE_TRAVAIL'
    WTTJ = 'WTTJ'
    GLASSDOOR = 'GLASSDOOR'
    OTHER = 'OTHER'


class Siteconfigantibotrisklevel(str, enum.Enum):
    LOW = 'LOW'
    MEDIUM = 'MEDIUM'
    HIGH = 'HIGH'


class Siteconfigintegrationtype(str, enum.Enum):
    HTML_SCRAPE = 'HTML_SCRAPE'
    OFFICIAL_API = 'OFFICIAL_API'


class Siteconfigsitekey(str, enum.Enum):
    LINKEDIN = 'LINKEDIN'
    INDEED = 'INDEED'
    FRANCE_TRAVAIL = 'FRANCE_TRAVAIL'
    WTTJ = 'WTTJ'
    GLASSDOOR = 'GLASSDOOR'


class JobOffer(Base):
    __tablename__ = 'JobOffer'
    __table_args__ = (
        PrimaryKeyConstraint('id', name='JobOffer_pkey'),
        Index('JobOffer_sourceUrl_key', 'sourceUrl', unique=True)
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    sourceUrl: Mapped[str] = mapped_column(Text, nullable=False)
    sourceSite: Mapped[Joboffersourcesite] = mapped_column(Enum(Joboffersourcesite, values_callable=lambda cls: [member.value for member in cls], name='JobOfferSourceSite'), nullable=False)
    extractionStatus: Mapped[Jobofferextractionstatus] = mapped_column(Enum(Jobofferextractionstatus, values_callable=lambda cls: [member.value for member in cls], name='JobOfferExtractionStatus'), nullable=False, server_default=text('\'PENDING\'::"JobOfferExtractionStatus"'))
    createdAt: Mapped[datetime.datetime] = mapped_column(TIMESTAMP(precision=3), nullable=False, server_default=text('CURRENT_TIMESTAMP'))
    updatedAt: Mapped[datetime.datetime] = mapped_column(TIMESTAMP(precision=3), nullable=False)
    title: Mapped[Optional[str]] = mapped_column(Text)
    company: Mapped[Optional[str]] = mapped_column(Text)
    location: Mapped[Optional[str]] = mapped_column(Text)
    postedAt: Mapped[Optional[datetime.datetime]] = mapped_column(TIMESTAMP(precision=3))
    rawContentKey: Mapped[Optional[str]] = mapped_column(Text)
    structuredData: Mapped[Optional[dict]] = mapped_column(JSONB)
    errorMessage: Mapped[Optional[str]] = mapped_column(Text)

    Analysis: Mapped[list['Analysis']] = relationship('Analysis', back_populates='JobOffer_')
    IngestionJobOffer: Mapped[list['IngestionJobOffer']] = relationship('IngestionJobOffer', back_populates='JobOffer_')


class SiteConfig(Base):
    __tablename__ = 'SiteConfig'
    __table_args__ = (
        PrimaryKeyConstraint('id', name='SiteConfig_pkey'),
        Index('SiteConfig_siteKey_key', 'siteKey', unique=True)
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    siteKey: Mapped[Siteconfigsitekey] = mapped_column(Enum(Siteconfigsitekey, values_callable=lambda cls: [member.value for member in cls], name='SiteConfigSiteKey'), nullable=False)
    displayName: Mapped[str] = mapped_column(Text, nullable=False)
    baseUrl: Mapped[str] = mapped_column(Text, nullable=False)
    integrationType: Mapped[Siteconfigintegrationtype] = mapped_column(Enum(Siteconfigintegrationtype, values_callable=lambda cls: [member.value for member in cls], name='SiteConfigIntegrationType'), nullable=False)
    requiresJsRendering: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text('false'))
    antiBotRiskLevel: Mapped[Siteconfigantibotrisklevel] = mapped_column(Enum(Siteconfigantibotrisklevel, values_callable=lambda cls: [member.value for member in cls], name='SiteConfigAntiBotRiskLevel'), nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text('true'))
    createdAt: Mapped[datetime.datetime] = mapped_column(TIMESTAMP(precision=3), nullable=False, server_default=text('CURRENT_TIMESTAMP'))
    updatedAt: Mapped[datetime.datetime] = mapped_column(TIMESTAMP(precision=3), nullable=False)
    searchUrlTemplate: Mapped[Optional[str]] = mapped_column(Text)
    filterParamMapping: Mapped[Optional[dict]] = mapped_column(JSONB)
    listItemSelector: Mapped[Optional[str]] = mapped_column(Text)
    offerLinkSelector: Mapped[Optional[str]] = mapped_column(Text)
    offerTitleSelector: Mapped[Optional[str]] = mapped_column(Text)
    apiBaseUrl: Mapped[Optional[str]] = mapped_column(Text)
    notes: Mapped[Optional[str]] = mapped_column(Text)


class User(Base):
    __tablename__ = 'User'
    __table_args__ = (
        PrimaryKeyConstraint('id', name='User_pkey'),
        Index('User_email_key', 'email', unique=True)
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    createdAt: Mapped[datetime.datetime] = mapped_column(TIMESTAMP(precision=3), nullable=False, server_default=text('CURRENT_TIMESTAMP'))
    updatedAt: Mapped[datetime.datetime] = mapped_column(TIMESTAMP(precision=3), nullable=False)
    name: Mapped[Optional[str]] = mapped_column(Text)
    email: Mapped[Optional[str]] = mapped_column(Text)
    emailVerified: Mapped[Optional[datetime.datetime]] = mapped_column(TIMESTAMP(precision=3))
    image: Mapped[Optional[str]] = mapped_column(Text)

    Account: Mapped[list['Account']] = relationship('Account', back_populates='User_')
    CVVersion: Mapped[list['CVVersion']] = relationship('CVVersion', back_populates='User_')
    IngestionJob: Mapped[list['IngestionJob']] = relationship('IngestionJob', back_populates='User_')
    Session: Mapped[list['Session']] = relationship('Session', back_populates='User_')
    Analysis: Mapped[list['Analysis']] = relationship('Analysis', back_populates='User_')


t_VerificationToken = Table(
    'VerificationToken', Base.metadata,
    Column('identifier', Text, nullable=False),
    Column('token', Text, nullable=False),
    Column('expires', TIMESTAMP(precision=3), nullable=False),
    Index('VerificationToken_identifier_token_key', 'identifier', 'token', unique=True),
    Index('VerificationToken_token_key', 'token', unique=True)
)


class PrismaMigrations(Base):
    __tablename__ = '_prisma_migrations'
    __table_args__ = (
        PrimaryKeyConstraint('id', name='_prisma_migrations_pkey'),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    checksum: Mapped[str] = mapped_column(String(64), nullable=False)
    migration_name: Mapped[str] = mapped_column(String(255), nullable=False)
    started_at: Mapped[datetime.datetime] = mapped_column(DateTime(True), nullable=False, server_default=text('now()'))
    applied_steps_count: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text('0'))
    finished_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime(True))
    logs: Mapped[Optional[str]] = mapped_column(Text)
    rolled_back_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime(True))


class Account(Base):
    __tablename__ = 'Account'
    __table_args__ = (
        ForeignKeyConstraint(['userId'], ['User.id'], ondelete='CASCADE', onupdate='CASCADE', name='Account_userId_fkey'),
        PrimaryKeyConstraint('id', name='Account_pkey'),
        Index('Account_provider_providerAccountId_key', 'provider', 'providerAccountId', unique=True)
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    userId: Mapped[str] = mapped_column(Text, nullable=False)
    type: Mapped[str] = mapped_column(Text, nullable=False)
    provider: Mapped[str] = mapped_column(Text, nullable=False)
    providerAccountId: Mapped[str] = mapped_column(Text, nullable=False)
    refresh_token: Mapped[Optional[str]] = mapped_column(Text)
    access_token: Mapped[Optional[str]] = mapped_column(Text)
    expires_at: Mapped[Optional[int]] = mapped_column(Integer)
    token_type: Mapped[Optional[str]] = mapped_column(Text)
    scope: Mapped[Optional[str]] = mapped_column(Text)
    id_token: Mapped[Optional[str]] = mapped_column(Text)
    session_state: Mapped[Optional[str]] = mapped_column(Text)

    User_: Mapped['User'] = relationship('User', back_populates='Account')


class CVVersion(Base):
    __tablename__ = 'CVVersion'
    __table_args__ = (
        ForeignKeyConstraint(['userId'], ['User.id'], ondelete='CASCADE', onupdate='CASCADE', name='CVVersion_userId_fkey'),
        PrimaryKeyConstraint('id', name='CVVersion_pkey'),
        Index('CVVersion_userId_idx', 'userId')
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    userId: Mapped[str] = mapped_column(Text, nullable=False)
    label: Mapped[str] = mapped_column(Text, nullable=False)
    fileKey: Mapped[str] = mapped_column(Text, nullable=False)
    fileName: Mapped[str] = mapped_column(Text, nullable=False)
    fileType: Mapped[Cvfiletype] = mapped_column(Enum(Cvfiletype, values_callable=lambda cls: [member.value for member in cls], name='CVFileType'), nullable=False)
    fileSizeBytes: Mapped[int] = mapped_column(Integer, nullable=False)
    isDefault: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text('false'))
    createdAt: Mapped[datetime.datetime] = mapped_column(TIMESTAMP(precision=3), nullable=False, server_default=text('CURRENT_TIMESTAMP'))
    updatedAt: Mapped[datetime.datetime] = mapped_column(TIMESTAMP(precision=3), nullable=False)
    conversionStatus: Mapped[Cvconversionstatus] = mapped_column(Enum(Cvconversionstatus, values_callable=lambda cls: [member.value for member in cls], name='CVConversionStatus'), nullable=False, server_default=text('\'PENDING\'::"CVConversionStatus"'))
    conversionError: Mapped[Optional[str]] = mapped_column(Text)
    markdownContent: Mapped[Optional[str]] = mapped_column(Text)

    User_: Mapped['User'] = relationship('User', back_populates='CVVersion')
    Analysis: Mapped[list['Analysis']] = relationship('Analysis', back_populates='CVVersion_')


class IngestionJob(Base):
    __tablename__ = 'IngestionJob'
    __table_args__ = (
        ForeignKeyConstraint(['userId'], ['User.id'], ondelete='CASCADE', onupdate='CASCADE', name='IngestionJob_userId_fkey'),
        PrimaryKeyConstraint('id', name='IngestionJob_pkey'),
        Index('IngestionJob_userId_idx', 'userId')
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    userId: Mapped[str] = mapped_column(Text, nullable=False)
    mode: Mapped[Ingestionmode] = mapped_column(Enum(Ingestionmode, values_callable=lambda cls: [member.value for member in cls], name='IngestionMode'), nullable=False)
    maxOffers: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text('25'))
    status: Mapped[Ingestionjobstatus] = mapped_column(Enum(Ingestionjobstatus, values_callable=lambda cls: [member.value for member in cls], name='IngestionJobStatus'), nullable=False, server_default=text('\'PENDING\'::"IngestionJobStatus"'))
    discoveredCount: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text('0'))
    scrapedCount: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text('0'))
    failedCount: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text('0'))
    createdAt: Mapped[datetime.datetime] = mapped_column(TIMESTAMP(precision=3), nullable=False, server_default=text('CURRENT_TIMESTAMP'))
    updatedAt: Mapped[datetime.datetime] = mapped_column(TIMESTAMP(precision=3), nullable=False)
    inputUrl: Mapped[Optional[str]] = mapped_column(Text)
    siteConfigId: Mapped[Optional[str]] = mapped_column(Text)
    filters: Mapped[Optional[dict]] = mapped_column(JSONB)
    errorMessage: Mapped[Optional[str]] = mapped_column(Text)

    User_: Mapped['User'] = relationship('User', back_populates='IngestionJob')
    IngestionJobOffer: Mapped[list['IngestionJobOffer']] = relationship('IngestionJobOffer', back_populates='IngestionJob_')
    PipelineEvent: Mapped[list['PipelineEvent']] = relationship('PipelineEvent', back_populates='IngestionJob_')


class Session(Base):
    __tablename__ = 'Session'
    __table_args__ = (
        ForeignKeyConstraint(['userId'], ['User.id'], ondelete='CASCADE', onupdate='CASCADE', name='Session_userId_fkey'),
        PrimaryKeyConstraint('id', name='Session_pkey'),
        Index('Session_sessionToken_key', 'sessionToken', unique=True)
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    sessionToken: Mapped[str] = mapped_column(Text, nullable=False)
    userId: Mapped[str] = mapped_column(Text, nullable=False)
    expires: Mapped[datetime.datetime] = mapped_column(TIMESTAMP(precision=3), nullable=False)

    User_: Mapped['User'] = relationship('User', back_populates='Session')


class Analysis(Base):
    __tablename__ = 'Analysis'
    __table_args__ = (
        ForeignKeyConstraint(['cvVersionId'], ['CVVersion.id'], ondelete='CASCADE', onupdate='CASCADE', name='Analysis_cvVersionId_fkey'),
        ForeignKeyConstraint(['jobOfferId'], ['JobOffer.id'], ondelete='CASCADE', onupdate='CASCADE', name='Analysis_jobOfferId_fkey'),
        ForeignKeyConstraint(['userId'], ['User.id'], ondelete='CASCADE', onupdate='CASCADE', name='Analysis_userId_fkey'),
        PrimaryKeyConstraint('id', name='Analysis_pkey'),
        Index('Analysis_cvVersionId_idx', 'cvVersionId'),
        Index('Analysis_jobOfferId_idx', 'jobOfferId'),
        Index('Analysis_userId_idx', 'userId')
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    userId: Mapped[str] = mapped_column(Text, nullable=False)
    jobOfferId: Mapped[str] = mapped_column(Text, nullable=False)
    cvVersionId: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[Analysisstatus] = mapped_column(Enum(Analysisstatus, values_callable=lambda cls: [member.value for member in cls], name='AnalysisStatus'), nullable=False, server_default=text('\'PENDING\'::"AnalysisStatus"'))
    requestedAt: Mapped[datetime.datetime] = mapped_column(TIMESTAMP(precision=3), nullable=False, server_default=text('CURRENT_TIMESTAMP'))
    s3ResultKey: Mapped[Optional[str]] = mapped_column(Text)
    matchScore: Mapped[Optional[int]] = mapped_column(Integer)
    resultJSON: Mapped[Optional[dict]] = mapped_column(JSONB)
    errorMessage: Mapped[Optional[str]] = mapped_column(Text)
    stepFunctionExecutionArn: Mapped[Optional[str]] = mapped_column(Text)
    startedAt: Mapped[Optional[datetime.datetime]] = mapped_column(TIMESTAMP(precision=3))
    completedAt: Mapped[Optional[datetime.datetime]] = mapped_column(TIMESTAMP(precision=3))

    CVVersion_: Mapped['CVVersion'] = relationship('CVVersion', back_populates='Analysis')
    JobOffer_: Mapped['JobOffer'] = relationship('JobOffer', back_populates='Analysis')
    User_: Mapped['User'] = relationship('User', back_populates='Analysis')
    PipelineEvent: Mapped[list['PipelineEvent']] = relationship('PipelineEvent', back_populates='Analysis_')


class IngestionJobOffer(Base):
    __tablename__ = 'IngestionJobOffer'
    __table_args__ = (
        ForeignKeyConstraint(['ingestionJobId'], ['IngestionJob.id'], ondelete='CASCADE', onupdate='CASCADE', name='IngestionJobOffer_ingestionJobId_fkey'),
        ForeignKeyConstraint(['jobOfferId'], ['JobOffer.id'], ondelete='CASCADE', onupdate='CASCADE', name='IngestionJobOffer_jobOfferId_fkey'),
        PrimaryKeyConstraint('id', name='IngestionJobOffer_pkey'),
        Index('IngestionJobOffer_ingestionJobId_jobOfferId_key', 'ingestionJobId', 'jobOfferId', unique=True),
        Index('IngestionJobOffer_jobOfferId_idx', 'jobOfferId')
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    ingestionJobId: Mapped[str] = mapped_column(Text, nullable=False)
    jobOfferId: Mapped[str] = mapped_column(Text, nullable=False)
    createdAt: Mapped[datetime.datetime] = mapped_column(TIMESTAMP(precision=3), nullable=False, server_default=text('CURRENT_TIMESTAMP'))

    IngestionJob_: Mapped['IngestionJob'] = relationship('IngestionJob', back_populates='IngestionJobOffer')
    JobOffer_: Mapped['JobOffer'] = relationship('JobOffer', back_populates='IngestionJobOffer')


class PipelineEvent(Base):
    __tablename__ = 'PipelineEvent'
    __table_args__ = (
        ForeignKeyConstraint(['analysisId'], ['Analysis.id'], ondelete='CASCADE', onupdate='CASCADE', name='PipelineEvent_analysisId_fkey'),
        ForeignKeyConstraint(['ingestionJobId'], ['IngestionJob.id'], ondelete='CASCADE', onupdate='CASCADE', name='PipelineEvent_ingestionJobId_fkey'),
        PrimaryKeyConstraint('id', name='PipelineEvent_pkey'),
        Index('PipelineEvent_analysisId_idx', 'analysisId'),
        Index('PipelineEvent_ingestionJobId_idx', 'ingestionJobId')
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    stage: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False)
    createdAt: Mapped[datetime.datetime] = mapped_column(TIMESTAMP(precision=3), nullable=False, server_default=text('CURRENT_TIMESTAMP'))
    analysisId: Mapped[Optional[str]] = mapped_column(Text)
    ingestionJobId: Mapped[Optional[str]] = mapped_column(Text)
    message: Mapped[Optional[str]] = mapped_column(Text)

    Analysis_: Mapped[Optional['Analysis']] = relationship('Analysis', back_populates='PipelineEvent')
    IngestionJob_: Mapped[Optional['IngestionJob']] = relationship('IngestionJob', back_populates='PipelineEvent')
