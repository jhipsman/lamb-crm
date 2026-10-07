"""Nonprofit Book CRM - local Flask server."""
import os

from flask import Flask, send_from_directory

from crm.api import api
from crm.db import DB_PATH, close_db, init_db

BASE_DIR = os.path.dirname(os.path.abspath(__file__))


def create_app():
    app = Flask(__name__, static_folder=os.path.join(BASE_DIR, "static"), static_url_path="/static")
    app.json.sort_keys = False
    init_db()
    app.register_blueprint(api)
    app.teardown_appcontext(close_db)

    @app.get("/")
    def index():
        return send_from_directory(app.static_folder, "index.html")

    @app.after_request
    def no_cache(resp):
        if resp.mimetype in ("application/json", "text/html"):
            resp.headers["Cache-Control"] = "no-store"
        return resp

    return app


app = create_app()

if __name__ == "__main__":
    host = os.environ.get("CRM_HOST", "127.0.0.1")
    port = int(os.environ.get("CRM_PORT", "5000"))
    print(f"\n  Nonprofit Book CRM running at http://{'localhost' if host == '127.0.0.1' else host}:{port}")
    print(f"  Database: {DB_PATH}\n")
    app.run(host=host, port=port, debug=False)
