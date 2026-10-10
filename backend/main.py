import hashlib
import os
import re
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path
from typing import Generator

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from pypdf import PdfReader
from sqlalchemy import JSON, Column, DateTime, Integer, String, Text, create_engine, desc
from sqlalchemy.orm import Session, declarative_base, sessionmaker


APP_DIR = Path(__file__).resolve().parent
MAX_TEXT_LENGTH = 100_000
MAX_PDF_BYTES = 10 * 1024 * 1024

# On Render, set DATABASE_URL to the Internal Database URL from your
# Render PostgreSQL dashboard. Locally, a SQLite file is used automatically.
DATABASE_URL = os.getenv(
    "DATABASE_URL",
    f"sqlite:///{APP_DIR / 'lexproof.db'}",
)

if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace(
        "postgres://",
        "postgresql://",
        1,
    )

engine_options = {}

if DATABASE_URL.startswith("sqlite"):
    engine_options["connect_args"] = {"check_same_thread": False}

engine = create_engine(
    DATABASE_URL,
    pool_pre_ping=True,
    **engine_options,
)

SessionLocal = sessionmaker(
    bind=engine,
    autoflush=False,
    autocommit=False,
)

Base = declarative_base()


class AnalysisRecord(Base):
    __tablename__ = "analysis_records"

    id = Column(Integer, primary_key=True, index=True)
    document_name = Column(
        String(255),
        nullable=False,
        default="Pasted text",
    )
    source_type = Column(String(20), nullable=False, default="text")
    page_count = Column(Integer, nullable=True)
    document_summary = Column(Text, nullable=False)
    character_count = Column(Integer, nullable=False)
    word_count = Column(Integer, nullable=False)
    sha256 = Column(String(64), nullable=False, index=True)
    flags = Column(JSON, nullable=False, default=list)
    analysis_type = Column(String(80), nullable=False)
    created_at = Column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
    )


Base.metadata.create_all(bind=engine)

app = FastAPI(
    title="LexProof AI API",
    version="0.2.0",
)

# CORS configuration:
# FRONTEND_ORIGINS can override these defaults on Render.
# Separate multiple origins with commas, without trailing slashes.
DEFAULT_FRONTEND_ORIGINS = (
    "https://lexproof-ai.netlify.app,"
    "http://localhost:5173,"
    "http://127.0.0.1:5173"
)

allowed_origins = [
    item.strip().rstrip("/")
    for item in os.getenv(
        "FRONTEND_ORIGINS",
        DEFAULT_FRONTEND_ORIGINS,
    ).split(",")
    if item.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


class TextRequest(BaseModel):
    text: str = Field(
        min_length=1,
        max_length=MAX_TEXT_LENGTH,
    )


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def analyze_document_text(text: str) -> dict:
    cleaned = re.sub(r"\s+", " ", text).strip()

    if not cleaned:
        raise HTTPException(
            status_code=422,
            detail="No readable text was found in this document.",
        )

    digest = hashlib.sha256(
        cleaned.encode("utf-8")
    ).hexdigest()

    patterns = {
        "Liability and indemnity": (
            r"\b(indemnif\w*|hold harmless|limitation of liability)\b"
        ),
        "Termination": (
            r"\b(terminat\w*|early termination|notice period)\b"
        ),
        "Automatic renewal": (
            r"\b(automatic(?:ally)? renew\w*|auto-renew\w*)\b"
        ),
        "Penalties and fees": (
            r"\b(penalt\w*|late fee\w*|liquidated damages)\b"
        ),
        "Confidentiality": (
            r"\b(confidential\w*|non-disclosure)\b"
        ),
        "Dispute resolution": (
            r"\b(arbitrat\w*|jurisdiction|governing law|dispute resolution)\b"
        ),
    }

    flags = []

    for label, pattern in patterns.items():
        matches = re.findall(
            pattern,
            cleaned,
            flags=re.IGNORECASE,
        )

        if matches:
            flags.append(
                {
                    "category": label,
                    "occurrences": len(matches),
                    "note": (
                        "This topic appears in the text and may deserve review; "
                        "its presence alone does not mean the clause is risky."
                    ),
                }
            )

    sentences = re.split(r"(?<=[.!?])\s+", cleaned)

    return {
        "document_summary": " ".join(sentences[:3])[:900],
        "character_count": len(cleaned),
        "word_count": len(cleaned.split()),
        "sha256": digest,
        "flags": flags,
        "analysis_type": "preliminary_keyword_scan",
        "analyzed_at": datetime.now(timezone.utc).isoformat(),
        "disclaimer": (
            "This is a preliminary keyword scan, not AI legal analysis or legal advice. "
            "A hash does not prove authorship or legal validity."
        ),
    }


def save_analysis(
    db: Session,
    result: dict,
    document_name: str,
    source_type: str,
    page_count: int | None = None,
) -> dict:
    record = AnalysisRecord(
        document_name=document_name[:255],
        source_type=source_type,
        page_count=page_count,
        document_summary=result["document_summary"],
        character_count=result["character_count"],
        word_count=result["word_count"],
        sha256=result["sha256"],
        flags=result["flags"],
        analysis_type=result["analysis_type"],
    )

    db.add(record)
    db.commit()
    db.refresh(record)

    result["id"] = record.id
    result["document_name"] = record.document_name
    result["source_type"] = record.source_type
    result["page_count"] = record.page_count
    result["created_at"] = (
        record.created_at.isoformat()
        if record.created_at
        else None
    )
    result["saved_to_database"] = True

    return result


def record_to_dict(record: AnalysisRecord) -> dict:
    return {
        "id": record.id,
        "document_name": record.document_name,
        "source_type": record.source_type,
        "page_count": record.page_count,
        "document_summary": record.document_summary,
        "character_count": record.character_count,
        "word_count": record.word_count,
        "sha256": record.sha256,
        "flags": record.flags or [],
        "analysis_type": record.analysis_type,
        "created_at": (
            record.created_at.isoformat()
            if record.created_at
            else None
        ),
        "saved_to_database": True,
    }


@app.get("/")
def root():
    return {
        "name": "LexProof AI API",
        "status": "running",
        "database": "configured",
    }


@app.get("/health")
def health():
    try:
        with engine.connect() as connection:
            connection.exec_driver_sql("SELECT 1")

        return {
            "status": "healthy",
            "database": "connected",
        }

    except Exception:
        raise HTTPException(
            status_code=503,
            detail="Database connection failed.",
        )


@app.post("/api/analyze-text")
def analyze_text(request: TextRequest):
    result = analyze_document_text(request.text)
    db = SessionLocal()

    try:
        return save_analysis(
            db=db,
            result=result,
            document_name="Pasted text",
            source_type="text",
        )

    except Exception:
        db.rollback()

        raise HTTPException(
            status_code=500,
            detail=(
                "Analysis completed, but saving the result "
                "to the database failed."
            ),
        )

    finally:
        db.close()


@app.post("/api/analyze-pdf")
async def analyze_pdf(file: UploadFile = File(...)):
    filename = (file.filename or "document.pdf").strip()

    if not filename.lower().endswith(".pdf"):
        raise HTTPException(
            status_code=400,
            detail="Please upload a PDF file.",
        )

    contents = await file.read(MAX_PDF_BYTES + 1)
    await file.close()

    if len(contents) > MAX_PDF_BYTES:
        raise HTTPException(
            status_code=413,
            detail="The PDF must be 10 MB or smaller.",
        )

    if not contents:
        raise HTTPException(
            status_code=400,
            detail="The uploaded PDF is empty.",
        )

    try:
        reader = PdfReader(
            BytesIO(contents),
            strict=False,
        )

        if reader.is_encrypted:
            try:
                decrypt_result = reader.decrypt("")
            except Exception:
                decrypt_result = 0

            if not decrypt_result:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        "This PDF is password-protected. "
                        "Please upload an unlocked PDF."
                    ),
                )

        page_count = len(reader.pages)

        if page_count == 0:
            raise HTTPException(
                status_code=422,
                detail="The PDF contains no pages.",
            )

        extracted_pages = []

        for page in reader.pages:
            extracted_pages.append(page.extract_text() or "")

        extracted_text = "\n".join(extracted_pages)

    except HTTPException:
        raise

    except Exception:
        raise HTTPException(
            status_code=400,
            detail=(
                "The PDF could not be read. "
                "Please try a valid, non-damaged PDF."
            ),
        )

    result = analyze_document_text(extracted_text)
    result["analysis_type"] = "pdf_text_extraction_keyword_scan"

    db = SessionLocal()

    try:
        return save_analysis(
            db=db,
            result=result,
            document_name=filename,
            source_type="pdf",
            page_count=page_count,
        )

    except Exception:
        db.rollback()

        raise HTTPException(
            status_code=500,
            detail=(
                "PDF analysis completed, but saving the result "
                "to the database failed."
            ),
        )

    finally:
        db.close()


@app.get("/api/analyses")
def list_analyses(limit: int = 20):
    if limit < 1 or limit > 100:
        raise HTTPException(
            status_code=400,
            detail="Limit must be between 1 and 100.",
        )

    db = SessionLocal()

    try:
        total_count = db.query(AnalysisRecord).count()

        records = (
            db.query(AnalysisRecord)
            .order_by(
                desc(AnalysisRecord.created_at),
                desc(AnalysisRecord.id),
            )
            .limit(limit)
            .all()
        )

        return {
            "count": len(records),
            "total_count": total_count,
            "analyses": [
                record_to_dict(item)
                for item in records
            ],
        }

    finally:
        db.close()


@app.get("/api/analyses/{analysis_id}")
def get_analysis(analysis_id: int):
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

        return record_to_dict(record)

    finally:
        db.close()
```
