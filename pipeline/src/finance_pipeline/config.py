"""Centralized project paths."""
from pathlib import Path

# Project root is two levels above this file's package:
# pipeline/src/finance_pipeline/config.py -> pipeline/src/finance_pipeline
# parents[3] -> project root
PROJECT_ROOT = Path(__file__).resolve().parents[3]

DB_DIR = PROJECT_ROOT / "db"
DB_PATH = DB_DIR / "finance.sqlite"
MIGRATIONS_DIR = DB_DIR / "migrations"

RAW_DIR = PROJECT_ROOT / "raw"
RAW_CARDS = RAW_DIR / "cards"
RAW_CHECKING = RAW_DIR / "checking"
RAW_INVESTMENTS = RAW_DIR / "investments"
RAW_KUBERA = RAW_DIR / "kubera"
RAW_CHASE = RAW_DIR / "chase"
RAW_INBOX = RAW_DIR / "_inbox"

BACKUPS_DIR = PROJECT_ROOT / "backups"

PIPELINE_DIR = PROJECT_ROOT / "pipeline"
RULES_PATH = PIPELINE_DIR / "rules.yaml"
RULES_EXAMPLE_PATH = PIPELINE_DIR / "rules.example.yaml"

RAW_EMAIL = RAW_DIR / "email"

SECRETS_DIR = PROJECT_ROOT / ".secrets"
GMAIL_CLIENT_SECRET = SECRETS_DIR / "gmail_client.json"
GMAIL_TOKEN = SECRETS_DIR / "gmail_token.json"
