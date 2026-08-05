#!/bin/bash
# ─── TarHeel Transit — Start Script ──────────────────────────────────────────
set -e

BLUE='\033[0;34m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo ""
echo -e "${BLUE}🚌  TarHeel Transit${NC}"
echo -e "${BLUE}    UNC Chapel Hill Bus Dashboard${NC}"
echo ""

# Install backend deps
echo -e "${YELLOW}[1/4] Installing backend dependencies...${NC}"
cd "$(dirname "$0")/backend"
npm install --silent

# Install frontend deps
echo -e "${YELLOW}[2/4] Installing frontend dependencies...${NC}"
cd "../frontend"
npm install --silent

# Check for Mapbox token
if grep -q "YOUR_TOKEN_HERE" .env 2>/dev/null; then
  echo ""
  echo -e "${YELLOW}⚠️  Mapbox token not set!${NC}"
  echo "    Get a free token at: https://account.mapbox.com/auth/signup/"
  echo "    Then edit: frontend/.env  →  VITE_MAPBOX_TOKEN=pk.your_token"
  echo ""
fi

# Start backend
echo -e "${YELLOW}[3/4] Starting backend (port 3001)...${NC}"
cd "../backend"
node server.js &
BACKEND_PID=$!
sleep 2

# Start frontend
echo -e "${YELLOW}[4/4] Starting frontend (port 5173)...${NC}"
cd "../frontend"
npm run dev &
FRONTEND_PID=$!

echo ""
echo -e "${GREEN}✅  TarHeel Transit is running!${NC}"
echo ""
echo -e "    Frontend  →  ${BLUE}http://localhost:5173${NC}"
echo -e "    Backend   →  ${BLUE}http://localhost:3001${NC}"
echo -e "    API docs  →  ${BLUE}http://localhost:3001/api/health${NC}"
echo ""
echo "    Press Ctrl+C to stop both servers."
echo ""

# Wait and clean up on exit
trap "kill $BACKEND_PID $FRONTEND_PID 2>/dev/null; echo ''; echo 'Stopped.'" EXIT
wait
