# Book CRM — Nonprofit & Human Services Insurance

A local, single-user CRM for a commercial insurance producer: book of business, renewals,
prospecting pipeline, submissions, document chasing, loss runs, tasks, internal handoffs and
commission tracking. It runs on your own computer, and all data is stored in one SQLite file.

- **Backend:** Python 3.9+ / Flask, SQLite (no other services)
- **Frontend:** plain HTML/CSS/JS (no React, no build step), dark mode by default
- **Data:** starts empty. The schema is created automatically on first run.

---

## Quick start

### macOS / Linux
```bash
./start.sh
```

### Windows
Double-click **`start.bat`** (or run it from a terminal).

On the first run the script creates a virtual environment (`.venv/`), installs Flask, creates the
database at `data/crm.db` and opens **http://localhost:5000** in your browser. Later runs start
immediately. Stop the server with `Ctrl+C`.

### Manual start
```bash
python3 -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python app.py
```

### Options (environment variables)
| Variable | Default | Purpose |
|---|---|---|
| `CRM_PORT` | `5000` | Port to serve on |
| `CRM_HOST` | `127.0.0.1` | Set to `0.0.0.0` to reach it from your phone on the same Wi-Fi |
| `CRM_DB_PATH` | `data/crm.db` | Use a different database file |

**Checking it from your phone:** start with `CRM_HOST=0.0.0.0 ./start.sh` (Windows:
`set CRM_HOST=0.0.0.0` then `start.bat`), find your computer's local IP address (for example
`192.168.1.20`) and open `http://192.168.1.20:5000` on your phone. The app has no login, so only
do this on a network you trust, such as your home Wi-Fi. Don't do it on public or office guest
networks.

---

## Backups

Everything is in **`data/crm.db`**. To back up, copy that file (with the server stopped), or use
**Settings → Data & Backup → Download database backup** at any time. The `data/` folder is in
`.gitignore` so your client data never gets committed.

---

## File structure

```
lamb-crm/
├── app.py                  Flask entry point (serves the UI + API, creates the DB on start)
├── crm/
│   ├── constants.py        Option lists: lines, statuses, stages, default carriers & checklists
│   ├── db.py               SQLite schema, connection handling, first-run setup
│   ├── resources.py        Generic CRUD + business rules (auto-calcs, cascades)
│   └── api.py              JSON API: dashboard, calendar, search, commission, reports, archive
├── static/
│   ├── index.html          App shell: top bar, collapsible sidebar
│   ├── css/style.css       Dark/light theme, responsive layout, print styles
│   └── js/
│       ├── core.js         DOM/API helpers, modal, form builder, sortable/filterable table + CSV
│       ├── forms.js        Record forms & quick-add dialogs
│       ├── app.js          Boot, keyboard shortcuts, search, theme
│       └── pages/          dashboard, accounts, renewals, pipeline, workflow, commission, reports, settings
├── data/crm.db             Created on first run (git-ignored)
├── requirements.txt
├── start.sh / start.bat
└── README.md
```

---

## Modules

| Area | Where | Highlights |
|---|---|---|
| **Dashboard** | Home | Renewals (90 days and next 6 months), tasks due, overdue follow-ups, outstanding docs and loss runs, pipeline by stage, book totals, call counter, recent accounts |
| **Today** | Home | Tasks and follow-ups due today or overdue, sorted by priority, with one-click Done |
| **Accounts** | Book | Account details, type tags, status, territory, prior broker, contacts (primary flag), timestamped append-only notes |
| **Portfolio** | Account → Portfolio | Every line in one grid with totals. *Not Yet Marketed* lines are highlighted, and ⚑ marks lines where you're not AOR yet. Lines not on file are suggested as cross-sell ideas. Print-friendly. |
| **Policies** | Book | All policies across accounts. Commission $ = premium × %. Claims-made retro date, WC experience mod, multi-year term end. |
| **Renewal Calendar** | Book | Month grid or list view. Colors: red ≤30 days, yellow 31–60, green 61–90, blue 91–120. Filter by line, carrier or territory. Click a renewal to see the whole account. |
| **Commission Book** | Book | Bound premium and commission, in-force run rate (annual and monthly), monthly booked vs. prior year, renewing commission by month, year-over-year, filters, CSV |
| **Pipeline** | Prospecting | Kanban with drag-and-drop (a dropdown on each card for mobile), list and summary views. Stage timestamps and history. Moving a card to Lost asks for a reason. |
| **Activity Log** | Prospecting | Call, email, meeting, note and document entries with next step, follow-up date and priority. Call counter for today, this week and this month. |
| **Submissions** | Placement | Carrier, wholesaler/MGA, status, quote, target premium, placement exec, decline reason, plus a checkable subjectivities list |
| **Document Checklist** | Placement | Per-line templates populate automatically when a submission is created. Each item has a status and requested/received dates, and you can add custom items. |
| **Loss Runs** | Placement | Outstanding requests with days outstanding, oldest first |
| **Tasks** | Work | Linked to an account or standalone. Has priority, category and assignee (Self, Placement, Account Management, Operations). |
| **Internal Team** | Work | Placement exec, account manager and operations contact per account, with handoff status and notes |
| **Reports** | Admin | Book of business, renewals by date range, pipeline by stage, submissions by carrier and status (with bind ratio), commission by month/quarter/year, lost business with reasons. All can be sorted, filtered and exported to CSV. |
| **Settings** | Admin | My info (added to the top of exports), commission % per line, carriers, account type tags, team members, document templates, backup |
| **Archive** | Admin | Deleted records are archived (soft delete), and you can restore them from here |

### Automation built in
- **Commission $** is calculated from premium × commission %. A new policy takes its commission % from the line's default in Settings.
- **Pipeline → account status:** moving a prospect to *BOR Submitted* sets the account to BOR Submitted, *Won* sets it to BOR Won, and *Lost* sets it to Lost. The status-changed date is stamped automatically.
- **Pipeline est. commission:** if you leave it blank, it is calculated from est. premium × the pipeline % in Settings (default 15%).
- **New submission:** adds that line's document checklist to the account, skipping items that are already there. If it's linked to a policy, the policy moves to *Submitted*. When the submission is marked Quoted, the policy moves to *Quoted*. When it's marked Bound, the policy becomes Bound with the carrier, quote premium and AOR status filled in.
- **Document marked "Requested":** stamps the request date and creates a *Document Chase* task due in 7 days. Loss-run items also create an entry in the Loss Run tracker.
- **Document or loss run marked "Received":** stamps the received date, closes the chase task and keeps the document and loss-run records in sync.
- **Renew** (on a bound policy): creates the next term starting at the old expiration date. The prior term stays in the history, which is what makes the year-over-year numbers work.
- **New account with status Prospect:** can be added to the pipeline in one step.

### UI conventions
- Click any column header to sort. Type in the box under a header to filter that column. Every table has a **CSV** export button.
- Keyboard: **N** opens a new account, **T** a new task, **A** a new activity, **/** jumps to search, and **Esc** closes a dialog. When you're on an account page, T and A pre-fill that account.
- The main date on every form (activity date, due date, effective date, submitted, requested) defaults to today. Some dates stay blank until they apply: follow-up, retro, quote and received dates. Quote and received dates are filled in automatically when the status changes to Quoted or Received.
- Currency fields accept `85000`, `85,000` or `$85,000`, and display as `$85,000`.
- The ◑ button switches between dark (default) and light themes.

### What gets pre-loaded (configuration only, no fake data)
- 15 common nonprofit carriers (you can edit them in Settings)
- Account type tags: Church, Senior Services/Assisted Living, Behavioral Health, Youth Organization, Affordable Housing, Camp, School/Education, Human Services, Other
- Default commission: **15%** for every line except **WC at 10%**. Change these in Settings → Commission Defaults.
- Document checklist templates per line, as listed in the spec. GL, PL and Professional Liability share the GL/PL list, and D&O and EPL share the management-liability list. Fiduciary, Bonds, Inland Marine and Other start with no template, and you can add one in Settings.
