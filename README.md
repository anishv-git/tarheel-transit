# 🚌 TarHeel Transit

A live bus dashboard for **UNC Chapel Hill** — see campus and Chapel Hill Transit
buses moving in real time on an interactive map, with route overlays, stop info,
and arrival predictions.

## What it does

- **Live map** (Mapbox GL) with road-snapped GTFS route shapes
- **Real-time vehicles** from TransLoc (UNC campus buses, agency 347) and
  Chapel Hill Transit
- **MoveUNC P2P** night service (7 PM – 3 AM) — live vehicles, routes, and stops
- **Arrival predictions** from the GTFS schedule (calendar + stop_times)
- **Active-route detection** so only routes running right now are highlighted
- **Campus destinations** quick-search (Davis Library, Lenoir, the Pit, etc.)

## Architecture

| Layer | Stack |
|-------|-------|
| Frontend | React 18 + Vite + Mapbox GL JS + Tailwind + lucide-react |
| Backend  | Node.js + Express, GTFS ingestion (adm-zip + csv-parse) |
| Data     | Chapel Hill Transit GTFS, TransLoc live feed, MoveUNC (Passio/Syncromatics) |

The backend downloads and caches the GTFS feed (refreshing every 12 hours),
builds in-memory lookup indices, and exposes a small REST API the frontend polls.

### Backend API (selected endpoints)

```
GET /api/health
GET /api/routes
GET /api/active-routes
GET /api/stops
GET /api/shapes            /api/shapes/:routeKey
GET /api/routes/:routeKey/stops
GET /api/next-trips
GET /api/arrivals/:stopId
GET /api/vehicles                    # live TransLoc vehicles
GET /api/moveunc                     # MoveUNC P2P status
GET /api/moveunc/routes  /vehicles  /shapes  /stops
```

## Getting started

### Prerequisites
- Node.js 18+
- A free [Mapbox token](https://account.mapbox.com/auth/signup/)

### Setup

```bash
# 1. Configure environment
cp backend/.env.example  backend/.env
cp frontend/.env.example frontend/.env
# then paste your Mapbox token into frontend/.env

# 2. Run everything (installs deps + starts both servers)
./start.sh
```

- Frontend → http://localhost:5173
- Backend  → http://localhost:3001
- Health   → http://localhost:3001/api/health

### Run manually

```bash
# Backend
cd backend && npm install && npm start

# Frontend (separate terminal)
cd frontend && npm install && npm run dev
```

## Project structure

```
tarheel-transit/
├── backend/
│   ├── server.js          # Express API + GTFS ingestion
│   ├── package.json
│   └── .env.example
├── frontend/
│   ├── src/
│   │   ├── App.jsx        # Main dashboard + map
│   │   ├── main.jsx
│   │   └── index.css
│   ├── index.html
│   ├── vite.config.js
│   └── .env.example
└── start.sh               # One-command dev launcher
```

## Data sources

- **Chapel Hill Transit GTFS** — http://mychtransit.org/gtfs (public)
- **TransLoc** — UNC campus bus positions (agency 347)
- **MoveUNC** — P2P night service via Passio GO / Syncromatics

---

Not affiliated with UNC Chapel Hill or Chapel Hill Transit. Built for students. 💙
