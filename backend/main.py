
import hashlib
import json
import logging
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from pypdf import PdfReader
from sqlalchemy import (
    JSON,
    Column,
    DateTime,
    Integer,
    String,
    Text,
    create_engine,
    inspect,
    text as sql_text,
)
from sqlalchemy.orm import declarative_base, sessionmaker

from ai_analysis import analyze_with_gemini


# ---------------------------------------------------------
# Configuration
# ---------------------------------------------------------

APP_DIR = Path(__file__).resolve().parent
load_dotenv(APP_DIR / ".env")

API_VERSION = "0.4.2-gemini-db-fix"

GEMINI_MODEL = os.getenv(
    "GEMINI_MODEL",
    "gemini-3.1-flash-lite",
).strip()

MAX_PDF_SIZE = 15 * 1024 * 1024
MAX_TEXT_LENGTH = 100_000

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("lexproof")

DATABASE_URL = os.getenv("DATABASE_URL", "").strip()

if not DATABASE_URL:
    DATABASE_URL = f"sqlite:///{APP_DIR / 'lexproof.db'}"

if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace(
        "postgres://",
        "postgresql://",
        1,
    )

engine_options: dict[str, Any] = {
    "pool_pre_ping": True,
}

if DATABASE_URL.startswith("sqlite"):
    engine_options["connect_args"] = {
        "check_same_thread": False,
    }

engine = create_engine(DATABASE_URL, **engine_options)

SessionLocal = sessionmaker(
    bind=engine,
    autoflush=False,
    autocommit=False,
)

Base = declarative_base()


# ---------------------------------------------------------
# Database model
# Supports both legacy and current database columns.
# ---------------------------------------------------------

class AnalysisRecord(Base):
    __tablename__ = "analysis_records"

    id = Column(Integer, primary_key=True, index=True)

    # Current fields
    filename = Column(
        String(255),
        nullable=False,
        default="Pasted text",
    )
    document_text = Column(Text, nullable=True)
    document_summary = Column(Text, nullable=True)
    analysis_type = Column(
        String(100),
        nullable=False,
        default="keyword_scan",
    )
    ai_report = Column(Text, nullable=True)
    ai_status = Column(
        String(30),
        nullable=False,
        default="not_run",
    )
    file_hash = Column(String(64), nullable=True)
    word_count = Column(
        Integer,
        nullable=False,
        default=0,
    )
    created_at = Column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
    )

    # Legacy fields still required by the existing SQLite table
    document_name = Column(
        String(255),
        nullable=False,
        default="Pasted text",
    )
    source_type = Column(
        String(20),
        nullable=False,
        default="text",
    )
    page_count = Column(Integer, nullable=True)
    character_count = Column(
        Integer,
        nullable=False,
        default=0,
    )
    sha256 = Column(
        String(64),
        nullable=False,
        default="",
    )
    flags = Column(
        JSON,
        nullable=False,
        default=list,
    )


# ---------------------------------------------------------
# Database initialization and migration
# ---------------------------------------------------------

def initialize_database() -> None:
    """
    Create the table if needed and add columns missing from
    older database versions.

    Existing records and existing tables are preserved.
    """

    Base.metadata.create_all(bind=engine)

    inspector = inspect(engine)
    table_names = inspector.get_table_names()

    if "analysis_records" not in table_names:
        raise RuntimeError(
            "Database initialization failed: "
            "analysis_records table was not created."
        )

    existing_columns = {
        column["name"]
        for column in inspector.get_columns("analysis_records")
    }

    # SQLite and PostgreSQL-compatible column definitions.
    migrations: dict[str, str] = {
        "filename": (
            "VARCHAR(255) NOT NULL DEFAULT 'Pasted text'"
        ),
        "document_text": "TEXT",
        "document_summary": "TEXT",
        "analysis_type": (
            "VARCHAR(100) NOT NULL DEFAULT 'keyword_scan'"
        ),
        "ai_report": "TEXT",
        "ai_status": (
            "VARCHAR(30) NOT NULL DEFAULT 'not_run'"
        ),
        "file_hash": "VARCHAR(64)",
        "word_count": "INTEGER NOT NULL DEFAULT 0",
        "created_at": (
            "TIMESTAMP WITH TIME ZONE "
            "NOT NULL DEFAULT CURRENT_TIMESTAMP"
            if engine.dialect.name == "postgresql"
            else "DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP"
        ),
        "document_name": (
            "VARCHAR(255) NOT NULL DEFAULT 'Pasted text'"
        ),
        "source_type": (
            "VARCHAR(20) NOT NULL DEFAULT 'text'"
        ),
        "page_count": "INTEGER",
        "character_count": "INTEGER NOT NULL DEFAULT 0",
        "sha256": "VARCHAR(64) NOT NULL DEFAULT ''",
        "flags": (
            "JSON NOT NULL DEFAULT '[]'"
        ),
    }

    with engine.begin() as connection:
        for column_name, column_definition in migrations.items():
            if column_name not in existing_columns:
                connection.execute(
                    sql_text(
                        f"ALTER TABLE analysis_records "
                        f"ADD COLUMN {column_name} "
                        f"{column_definition}"
                    )
                )

                logger.info(
                    "Added missing database column: %s",
                    column_name,
                )

    logger.info(
        "LexProof database initialization completed. "
        "Database dialect: %s",
        engine.dialect.name,
    )


initialize_database()


# ---------------------------------------------------------
# FastAPI application
# ---------------------------------------------------------

app = FastAPI(
    title="LexProof AI",
    description=(
        "AI-powered legal document intelligence, "
        "document integrity, and analysis history."
    ),
    version=API_VERSION,
)

allowed_origins = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "https://lexproof-ai.netlify.app",
]

extra_origins = os.getenv("FRONTEND_ORIGINS", "").strip()

if extra_origins:
    allowed_origins.extend(
        origin.strip()
        for origin in extra_origins.split(",")
        if origin.strip()
    )

app.add_middleware(
    CORSMiddleware,
    allow_origins=list(set(allowed_origins)),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------
# Request models
# ---------------------------------------------------------

class TextAnalysisRequest(BaseModel):
    text: str
    filename: str = "Pasted text"


# ---------------------------------------------------------
# Utility functions
# ---------------------------------------------------------

def get_utc_now() -> datetime:
    return datetime.now(timezone.utc)


def calculate_sha256(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def count_words(content: str) -> int:
    return len(content.split()) if content else 0


def extract_pdf_text(content: bytes) -> str:
    """Extract readable text from an uploaded PDF."""

    try:
        import io

        reader = PdfReader(io.BytesIO(content))

        if reader.is_encrypted:
            try:
                decrypted = reader.decrypt("")

                if not decrypted:
                    raise HTTPException(
                        status_code=400,
                        detail=(
                            "This PDF is password-protected. "
                            "Please upload an unlocked PDF."
                        ),
                    )
            except HTTPException:
                raise
            except Exception as exc:
                raise HTTPException(
                    status_code=400,
                    detail="Unable to unlock this PDF.",
                ) from exc

        pages: list[str] = []

        for page in reader.pages:
            page_text = page.extract_text() or ""

            if page_text.strip():
                pages.append(page_text)

        extracted_text = "\n\n".join(pages).strip()

        if not extracted_text:
            raise HTTPException(
                status_code=422,
                detail=(
                    "No readable text was extracted from this PDF. "
                    "It may be scanned or image-only."
                ),
            )

        return extracted_text

    except HTTPException:
        raise
    except Exception as exc:
        logger.warning(
            "PDF extraction failed: %s",
            type(exc).__name__,
        )

        raise HTTPException(
            status_code=400,
            detail="The uploaded PDF could not be read.",
        ) from exc


# ---------------------------------------------------------
# Preliminary keyword scan
# ---------------------------------------------------------

def analyze_document_text(
    document_text: str,
) -> dict[str, Any]:
    """Run a preliminary keyword scan."""

    normalized_text = document_text.strip()
    lower_text = normalized_text.lower()

    keywords = {
        "termination": [
            "terminate",
            "termination",
            "end this agreement",
        ],
        "payment": [
            "payment",
            "fee",
            "penalty",
            "late fee",
        ],
        "liability": [
            "liability",
            "liable",
            "indemnify",
            "indemnification",
        ],
        "confidentiality": [
            "confidential",
            "confidentiality",
            "non-disclosure",
        ],
        "renewal": [
            "automatic renewal",
            "auto-renew",
            "renewal",
        ],
        "dispute_resolution": [
            "arbitration",
            "dispute resolution",
            "jurisdiction",
        ],
        "data_privacy": [
            "personal data",
            "privacy",
            "data protection",
        ],
    }

    keyword_findings: list[dict[str, Any]] = []

    for category, terms in keywords.items():
        matched_terms = [
            term for term in terms if term in lower_text
        ]

        if matched_terms:
            keyword_findings.append(
                {
                    "category": category,
                    "matched_terms": matched_terms,
                    "description": (
                        f"Potentially relevant "
                        f"{category.replace('_', ' ')} wording "
                        "was detected. Review the complete clause "
                        "before drawing a conclusion."
                    ),
                }
            )

    return {
        "filename": "Pasted text",
        "analysis_type": "keyword_scan",
        "document_summary": (
            "A preliminary keyword scan was completed. "
            "This scan is not a substitute for legal review."
        ),
        "word_count": count_words(normalized_text),
        "file_hash": None,
        "keyword_findings": keyword_findings,
        "ai_status": "not_run",
        "ai_report": None,
        "backend_version": API_VERSION,
    }


# ---------------------------------------------------------
# Gemini AI integration
# ---------------------------------------------------------

def add_ai_analysis(
    extracted_text: str,
    result: dict[str, Any],
    source_type: str,
) -> dict[str, Any]:
    """Add Gemini analysis while preserving preliminary findings."""

    result["backend_version"] = API_VERSION

    if not os.getenv("GEMINI_API_KEY", "").strip():
        logger.error("Gemini API key is not configured.")

        result["ai_status"] = "unavailable"
        result["ai_report"] = None
        result["ai_error_type"] = "MissingAPIKey"
        result["ai_message"] = (
            "The preliminary scan completed, but AI analysis "
            "is unavailable because the Gemini API key is not configured."
        )
        result["analysis_type"] = (
            f"{source_type}_keyword_scan_ai_unavailable"
        )

        return result

    try:
        report = analyze_with_gemini(
            document_text=extracted_text,
            source_type=source_type,
        )

        if not isinstance(report, dict):
            raise TypeError(
                "Gemini analysis did not return a dictionary."
            )

        result["ai_status"] = "completed"
        result["ai_report"] = report

        result["document_summary"] = report.get(
            "summary",
            result.get("document_summary"),
        )

        result["analysis_type"] = (
            f"gemini_ai_{source_type}_analysis"
        )

        result.pop("ai_error_type", None)
        result.pop("ai_message", None)

        logger.info(
            "Gemini analysis completed for source type %s.",
            source_type,
        )

    except Exception as exc:
        logger.error(
            "Gemini analysis failed for %s: %s",
            source_type,
            type(exc).__name__,
        )

        result["ai_status"] = "unavailable"
        result["ai_report"] = None
        result["ai_error_type"] = type(exc).__name__
        result["ai_message"] = (
            "The preliminary scan completed, but AI analysis "
            "was unavailable. Check the Gemini API key, model "
            "configuration, and backend logs."
        )
        result["analysis_type"] = (
            f"{source_type}_keyword_scan_ai_unavailable"
        )

    result["backend_version"] = API_VERSION

    return result


# ---------------------------------------------------------
# Save analysis to database
# ---------------------------------------------------------

def save_analysis(
    result: dict[str, Any],
    filename: str,
    document_text: str,
    file_hash: str | None = None,
    source_type: str | None = None,
    page_count: int | None = None,
) -> dict[str, Any]:
    """Save analysis using both current and legacy DB fields."""

    db = SessionLocal()

    try:
        report = result.get("ai_report")
        final_hash = file_hash or result.get("file_hash") or ""
        safe_filename = (filename or "Pasted text")[:255]

        resolved_source_type = (
            source_type
            or (
                "pdf"
                if safe_filename.lower().endswith(".pdf")
                else "text"
            )
        )

        # JSON columns are stored as JSON values by SQLAlchemy.
        # The legacy database may declare ai_report as JSON, while
        # newer schemas may declare it as TEXT. Both support this
        # serialized JSON string on SQLite.
        serialized_report = (
            json.dumps(report, ensure_ascii=False)
            if report is not None
            else None
        )

        record = AnalysisRecord(
            # Current fields
            filename=safe_filename,
            document_text=document_text,
            document_summary=result.get("document_summary")
            or "Analysis completed.",
            analysis_type=result.get(
                "analysis_type",
                "keyword_scan",
            ),
            ai_report=serialized_report,
            ai_status=result.get("ai_status", "not_run"),
            file_hash=final_hash or None,
            word_count=count_words(document_text),
            created_at=get_utc_now(),

            # Legacy fields required by the existing database
            document_name=safe_filename,
            source_type=resolved_source_type,
            page_count=page_count,
            character_count=len(document_text),
            sha256=final_hash,
            flags=result.get("keyword_findings", []),
        )

        db.add(record)
        db.commit()
        db.refresh(record)

        result["id"] = record.id
        result["saved_to_database"] = True
        result["created_at"] = (
            record.created_at.isoformat()
            if record.created_at
            else None
        )

        return result

    except Exception as exc:
        db.rollback()

        logger.exception(
            "Failed to save analysis to the database."
        )

        raise HTTPException(
            status_code=500,
            detail="Analysis could not be saved to the database.",
        ) from exc

    finally:
        db.close()


# ---------------------------------------------------------
# Serialize saved records
# ---------------------------------------------------------

def serialize_record(
    record: AnalysisRecord,
) -> dict[str, Any]:
    """Convert a database record into a frontend-friendly result."""

    ai_report = None

    if record.ai_report:
        if isinstance(record.ai_report, dict):
            ai_report = record.ai_report
        else:
            try:
                ai_report = json.loads(record.ai_report)
            except (json.JSONDecodeError, TypeError):
                ai_report = None

    created_at = record.created_at

    return {
        "id": record.id,
        "filename": record.filename or record.document_name,
        "document_summary": record.document_summary,
        "analysis_type": record.analysis_type,
        "ai_status": record.ai_status or "not_run",
        "ai_report": ai_report,
        "file_hash": record.file_hash or record.sha256,
        "word_count": record.word_count or 0,
        "created_at": (
            created_at.isoformat() if created_at else None
        ),
    }


# ---------------------------------------------------------
# Health and deployment diagnostics
# ---------------------------------------------------------

@app.get("/")
def root() -> dict[str, Any]:
    return {
        "name": "LexProof AI",
        "status": "online",
        "api_version": API_VERSION,
        "gemini_api_key_configured": bool(
            os.getenv("GEMINI_API_KEY", "").strip()
        ),
        "gemini_model": GEMINI_MODEL,
        "endpoints": [
            "/health",
            "/api/analyze-text",
            "/api/analyze-pdf",
            "/api/analyses",
        ],
    }


@app.get("/health")
def health() -> dict[str, Any]:
    database_status = "connected"

    try:
        with engine.connect() as connection:
            connection.execute(sql_text("SELECT 1"))

            # Check that the application can see the expected table.
            if not inspect(connection).has_table("analysis_records"):
                database_status = "unavailable"

    except Exception as exc:
        logger.error(
            "Database health check failed: %s",
            type(exc).__name__,
        )
        database_status = "unavailable"

    return {
        "status": (
            "ok" if database_status == "connected" else "degraded"
        ),
        "api_version": API_VERSION,
        "database": database_status,
        "gemini_api_key_configured": bool(
            os.getenv("GEMINI_API_KEY", "").strip()
        ),
        "gemini_model": GEMINI_MODEL,
    }


# ---------------------------------------------------------
# Analyze pasted text
# ---------------------------------------------------------

@app.post("/api/analyze-text")
def analyze_text(
    request: TextAnalysisRequest,
) -> dict[str, Any]:

    document_text = request.text.strip()

    if not document_text:
        raise HTTPException(
            status_code=400,
            detail="Please provide text to analyze.",
        )

    if len(document_text) > MAX_TEXT_LENGTH:
        raise HTTPException(
            status_code=413,
            detail=(
                f"Text is too long. The maximum is "
                f"{MAX_TEXT_LENGTH:,} characters."
            ),
        )

    filename = Path(
        request.filename.strip() or "Pasted text"
    ).name[:255]

    result = analyze_document_text(document_text)
    result["filename"] = filename

    result = add_ai_analysis(
        extracted_text=document_text,
        result=result,
        source_type="text",
    )

    file_hash = calculate_sha256(
        document_text.encode("utf-8")
    )
    result["file_hash"] = file_hash

    return save_analysis(
        result=result,
        filename=filename,
        document_text=document_text,
        file_hash=file_hash,
        source_type="text",
    )


# ---------------------------------------------------------
# Analyze uploaded PDF
# ---------------------------------------------------------

@app.post("/api/analyze-pdf")
async def analyze_pdf(
    file: UploadFile = File(...),
) -> dict[str, Any]:

    filename = Path(
        file.filename or "document.pdf"
    ).name[:255]

    if not filename.lower().endswith(".pdf"):
        raise HTTPException(
            status_code=400,
            detail="Please upload a PDF file.",
        )

    content = await file.read(MAX_PDF_SIZE + 1)

    if not content:
        raise HTTPException(
            status_code=400,
            detail="The uploaded file is empty.",
        )

    if len(content) > MAX_PDF_SIZE:
        raise HTTPException(
            status_code=413,
            detail="PDF is too large. The maximum upload size is 15 MB.",
        )

    if not content.startswith(b"%PDF-"):
        raise HTTPException(
            status_code=400,
            detail="The uploaded file does not appear to be a valid PDF.",
        )

    file_hash = calculate_sha256(content)
    extracted_text = extract_pdf_text(content)

    if len(extracted_text) > MAX_TEXT_LENGTH:
        extracted_text = extracted_text[:MAX_TEXT_LENGTH]

        logger.info(
            "Extracted PDF text truncated to %s characters.",
            MAX_TEXT_LENGTH,
        )

    result = analyze_document_text(extracted_text)
    result["filename"] = filename
    result["file_hash"] = file_hash

    result = add_ai_analysis(
        extracted_text=extracted_text,
        result=result,
        source_type="pdf",
    )

    return save_analysis(
        result=result,
        filename=filename,
        document_text=extracted_text,
        file_hash=file_hash,
        source_type="pdf",
        page_count=None,
    )


# ---------------------------------------------------------
# Retrieve saved analysis history
# ---------------------------------------------------------

@app.get("/api/analyses")
def get_analyses(
    limit: int = 20,
) -> dict[str, Any]:

    limit = max(1, min(limit, 100))
    db = SessionLocal()

    try:
        records = (
            db.query(AnalysisRecord)
            .order_by(AnalysisRecord.id.desc())
            .limit(limit)
            .all()
        )

        return {
            "items": [
                serialize_record(record)
                for record in records
            ],
            "count": len(records),
            "api_version": API_VERSION,
        }

    except Exception as exc:
        logger.exception(
            "Failed to retrieve analysis history: %s",
            type(exc).__name__,
        )

        raise HTTPException(
            status_code=500,
            detail="Unable to retrieve analysis history.",
        ) from exc

    finally:
        db.close()


@app.get("/api/analyses/{analysis_id}")
def get_analysis(
    analysis_id: int,
) -> dict[str, Any]:

    db = SessionLocal()

    try:
        record = (
            db.query(AnalysisRecord)
            .filter(AnalysisRecord.id == analysis_id)
            .first()
        )

        if record is None:
            raise HTTPException(
                status_code=404,
                detail="Analysis record not found.",
            )

        result = serialize_record(record)
        result["api_version"] = API_VERSION

        return result

    except HTTPException:
        raise

    except Exception as exc:
        logger.exception(
            "Failed to retrieve analysis %s.",
            analysis_id,
        )

        raise HTTPException(
            status_code=500,
            detail="Unable to retrieve this analysis.",
        ) from exc

    finally:
        db.close()