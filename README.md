# Sytist Production Dashboard

Web-based production dashboard for processing Sytist orders into Darkroom-ready txt files, packing slips, and ShipStation shipments. Pulls order data directly from the Sytist MySQL database.

Mirrors the architecture of the Photo Day Dashboard but is a separate, standalone project.

**Status:** Phase 0 — bootstrap. See `SPEC.md` for full roadmap.

---

## Setup

### Prerequisites

- Node.js 22+ (developed on 22.13.1)
- Network access to the Sytist droplet (Phase 2+)
- A `.env` file in `server/` with required variables (see `.env.example`)

### First-time install

From the project root:

```powershell
npm run install-all
```

This installs deps for the root, server, and client in one go.

### Configure

Copy the env template and fill in values:

```powershell
copy .env.example server\.env
```

Edit `server\.env` — at minimum, set `SESSION_SECRET`. Other vars get filled in as later phases need them.

Generate a session secret:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Run (development)

```powershell
npm run dev
```

Starts both processes concurrently:

- Server on http://localhost:3011
- Client on http://localhost:3010

Open http://localhost:3010 — should show "✅ Connected to server" if both started successfully.

### Run individually

If you want one without the other:

```powershell
npm run server   # only the Express API
npm run client   # only the React dev server
```

---

## Project structure

```
sytist-dashboard/
├── server/                    Express API server (port 3011)
│   ├── index.js               App entry point
│   ├── routes/                HTTP routes (Phase 1+)
│   ├── services/              Business logic (Phase 2+)
│   ├── middleware/            Auth, request logging, etc. (Phase 1+)
│   ├── config/                JSON configs + local SQLite (gitignored)
│   └── assets/                Uploaded overlays/logos/fonts (Phase 9, gitignored)
│
├── client/                    React app (port 3010 in dev)
│   ├── public/
│   └── src/
│       ├── App.js
│       ├── index.js
│       ├── pages/             Route-level components (Phase 1+)
│       ├── services/          API client wrappers (Phase 1+)
│       └── styles/
│
├── SPEC.md                    Full project specification
├── README.md                  This file
├── package.json               Root scripts (run both, install-all)
├── .gitignore
└── .env.example
```

### Why separate `server/` and `client/`?

Same pattern as the Photo Day Dashboard. The server is a long-running Node process; the client is a static bundle in production. Keeping them in separate trees keeps deps clean and lets each be deployed independently when we move to the droplet container.

---

## Roadmap

| Phase | Description | Status |
|-------|-------------|--------|
| 0 | Bootstrap — empty skeleton, dev server runs | **← here** |
| 1 | Auth — login page, session middleware | next |
| 2 | Sytist MySQL data layer | |
| 3 | Read-only orders UI | |
| 4 | Pipeline port (Darkroom txt, packing slip, imposition, ShipStation pieces) | |
| 5 | ShipStation integration | |
| 6 | Schedulers (auto-fetch + scheduled batch) | |
| 7 | Status writeback to Sytist | |
| 8 | Composition engine (Memory Mate, etc.) — JSON-driven | |
| 9 | Asset upload + per-gallery logo assignment | |
| 10 | Visual template editor | |
| 11 | Per-order re-render with overrides | |
| 12 | Polish | |

See `SPEC.md` for what each phase delivers and the rationale behind the ordering.

---

## Conventions

- **Ports:** server 3011, client 3010 (chosen to coexist with the Photo Day Dashboard on 3000/3001).
- **No business logic in routes.** Routes are thin: parse input, call a service, return JSON. Services are testable units.
- **JSON config files** in `server/config/` for runtime settings (like the photo day dashboard).
- **Local SQLite** (also in `server/config/`) for tracking, audit log, schedules. **NOT** for caching Sytist data — that comes fresh from MySQL each request.
- **Never write to `ms_order_status_logs`** in the Sytist database. That table is owned by an existing automation. We write to `ms_orders.order_open_status` instead.

---

## Troubleshooting

**Client says "Server not reachable"** — make sure the server actually started on 3011. Check the terminal where `npm run dev` is running for errors. Common cause: port 3011 already in use.

**`npm run dev` only starts one process** — `concurrently` should run both. If only one runs, check that you ran `npm run install-all` (which installs `concurrently` at the root).

**CORS errors** — the server explicitly allows `http://localhost:3010` in dev. If you're running the client on a different port, edit `server/index.js`.

**Port 3010 already in use** — the photo day dashboard might be running on 3000, but if something else is on 3010 you'll need to either stop it or change the port in `client/package.json` and the CORS origin in `server/index.js`.
