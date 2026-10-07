"""Generic CRUD resources with per-table business rules (hooks)."""
import json
import re
from datetime import date, timedelta

from . import constants as C
from .db import now, today

ACCOUNT_JOIN = "LEFT JOIN accounts a ON a.id = t.account_id"
ACCOUNT_COLS = "a.named_insured AS account_name, a.territory AS territory, a.status AS account_status"


class ValidationError(Exception):
    pass


def to_number(value, cast=float):
    if value is None:
        return None
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return cast(value)
    s = re.sub(r"[,$%\s]", "", str(value))
    if s == "":
        return None
    try:
        return cast(float(s))
    except ValueError:
        raise ValidationError(f"'{value}' is not a number")


def to_bool(value):
    if isinstance(value, str):
        return 1 if value.lower() in ("1", "true", "yes", "on") else 0
    return 1 if value else 0


def to_text(value):
    if value is None:
        return None
    s = str(value).strip()
    return s or None


COERCE = {
    "text": to_text,
    "date": to_text,
    "real": lambda v: to_number(v, float),
    "int": lambda v: to_number(v, int),
    "bool": to_bool,
    "json": lambda v: json.dumps(v if isinstance(v, list) else ([] if v in (None, "") else [v])),
}


class Resource:
    def __init__(self, table, fields, required=(), select=None, joins="", order="t.id DESC",
                 before_save=None, after_save=None, json_out=(), updatable=True, deletable=True):
        self.table = table
        self.fields = fields
        self.required = required
        self.select = select or "t.*"
        self.joins = joins
        self.order = order
        self.before_save = before_save
        self.after_save = after_save
        self.json_out = json_out
        self.updatable = updatable
        self.deletable = deletable

    # -- helpers -----------------------------------------------------------
    def clean(self, payload, partial):
        data = {}
        for name, kind in self.fields.items():
            if name in payload:
                data[name] = COERCE[kind](payload[name])
        if not partial:
            for name in self.required:
                if data.get(name) in (None, ""):
                    raise ValidationError(f"{name.replace('_', ' ').title()} is required")
        else:
            for name in self.required:
                if name in data and data[name] in (None, ""):
                    raise ValidationError(f"{name.replace('_', ' ').title()} is required")
        return data

    def row_out(self, row):
        if row is None:
            return None
        d = dict(row)
        for name in self.json_out:
            try:
                d[name] = json.loads(d.get(name) or "[]")
            except ValueError:
                d[name] = []
        return d

    def base_query(self):
        return f"SELECT {self.select} FROM {self.table} t {self.joins}"

    # -- operations ----------------------------------------------------------
    def list(self, db, args):
        archived = 1 if args.get("archived") in ("1", "true") else 0
        where, params = ["t.archived = ?"], [archived]
        for key, value in args.items():
            if key in self.fields or key in ("id",):
                where.append(f"t.{key} = ?")
                params.append(value)
        sql = f"{self.base_query()} WHERE {' AND '.join(where)} ORDER BY {self.order}"
        return [self.row_out(r) for r in db.execute(sql, params).fetchall()]

    def get(self, db, row_id):
        row = db.execute(f"{self.base_query()} WHERE t.id = ?", (row_id,)).fetchone()
        return self.row_out(row)

    def raw(self, db, row_id):
        row = db.execute(f"SELECT * FROM {self.table} WHERE id = ?", (row_id,)).fetchone()
        return dict(row) if row else None

    def create(self, db, payload):
        data = self.clean(payload, partial=False)
        if self.before_save:
            self.before_save(db, data, None, payload)
        ts = now()
        data["created_at"] = ts
        data["updated_at"] = ts
        cols = ", ".join(data)
        marks = ", ".join("?" for _ in data)
        cur = db.execute(f"INSERT INTO {self.table} ({cols}) VALUES ({marks})", list(data.values()))
        row_id = cur.lastrowid
        if self.after_save:
            self.after_save(db, row_id, data, None, payload)
        db.commit()
        return self.get(db, row_id)

    def update(self, db, row_id, payload):
        if not self.updatable:
            raise ValidationError("This record cannot be edited")
        old = self.raw(db, row_id)
        if old is None:
            return None
        data = self.clean(payload, partial=True)
        if self.before_save:
            self.before_save(db, data, old, payload)
        data["updated_at"] = now()
        sets = ", ".join(f"{k} = ?" for k in data)
        db.execute(f"UPDATE {self.table} SET {sets} WHERE id = ?", [*data.values(), row_id])
        if self.after_save:
            self.after_save(db, row_id, data, old, payload)
        db.commit()
        return self.get(db, row_id)

    def set_archived(self, db, row_id, flag):
        if not self.deletable:
            raise ValidationError("This record cannot be archived")
        db.execute(f"UPDATE {self.table} SET archived = ?, updated_at = ? WHERE id = ?",
                   (1 if flag else 0, now(), row_id))
        db.commit()


# ---------------------------------------------------------------------------
# Shared helpers used by hooks
# ---------------------------------------------------------------------------

def insert(db, table, **values):
    ts = now()
    values.update(created_at=ts, updated_at=ts)
    cols = ", ".join(values)
    marks = ", ".join("?" for _ in values)
    return db.execute(f"INSERT INTO {table} ({cols}) VALUES ({marks})", list(values.values())).lastrowid


def update(db, table, row_id, **values):
    values["updated_at"] = now()
    sets = ", ".join(f"{k} = ?" for k in values)
    db.execute(f"UPDATE {table} SET {sets} WHERE id = ?", [*values.values(), row_id])


def setting(db, key, default=None):
    row = db.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    return row["value"] if row and row["value"] not in (None, "") else default


def default_commission_pct(db, line):
    row = db.execute("SELECT commission_pct FROM line_defaults WHERE line = ?", (line,)).fetchone()
    return row["commission_pct"] if row else None


def changed(field, data, old):
    return field in data and (old is None or data[field] != old.get(field))


def merged(data, old, field):
    if field in data:
        return data[field]
    return old.get(field) if old else None


def add_days(iso, days):
    return (date.fromisoformat(iso) + timedelta(days=days)).isoformat()


def account_name(db, account_id):
    row = db.execute("SELECT named_insured FROM accounts WHERE id = ?", (account_id,)).fetchone()
    return row["named_insured"] if row else ""


# ---------------------------------------------------------------------------
# Hooks
# ---------------------------------------------------------------------------

def account_before(db, data, old, payload):
    if old is None:
        data.setdefault("date_added", today())
        data.setdefault("status", "Prospect")
        data["date_added"] = data.get("date_added") or today()
        data["status_changed_at"] = now()
    elif changed("status", data, old):
        data["status_changed_at"] = now()


def account_after(db, row_id, data, old, payload):
    if old is None and data.get("status") == "Prospect" and to_bool(payload.get("add_to_pipeline")):
        deals.create_nocommit(db, {"account_id": row_id, "stage": "Identified",
                                   "source": payload.get("source"),
                                   "est_premium": payload.get("est_premium")})


def contact_after(db, row_id, data, old, payload):
    if data.get("is_primary"):
        account_id = merged(data, old, "account_id")
        db.execute("UPDATE contacts SET is_primary = 0 WHERE account_id = ? AND id != ?",
                   (account_id, row_id))


def policy_before(db, data, old, payload):
    line = merged(data, old, "line")
    if old is None and data.get("commission_pct") is None:
        data["commission_pct"] = default_commission_pct(db, line)
    premium = merged(data, old, "premium")
    pct = merged(data, old, "commission_pct")
    if "premium" in data or "commission_pct" in data or old is None:
        data["commission_amt"] = round(premium * pct / 100, 2) if premium is not None and pct is not None else None
    if old is None and data.get("effective_date") and not data.get("expiration_date"):
        data["expiration_date"] = add_days(data["effective_date"], 365)


def deal_before(db, data, old, payload):
    if old is None:
        data["stage"] = data.get("stage") or "Identified"
    if changed("stage", data, old):
        data["stage_entered_at"] = now()
    # Auto-estimate commission when premium is set and no commission was entered.
    if data.get("est_commission") is None and (old is None or "est_premium" in data):
        premium = merged(data, old, "est_premium")
        if premium is not None:
            pct = to_number(setting(db, "pipeline_commission_pct", "15")) or 0
            data["est_commission"] = round(premium * pct / 100, 2)


STAGE_TO_ACCOUNT_STATUS = {"BOR Submitted": "BOR Submitted", "Won": "BOR Won", "Lost": "Lost"}


def deal_after(db, row_id, data, old, payload):
    if changed("stage", data, old):
        insert(db, "deal_stage_history", deal_id=row_id, stage=data["stage"], entered_at=now())
        status = STAGE_TO_ACCOUNT_STATUS.get(data["stage"])
        account_id = merged(data, old, "account_id")
        if status:
            update(db, "accounts", account_id, status=status, status_changed_at=now())
        elif old is not None and old.get("stage") in STAGE_TO_ACCOUNT_STATUS:
            # Moved back out of BOR/Won/Lost into an earlier stage.
            update(db, "accounts", account_id, status="Prospect", status_changed_at=now())


def populate_documents(db, account_id, line, submission_id):
    """Add the checklist template for a line, skipping items already on the account."""
    items = db.execute("SELECT name FROM doc_templates WHERE line = ? AND archived = 0 ORDER BY sort_order, id",
                       (line,)).fetchall()
    for item in items:
        exists = db.execute(
            "SELECT 1 FROM documents WHERE account_id = ? AND line = ? AND name = ? AND archived = 0",
            (account_id, line, item["name"])).fetchone()
        if not exists:
            insert(db, "documents", account_id=account_id, submission_id=submission_id, line=line,
                   name=item["name"], status="Not Requested")


def submission_before(db, data, old, payload):
    if old is None:
        data["date_submitted"] = data.get("date_submitted") or today()
        if data.get("policy_id") and not data.get("line"):
            pol = db.execute("SELECT line FROM policies WHERE id = ?", (data["policy_id"],)).fetchone()
            if pol:
                data["line"] = pol["line"]
        if not data.get("line"):
            raise ValidationError("Line is required")
    status = merged(data, old, "status")
    if changed("status", data, old) and status == "Quoted" and not merged(data, old, "quote_date"):
        data["quote_date"] = today()


def submission_after(db, row_id, data, old, payload):
    account_id = merged(data, old, "account_id")
    policy_id = merged(data, old, "policy_id")
    if old is None:
        populate_documents(db, account_id, data["line"], row_id)
        if policy_id:
            pol = db.execute("SELECT status FROM policies WHERE id = ?", (policy_id,)).fetchone()
            if pol and pol["status"] in ("Not Yet Marketed", "Marketing"):
                update(db, "policies", policy_id, status="Submitted")
    if policy_id and changed("status", data, old):
        status = data["status"]
        if status == "Quoted":
            pol = db.execute("SELECT status FROM policies WHERE id = ?", (policy_id,)).fetchone()
            if pol and pol["status"] in ("Not Yet Marketed", "Marketing", "Submitted"):
                update(db, "policies", policy_id, status="Quoted")
        elif status == "Bound":
            pol = policies.raw(db, policy_id)
            values = {"status": "Bound", "carrier": merged(data, old, "carrier") or pol["carrier"],
                      "aor_status": "AOR"}
            quote = merged(data, old, "quote_amount")
            if quote is not None:
                values["premium"] = quote
                if pol["commission_pct"] is not None:
                    values["commission_amt"] = round(quote * pol["commission_pct"] / 100, 2)
            update(db, "policies", policy_id, **values)


def document_before(db, data, old, payload):
    status = merged(data, old, "status")
    if changed("status", data, old):
        if status == "Requested" and not merged(data, old, "date_requested"):
            data["date_requested"] = today()
        if status == "Received" and not merged(data, old, "date_received"):
            data["date_received"] = today()


def is_loss_run(name):
    return (name or "").lower().startswith("loss run")


def document_after(db, row_id, data, old, payload):
    if not changed("status", data, old):
        return
    doc = documents.raw(db, row_id)
    status = doc["status"]
    if status == "Requested":
        due = add_days(doc["date_requested"] or today(), 7)
        title = f"Follow up: {doc['name']}" + (f" ({doc['line']})" if doc["line"] else "")
        open_task = db.execute("SELECT 1 FROM tasks WHERE document_id = ? AND status = 'Open' AND archived = 0",
                               (row_id,)).fetchone()
        if not open_task:
            insert(db, "tasks", account_id=doc["account_id"], document_id=row_id, title=title,
                   description=f"Document requested {doc['date_requested'] or today()} for "
                               f"{account_name(db, doc['account_id'])}",
                   due_date=due, priority="Medium", status="Open", category="Document Chase",
                   assigned_to="Self")
        if is_loss_run(doc["name"]):
            exists = db.execute("SELECT 1 FROM loss_runs WHERE document_id = ? AND archived = 0",
                                (row_id,)).fetchone()
            if not exists:
                pol = db.execute(
                    "SELECT carrier, prior_carrier FROM policies WHERE account_id = ? AND line = ? AND archived = 0 "
                    "ORDER BY expiration_date DESC LIMIT 1", (doc["account_id"], doc["line"])).fetchone()
                carrier = (pol["carrier"] or pol["prior_carrier"]) if pol else None
                insert(db, "loss_runs", account_id=doc["account_id"], document_id=row_id, carrier=carrier,
                       line=doc["line"], date_requested=doc["date_requested"] or today(), status="Requested")
    if status in ("Received", "N/A"):
        # Close the auto-generated chase task and sync any linked loss run.
        db.execute("UPDATE tasks SET status = 'Done', completed_at = ?, updated_at = ? "
                   "WHERE document_id = ? AND status = 'Open'", (now(), now(), row_id))
        db.execute("UPDATE loss_runs SET status = ?, date_received = COALESCE(date_received, ?), updated_at = ? "
                   "WHERE document_id = ? AND status != ?",
                   (status, today() if status == "Received" else None, now(), row_id, status))


def loss_run_before(db, data, old, payload):
    if old is None:
        data["date_requested"] = data.get("date_requested") or today()
    if changed("status", data, old) and merged(data, old, "status") == "Received" \
            and not merged(data, old, "date_received"):
        data["date_received"] = today()


def loss_run_after(db, row_id, data, old, payload):
    if not changed("status", data, old):
        return
    lr = loss_runs.raw(db, row_id)
    if lr["document_id"] and lr["status"] in ("Received", "N/A"):
        doc = documents.raw(db, lr["document_id"])
        if doc and doc["status"] != lr["status"]:
            documents.update_nocommit(db, lr["document_id"], {"status": lr["status"],
                                                              "date_received": lr["date_received"]})


def activity_before(db, data, old, payload):
    if old is None:
        data["activity_date"] = data.get("activity_date") or today()


def task_before(db, data, old, payload):
    if old is None:
        data["due_date"] = data.get("due_date") or today()
    if changed("status", data, old):
        data["completed_at"] = now() if data["status"] == "Done" else None


def team_before(db, data, old, payload):
    if old is None:
        data["handoff_date"] = data.get("handoff_date") or today()


# Non-committing variants used for cascades inside another write.
def _create_nocommit(self, db, payload):
    data = self.clean(payload, partial=False)
    if self.before_save:
        self.before_save(db, data, None, payload)
    row_id = insert(db, self.table, **data)
    if self.after_save:
        self.after_save(db, row_id, data, None, payload)
    return row_id


def _update_nocommit(self, db, row_id, payload):
    old = self.raw(db, row_id)
    data = self.clean(payload, partial=True)
    if self.before_save:
        self.before_save(db, data, old, payload)
    update(db, self.table, row_id, **data)
    if self.after_save:
        self.after_save(db, row_id, data, old, payload)


Resource.create_nocommit = _create_nocommit
Resource.update_nocommit = _update_nocommit


# ---------------------------------------------------------------------------
# Resource definitions
# ---------------------------------------------------------------------------

def renewal_date_sql(alias="t"):
    return (f"CASE WHEN {alias}.multi_year = 1 AND {alias}.term_end_date IS NOT NULL "
            f"THEN {alias}.term_end_date ELSE {alias}.expiration_date END")


def in_force_sql(alias="t"):
    """Bound/renewed, not archived, and not yet past its renewal date."""
    return (f"({alias}.archived = 0 AND {alias}.status IN ('Bound', 'Renewed') AND "
            f"({renewal_date_sql(alias)} IS NULL OR {renewal_date_sql(alias)} >= date('now', 'localtime')))")


RENEWAL_DATE_SQL = renewal_date_sql()

accounts = Resource(
    "accounts",
    {"named_insured": "text", "dba": "text", "address": "text", "city": "text", "state": "text",
     "zip": "text", "county": "text", "fein": "text", "website": "text", "types": "json",
     "status": "text", "territory": "text", "annual_revenue": "real", "num_employees": "int",
     "prior_broker_name": "text", "prior_broker_contact": "text", "prior_broker_phone": "text",
     "prior_broker_email": "text", "date_added": "date"},
    required=("named_insured",),
    select=f"""t.*,
        (SELECT name FROM contacts c WHERE c.account_id = t.id AND c.archived = 0
            ORDER BY c.is_primary DESC, c.id LIMIT 1) AS primary_contact,
        (SELECT COUNT(*) FROM policies p WHERE p.account_id = t.id AND p.archived = 0) AS policy_count,
        (SELECT COALESCE(SUM(p.premium), 0) FROM policies p WHERE p.account_id = t.id
            AND {in_force_sql("p")}) AS bound_premium""",
    order="t.named_insured COLLATE NOCASE",
    before_save=account_before, after_save=account_after, json_out=("types",),
)

contacts = Resource(
    "contacts",
    {"account_id": "int", "name": "text", "title": "text", "phone": "text", "email": "text", "is_primary": "bool"},
    required=("account_id", "name"), select=f"t.*, {ACCOUNT_COLS}", joins=ACCOUNT_JOIN,
    order="t.is_primary DESC, t.name COLLATE NOCASE", after_save=contact_after,
)

notes = Resource(
    "account_notes", {"account_id": "int", "body": "text"}, required=("account_id", "body"),
    order="t.created_at DESC, t.id DESC", updatable=False, deletable=False,
)

policies = Resource(
    "policies",
    {"account_id": "int", "line": "text", "carrier": "text", "policy_number": "text",
     "effective_date": "date", "expiration_date": "date", "premium": "real", "commission_pct": "real",
     "coverage_form": "text", "retro_date": "date", "experience_mod": "real", "status": "text",
     "aor_status": "text", "prior_carrier": "text", "multi_year": "bool", "term_end_date": "date",
     "renewed_to_id": "int", "notes": "text"},
    required=("account_id", "line"),
    select=f"t.*, {ACCOUNT_COLS}, {RENEWAL_DATE_SQL} AS renewal_date",
    joins=ACCOUNT_JOIN, order="t.expiration_date",
    before_save=policy_before,
)

deals = Resource(
    "deals",
    {"account_id": "int", "stage": "text", "est_premium": "real", "est_commission": "real",
     "source": "text", "target_date": "date", "lost_reason": "text", "lost_reason_detail": "text",
     "notes": "text"},
    required=("account_id",),
    select=f"""t.*, {ACCOUNT_COLS}, a.dba AS dba, a.types AS account_types,
        CAST(julianday('now', 'localtime') - julianday(t.stage_entered_at) AS INTEGER) AS days_in_stage""",
    joins=ACCOUNT_JOIN, order="t.stage_entered_at DESC",
    before_save=deal_before, after_save=deal_after,
)

submissions = Resource(
    "submissions",
    {"account_id": "int", "policy_id": "int", "line": "text", "carrier": "text", "wholesaler": "text",
     "date_submitted": "date", "status": "text", "quote_amount": "real", "quote_date": "date",
     "decline_reason": "text", "placement_exec": "text", "target_premium": "real", "notes": "text"},
    required=("account_id",),
    select=f"""t.*, {ACCOUNT_COLS},
        (SELECT COUNT(*) FROM subjectivities s WHERE s.submission_id = t.id AND s.archived = 0) AS subj_total,
        (SELECT COUNT(*) FROM subjectivities s WHERE s.submission_id = t.id AND s.archived = 0 AND s.done = 1) AS subj_done""",
    joins=ACCOUNT_JOIN, order="t.date_submitted DESC, t.id DESC",
    before_save=submission_before, after_save=submission_after,
)

subjectivities = Resource(
    "subjectivities", {"submission_id": "int", "text": "text", "done": "bool"},
    required=("submission_id", "text"), order="t.id",
)

documents = Resource(
    "documents",
    {"account_id": "int", "submission_id": "int", "line": "text", "name": "text", "status": "text",
     "date_requested": "date", "date_received": "date", "notes": "text"},
    required=("account_id", "name"),
    select=f"""t.*, {ACCOUNT_COLS},
        CAST(julianday('now', 'localtime') - julianday(t.date_requested) AS INTEGER) AS days_outstanding""",
    joins=ACCOUNT_JOIN, order="t.line, t.id",
    before_save=document_before, after_save=document_after,
)

loss_runs = Resource(
    "loss_runs",
    {"account_id": "int", "document_id": "int", "carrier": "text", "line": "text",
     "date_requested": "date", "date_received": "date", "status": "text", "notes": "text"},
    required=("account_id",),
    select=f"""t.*, {ACCOUNT_COLS},
        CAST(julianday(COALESCE(t.date_received, date('now', 'localtime'))) - julianday(t.date_requested) AS INTEGER)
            AS days_outstanding""",
    joins=ACCOUNT_JOIN, order="t.date_requested",
    before_save=loss_run_before, after_save=loss_run_after,
)

activities = Resource(
    "activities",
    {"account_id": "int", "type": "text", "activity_date": "date", "summary": "text", "next_step": "text",
     "follow_up_date": "date", "follow_up_done": "bool", "priority": "text"},
    required=("type",), select=f"t.*, {ACCOUNT_COLS}", joins=ACCOUNT_JOIN,
    order="t.activity_date DESC, t.id DESC", before_save=activity_before,
)

tasks = Resource(
    "tasks",
    {"account_id": "int", "document_id": "int", "title": "text", "description": "text", "due_date": "date",
     "priority": "text", "status": "text", "category": "text", "assigned_to": "text"},
    required=("title",), select=f"t.*, {ACCOUNT_COLS}", joins=ACCOUNT_JOIN,
    order="t.status DESC, t.due_date, CASE t.priority WHEN 'High' THEN 0 WHEN 'Medium' THEN 1 ELSE 2 END",
    before_save=task_before,
)

team = Resource(
    "team_assignments",
    {"account_id": "int", "role": "text", "person_name": "text", "handoff_date": "date",
     "handoff_status": "text", "notes": "text"},
    required=("account_id", "role"), select=f"t.*, {ACCOUNT_COLS}", joins=ACCOUNT_JOIN,
    order="t.handoff_date DESC, t.id DESC", before_save=team_before,
)

carriers = Resource("carriers", {"name": "text"}, required=("name",), order="t.name COLLATE NOCASE")
account_types = Resource("account_types", {"name": "text"}, required=("name",), order="t.id")
team_members = Resource("team_members", {"name": "text", "team": "text", "email": "text", "phone": "text"},
                        required=("name",), order="t.name COLLATE NOCASE")
doc_templates = Resource("doc_templates", {"line": "text", "name": "text", "sort_order": "int"},
                         required=("line", "name"), order="t.line, t.sort_order, t.id")

REGISTRY = {
    "accounts": accounts,
    "contacts": contacts,
    "notes": notes,
    "policies": policies,
    "deals": deals,
    "submissions": submissions,
    "subjectivities": subjectivities,
    "documents": documents,
    "loss_runs": loss_runs,
    "activities": activities,
    "tasks": tasks,
    "team": team,
    "carriers": carriers,
    "account_types": account_types,
    "team_members": team_members,
    "doc_templates": doc_templates,
}
