"""SQLite connection handling, schema creation and first-run setup."""
import os
import sqlite3
from datetime import date, datetime

from flask import g

from . import constants as C

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.environ.get("CRM_DB_PATH", os.path.join(BASE_DIR, "data", "crm.db"))

# Columns every table gets.
_STD = """
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0
"""

SCHEMA = f"""
CREATE TABLE IF NOT EXISTS settings (
    {_STD},
    key TEXT NOT NULL UNIQUE,
    value TEXT
);

CREATE TABLE IF NOT EXISTS line_defaults (
    {_STD},
    line TEXT NOT NULL UNIQUE,
    commission_pct REAL
);

CREATE TABLE IF NOT EXISTS account_types (
    {_STD},
    name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS carriers (
    {_STD},
    name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS team_members (
    {_STD},
    name TEXT NOT NULL,
    team TEXT,
    email TEXT,
    phone TEXT
);

CREATE TABLE IF NOT EXISTS doc_templates (
    {_STD},
    line TEXT NOT NULL,
    name TEXT NOT NULL,
    sort_order INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS accounts (
    {_STD},
    named_insured TEXT NOT NULL,
    dba TEXT,
    address TEXT,
    city TEXT,
    state TEXT,
    zip TEXT,
    county TEXT,
    fein TEXT,
    website TEXT,
    types TEXT DEFAULT '[]',
    status TEXT DEFAULT 'Prospect',
    territory TEXT,
    annual_revenue REAL,
    num_employees INTEGER,
    prior_broker_name TEXT,
    prior_broker_contact TEXT,
    prior_broker_phone TEXT,
    prior_broker_email TEXT,
    date_added TEXT,
    status_changed_at TEXT
);

CREATE TABLE IF NOT EXISTS contacts (
    {_STD},
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    name TEXT NOT NULL,
    title TEXT,
    phone TEXT,
    email TEXT,
    is_primary INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS account_notes (
    {_STD},
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    body TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS policies (
    {_STD},
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    line TEXT NOT NULL,
    carrier TEXT,
    policy_number TEXT,
    effective_date TEXT,
    expiration_date TEXT,
    premium REAL,
    commission_pct REAL,
    commission_amt REAL,
    coverage_form TEXT DEFAULT 'Occurrence',
    retro_date TEXT,
    experience_mod REAL,
    status TEXT DEFAULT 'Not Yet Marketed',
    aor_status TEXT DEFAULT 'AOR',
    prior_carrier TEXT,
    multi_year INTEGER DEFAULT 0,
    term_end_date TEXT,
    renewed_to_id INTEGER,
    notes TEXT
);

CREATE TABLE IF NOT EXISTS deals (
    {_STD},
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    stage TEXT NOT NULL DEFAULT 'Identified',
    stage_entered_at TEXT,
    est_premium REAL,
    est_commission REAL,
    source TEXT,
    target_date TEXT,
    lost_reason TEXT,
    lost_reason_detail TEXT,
    notes TEXT
);

CREATE TABLE IF NOT EXISTS deal_stage_history (
    {_STD},
    deal_id INTEGER NOT NULL REFERENCES deals(id),
    stage TEXT NOT NULL,
    entered_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS submissions (
    {_STD},
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    policy_id INTEGER REFERENCES policies(id),
    line TEXT NOT NULL,
    carrier TEXT,
    wholesaler TEXT,
    date_submitted TEXT,
    status TEXT DEFAULT 'Pending',
    quote_amount REAL,
    quote_date TEXT,
    decline_reason TEXT,
    placement_exec TEXT,
    target_premium REAL,
    notes TEXT
);

CREATE TABLE IF NOT EXISTS subjectivities (
    {_STD},
    submission_id INTEGER NOT NULL REFERENCES submissions(id),
    text TEXT NOT NULL,
    done INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS documents (
    {_STD},
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    submission_id INTEGER REFERENCES submissions(id),
    line TEXT,
    name TEXT NOT NULL,
    status TEXT DEFAULT 'Not Requested',
    date_requested TEXT,
    date_received TEXT,
    notes TEXT
);

CREATE TABLE IF NOT EXISTS loss_runs (
    {_STD},
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    document_id INTEGER REFERENCES documents(id),
    carrier TEXT,
    line TEXT,
    date_requested TEXT,
    date_received TEXT,
    status TEXT DEFAULT 'Requested',
    notes TEXT
);

CREATE TABLE IF NOT EXISTS activities (
    {_STD},
    account_id INTEGER REFERENCES accounts(id),
    type TEXT NOT NULL,
    activity_date TEXT,
    summary TEXT,
    next_step TEXT,
    follow_up_date TEXT,
    follow_up_done INTEGER DEFAULT 0,
    priority TEXT DEFAULT 'Medium'
);

CREATE TABLE IF NOT EXISTS tasks (
    {_STD},
    account_id INTEGER REFERENCES accounts(id),
    document_id INTEGER REFERENCES documents(id),
    title TEXT NOT NULL,
    description TEXT,
    due_date TEXT,
    priority TEXT DEFAULT 'Medium',
    status TEXT DEFAULT 'Open',
    category TEXT DEFAULT 'Follow-up',
    assigned_to TEXT DEFAULT 'Self',
    completed_at TEXT
);

CREATE TABLE IF NOT EXISTS team_assignments (
    {_STD},
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    role TEXT NOT NULL,
    person_name TEXT,
    handoff_date TEXT,
    handoff_status TEXT DEFAULT 'Handed Off',
    notes TEXT
);

CREATE INDEX IF NOT EXISTS ix_contacts_account ON contacts(account_id);
CREATE INDEX IF NOT EXISTS ix_notes_account ON account_notes(account_id);
CREATE INDEX IF NOT EXISTS ix_policies_account ON policies(account_id);
CREATE INDEX IF NOT EXISTS ix_policies_exp ON policies(expiration_date);
CREATE INDEX IF NOT EXISTS ix_deals_account ON deals(account_id);
CREATE INDEX IF NOT EXISTS ix_subs_account ON submissions(account_id);
CREATE INDEX IF NOT EXISTS ix_docs_account ON documents(account_id);
CREATE INDEX IF NOT EXISTS ix_lossruns_account ON loss_runs(account_id);
CREATE INDEX IF NOT EXISTS ix_acts_account ON activities(account_id);
CREATE INDEX IF NOT EXISTS ix_acts_date ON activities(activity_date);
CREATE INDEX IF NOT EXISTS ix_tasks_due ON tasks(due_date);
CREATE INDEX IF NOT EXISTS ix_team_account ON team_assignments(account_id);
"""

DEFAULT_SETTINGS = {
    "user_name": "",
    "user_title": "",
    "user_email": "",
    "user_phone": "",
    "agency_name": "",
    "pipeline_commission_pct": "15",
    "export_header": "1",
}


def now():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def today():
    return date.today().isoformat()


def connect(path=None):
    conn = sqlite3.connect(path or DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def get_db():
    if "db" not in g:
        g.db = connect()
    return g.db


def close_db(_exc=None):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def _insert(conn, table, **values):
    ts = now()
    values.update(created_at=ts, updated_at=ts)
    cols = ", ".join(values)
    marks = ", ".join("?" for _ in values)
    conn.execute(f"INSERT INTO {table} ({cols}) VALUES ({marks})", list(values.values()))


def init_db(path=None):
    """Create the schema and configuration defaults. Safe to run on every start.

    Only configuration is seeded (option lists, carriers, commission defaults,
    checklist templates) -- never business data.
    """
    path = path or DB_PATH
    os.makedirs(os.path.dirname(path), exist_ok=True)
    conn = connect(path)
    conn.executescript(SCHEMA)

    for key, value in DEFAULT_SETTINGS.items():
        if not conn.execute("SELECT 1 FROM settings WHERE key=?", (key,)).fetchone():
            _insert(conn, "settings", key=key, value=value)

    for line, pct in C.DEFAULT_COMMISSION.items():
        if not conn.execute("SELECT 1 FROM line_defaults WHERE line=?", (line,)).fetchone():
            _insert(conn, "line_defaults", line=line, commission_pct=pct)

    seeded = conn.execute("SELECT value FROM settings WHERE key='_seeded'").fetchone()
    if not seeded:
        for name in C.DEFAULT_ACCOUNT_TYPES:
            _insert(conn, "account_types", name=name)
        for name in C.DEFAULT_CARRIERS:
            _insert(conn, "carriers", name=name)
        for line, items in C.DEFAULT_DOC_TEMPLATES.items():
            for i, item in enumerate(items):
                _insert(conn, "doc_templates", line=line, name=item, sort_order=i)
        _insert(conn, "settings", key="_seeded", value="1")

    conn.commit()
    conn.close()
