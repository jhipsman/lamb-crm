"""JSON API: generic CRUD plus dashboard, calendar, search, commission and reports."""
import os
from datetime import date, timedelta

from flask import Blueprint, jsonify, request, send_file

from . import constants as C
from .db import DB_PATH, get_db, now, today
from .resources import (REGISTRY, ValidationError, add_days, in_force_sql, insert, populate_documents,
                        renewal_date_sql, to_number)

api = Blueprint("api", __name__, url_prefix="/api")

ACTIVE_SUB_STATUSES = ("Pending", "Need Additional Info", "Quoted")
PRIORITY_ORDER = "CASE {col} WHEN 'High' THEN 0 WHEN 'Medium' THEN 1 ELSE 2 END"


def rows(sql, params=()):
    return [dict(r) for r in get_db().execute(sql, params).fetchall()]


def one(sql, params=()):
    r = get_db().execute(sql, params).fetchone()
    return dict(r) if r else None


def scalar(sql, params=()):
    r = get_db().execute(sql, params).fetchone()
    return r[0] if r else None


def in_clause(values):
    return "(" + ", ".join("?" for _ in values) + ")"


@api.errorhandler(ValidationError)
def _validation(err):
    return jsonify(error=str(err)), 400


# ---------------------------------------------------------------------------
# Generic CRUD
# ---------------------------------------------------------------------------

def resource(name):
    res = REGISTRY.get(name)
    if res is None:
        raise ValidationError(f"Unknown resource '{name}'")
    return res


@api.get("/r/<name>")
def list_records(name):
    return jsonify(resource(name).list(get_db(), request.args))


@api.post("/r/<name>")
def create_record(name):
    return jsonify(resource(name).create(get_db(), request.get_json(force=True) or {})), 201


@api.get("/r/<name>/<int:row_id>")
def get_record(name, row_id):
    row = resource(name).get(get_db(), row_id)
    return (jsonify(row), 200) if row else (jsonify(error="Not found"), 404)


@api.put("/r/<name>/<int:row_id>")
def update_record(name, row_id):
    row = resource(name).update(get_db(), row_id, request.get_json(force=True) or {})
    return (jsonify(row), 200) if row else (jsonify(error="Not found"), 404)


@api.delete("/r/<name>/<int:row_id>")
def archive_record(name, row_id):
    resource(name).set_archived(get_db(), row_id, True)
    return jsonify(ok=True)


@api.post("/r/<name>/<int:row_id>/restore")
def restore_record(name, row_id):
    resource(name).set_archived(get_db(), row_id, False)
    return jsonify(ok=True)


# ---------------------------------------------------------------------------
# Lookups and settings
# ---------------------------------------------------------------------------

@api.get("/lookups")
def lookups():
    data = C.lookups()
    data["carriers"] = [r["name"] for r in rows("SELECT name FROM carriers WHERE archived = 0 ORDER BY name COLLATE NOCASE")]
    data["account_types"] = [r["name"] for r in rows("SELECT name FROM account_types WHERE archived = 0 ORDER BY id")]
    data["team_members"] = rows("SELECT id, name, team FROM team_members WHERE archived = 0 ORDER BY name COLLATE NOCASE")
    data["line_defaults"] = {r["line"]: r["commission_pct"] for r in rows("SELECT line, commission_pct FROM line_defaults")}
    data["settings"] = {r["key"]: r["value"] for r in rows("SELECT key, value FROM settings WHERE key NOT LIKE '\\_%' ESCAPE '\\'")}
    data["today"] = today()
    return jsonify(data)


@api.put("/settings")
def save_settings():
    db = get_db()
    payload = request.get_json(force=True) or {}
    for key, value in (payload.get("settings") or {}).items():
        if key.startswith("_"):
            continue
        if db.execute("SELECT 1 FROM settings WHERE key = ?", (key,)).fetchone():
            db.execute("UPDATE settings SET value = ?, updated_at = ? WHERE key = ?", (value, now(), key))
        else:
            insert(db, "settings", key=key, value=value)
    for line, pct in (payload.get("line_defaults") or {}).items():
        pct = to_number(pct)
        if db.execute("SELECT 1 FROM line_defaults WHERE line = ?", (line,)).fetchone():
            db.execute("UPDATE line_defaults SET commission_pct = ?, updated_at = ? WHERE line = ?", (pct, now(), line))
        else:
            insert(db, "line_defaults", line=line, commission_pct=pct)
    db.commit()
    return lookups()


@api.get("/backup")
def backup():
    return send_file(DB_PATH, as_attachment=True,
                     download_name=f"crm-backup-{today()}{os.path.splitext(DB_PATH)[1] or '.db'}")


# ---------------------------------------------------------------------------
# Account detail
# ---------------------------------------------------------------------------

@api.get("/accounts/<int:account_id>/full")
def account_full(account_id):
    db = get_db()
    account = REGISTRY["accounts"].get(db, account_id)
    if not account:
        return jsonify(error="Not found"), 404
    args = {"account_id": account_id}
    out = {"account": account}
    for key, res in (("contacts", "contacts"), ("notes", "notes"), ("policies", "policies"), ("deals", "deals"),
                     ("submissions", "submissions"), ("documents", "documents"), ("loss_runs", "loss_runs"),
                     ("activities", "activities"), ("tasks", "tasks"), ("team", "team")):
        out[key] = REGISTRY[res].list(db, args)
    return jsonify(out)


@api.post("/policies/<int:policy_id>/renew")
def renew_policy(policy_id):
    """Create the next policy term and link it to the current one."""
    db = get_db()
    old = REGISTRY["policies"].raw(db, policy_id)
    if not old:
        return jsonify(error="Not found"), 404
    start = old["term_end_date"] if old["multi_year"] and old["term_end_date"] else old["expiration_date"]
    start = start or today()
    payload = {k: old[k] for k in ("account_id", "line", "carrier", "commission_pct", "coverage_form",
                                   "retro_date", "experience_mod", "aor_status", "premium")}
    payload.update(effective_date=start, expiration_date=add_days(start, 365), status="Marketing",
                   prior_carrier=old["carrier"], multi_year=0)
    new = REGISTRY["policies"].create(db, payload)
    db.execute("UPDATE policies SET renewed_to_id = ?, updated_at = ? WHERE id = ?", (new["id"], now(), policy_id))
    db.commit()
    return jsonify(new), 201


@api.post("/accounts/<int:account_id>/populate_docs")
def populate_docs(account_id):
    """Add a line's document checklist to an account without creating a submission."""
    line = (request.get_json(force=True) or {}).get("line")
    if not line:
        raise ValidationError("Line is required")
    db = get_db()
    populate_documents(db, account_id, line, None)
    db.commit()
    return jsonify(REGISTRY["documents"].list(db, {"account_id": account_id}))


@api.get("/deals/<int:deal_id>/history")
def deal_history(deal_id):
    return jsonify(rows("SELECT stage, entered_at FROM deal_stage_history WHERE deal_id = ? ORDER BY entered_at, id",
                        (deal_id,)))


# ---------------------------------------------------------------------------
# Dashboard / Today
# ---------------------------------------------------------------------------

RENEWAL_BASE = f"""
    SELECT p.id, p.account_id, p.line, p.carrier, p.policy_number, p.premium, p.status, p.commission_amt,
           p.aor_status, p.expiration_date, {renewal_date_sql('p')} AS renewal_date,
           a.named_insured AS account_name, a.territory
    FROM policies p JOIN accounts a ON a.id = p.account_id
    WHERE p.archived = 0 AND a.archived = 0 AND p.renewed_to_id IS NULL
      AND p.status NOT IN ('Lost', 'Cancelled')
"""


def call_counts():
    t = date.today()
    week_start = (t - timedelta(days=t.weekday())).isoformat()
    month_start = t.replace(day=1).isoformat()
    q = "SELECT COUNT(*) FROM activities WHERE archived = 0 AND type = 'Call' AND activity_date >= ? AND activity_date <= ?"
    return {"today": scalar(q, (t.isoformat(), t.isoformat())),
            "week": scalar(q, (week_start, t.isoformat())),
            "month": scalar(q, (month_start, t.isoformat()))}


def month_keys(n):
    t = date.today().replace(day=1)
    keys = []
    for _ in range(n):
        keys.append(t.strftime("%Y-%m"))
        t = (t + timedelta(days=32)).replace(day=1)
    return keys


@api.get("/dashboard")
def dashboard():
    t = today()
    rd = renewal_date_sql("p")
    renewals_90 = rows(RENEWAL_BASE + f" AND {rd} >= ? AND {rd} <= ? ORDER BY {rd}", (t, add_days(t, 90)))

    keys = month_keys(6)
    by_month = {r["m"]: r for r in rows(f"""
        SELECT strftime('%Y-%m', {rd}) AS m, COUNT(*) AS n, COALESCE(SUM(p.premium), 0) AS premium
        FROM policies p JOIN accounts a ON a.id = p.account_id
        WHERE p.archived = 0 AND a.archived = 0 AND p.renewed_to_id IS NULL
          AND p.status NOT IN ('Lost', 'Cancelled') AND {rd} >= ?
        GROUP BY m""", (keys[0] + "-01",))}
    renewals_by_month = [{"month": k, "count": by_month.get(k, {}).get("n", 0),
                          "premium": by_month.get(k, {}).get("premium", 0)} for k in keys]

    ph = in_clause(ACTIVE_SUB_STATUSES)
    outstanding_docs = scalar(f"""
        SELECT COUNT(*) FROM documents d JOIN accounts a ON a.id = d.account_id
        WHERE d.archived = 0 AND a.archived = 0 AND d.status IN ('Not Requested', 'Requested')
          AND EXISTS (SELECT 1 FROM submissions s WHERE s.account_id = d.account_id AND s.line = d.line
                      AND s.archived = 0 AND s.status IN {ph})""", ACTIVE_SUB_STATUSES)

    pipeline = pipeline_summary()

    book = one(f"""
        SELECT (SELECT COUNT(*) FROM accounts WHERE archived = 0 AND status IN ('Active Client', 'BOR Won')) AS active_accounts,
               COALESCE(SUM(t.premium), 0) AS premium, COALESCE(SUM(t.commission_amt), 0) AS commission,
               COUNT(*) AS policies
        FROM policies t JOIN accounts a ON a.id = t.account_id WHERE a.archived = 0 AND {in_force_sql('t')}""")

    return jsonify({
        "renewals_90": renewals_90,
        "renewals_by_month": renewals_by_month,
        "tasks_today": rows(f"""
            SELECT t.*, a.named_insured AS account_name FROM tasks t LEFT JOIN accounts a ON a.id = t.account_id
            WHERE t.archived = 0 AND t.status = 'Open' AND t.due_date <= ?
            ORDER BY {PRIORITY_ORDER.format(col='t.priority')}, t.due_date""", (t,)),
        "overdue_followups": rows(f"""
            SELECT t.*, a.named_insured AS account_name FROM activities t LEFT JOIN accounts a ON a.id = t.account_id
            WHERE t.archived = 0 AND t.follow_up_done = 0 AND t.follow_up_date IS NOT NULL AND t.follow_up_date < ?
            ORDER BY {PRIORITY_ORDER.format(col='t.priority')}, t.follow_up_date""", (t,)),
        "followups_today": scalar("""SELECT COUNT(*) FROM activities WHERE archived = 0 AND follow_up_done = 0
                                     AND follow_up_date = ?""", (t,)),
        "outstanding_docs": outstanding_docs,
        "outstanding_loss_runs": one("""
            SELECT COUNT(*) AS count, MIN(l.date_requested) AS oldest FROM loss_runs l JOIN accounts a ON a.id = l.account_id
            WHERE l.archived = 0 AND a.archived = 0 AND l.status = 'Requested'"""),
        "pipeline": pipeline,
        "book": book,
        "calls": call_counts(),
        "recent_accounts": rows("""SELECT id, named_insured, status, territory, updated_at, created_at FROM accounts
                                   WHERE archived = 0 ORDER BY updated_at DESC LIMIT 5"""),
    })


def pipeline_summary():
    data = {r["stage"]: r for r in rows("""
        SELECT d.stage, COUNT(*) AS count, COALESCE(SUM(d.est_premium), 0) AS est_premium,
               COALESCE(SUM(d.est_commission), 0) AS est_commission
        FROM deals d JOIN accounts a ON a.id = d.account_id WHERE d.archived = 0 AND a.archived = 0
        GROUP BY d.stage""")}
    return [{"stage": s, "count": data.get(s, {}).get("count", 0),
             "est_premium": data.get(s, {}).get("est_premium", 0),
             "est_commission": data.get(s, {}).get("est_commission", 0)} for s in C.PIPELINE_STAGES]


@api.get("/today")
def today_view():
    t = today()
    return jsonify({
        "tasks": rows(f"""
            SELECT t.*, a.named_insured AS account_name FROM tasks t LEFT JOIN accounts a ON a.id = t.account_id
            WHERE t.archived = 0 AND t.status = 'Open' AND t.due_date <= ?
            ORDER BY {PRIORITY_ORDER.format(col='t.priority')}, t.due_date""", (t,)),
        "followups": rows(f"""
            SELECT t.*, a.named_insured AS account_name FROM activities t LEFT JOIN accounts a ON a.id = t.account_id
            WHERE t.archived = 0 AND t.follow_up_done = 0 AND t.follow_up_date IS NOT NULL AND t.follow_up_date <= ?
            ORDER BY {PRIORITY_ORDER.format(col='t.priority')}, t.follow_up_date""", (t,)),
        "calls": call_counts(),
    })


@api.get("/calls")
def calls():
    return jsonify(call_counts())


# ---------------------------------------------------------------------------
# Renewals calendar
# ---------------------------------------------------------------------------

@api.get("/renewals")
def renewals():
    rd = renewal_date_sql("p")
    sql, params = RENEWAL_BASE, []
    start, end = request.args.get("start"), request.args.get("end")
    if start:
        sql += f" AND {rd} >= ?"
        params.append(start)
    if end:
        sql += f" AND {rd} <= ?"
        params.append(end)
    for arg, col in (("line", "p.line"), ("carrier", "p.carrier"), ("territory", "a.territory"),
                     ("account_id", "p.account_id")):
        if request.args.get(arg):
            sql += f" AND {col} = ?"
            params.append(request.args[arg])
    sql += f" AND {rd} IS NOT NULL ORDER BY {rd}, a.named_insured"
    return jsonify(rows(sql, params))


# ---------------------------------------------------------------------------
# Global search
# ---------------------------------------------------------------------------

@api.get("/search")
def search():
    q = (request.args.get("q") or "").strip()
    if not q:
        return jsonify({"accounts": [], "contacts": [], "policies": [], "notes": []})
    like = f"%{q}%"
    return jsonify({
        "accounts": rows("""SELECT id, named_insured, dba, city, state, status FROM accounts
                            WHERE archived = 0 AND (named_insured LIKE ? OR dba LIKE ? OR fein LIKE ? OR city LIKE ?)
                            ORDER BY named_insured COLLATE NOCASE LIMIT 50""", (like, like, like, like)),
        "contacts": rows("""SELECT c.id, c.account_id, c.name, c.title, c.email, c.phone, a.named_insured AS account_name
                            FROM contacts c JOIN accounts a ON a.id = c.account_id
                            WHERE c.archived = 0 AND a.archived = 0 AND (c.name LIKE ? OR c.email LIKE ? OR c.phone LIKE ?)
                            ORDER BY c.name COLLATE NOCASE LIMIT 50""", (like, like, like)),
        "policies": rows("""SELECT p.id, p.account_id, p.line, p.carrier, p.policy_number, p.expiration_date, p.status,
                                   a.named_insured AS account_name
                            FROM policies p JOIN accounts a ON a.id = p.account_id
                            WHERE p.archived = 0 AND a.archived = 0
                              AND (p.policy_number LIKE ? OR p.carrier LIKE ? OR p.prior_carrier LIKE ? OR p.notes LIKE ?)
                            ORDER BY p.expiration_date DESC LIMIT 50""", (like, like, like, like)),
        "notes": rows("""SELECT 'Note' AS kind, n.account_id, n.body AS text, n.created_at AS at, a.named_insured AS account_name
                         FROM account_notes n JOIN accounts a ON a.id = n.account_id
                         WHERE n.archived = 0 AND a.archived = 0 AND n.body LIKE ?
                         UNION ALL
                         SELECT 'Activity', t.account_id, t.type || ': ' || COALESCE(t.summary, '') || ' ' || COALESCE(t.next_step, ''),
                                t.activity_date, a.named_insured
                         FROM activities t LEFT JOIN accounts a ON a.id = t.account_id
                         WHERE t.archived = 0 AND (t.summary LIKE ? OR t.next_step LIKE ?)
                         ORDER BY at DESC LIMIT 50""", (like, like, like)),
    })


# ---------------------------------------------------------------------------
# Commission book
# ---------------------------------------------------------------------------

def bound_policy_filter(args, alias="t"):
    where = [f"{alias}.archived = 0", "a.archived = 0", f"{alias}.status IN ('Bound', 'Renewed')"]
    params = []
    for arg, col in (("account_id", f"{alias}.account_id"), ("line", f"{alias}.line"),
                     ("carrier", f"{alias}.carrier"), ("territory", "a.territory")):
        if args.get(arg):
            where.append(f"{col} = ?")
            params.append(args[arg])
    if args.get("start"):
        where.append(f"{alias}.effective_date >= ?")
        params.append(args["start"])
    if args.get("end"):
        where.append(f"{alias}.effective_date <= ?")
        params.append(args["end"])
    return " AND ".join(where), params


@api.get("/commission")
def commission():
    where, params = bound_policy_filter(request.args)
    base = f"FROM policies t JOIN accounts a ON a.id = t.account_id WHERE {where}"
    policy_rows = rows(f"""SELECT t.id, t.account_id, a.named_insured AS account_name, t.line, t.carrier, t.policy_number,
                                  t.effective_date, t.expiration_date, t.premium, t.commission_pct, t.commission_amt,
                                  t.status, {in_force_sql('t')} AS in_force
                           {base} ORDER BY t.effective_date DESC""", params)
    totals = one(f"SELECT COALESCE(SUM(t.premium), 0) AS premium, COALESCE(SUM(t.commission_amt), 0) AS commission, "
                 f"COUNT(*) AS count {base}", params)
    in_force = one(f"SELECT COALESCE(SUM(t.premium), 0) AS premium, COALESCE(SUM(t.commission_amt), 0) AS commission, "
                   f"COUNT(*) AS count {base} AND {in_force_sql('t')}", params)
    by_year = rows(f"""SELECT strftime('%Y', t.effective_date) AS year, COUNT(*) AS count,
                              COALESCE(SUM(t.premium), 0) AS premium, COALESCE(SUM(t.commission_amt), 0) AS commission
                       {base} AND t.effective_date IS NOT NULL GROUP BY year ORDER BY year""", params)
    prev = None
    for r in by_year:
        r["yoy_commission"] = (r["commission"] - prev["commission"]) if prev else None
        r["yoy_pct"] = ((r["commission"] - prev["commission"]) / prev["commission"] * 100) \
            if prev and prev["commission"] else None
        prev = r

    year = int(request.args.get("year") or date.today().year)
    monthly = {(r["y"], r["m"]): r for r in rows(
        f"""SELECT CAST(strftime('%Y', t.effective_date) AS INTEGER) AS y, CAST(strftime('%m', t.effective_date) AS INTEGER) AS m,
                   COALESCE(SUM(t.premium), 0) AS premium, COALESCE(SUM(t.commission_amt), 0) AS commission
            {base} AND t.effective_date IS NOT NULL GROUP BY y, m""", params)}
    # Projected renewal commission: in-force policies whose renewal date falls in that month of the year.
    rd = renewal_date_sql("t")
    renewing = {r["m"]: r for r in rows(
        f"""SELECT CAST(strftime('%m', {rd}) AS INTEGER) AS m, COALESCE(SUM(t.commission_amt), 0) AS commission
            {base} AND {in_force_sql('t')} AND strftime('%Y', {rd}) = ? GROUP BY m""", [*params, str(year)])}
    months = []
    for m in range(1, 13):
        cur = monthly.get((year, m), {})
        last = monthly.get((year - 1, m), {})
        months.append({"month": m, "premium": cur.get("premium", 0), "commission": cur.get("commission", 0),
                       "prior_year_commission": last.get("commission", 0),
                       "renewing_commission": renewing.get(m, {}).get("commission", 0)})
    return jsonify({
        "policies": policy_rows, "totals": totals, "in_force": in_force,
        "projection": {"annual": in_force["commission"], "monthly": in_force["commission"] / 12},
        "by_year": by_year, "year": year, "months": months,
    })


# ---------------------------------------------------------------------------
# Reports
# ---------------------------------------------------------------------------

@api.get("/reports/<name>")
def report(name):
    args = request.args
    if name == "book":
        return jsonify(rows(f"""
            SELECT a.id AS account_id, a.named_insured AS account_name, a.dba, a.status AS account_status, a.territory,
                   a.city, a.state, t.line, t.carrier, t.policy_number, t.effective_date, t.expiration_date,
                   t.premium, t.commission_pct, t.commission_amt, t.status, t.aor_status
            FROM accounts a LEFT JOIN policies t ON t.account_id = a.id AND {in_force_sql('t')}
            WHERE a.archived = 0 AND a.status IN ('Active Client', 'BOR Won')
            ORDER BY a.named_insured COLLATE NOCASE, t.line"""))

    if name == "renewals":
        rd = renewal_date_sql("p")
        start = args.get("start") or today()
        end = args.get("end") or add_days(start, 120)
        return jsonify(rows(RENEWAL_BASE + f" AND {rd} >= ? AND {rd} <= ? ORDER BY {rd}", (start, end)))

    if name == "pipeline":
        sql = """SELECT d.id, d.account_id, a.named_insured AS account_name, a.territory, d.stage, d.source,
                        d.est_premium, d.est_commission, d.stage_entered_at, d.target_date, d.lost_reason,
                        CAST(julianday('now', 'localtime') - julianday(d.stage_entered_at) AS INTEGER) AS days_in_stage
                 FROM deals d JOIN accounts a ON a.id = d.account_id WHERE d.archived = 0 AND a.archived = 0"""
        params = []
        if args.get("stage"):
            sql += " AND d.stage = ?"
            params.append(args["stage"])
        stage_order = " ".join(f"WHEN '{s}' THEN {i}" for i, s in enumerate(C.PIPELINE_STAGES))
        return jsonify({"rows": rows(sql + f" ORDER BY CASE d.stage {stage_order} END, a.named_insured", params),
                        "summary": pipeline_summary()})

    if name == "submissions":
        sql = """SELECT s.id, s.account_id, a.named_insured AS account_name, s.line, s.carrier, s.wholesaler, s.status,
                        s.date_submitted, s.quote_amount, s.quote_date, s.target_premium, s.placement_exec, s.decline_reason
                 FROM submissions s JOIN accounts a ON a.id = s.account_id WHERE s.archived = 0 AND a.archived = 0"""
        params = []
        for arg in ("carrier", "status"):
            if args.get(arg):
                sql += f" AND s.{arg} = ?"
                params.append(args[arg])
        if args.get("start"):
            sql += " AND s.date_submitted >= ?"
            params.append(args["start"])
        if args.get("end"):
            sql += " AND s.date_submitted <= ?"
            params.append(args["end"])
        data = rows(sql + " ORDER BY s.carrier COLLATE NOCASE, s.status", params)
        pivot = {}
        for r in data:
            p = pivot.setdefault(r["carrier"] or "(none)", {s: 0 for s in C.SUBMISSION_STATUSES})
            p[r["status"]] = p.get(r["status"], 0) + 1
        return jsonify({"rows": data, "pivot": [{"carrier": k, **v} for k, v in sorted(pivot.items())]})

    if name == "commission":
        group = args.get("group", "month")
        fmt = {"month": "strftime('%Y-%m', t.effective_date)",
               "quarter": "strftime('%Y', t.effective_date) || '-Q' || ((CAST(strftime('%m', t.effective_date) AS INTEGER) + 2) / 3)",
               "year": "strftime('%Y', t.effective_date)"}.get(group, "strftime('%Y-%m', t.effective_date)")
        where, params = bound_policy_filter(args)
        return jsonify(rows(f"""SELECT {fmt} AS period, COUNT(*) AS policies, COALESCE(SUM(t.premium), 0) AS premium,
                                       COALESCE(SUM(t.commission_amt), 0) AS commission
                                FROM policies t JOIN accounts a ON a.id = t.account_id
                                WHERE {where} AND t.effective_date IS NOT NULL GROUP BY period ORDER BY period""", params))

    if name == "lost":
        return jsonify(rows("""
            SELECT 'Prospect' AS kind, d.account_id, a.named_insured AS account_name, a.territory, NULL AS line,
                   NULL AS carrier, d.est_premium AS premium, substr(d.stage_entered_at, 1, 10) AS lost_date,
                   d.lost_reason AS reason, d.lost_reason_detail AS detail, d.source
            FROM deals d JOIN accounts a ON a.id = d.account_id
            WHERE d.archived = 0 AND a.archived = 0 AND d.stage = 'Lost'
            UNION ALL
            SELECT 'Policy', p.account_id, a.named_insured, a.territory, p.line, p.carrier, p.premium,
                   substr(p.updated_at, 1, 10), NULL, p.notes, NULL
            FROM policies p JOIN accounts a ON a.id = p.account_id
            WHERE p.archived = 0 AND a.archived = 0 AND p.status = 'Lost'
            ORDER BY lost_date DESC"""))

    return jsonify(error="Unknown report"), 404


# ---------------------------------------------------------------------------
# Archive (soft-deleted records)
# ---------------------------------------------------------------------------

@api.get("/archive")
def archive():
    out = []
    specs = [
        ("accounts", "accounts", "named_insured", None),
        ("contacts", "contacts", "name", "account_id"),
        ("policies", "policies", "line || ' - ' || COALESCE(carrier, '') || ' ' || COALESCE(policy_number, '')", "account_id"),
        ("deals", "deals", "'Pipeline: ' || stage", "account_id"),
        ("submissions", "submissions", "line || ' - ' || COALESCE(carrier, '')", "account_id"),
        ("documents", "documents", "name", "account_id"),
        ("loss_runs", "loss_runs", "'Loss run ' || COALESCE(carrier, '')", "account_id"),
        ("activities", "activities", "type || ': ' || COALESCE(summary, '')", "account_id"),
        ("tasks", "tasks", "title", "account_id"),
        ("team", "team_assignments", "role || ': ' || COALESCE(person_name, '')", "account_id"),
    ]
    for res, table, label, acct in specs:
        acct_sql = f"(SELECT named_insured FROM accounts WHERE id = t.{acct})" if acct else "NULL"
        for r in rows(f"SELECT t.id, {label} AS label, {acct_sql} AS account_name, t.updated_at FROM {table} t "
                      f"WHERE t.archived = 1 ORDER BY t.updated_at DESC LIMIT 500"):
            out.append({"resource": res, **r})
    out.sort(key=lambda r: r["updated_at"], reverse=True)
    return jsonify(out)
