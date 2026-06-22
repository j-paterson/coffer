"""Centralized project paths."""
import os
from pathlib import Path

# Project root is two levels above this file's package:
# pipeline/src/finance_pipeline/config.py -> pipeline/src/finance_pipeline
# parents[3] -> project root
PROJECT_ROOT = Path(__file__).resolve().parents[3]

DB_DIR = PROJECT_ROOT / "db"

# Honor FINANCE_DB so the sidecar targets the same database as the TS server
# and CLI, both of which read FINANCE_DB. This keeps post-sync hooks correct
# when the database is relocated outside the checkout (e.g. a dog-fooding
# instance with FINANCE_DB=~/coffer-data/finance.sqlite). Falls back to the
# in-repo default when unset.
_FINANCE_DB = os.environ.get("FINANCE_DB")
DB_PATH = Path(_FINANCE_DB).resolve() if _FINANCE_DB else DB_DIR / "finance.sqlite"

MIGRATIONS_DIR = DB_DIR / "migrations"

RAW_DIR = PROJECT_ROOT / "raw"
RAW_INBOX = RAW_DIR / "_inbox"

BACKUPS_DIR = PROJECT_ROOT / "backups"

PIPELINE_DIR = PROJECT_ROOT / "pipeline"
RULES_PATH = PIPELINE_DIR / "rules.yaml"
RULES_EXAMPLE_PATH = PIPELINE_DIR / "rules.example.yaml"

RAW_EMAIL = RAW_DIR / "email"

SECRETS_DIR = PROJECT_ROOT / ".secrets"
GMAIL_CLIENT_SECRET = SECRETS_DIR / "gmail_client.json"
GMAIL_TOKEN = SECRETS_DIR / "gmail_token.json"
