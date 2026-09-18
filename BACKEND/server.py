import os
import sqlite3
import hashlib
import secrets
import time
import smtplib
import json
import io
import urllib.parse
import urllib.request
import re
from datetime import datetime, timezone
from email.mime.text import MIMEText
from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
from dotenv import load_dotenv
from google import genai
from google.genai import types
try:
    from pypdf import PdfReader
except ImportError:
    PdfReader = None
try:
    from docx import Document
except ImportError:
    Document = None

# Load environment variables from BACKEND/.env
load_dotenv(os.path.join(os.path.dirname(__file__), '.env'))

app = Flask(__name__)
ALLOWED_ORIGIN = os.getenv("ALLOWED_ORIGIN", "*")
CORS(app, resources={r"/api/*": {"origins": ALLOWED_ORIGIN}})

DB_PATH = os.path.join(os.path.dirname(__file__), 'database.sqlite')
SITE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'SITE'))

# Initialize Google GenAI client.  The API key is loaded from BACKEND/.env.
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
ai_client = genai.Client(api_key=GEMINI_API_KEY) if GEMINI_API_KEY else None

# Flash Lite is optimized for low-latency structured generation, which makes it
# a better fit for interactive quizzes. Keep this configurable for deployments
# that prefer a different enabled model.
QUIZ_MODEL = os.getenv("GEMINI_QUIZ_MODEL", "gemini-3.1-flash-lite")

DEFAULT_CADRES = {
    "data-analyst": [
        ("Official Statistics & MoSPI", "Statistical standards, official releases, and evidence-led public administration", 62, 88),
        ("Macroeconomic Indicators", "GDP, CPI, IIP, employment, and national indicator interpretation", 55, 85),
        ("Survey Methodology & Quality", "Sampling, non-response, metadata, and quality assurance in official surveys", 48, 82),
        ("Data Governance & Ethics", "Anonymization, confidentiality, metadata, and responsible statistical disclosure", 72, 86),
        ("Statistical Data Communication", "Explaining estimates, revisions, uncertainty, and official data to decision-makers", 58, 80)
    ],
    "director-ai": [
        ("Official Statistics & MoSPI", "Stewardship of India's Official Statistical System and MoSPI data programmes", 58, 92),
        ("Macroeconomic Indicators", "Policy interpretation of national accounts, prices, labour, and industrial indicators", 62, 90),
        ("Statistical Quality Assurance", "Governance of survey design, revisions, comparability, and reproducibility", 55, 88),
        ("Responsible AI for Statistics", "Auditable AI support for statistical production without compromising official standards", 64, 90)
    ],
    "governance-officer": [
        ("Official Statistics & MoSPI", "Using official statistical releases for programme monitoring and policy decisions", 68, 88),
        ("Survey Operations", "Field coordination, data validation, non-response handling, and survey protocols", 52, 84),
        ("Macroeconomic Indicators", "Reading indicator trends and communicating limitations to administrators", 60, 82),
        ("Data Governance & Ethics", "Confidentiality, metadata completeness, and controlled statistical access", 75, 88)
    ]
}

IGOT_DEFAULT_SCOPES = "learning.progress.write learning.catalog.read"

def mock_igot_enabled():
    return os.getenv("IGOT_MOCK_MODE", "true").strip().lower() in {"1", "true", "yes", "on"}

FALLBACK_POOL = [
    {
        "q": "When using an MoSPI release for '{topic}', which practice best protects the integrity of an official-statistics decision?",
        "options": [
            "Report the estimate without its reference period or metadata",
            "Check the release metadata, reference period, revisions, and stated limitations before interpretation",
            "Replace the official estimate with an unverified social-media survey",
            "Round all estimates to zero when uncertainty is not immediately visible"
        ],
        "correct": 1,
        "domain": "Official Statistics & MoSPI",
        "rationale": "Official statistics must be interpreted with their metadata, reference period, revisions, and limitations so decisions remain evidence-led."
    },
    {
        "q": "A policymaker asks why a macroeconomic indicator for '{topic}' changed after its first release. What is the most responsible response?",
        "options": [
            "Treat the first estimate as permanently final",
            "Explain that revisions can incorporate improved source data and follow the published revision policy",
            "Delete the earlier release so the series appears unchanged",
            "Assume every revision is an error without checking methodology"
        ],
        "correct": 1,
        "domain": "Macroeconomic Indicators",
        "rationale": "Official estimates may be revised as more complete source data arrives; the published revision process provides the proper context."
    },
    {
        "q": "For a survey about '{topic}', which action most directly improves the quality of the resulting official statistics?",
        "options": [
            "Use a convenience sample and omit the sampling frame",
            "Document the sampling design, monitor non-response, and apply the approved quality checks",
            "Remove responses that do not support the expected policy outcome",
            "Publish estimates without explaining coverage or weighting"
        ],
        "correct": 1,
        "domain": "Survey Methodology & Quality",
        "rationale": "A documented sampling design, non-response monitoring, and quality checks make survey estimates more reliable and reproducible."
    },
    {
        "q": "When communicating an estimate about '{topic}', what should an officer include to avoid misleading decision-makers?",
        "options": [
            "Only the most favorable point estimate",
            "The reference period, uncertainty or limitations, and any relevant revision context",
            "An unsupported claim that the estimate proves causation",
            "A chart with no units or source information"
        ],
        "correct": 1,
        "domain": "Statistical Data Communication",
        "rationale": "Clear communication includes the reference period, uncertainty, limitations, and revision context so an estimate is not overstated."
    },
    {
        "q": "Before sharing records related to '{topic}', which safeguard should be applied first?",
        "options": [
            "Share all raw identifiers for transparency",
            "Check confidentiality requirements and remove or protect identifying information before controlled access",
            "Post the records publicly so users can validate them",
            "Skip access controls when the dataset is used internally"
        ],
        "correct": 1,
        "domain": "Data Governance & Ethics",
        "rationale": "Confidentiality and responsible access require protecting identifying information before sharing statistical records."
    }
]

def get_db():
    conn = sqlite3.connect(DB_PATH, timeout=30.0)
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA synchronous=NORMAL;")
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    conn = get_db()
    cur = conn.cursor()
    cur.executescript("""
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            department_id TEXT UNIQUE NOT NULL,
            email TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            role_key TEXT NOT NULL DEFAULT 'data-analyst',
            joined_date TEXT NOT NULL,
            last_active TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sessions (
            token TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            expires_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS otp_challenges (
            id TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            purpose TEXT DEFAULT 'login',
            otp_hash TEXT NOT NULL,
            expires_at INTEGER NOT NULL,
            attempts INTEGER DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS competencies (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            role_key TEXT NOT NULL,
            domain TEXT NOT NULL,
            desc TEXT NOT NULL,
            current INTEGER NOT NULL,
            target INTEGER NOT NULL,
            UNIQUE(user_id, role_key, domain)
        );
        CREATE TABLE IF NOT EXISTS assessments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            topic TEXT NOT NULL,
            domain TEXT NOT NULL,
            date TEXT NOT NULL,
            score INTEGER NOT NULL,
            status TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS igot_connections (
            user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
            access_token TEXT,
            refresh_token TEXT,
            expires_at INTEGER,
            scope TEXT,
            connected_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS igot_oauth_states (
            state TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            expires_at INTEGER NOT NULL
        );
    """)
    conn.commit()
    conn.close()

init_db()

def hash_pw(pw: str) -> str:
    salt = secrets.token_hex(16)
    h = hashlib.scrypt(pw.encode(), salt=salt.encode(), n=16384, r=8, p=1).hex()
    return f"{salt}:{h}"

def verify_pw(pw: str, stored: str) -> bool:
    try:
        salt, h = stored.split(':')
        test_h = hashlib.scrypt(pw.encode(), salt=salt.encode(), n=16384, r=8, p=1).hex()
        return secrets.compare_digest(h, test_h)
    except Exception:
        return False

def deliver_otp(to_email: str, otp: str, purpose: str = "login") -> str:
    smtp_user = os.getenv("AETHERNYX_SMTP_USER") or os.getenv("SMTP_USER")
    smtp_pass = os.getenv("AETHERNYX_SMTP_PASS") or os.getenv("SMTP_PASS")
    if not smtp_user or not smtp_pass:
        print(f"\n[Aethernyx Security Log] Console OTP ({purpose}) for {to_email}: {otp}\n")
        return "console"
    subject = "Aethernyx Workspace Security OTP" if purpose == "login" else "Aethernyx Password Reset OTP"
    body = (
        f"Aethernyx Officer Capability Studio\n"
        f"====================================\n\n"
        f"Your verification security PIN is: {otp}\n"
        f"Purpose: {purpose.replace('_', ' ').title()}\n"
        f"Validity: 5 minutes.\n\n"
        f"If you did not initiate this command portal request, notify your administrative lead immediately."
    )
    msg = MIMEText(body)
    msg['Subject'] = subject
    msg['From'] = smtp_user
    msg['To'] = to_email
    try:
        with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=12) as server:
            server.login(smtp_user, smtp_pass)
            server.send_message(msg)
        print(f"[Aethernyx Security Log] Email dispatched successfully to {to_email}")
        return "smtp"
    except Exception as e:
        print(f"[Aethernyx SMTP Error] Could not send email: {e}")
        print(f"[Aethernyx Security Log] Terminal Fallback OTP ({purpose}) for {to_email}: {otp}")
        return "console"

def get_auth_user():
    auth = request.headers.get('Authorization', '')
    token = auth.replace('Bearer ', '').strip()
    if not token:
        return None
    conn = get_db()
    row = conn.execute("""
        SELECT u.* FROM sessions s
        JOIN users u ON s.user_id = u.id
        WHERE s.token = ? AND s.expires_at > ?
    """, (token, int(time.time() * 1000))).fetchone()
    conn.close()
    return row

def seed_user_competencies(user_id, role_key):
    domains = DEFAULT_CADRES.get(role_key, DEFAULT_CADRES["data-analyst"])
    conn = get_db()
    legacy_domains = (
        "Algorithmic Accountability", "Policy Impact Modeling", "Digital Public Infrastructure",
        "Cybersecurity & Incident Response", "Strategic AI Procurement", "Inter-Agency Schema Governance"
    )
    conn.executemany("DELETE FROM competencies WHERE user_id = ? AND domain = ?", [(user_id, domain) for domain in legacy_domains])
    for domain, desc, current, target in domains:
        conn.execute("""
            INSERT OR IGNORE INTO competencies (user_id, role_key, domain, desc, current, target)
            VALUES (?, ?, ?, ?, ?, ?)
        """, (user_id, role_key, domain, desc, current, target))
    conn.commit()
    conn.close()

def configured_igot():
    return all(os.getenv(name) for name in ("IGOT_CLIENT_ID", "IGOT_CLIENT_SECRET", "IGOT_AUTHORIZE_URL", "IGOT_TOKEN_URL", "IGOT_API_URL"))

def resolve_competency_domain(domain, role_key):
    role_domains = DEFAULT_CADRES.get(role_key, DEFAULT_CADRES["data-analyst"])
    available = [item[0] for item in role_domains]
    requested = " ".join(str(domain or "").lower().split())
    normalized = re.sub(r"[^a-z0-9]+", "", requested)
    for candidate in available:
        if normalized == re.sub(r"[^a-z0-9]+", "", candidate.lower()):
            return candidate

    aliases = {
        "macroeconomics": "Macroeconomic Indicators",
        "macroeconomic": "Macroeconomic Indicators",
        "officialstatistics": "Official Statistics & MoSPI",
        "generalgovernance": "Official Statistics & MoSPI",
        "surveyquality": "Survey Methodology & Quality",
        "datagovernance": "Data Governance & Ethics",
        "statisticalcommunication": "Statistical Data Communication"
    }
    alias_match = aliases.get(normalized)
    if alias_match in available:
        return alias_match

    return max(role_domains, key=lambda item: item[3] - item[2])[0]

def extract_learning_material(upload):
    filename = (upload.filename or "").lower()
    raw = upload.read()
    if filename.endswith(".txt") or filename.endswith(".md"):
        return raw.decode("utf-8", errors="ignore")
    if filename.endswith(".pdf"):
        if PdfReader is None:
            raise ValueError("PDF support is unavailable. Install dependencies from BACKEND/requirements.txt.")
        reader = PdfReader(io.BytesIO(raw))
        return "\n".join(page.extract_text() or "" for page in reader.pages)
    if filename.endswith(".docx"):
        if Document is None:
            raise ValueError("DOCX support is unavailable. Install dependencies from BACKEND/requirements.txt.")
        document = Document(io.BytesIO(raw))
        return "\n".join(paragraph.text for paragraph in document.paragraphs)
    raise ValueError("Supported learning materials are PDF, DOCX, TXT, or MD files.")

def igot_redirect_uri():
    return os.getenv("IGOT_REDIRECT_URI", request.host_url.rstrip("/") + "/api/igot/oauth/callback")

# --- Public & Health Endpoints ---
@app.route('/api/health', methods=['GET'])
def health():
    smtp_configured = bool((os.getenv("AETHERNYX_SMTP_USER") or os.getenv("SMTP_USER")) and
                           (os.getenv("AETHERNYX_SMTP_PASS") or os.getenv("SMTP_PASS")))
    return jsonify({
        "status": "ok",
        "service": "aethernyx-python-flask",
        "storage": "sqlite-wal",
        "otpDelivery": "smtp" if smtp_configured else "console"
    })

@app.route('/api/igot/status', methods=['GET'])
def igot_status():
    user = get_auth_user()
    if not user:
        return jsonify({"message": "Authentication required."}), 401
    conn = get_db()
    connection = conn.execute("SELECT scope, connected_at FROM igot_connections WHERE user_id = ?", (user['id'],)).fetchone()
    conn.close()
    return jsonify({
        "configured": configured_igot(),
        "mockMode": mock_igot_enabled(),
        "connected": bool(connection),
        "provider": "iGOT Karmayogi",
        "scope": connection['scope'] if connection else None,
        "connectedAt": connection['connected_at'] if connection else None
    })

@app.route('/api/igot/oauth/start', methods=['POST'])
def igot_oauth_start():
    user = get_auth_user()
    if not user:
        return jsonify({"message": "Authentication required."}), 401
    if not configured_igot() and mock_igot_enabled():
        conn = get_db()
        conn.execute("""
            INSERT OR REPLACE INTO igot_connections
            (user_id, access_token, refresh_token, expires_at, scope, connected_at)
            VALUES (?, ?, ?, ?, ?, ?)
        """, (
            user['id'], 'mock-access-token', 'mock-refresh-token',
            int(time.time() * 1000) + 86400000,
            IGOT_DEFAULT_SCOPES, datetime.now(timezone.utc).isoformat()
        ))
        conn.commit()
        conn.close()
        return jsonify({
            "configured": False,
            "mock": True,
            "connected": True,
            "message": "Connected to the local iGOT simulation."
        })
    if not configured_igot():
        return jsonify({
            "configured": False,
            "message": "Add IGOT_CLIENT_ID, IGOT_CLIENT_SECRET, IGOT_AUTHORIZE_URL, IGOT_TOKEN_URL, and IGOT_API_URL to BACKEND/.env."
        })
    state = secrets.token_urlsafe(32)
    conn = get_db()
    conn.execute("DELETE FROM igot_oauth_states WHERE user_id = ?", (user['id'],))
    conn.execute("INSERT INTO igot_oauth_states (state, user_id, expires_at) VALUES (?, ?, ?)",
                 (state, user['id'], int(time.time() * 1000) + 600000))
    conn.commit()
    conn.close()
    params = {
        "response_type": "code",
        "client_id": os.getenv("IGOT_CLIENT_ID"),
        "redirect_uri": igot_redirect_uri(),
        "scope": os.getenv("IGOT_SCOPES", IGOT_DEFAULT_SCOPES),
        "state": state
    }
    return jsonify({"configured": True, "authorizationUrl": os.getenv("IGOT_AUTHORIZE_URL") + "?" + urllib.parse.urlencode(params)})

@app.route('/api/igot/oauth/callback', methods=['GET'])
def igot_oauth_callback():
    state = request.args.get('state', '')
    code = request.args.get('code', '')
    conn = get_db()
    state_row = conn.execute("SELECT * FROM igot_oauth_states WHERE state = ? AND expires_at > ?", (state, int(time.time() * 1000))).fetchone()
    if not state_row or not code:
        conn.close()
        return "Invalid or expired iGOT authorization request.", 400
    token_request = urllib.request.Request(
        os.getenv("IGOT_TOKEN_URL"),
        data=urllib.parse.urlencode({
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": igot_redirect_uri(),
            "client_id": os.getenv("IGOT_CLIENT_ID"),
            "client_secret": os.getenv("IGOT_CLIENT_SECRET")
        }).encode(),
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST"
    )
    try:
        with urllib.request.urlopen(token_request, timeout=15) as response:
            token_data = json.loads(response.read().decode())
        conn.execute("INSERT OR REPLACE INTO igot_connections (user_id, access_token, refresh_token, expires_at, scope, connected_at) VALUES (?, ?, ?, ?, ?, ?)", (
            state_row['user_id'], token_data.get('access_token'), token_data.get('refresh_token'),
            int(time.time() * 1000) + int(token_data.get('expires_in', 3600)) * 1000,
            token_data.get('scope', os.getenv("IGOT_SCOPES", IGOT_DEFAULT_SCOPES)), datetime.now(timezone.utc).isoformat()
        ))
        conn.execute("DELETE FROM igot_oauth_states WHERE state = ?", (state,))
        conn.commit()
    except Exception as error:
        conn.close()
        return f"iGOT token exchange failed: {error}", 502
    conn.close()
    return "<script>window.opener && window.opener.postMessage({type:'igot-connected'}, window.location.origin); window.close();</script>iGOT connected. You can close this window."

@app.route('/api/igot/sync', methods=['POST'])
def igot_sync():
    user = get_auth_user()
    if not user:
        return jsonify({"message": "Authentication required."}), 401
    conn = get_db()
    connection = conn.execute("SELECT * FROM igot_connections WHERE user_id = ?", (user['id'],)).fetchone()
    conn.close()
    if not connection:
        return jsonify({"message": "Connect iGOT Karmayogi before synchronizing progress."}), 409
    payload = request.get_json() or {}
    if connection['access_token'] == 'mock-access-token':
        return jsonify({
            "success": True,
            "provider": "iGOT Karmayogi (simulation)",
            "response": {"accepted": len(payload.get('progress', []))}
        })
    sync_request = urllib.request.Request(
        os.getenv("IGOT_API_URL"),
        data=json.dumps({"user": {"departmentId": user['department_id'], "email": user['email']}, "progress": payload.get('progress', [])}).encode(),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {connection['access_token']}"},
        method="POST"
    )
    try:
        with urllib.request.urlopen(sync_request, timeout=15) as response:
            upstream = json.loads(response.read().decode() or "{}")
        return jsonify({"success": True, "provider": "iGOT Karmayogi", "response": upstream})
    except Exception as error:
        return jsonify({"message": f"iGOT synchronization failed: {error}"}), 502

# --- Authentication Endpoints ---
@app.route('/api/auth/register', methods=['POST'])
def register():
    data = request.get_json() or {}
    name = data.get('name', '').strip()
    dept_id = data.get('departmentId', '').strip().upper()
    email = data.get('email', '').strip().lower()
    pw = data.get('password', '')
    if not all([name, dept_id, email, pw]):
        return jsonify({"message": "All fields are required."}), 400
    if len(pw) < 6:
        return jsonify({"message": "Security PIN must be at least 6 characters long."}), 400
    conn = get_db()
    today = time.strftime('%Y-%m-%d')
    try:
        cur = conn.cursor()
        cur.execute("""
            INSERT INTO users (name, department_id, email, password_hash, joined_date, last_active)
            VALUES (?, ?, ?, ?, ?, ?)
        """, (name, dept_id, email, hash_pw(pw), today, today))
        user_id = cur.lastrowid
        conn.commit()
        seed_user_competencies(user_id, 'data-analyst')
        return jsonify({"success": True})
    except sqlite3.IntegrityError:
        return jsonify({"message": "Department ID or Email already registered in roster."}), 409
    finally:
        conn.close()

@app.route('/api/auth/request-otp', methods=['POST'])
def request_otp():
    data = request.get_json() or {}
    dept_id = data.get('departmentId', '').strip().upper()
    email = data.get('email', '').strip().lower()
    pw = data.get('password', '')
    conn = get_db()
    user = conn.execute("SELECT * FROM users WHERE department_id = ? AND email = ?", (dept_id, email)).fetchone()
    if not user or not verify_pw(pw, user['password_hash']):
        conn.close()
        return jsonify({"message": "Invalid officer credentials."}), 401
    otp = str(secrets.randbelow(900000) + 100000)
    challenge_id = secrets.token_urlsafe(24)
    otp_hash = hashlib.sha256(otp.encode()).hexdigest()
    expires_at = int(time.time() * 1000) + 300000
    conn.execute("DELETE FROM otp_challenges WHERE user_id = ?", (user['id'],))
    conn.execute("""
        INSERT INTO otp_challenges (id, user_id, purpose, otp_hash, expires_at)
        VALUES (?, ?, 'login', ?, ?)
    """, (challenge_id, user['id'], otp_hash, expires_at))
    conn.commit()
    conn.close()
    delivery_mode = deliver_otp(user['email'], otp, purpose="login")
    return jsonify({
        "success": True,
        "challengeId": challenge_id,
        "delivery": delivery_mode,
        "expiresInSeconds": 300
    })

@app.route('/api/auth/verify-otp', methods=['POST'])
def verify_otp():
    data = request.get_json() or {}
    challenge_id = data.get('challengeId')
    otp = data.get('otp', '').strip()
    otp_hash = hashlib.sha256(otp.encode()).hexdigest()
    conn = get_db()
    row = conn.execute("""
        SELECT c.*, u.name, u.department_id, u.role_key
        FROM otp_challenges c
        JOIN users u ON c.user_id = u.id
        WHERE c.id = ? AND c.purpose = 'login'
    """, (challenge_id,)).fetchone()
    if not row or row['otp_hash'] != otp_hash or int(time.time() * 1000) > row['expires_at']:
        conn.close()
        return jsonify({"message": "Invalid or expired OTP."}), 401
    token = secrets.token_hex(32)
    conn.execute("DELETE FROM otp_challenges WHERE id = ?", (challenge_id,))
    conn.execute("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)",
                 (token, row['user_id'], int(time.time() * 1000) + 86400000))
    conn.commit()
    conn.close()
    return jsonify({
        "success": True,
        "token": token,
        "user": {
            "name": row['name'],
            "departmentId": row['department_id'],
            "roleKey": row['role_key']
        }
    })

@app.route('/api/auth/request-password-reset-otp', methods=['POST'])
def request_password_reset_otp():
    data = request.get_json() or {}
    name = data.get('name', '').strip()
    email = data.get('email', '').strip().lower()
    conn = get_db()
    user = conn.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
    if not user or user['name'].strip().lower() != name.lower():
        conn.close()
        return jsonify({"message": "No officer matching that name and email was found."}), 404
    otp = str(secrets.randbelow(900000) + 100000)
    challenge_id = secrets.token_urlsafe(24)
    otp_hash = hashlib.sha256(otp.encode()).hexdigest()
    expires_at = int(time.time() * 1000) + 300000
    conn.execute("DELETE FROM otp_challenges WHERE user_id = ?", (user['id'],))
    conn.execute("""
        INSERT INTO otp_challenges (id, user_id, purpose, otp_hash, expires_at)
        VALUES (?, ?, 'password_reset', ?, ?)
    """, (challenge_id, user['id'], otp_hash, expires_at))
    conn.commit()
    conn.close()
    delivery_mode = deliver_otp(user['email'], otp, purpose="password_reset")
    return jsonify({
        "success": True,
        "challengeId": challenge_id,
        "delivery": delivery_mode,
        "expiresInSeconds": 300
    })

@app.route('/api/auth/verify-password-reset-otp', methods=['POST'])
def verify_password_reset_otp():
    data = request.get_json() or {}
    challenge_id = data.get('challengeId')
    otp = data.get('otp', '').strip()
    new_password = data.get('password', '')
    if len(new_password) < 6:
        return jsonify({"message": "Password must be at least 6 characters long."}), 400
    otp_hash = hashlib.sha256(otp.encode()).hexdigest()
    conn = get_db()
    challenge = conn.execute("""
        SELECT * FROM otp_challenges WHERE id = ? AND purpose = 'password_reset'
    """, (challenge_id,)).fetchone()
    if not challenge or challenge['otp_hash'] != otp_hash or int(time.time() * 1000) > challenge['expires_at']:
        conn.close()
        return jsonify({"message": "Invalid or expired recovery code."}), 401
    conn.execute("UPDATE users SET password_hash = ? WHERE id = ?", (hash_pw(new_password), challenge['user_id']))
    conn.execute("DELETE FROM otp_challenges WHERE id = ?", (challenge_id,))
    conn.execute("DELETE FROM sessions WHERE user_id = ?", (challenge['user_id'],))
    conn.commit()
    conn.close()
    return jsonify({"success": True, "message": "Password reset successfully."})

# --- Profile, Cadre & Competencies Endpoints ---
@app.route('/api/user/profile', methods=['GET'])
def profile():
    user = get_auth_user()
    if not user:
        return jsonify({"message": "Unauthorized"}), 401
    return jsonify({
        "profile": {
            "name": user['name'],
            "departmentId": user['department_id'],
            "roleKey": user['role_key'],
            "joinedDate": user['joined_date'],
            "lastActive": user['last_active']
        }
    })

@app.route('/api/user/role', methods=['PUT'])
def update_role():
    user = get_auth_user()
    if not user:
        return jsonify({"message": "Unauthorized"}), 401
    role_key = (request.get_json() or {}).get('roleKey')
    if role_key not in DEFAULT_CADRES:
        return jsonify({"message": "Invalid cadre specified."}), 400
    conn = get_db()
    conn.execute("UPDATE users SET role_key = ? WHERE id = ?", (role_key, user['id']))
    conn.commit()
    conn.close()
    seed_user_competencies(user['id'], role_key)
    return jsonify({"success": True, "roleKey": role_key})

@app.route('/api/competencies', methods=['GET'])
def competencies():
    user = get_auth_user()
    if not user:
        return jsonify({"message": "Unauthorized"}), 401
    seed_user_competencies(user['id'], user['role_key'])
    conn = get_db()
    rows = conn.execute("""
        SELECT domain, desc, current, target FROM competencies
        WHERE user_id = ? AND role_key = ?
    """, (user['id'], user['role_key'])).fetchall()
    conn.close()
    return jsonify({"competencies": [dict(r) for r in rows]})

@app.route('/api/assessments', methods=['GET'])
def assessments():
    user = get_auth_user()
    if not user:
        return jsonify({"message": "Unauthorized"}), 401
    conn = get_db()
    rows = conn.execute("""
        SELECT id, topic, domain, date, score, status FROM assessments
        WHERE user_id = ? ORDER BY id DESC
    """, (user['id'],)).fetchall()
    conn.close()
    return jsonify({"assessments": [dict(r) for r in rows]})

@app.route('/api/assessments/submit', methods=['POST'])
def submit_assessment():
    user = get_auth_user()
    if not user:
        return jsonify({"message": "Unauthorized"}), 401
    data = request.get_json() or {}
    topic = data.get('topic', 'General Evaluation')
    domain = data.get('domain', 'General Governance')
    score = int(data.get('score', 0))
    status = "Passed" if score >= 70 else "Needs Review"
    today = time.strftime('%Y-%m-%d')
    conn = get_db()
    competency_domain = resolve_competency_domain(domain, user['role_key'])
    conn.execute("""
        INSERT INTO assessments (user_id, topic, domain, date, score, status)
        VALUES (?, ?, ?, ?, ?, ?)
    """, (user['id'], topic, competency_domain, today, score, status))
    cur_score = conn.execute("""
        SELECT current FROM competencies WHERE user_id = ? AND role_key = ? AND domain = ?
    """, (user['id'], user['role_key'], competency_domain)).fetchone()
    if cur_score:
        new_val = min(100, max(20, round(cur_score['current'] * 0.7 + score * 0.3)))
        conn.execute("""
            UPDATE competencies SET current = ? WHERE user_id = ? AND role_key = ? AND domain = ?
        """, (new_val, user['id'], user['role_key'], competency_domain))
    conn.execute("UPDATE users SET last_active = ? WHERE id = ?", (today, user['id']))
    conn.commit()
    conn.close()
    return jsonify({"success": True})

# --- AI Quiz Generator Endpoint ---
@app.route('/api/quiz/generate', methods=['POST'])
def generate_quiz():
    data = request.form.to_dict() if request.form else (request.get_json() or {})
    topic = (data.get('topic') or '').strip() or 'MoSPI Official Statistics'
    difficulty = data.get('difficulty', 'medium')
    count = min(100, max(1, int(data.get('count', 3))))
    authenticated_user = get_auth_user()
    role_key = authenticated_user['role_key'] if authenticated_user else data.get('roleKey', 'data-analyst')
    role_domains = DEFAULT_CADRES.get(role_key, DEFAULT_CADRES['data-analyst'])
    cadre_context = "; ".join(f"{domain}: {description}" for domain, description, _, _ in role_domains)
    domain_names = ", ".join(domain for domain, _, _, _ in role_domains)
    source_text = ''
    source_name = None
    learning_file = request.files.get('learning_material')
    if learning_file and learning_file.filename:
        try:
            source_text = extract_learning_material(learning_file).strip()
            source_name = learning_file.filename
        except Exception as error:
            return jsonify({"message": str(error)}), 400
    if not topic and not source_text:
        return jsonify({"message": "Provide a topic or upload a learning material file."}), 400
    source_context = source_text[:50000] if source_text else (
        "No document uploaded. Build every question specifically around the typed topic or guidelines; "
        "use MoSPI context only where it helps interpret that topic."
    )

    prompt = f"""
    Generate a multiple-choice diagnostic quiz for Indian civil-service officers working with MoSPI and India's Official Statistical System.
    Officer cadre: {role_key}
    Cadre competency domains and responsibilities: {cadre_context}
    Topic / Guidelines: {topic}
    Learning material extracted from {source_name or 'the selected topic'}:
    {source_context}
    Difficulty level: {difficulty}
    Total questions: {count}

    Rules:
    - Exactly 4 plausible options per question.
    - correctIndex must be an integer (0, 1, 2, or 3).
    - When no learning material is supplied, make the typed Topic / Guidelines the central subject of every question. Do not replace it with generic MoSPI questions.
    - When learning material is supplied, ground the questions in that material while keeping the typed topic as the focus when one is provided.
    - Map each question to one of this officer cadre's domains: {domain_names}.
    - Tailor the scenarios and decision context to the responsibilities of the selected officer cadre.
    - Test interpretation of official estimates, metadata, sampling, revisions, confidentiality, quality, and evidence-led policy use.
    - Do not invent a statistic or cite a document fact that is absent from the supplied material.
    - Provide a detailed rationale grounded in the supplied material or established official-statistics practice.
    """

    quiz_schema = {
        "type": "OBJECT",
        "properties": {
            "questions": {
                "type": "ARRAY",
                "items": {
                    "type": "OBJECT",
                    "properties": {
                        "question": {"type": "STRING"},
                        "options": {
                            "type": "ARRAY",
                            "items": {"type": "STRING"}
                        },
                        "correctIndex": {"type": "INTEGER"},
                        "domain": {"type": "STRING"},
                        "rationale": {"type": "STRING"}
                    },
                    "required": ["question", "options", "correctIndex", "domain", "rationale"]
                }
            }
        },
        "required": ["questions"]
    }

    try:
        if not ai_client:
            raise RuntimeError("GEMINI_API_KEY is not configured")
        response = ai_client.models.generate_content(
            model=QUIZ_MODEL,
            contents=prompt,
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                response_schema=quiz_schema,
                temperature=0.3,
                # A 100-question assessment needs a larger response budget
                # than the SDK default.
                max_output_tokens=32768
            )
        )
        parsed = json.loads(response.text)
        generated_questions = parsed.get("questions", [])
        if len(generated_questions) != count:
            raise ValueError(
                f"AI returned {len(generated_questions)} questions; expected {count}."
            )

        for question in generated_questions:
            options = question.get("options", [])
            correct_index = question.get("correctIndex")
            if (
                not isinstance(question.get("question"), str)
                or len(options) != 4
                or not all(isinstance(option, str) and option.strip() for option in options)
                or not isinstance(correct_index, int)
                or correct_index not in range(4)
            ):
                raise ValueError("AI returned an invalid quiz question.")

        formatted_questions = [
            {
                "id": f"q_{idx + 1}",
                "question": q["question"],
                "options": q["options"],
                "correctIndex": int(q["correctIndex"]),
                "domain": q.get("domain", "General Governance"),
                "rationale": q.get("rationale", "")
            }
            for idx, q in enumerate(generated_questions)
        ]
    except Exception as e:
        print(f"[AI Generation Fallback] Error contacting AI engine: {e}")
        formatted_questions = []
        for i in range(count):
            t = FALLBACK_POOL[i % len(FALLBACK_POOL)]
            formatted_questions.append({
                "id": f"q_{i + 1}",
                "question": t["q"].format(topic=topic),
                "options": t["options"],
                "correctIndex": t["correct"],
                "domain": t["domain"],
                "rationale": t["rationale"]
            })

    return jsonify({
        "topic": topic,
        "sourceFile": source_name,
        "difficulty": difficulty,
        "difficultyLabel": difficulty.capitalize(),
        "questions": formatted_questions
    })

# --- Static Frontend Serving ---
@app.route('/', defaults={'path': 'index.html'})
@app.route('/<path:path>')
def serve_site(path):
    target = os.path.join(SITE_DIR, path)
    if os.path.exists(target) and not os.path.isdir(target):
        return send_from_directory(SITE_DIR, path)
    return send_from_directory(SITE_DIR, 'index.html')

if __name__ == '__main__':
    port = int(os.environ.get("PORT", 5000))
    debug_mode = os.environ.get("FLASK_ENV", "production") == "development"
    print(f"Aethernyx Python Backend starting on port {port} (debug={debug_mode})")
    app.run(host='0.0.0.0', port=port, debug=debug_mode)
