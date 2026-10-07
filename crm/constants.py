"""Fixed option lists used by both the API and the UI."""

LINES = [
    "GL", "PL", "Professional Liability", "Property", "Auto", "WC", "D&O", "EPL",
    "Fiduciary", "Cyber", "Crime", "Excess/Umbrella", "Abuse & Molestation",
    "Bonds", "Inland Marine", "Other",
]

ACCOUNT_STATUSES = ["Prospect", "BOR Submitted", "BOR Won", "Active Client", "Lost"]
DEFAULT_ACCOUNT_TYPES = [
    "Church", "Senior Services/Assisted Living", "Behavioral Health", "Youth Organization",
    "Affordable Housing", "Camp", "School/Education", "Human Services", "Other",
]
TERRITORIES = ["New England/Upstate", "NYC", "Other"]

POLICY_STATUSES = [
    "Not Yet Marketed", "Marketing", "Submitted", "Quoted", "Bound", "Renewed", "Lost", "Cancelled",
]
BOUND_STATUSES = ("Bound", "Renewed")
AOR_STATUSES = ["AOR", "BOR Pending", "Not AOR"]
COVERAGE_FORMS = ["Occurrence", "Claims-Made"]

PIPELINE_STAGES = [
    "Identified", "Researched", "First Contact", "Meeting Scheduled",
    "Application Sent", "BOR Submitted", "Won", "Lost",
]
LEAD_SOURCES = ["Cold Call", "Referral", "Event/Conference", "Web Research", "Other"]
LOST_REASONS = [
    "Price", "Coverage", "Incumbent Relationship", "No Response", "Timing",
    "Declined by Markets", "Not a Fit", "BOR Rejected", "Other",
]

SUBMISSION_STATUSES = ["Pending", "Need Additional Info", "Quoted", "Declined", "Bound"]
DOC_STATUSES = ["Not Requested", "Requested", "Received", "N/A"]
LOSS_RUN_STATUSES = ["Requested", "Received", "N/A"]

ACTIVITY_TYPES = ["Call", "Email Sent", "Email Received", "Meeting", "Internal Note", "Document Received"]
PRIORITIES = ["High", "Medium", "Low"]
TASK_STATUSES = ["Open", "Done"]
TASK_CATEGORIES = ["Follow-up", "Document Chase", "Internal Handoff", "Client Request", "Renewal Prep", "Other"]
TEAMS = ["Self", "Placement", "Account Management", "Operations"]

TEAM_ROLES = ["Placement Exec", "Account Manager", "Operations Contact"]
HANDOFF_STATUSES = ["Handed Off", "In Progress", "Complete"]

DEFAULT_CARRIERS = [
    "Hanover", "Hartford", "Philadelphia", "Church Mutual", "GuideOne", "Brotherhood Mutual",
    "Glatfelter", "Great American", "MEMIC", "AmTrust", "Progressive", "Chubb", "Travelers",
    "CNA", "USLI",
]

# Default commission % per line (editable in Settings).
DEFAULT_COMMISSION = {line: 15.0 for line in LINES}
DEFAULT_COMMISSION["WC"] = 10.0

_GL_PL = ["ACORD 125", "ACORD 126", "Supplemental App", "Loss Runs (5yr)", "State Survey + POC",
          "Operating License", "Driver List", "Vehicle Schedule", "SOV"]
_MGMT = ["Application", "Loss Runs (5yr)", "Bylaws", "Board List", "Financial Statements"]

# Document checklist templates per line (editable in Settings).
DEFAULT_DOC_TEMPLATES = {
    "GL": _GL_PL,
    "PL": _GL_PL,
    "Professional Liability": _GL_PL,
    "WC": ["ACORD 130", "Loss Runs (5yr)", "Experience Mod Worksheet", "Payroll by Class"],
    "Property": ["ACORD 140", "SOV", "Loss Runs (5yr)"],
    "Auto": ["ACORD 127", "ACORD 137", "Driver List", "Vehicle Schedule", "MVRs", "Loss Runs (5yr)"],
    "D&O": _MGMT,
    "EPL": _MGMT,
    "Cyber": ["Application", "Loss Runs"],
    "Crime": ["ACORD 141", "Loss Runs"],
    "Abuse & Molestation": ["Abuse & Molestation Questionnaire"],
    "Excess/Umbrella": ["Underlying Schedules", "Loss Runs (5yr)"],
}


def lookups():
    return {
        "lines": LINES,
        "account_statuses": ACCOUNT_STATUSES,
        "territories": TERRITORIES,
        "policy_statuses": POLICY_STATUSES,
        "bound_statuses": list(BOUND_STATUSES),
        "aor_statuses": AOR_STATUSES,
        "coverage_forms": COVERAGE_FORMS,
        "pipeline_stages": PIPELINE_STAGES,
        "lead_sources": LEAD_SOURCES,
        "lost_reasons": LOST_REASONS,
        "submission_statuses": SUBMISSION_STATUSES,
        "doc_statuses": DOC_STATUSES,
        "loss_run_statuses": LOSS_RUN_STATUSES,
        "activity_types": ACTIVITY_TYPES,
        "priorities": PRIORITIES,
        "task_statuses": TASK_STATUSES,
        "task_categories": TASK_CATEGORIES,
        "teams": TEAMS,
        "team_roles": TEAM_ROLES,
        "handoff_statuses": HANDOFF_STATUSES,
    }
