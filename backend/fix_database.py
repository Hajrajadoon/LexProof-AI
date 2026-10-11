import sqlite3
import shutil
from pathlib import Path

db_path = Path(__file__).resolve().parent / "lexproof.db"
backup_path = db_path.with_name("lexproof.before_schema_fix.db")

if not db_path.exists():
    raise FileNotFoundError(f"Database not found: {db_path}")

shutil.copy2(db_path, backup_path)
print(f"Backup created: {backup_path}")

try:
    conn = sqlite3.connect(db_path)
    tables = [
        row[0] for row in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ).fetchall()
    ]

    if "analysis_records_legacy" in tables:
        raise RuntimeError(
            "A legacy table already exists. Stop and ask for help."
        )

    if "analysis_records" not in tables:
        raise RuntimeError("analysis_records table not found.")

    conn.execute(
        "ALTER TABLE analysis_records RENAME TO analysis_records_legacy"
    )
    conn.commit()
    conn.close()

    # Import the current application to create its correct table.
    import main

    conn = sqlite3.connect(db_path)
    conn.execute("""
        INSERT INTO analysis_records (
            id, filename, document_text, document_summary,
            analysis_type, ai_report, ai_status, file_hash,
            word_count, created_at
        )
        SELECT
            id,
            COALESCE(filename, document_name, 'Pasted text'),
            document_text,
            document_summary,
            analysis_type,
            CAST(ai_report AS TEXT),
            COALESCE(ai_status, 'not_run'),
            COALESCE(file_hash, sha256),
            word_count,
            created_at
        FROM analysis_records_legacy
    """)
    conn.commit()

    count = conn.execute(
        "SELECT COUNT(*) FROM analysis_records"
    ).fetchone()[0]
    print(f"Migration completed. Records preserved: {count}")
    print("The original table remains as analysis_records_legacy.")
    conn.close()

except Exception:
    print("Migration failed. Restoring the original database backup.")
    shutil.copy2(backup_path, db_path)
    raise
