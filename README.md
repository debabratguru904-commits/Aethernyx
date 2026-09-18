# Aethernyx

Aethernyx is an officer capability and learning workspace for **MoSPI and India's Official Statistical System**. It helps officers identify statistical competency gaps, practice decision-making with AI-generated quizzes, learn from official documents, and synchronize progress with iGOT Karmayogi.

## What the website provides

- **MoSPI competency diagnostics**: role-based readiness scores for official statistics, macroeconomic indicators, survey methodology, statistical quality, data governance, and statistical communication.
- **Document-grounded AI Quiz Lab**: generate scenario-based multiple-choice assessments from a topic or uploaded PDF, DOCX, TXT, or Markdown learning material.
- **Assessment audit trail**: completed quiz scores update competency progress and remain available in the officer dashboard.
- **iGOT Karmayogi integration**: connect through OAuth when partner credentials are available, or use the built-in local simulation for a reliable hackathon demo.
- **Officer authentication**: registration, password login with OTP verification, password recovery, role selection, and local SQLite persistence.

## Quick start

From the workspace root in Windows PowerShell:

```powershell
python -m pip install -r BACKEND\requirements.txt
python BACKEND\server.py
```

Open [http://localhost:5000](http://localhost:5000). The Flask server hosts both the website and API, so a separate frontend server is not required.

To stop the server, press `Ctrl+C` in the terminal running it.

## Configuration

Environment values are loaded from `BACKEND/.env`. Keep this file private and never commit API keys or client secrets.

### Gemini quizzes

Live AI quiz generation uses:

```text
GEMINI_API_KEY=your-gemini-api-key
```

If the key is unavailable or the AI request fails, the Quiz Lab uses a built-in MoSPI fallback question bank so the demonstration remains usable.

### OTP email

Email delivery is optional. Configure SMTP values to send OTPs by email:

```text
AETHERNYX_SMTP_USER=your-gmail-address
AETHERNYX_SMTP_PASS=your-gmail-app-password
```

Without SMTP configuration, development OTPs are printed in the backend terminal. The application does not claim that an email was delivered.

### iGOT Karmayogi

For local judging, the default simulation is enabled:

```text
IGOT_MOCK_MODE=true
```

In simulation mode, **Connect iGOT** creates a local connection and **Sync progress** reports the number of submitted assessments accepted by the simulator.

For a real iGOT OAuth connection, obtain partner credentials and endpoint details, then add:

```text
IGOT_MOCK_MODE=false
IGOT_CLIENT_ID=your-client-id
IGOT_CLIENT_SECRET=your-client-secret
IGOT_AUTHORIZE_URL=https://your-igot-provider.example/oauth/authorize
IGOT_TOKEN_URL=https://your-igot-provider.example/oauth/token
IGOT_API_URL=https://your-igot-provider.example/api/progress
IGOT_REDIRECT_URI=http://localhost:5000/api/igot/oauth/callback
IGOT_SCOPES=learning.progress.write learning.catalog.read
```

Register the redirect URI with the iGOT provider. The client secret remains on the Flask server. The actual authorization, token exchange, and progress payload contract must be supplied by the iGOT integration team.

## Typical demo flow

1. Start the backend and open `http://localhost:5000`.
2. Register an officer or sign in with an existing account.
3. Review the MoSPI competency dashboard and gap diagnostics.
4. Open **AI Quiz Lab**.
5. Enter a topic such as `CPI revision policy`, or upload a PDF/DOCX/TXT/Markdown learning document.
6. Generate and submit the assessment.
7. Return to the dashboard to view the updated score.
8. On Overview, click **Connect iGOT**, then **Sync progress**.

## API endpoints

### Health and authentication

- `GET /api/health`
- `POST /api/auth/register`
- `POST /api/auth/request-otp`
- `POST /api/auth/verify-otp`
- `POST /api/auth/request-password-reset-otp`
- `POST /api/auth/verify-password-reset-otp`

### Officer workspace

- `GET /api/user/profile`
- `PUT /api/user/role`
- `GET /api/competencies`
- `GET /api/assessments`
- `POST /api/assessments/submit`

### Quiz generation

- `POST /api/quiz/generate`

The endpoint accepts JSON for topic-only quizzes or `multipart/form-data` with a `learning_material` file for document-grounded quizzes.

### iGOT integration

- `GET /api/igot/status`
- `POST /api/igot/oauth/start`
- `GET /api/igot/oauth/callback`
- `POST /api/igot/sync`

## Project structure

```text
BACKEND/
	.env                 Local secrets and service configuration
	.gitignore           Runtime-file ignore rules
	database.sqlite      Local SQLite data store, created by the backend
	requirements.txt     Python dependencies
	server.py            Flask API and static-site server
SITE/
	index.html            Application markup
	script.js             Frontend state, API calls, and interactions
	style.css             Application styling and responsive layout
README.md               Setup and feature documentation
```

## Validation

Useful local checks from the workspace root:

```powershell
python -m py_compile BACKEND\server.py
node --check SITE\script.js
```

The backend health response should return `status: ok` at `/api/health`.