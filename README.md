# 🏢 Enterprise Performance & Appraisal Management System — Backend API

Enterprise-grade Node.js & Express backend for managing multi-cohort employee performance reviews, 4-quarter KRA evaluations, annual salary increments, digital letter generation, 9-box talent matrix calibration, and audit logging.

---

## 🛠️ Tech Stack & Architecture

- **Runtime:** Node.js (v18.x, v20.x, or v22.x)
- **Framework:** Express.js 4.x
- **Language:** TypeScript
- **Authentication:** JWT (JSON Web Tokens) with Bcrypt password hashing
- **Database Engine:** Built-in High-Performance Embedded Document Store (`server/db.ts`) with full MongoDB Compass schema compatibility and optional MongoDB Atlas support
- **AI Integration:** Google GenAI SDK (`@google/genai` on `gemini-3.8-flash`)
- **Execution & Bundler:** `tsx` for hot-reloading dev server, `esbuild` for standalone single-file production compilation (`dist/server.cjs`)

---

## 📂 Backend Directory Structure

```text
backend/
├── server.ts                    # Main Express server entry point & CORS configuration
├── server/
│   ├── db.ts                   # In-memory document database engine (with collection persistence)
│   ├── seedData.ts             # Initial enterprise seed data (Employees across Cycles A-H, KRAs, etc.)
│   └── routes/
│       ├── authRoutes.ts       # Authentication, login, token refresh, and role switching
│       ├── masterDataRoutes.ts # Cycles (A-H), departments, designations, and employee directory
│       ├── kraRoutes.ts        # KRA templates, goal libraries, and 100% weightage validation
│       ├── reviewRoutes.ts     # 4-quarter review scoring, self-assessments, manager reviews
│       ├── appraisalRoutes.ts  # 8-cycle cohort rollups, bell-curve calibrations, salary letters
│       ├── essRoutes.ts        # Employee Self-Service (ESS) and milestone tracker
│       ├── analyticsRoutes.ts  # Executive dashboards, bell curve normalization & budget pools
│       ├── notificationRoutes.ts # In-app workflow notification engine
│       ├── bulkDataRoutes.ts   # CSV/Excel bulk import and export pipelines
│       ├── auditRoutes.ts      # Immutable ISO-compliant audit logs
│       └── aiAndFeedbackRoutes.ts # Gemini 3.8 Flash AI narrative synthesis & 360 kudos
├── package.json
├── tsconfig.json
├── .env.example
└── README.md
```

---

## ⚙️ Environment Variables Setup

Create a `.env` file in the root of the `backend/` directory:

```env
# Port on which Express runs (Default: 3000)
PORT=3000

# Secret key used for signing JWT authentication tokens
JWT_SECRET=quarterly_review_appraisal_jwt_secret_key_2026

# Optional: Google Gemini API Key for AI synthesis features
GEMINI_API_KEY=your_google_gemini_api_key_here

# Optional: MongoDB Connection String (if connecting to MongoDB Atlas)
MONGODB_URI=mongodb://localhost:27017/review_appraisal_db
DATABASE_NAME=review_appraisal_db
```

---

## 🚀 Getting Started (Local Development)

### 1. Install Dependencies
```bash
npm install
```

### 2. Start the Development Server
```bash
npm run dev
```

The server will start on:
👉 **`http://localhost:3000`**

### 3. Build & Run for Production
```bash
# Compile TypeScript into single-file CommonJS bundle
npm run build

# Start the compiled production server
npm start
```

---

## 📡 Core API Route Reference

| Endpoint Prefix | Description | Key Capabilities |
| :--- | :--- | :--- |
| `POST /api/auth/login` | User Authentication | Login with corporate credentials, returns JWT token |
| `GET /api/auth/me` | Current Profile | Returns authenticated user info and permissions |
| `POST /api/auth/switch-role`| Persona Switch | Fast switch for testing RBAC across user roles |
| `GET /api/employees` | Employee Directory | Filterable list across cohorts (June / September cycles) |
| `GET /api/kras` | KRA Goal Library | KRA definitions with 100% weightage invariants |
| `GET /api/reviews` | Quarterly Reviews | 4-Quarter review scores (Q1, Q2, Q3, Q4) |
| `GET /api/appraisals` | Annual Appraisals | June/September cohort rollups, promotions, increment percentages |
| `POST /api/ai/synthesize-review` | AI Review Narrative | Gemini 3.8 Flash automated review synthesis |
| `POST /api/ai/bias-check` | AI Tone Harmonizer | Detection of subjective bias and corrective rewrites |
| `GET /api/audit/logs` | Audit Trail | Immutable compliance logs of all appraisal actions |

---

## ☁️ Deployment Guide (Railway / Render / Heroku)

1. **Root Directory:** Point your deployment service to the `backend` folder.
2. **Build Command:** `npm run build`
3. **Start Command:** `npm start`
4. **Environment Variables:**
   - Add `PORT` (e.g. `3000` or assigned dynamically by host)
   - Add `JWT_SECRET`
   - Add `GEMINI_API_KEY` (optional)
5. **CORS:** The server automatically supports CORS requests from your Vercel frontend URL.
