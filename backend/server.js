/**
 * TarHeel Transit — Backend API Server
 *
 * Serves:
 *  - GTFS routes, stops, and road-following shapes from Chapel Hill Transit
 *  - Active-route detection via GTFS calendar + stop_times
 *  - Live vehicle positions from TransLoc (UNC campus buses, agency 347)
 *  - Enhanced vehicle details: next stop, heading, headsign
 *  - MoveUNC P2P status + live vehicle proxy (Passio GO / Syncromatics)
 */

require('dotenv').config();

const express  = require('express');
const cors     = require('cors');
const fetch    = require('node-fetch');
const AdmZip   = require('adm-zip');
const { parse } = require('csv-parse/sync');
const path     = require('path');
const fs       = require('fs');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

// ── Config ──────────────────────────────────────────────────────────────────
const PORT            = process.env.PORT            || 3001;
const GTFS_URL        = process.env.GTFS_URL        || 'http://mychtransit.org/gtfs';
const TRANSLOC_AGENCY = process.env.TRANSLOC_AGENCY || '347';
const CACHE_DIR       = path.join(__dirname, 'cache');
const CACHE_PATH      = path.join(CACHE_DIR, 'gtfs.zip');
const REFRESH_MS      = 12 * 60 * 60 * 1000; // 12 hours

if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

// ── In-memory GTFS store ─────────────────────────────────────────────────
let gtfs = {
  routes:     [],
  stops:      [],
  shapes:     [],
  trips:      [],
  stop_times: [],
  calendar:   [],
};
let gtfsLoaded    = false;
let lastFetchTime = null;

// ── Pre-built indices (populated after each GTFS parse) ─────────────────────
// tripTimes:  trip_id → { min: minutesSinceMidnight, max: minutesSinceMidnight }
// tripMeta:   trip_id → { route_id, service_id, headsign, shape_id, direction_id }
// routeStops: route_id → [ { stop_id, stop_sequence, departure_time, stop } ]
let idx = { tripTimes: {}, tripMeta: {}, routeStops: {} };

function toMins(timeStr) {
  if (!timeStr) return NaN;
  const [h, m] = timeStr.split(':').map(Number);
  return isNaN(h) ? NaN : h * 60 + m;
}

function headingToText(deg) {
  if (deg == null) return 'Unknown';
  const dirs = ['N','NE','E','SE','S','SW','W','NW'];
  return dirs[Math.round(deg / 45) % 8];
}

function buildIndices() {
  console.log('[GTFS] Building lookup indices…');

  // trip → meta
  idx.tripMeta = {};
  for (const t of gtfs.trips) {
    idx.tripMeta[t.trip_id] = {
      route_id:     t.route_id,
      service_id:   t.service_id,
      headsign:     t.trip_headsign || '',
      shape_id:     t.shape_id     || null,
      direction_id: t.direction_id || '0',
    };
  }

  // trip → time range (minutes since midnight)
  idx.tripTimes = {};
  for (const st of gtfs.stop_times) {
    if (!st.trip_id || !st.departure_time) continue;
    const m = toMins(st.departure_time);
    if (isNaN(m)) continue;
    if (!idx.tripTimes[st.trip_id]) {
      idx.tripTimes[st.trip_id] = { min: m, max: m };
    } else {
      if (m < idx.tripTimes[st.trip_id].min) idx.tripTimes[st.trip_id].min = m;
      if (m > idx.tripTimes[st.trip_id].max) idx.tripTimes[st.trip_id].max = m;
    }
  }

  // route → ordered stops list (deduplicated, using first encountered trip per route)
  idx.routeStops = {};
  const routeSeen = new Set();
  for (const st of gtfs.stop_times) {
    const meta = idx.tripMeta[st.trip_id];
    if (!meta) continue;
    const rid = meta.route_id;
    if (!idx.routeStops[rid]) idx.routeStops[rid] = [];
    const key = `${rid}:${st.stop_id}`;
    if (!routeSeen.has(key)) {
      routeSeen.add(key);
      const stopData = gtfs.stops.find(s => s.stop_id === st.stop_id);
      idx.routeStops[rid].push({
        stop_id:        st.stop_id,
        stop_sequence:  parseInt(st.stop_sequence) || 0,
        departure_time: st.departure_time,
        name:           stopData?.stop_name || st.stop_id,
        lat:            parseFloat(stopData?.stop_lat),
        lng:            parseFloat(stopData?.stop_lon),
      });
    }
  }
  // sort each route's stops by sequence
  for (const rid of Object.keys(idx.routeStops)) {
    idx.routeStops[rid].sort((a, b) => a.stop_sequence - b.stop_sequence);
  }

  console.log(`[GTFS] Indices built: ${Object.keys(idx.tripTimes).length} trips indexed`);
}

// ── GTFS download + parse ────────────────────────────────────────────────────
async function downloadAndParseGTFS() {
  console.log('[GTFS] Fetching from', GTFS_URL);
  let zipBuffer;

  try {
    const res = await fetch(GTFS_URL, {
      timeout: 20000,
      headers: { 'User-Agent': 'TarHeelTransit/1.0' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    zipBuffer = await res.buffer();
    fs.writeFileSync(CACHE_PATH, zipBuffer);
    console.log('[GTFS] Downloaded and cached successfully');
  } catch (err) {
    console.warn('[GTFS] Live download failed:', err.message);
    if (fs.existsSync(CACHE_PATH)) {
      console.log('[GTFS] Falling back to cached zip');
      zipBuffer = fs.readFileSync(CACHE_PATH);
    } else {
      console.error('[GTFS] No cache available — routes will be empty');
      return false;
    }
  }

  try {
    const zip = new AdmZip(zipBuffer);

    const parseFile = (name) => {
      const entry = zip.getEntry(name);
      if (!entry) { console.warn(`[GTFS] Missing: ${name}`); return []; }
      return parse(entry.getData().toString('utf8'), {
        columns: true, skip_empty_lines: true, trim: true, relax_column_count: true,
      });
    };

    gtfs.routes     = parseFile('routes.txt');
    gtfs.stops      = parseFile('stops.txt');
    gtfs.shapes     = parseFile('shapes.txt');
    gtfs.trips      = parseFile('trips.txt');
    gtfs.stop_times = parseFile('stop_times.txt');
    gtfs.calendar   = parseFile('calendar.txt');

    gtfsLoaded    = true;
    lastFetchTime = new Date();

    console.log(
      `[GTFS] Loaded: ${gtfs.routes.length} routes | ` +
      `${gtfs.stops.length} stops | ${gtfs.trips.length} trips | ` +
      `${gtfs.stop_times.length} stop_times`
    );

    buildIndices();
    return true;
  } catch (err) {
    console.error('[GTFS] Parse error:', err.message);
    return false;
  }
}

// ── Helper: build GeoJSON LineString for one route ───────────────────────────
function buildRouteGeoJSON(routeId) {
  const trips    = gtfs.trips.filter(t => t.route_id === routeId);
  const shapeIds = [...new Set(trips.map(t => t.shape_id).filter(Boolean))];
  if (!shapeIds.length) return { type: 'FeatureCollection', features: [] };

  const features = shapeIds.slice(0, 2).map(shapeId => {
    const coords = gtfs.shapes
      .filter(s => s.shape_id === shapeId)
      .sort((a, b) => parseInt(a.shape_pt_sequence) - parseInt(b.shape_pt_sequence))
      .map(s => [parseFloat(s.shape_pt_lon), parseFloat(s.shape_pt_lat)])
      .filter(([lng, lat]) => !isNaN(lng) && !isNaN(lat));
    return {
      type: 'Feature',
      properties: { route_id: routeId, shape_id: shapeId },
      geometry: { type: 'LineString', coordinates: coords },
    };
  });

  return { type: 'FeatureCollection', features };
}

// ── Helper: get next stop for a vehicle given its route + current time ────────
function getNextStop(routeId, nowMins) {
  const stops = idx.routeStops[routeId];
  if (!stops?.length) return null;

  // Find the stop in the schedule whose departure time is just past now
  const upcoming = stops
    .filter(s => s.departure_time)
    .map(s => ({ ...s, depMins: toMins(s.departure_time) }))
    .filter(s => !isNaN(s.depMins) && s.depMins > nowMins)
    .sort((a, b) => a.depMins - b.depMins);

  return upcoming[0] || stops[stops.length - 1]; // last stop fallback
}

// ── Helper: compute stops remaining for a vehicle ────────────────────────────
function getStopsRemaining(routeId, nowMins) {
  const stops = idx.routeStops[routeId];
  if (!stops?.length) return null;
  return stops.filter(s => s.departure_time && toMins(s.departure_time) > nowMins).length;
}

// ── API Endpoints ────────────────────────────────────────────────────────────

app.get('/api/health', (req, res) => {
  res.json({ ok: true, gtfsLoaded, lastFetchTime, routes: gtfs.routes.length, stops: gtfs.stops.length });
});

// All routes
app.get('/api/routes', (req, res) => {
  res.json({
    gtfsLoaded, lastFetchTime,
    routes: gtfs.routes.map(r => ({
      route_id:   r.route_id,
      short_name: r.route_short_name || r.route_id,
      long_name:  r.route_long_name  || '',
      color:      r.route_color      ? `#${r.route_color}` : null,
    })),
  });
});

// ── ACTIVE ROUTES — currently running based on GTFS schedule ─────────────────
app.get('/api/active-routes', (req, res) => {
  if (!gtfsLoaded) return res.json({ active_routes: [], gtfsLoaded: false });

  const now      = new Date();
  // Allow ?hour=13 from the frontend simulator slider
  const simHour  = req.query.hour != null ? parseInt(req.query.hour) : null;
  const nowMins  = simHour != null ? simHour * 60 + 30 : now.getHours() * 60 + now.getMinutes();
  const dayNames = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  const today    = dayNames[now.getDay()];

  // Get service_ids active today per calendar.txt
  const activeServiceIds = new Set(
    gtfs.calendar
      .filter(c => {
        if (c[today] !== '1') return false;
        // Check date range (YYYYMMDD)
        if (c.start_date && c.end_date) {
          const ds = now.toISOString().slice(0,10).replace(/-/g,'');
          if (ds < c.start_date || ds > c.end_date) return false;
        }
        return true;
      })
      .map(c => c.service_id)
  );

  // Find route_ids with active trips right now (±15 min window before start, ±10 after end)
  const activeRouteIds = new Set();
  for (const [tripId, times] of Object.entries(idx.tripTimes)) {
    const meta = idx.tripMeta[tripId];
    if (!meta) continue;
    if (activeServiceIds.size > 0 && !activeServiceIds.has(meta.service_id)) continue;
    if (nowMins >= times.min - 15 && nowMins <= times.max + 10) {
      activeRouteIds.add(meta.route_id);
    }
  }

  const activeRoutes = gtfs.routes
    .filter(r => activeRouteIds.has(r.route_id))
    .map(r => ({
      route_id:   r.route_id,
      short_name: r.route_short_name || r.route_id,
      long_name:  r.route_long_name  || '',
      color:      r.route_color ? `#${r.route_color}` : null,
      first_trip: idx.tripTimes[
        Object.keys(idx.tripTimes).find(tid => idx.tripMeta[tid]?.route_id === r.route_id)
      ]?.min,
      last_trip: idx.tripTimes[
        Object.keys(idx.tripTimes).find(tid => idx.tripMeta[tid]?.route_id === r.route_id)
      ]?.max,
    }));

  res.json({
    active_routes: activeRoutes,
    count:         activeRoutes.length,
    service_day:   today,
    now_mins:      nowMins,
    gtfsLoaded,
  });
});

// All stops
app.get('/api/stops', (req, res) => {
  res.json({
    stops: gtfs.stops
      .map(s => ({ stop_id: s.stop_id, name: s.stop_name, lat: parseFloat(s.stop_lat), lng: parseFloat(s.stop_lon), code: s.stop_code || '' }))
      .filter(s => !isNaN(s.lat) && !isNaN(s.lng)),
  });
});

// All route shapes as GeoJSON
app.get('/api/shapes', (req, res) => {
  if (!gtfsLoaded) return res.json({ type: 'FeatureCollection', features: [] });
  const features = gtfs.routes.flatMap(route => {
    const gj = buildRouteGeoJSON(route.route_id);
    return gj.features.map(f => ({
      ...f,
      properties: {
        ...f.properties,
        short_name: route.route_short_name || route.route_id,
        long_name:  route.route_long_name  || '',
        color:      route.route_color ? `#${route.route_color}` : '#0057A8',
      },
    }));
  });
  res.json({ type: 'FeatureCollection', features });
});

// Shape for one route
app.get('/api/shapes/:routeKey', (req, res) => {
  if (!gtfsLoaded) return res.json({ type: 'FeatureCollection', features: [] });
  const key   = req.params.routeKey.toUpperCase();
  const route = gtfs.routes.find(r => r.route_id === key || (r.route_short_name || '').toUpperCase() === key);
  if (!route) return res.status(404).json({ error: `Route ${key} not found` });
  const gj = buildRouteGeoJSON(route.route_id);
  gj.features.forEach(f => {
    f.properties.color      = route.route_color ? `#${route.route_color}` : '#0057A8';
    f.properties.short_name = route.route_short_name || route.route_id;
  });
  res.json(gj);
});

// Stops for a route
app.get('/api/routes/:routeKey/stops', (req, res) => {
  if (!gtfsLoaded) return res.json({ stops: [] });
  const key   = req.params.routeKey.toUpperCase();
  const route = gtfs.routes.find(r => r.route_id === key || (r.route_short_name || '').toUpperCase() === key);
  if (!route) return res.status(404).json({ error: `Route ${key} not found` });
  const stops = (idx.routeStops[route.route_id] || [])
    .filter(s => !isNaN(s.lat) && !isNaN(s.lng))
    .map(({ stop_id, name, lat, lng, stop_sequence }) => ({ stop_id, name, lat, lng, stop_sequence }));
  res.json({ stops });
});

// Next scheduled trips for a route (by short name), respects ?hour= simulator
app.get('/api/next-trips', (req, res) => {
  if (!gtfsLoaded) return res.json({ trips: [] });

  const shortName = (req.query.route || '').toUpperCase();
  const simHour   = req.query.hour != null ? parseInt(req.query.hour) : null;
  const now       = new Date();
  const nowMins   = simHour != null ? simHour * 60 : now.getHours() * 60 + now.getMinutes();

  const route = gtfs.routes.find(r =>
    (r.route_short_name || '').toUpperCase() === shortName ||
    r.route_id.toUpperCase() === shortName
  );
  if (!route) return res.json({ route: shortName, trips: [] });

  // Get service_ids active today
  const dayNames = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  const today    = dayNames[now.getDay()];
  const activeServiceIds = new Set(
    gtfs.calendar
      .filter(c => {
        if (c[today] !== '1') return false;
        if (c.start_date && c.end_date) {
          const ds = now.toISOString().slice(0,10).replace(/-/g,'');
          if (ds < c.start_date || ds > c.end_date) return false;
        }
        return true;
      })
      .map(c => c.service_id)
  );

  // Collect trip_ids for this route on active service days
  const routeTripIds = new Set(
    gtfs.trips
      .filter(t => t.route_id === route.route_id &&
        (activeServiceIds.size === 0 || activeServiceIds.has(t.service_id)))
      .map(t => t.trip_id)
  );

  // Find upcoming departures: use ALL stop_times for the route (not just seq=1)
  // so we get per-stop arrival predictions, then deduplicate by trip
  const seenTrips = new Set();
  const nextDepartures = gtfs.stop_times
    .filter(st =>
      routeTripIds.has(st.trip_id) &&
      !isNaN(toMins(st.departure_time)) &&
      toMins(st.departure_time) > nowMins &&          // strictly future
      !seenTrips.has(st.trip_id) &&
      seenTrips.add(st.trip_id)                       // one entry per trip
    )
    .sort((a, b) => toMins(a.departure_time) - toMins(b.departure_time))
    .slice(0, 4)
    .map(st => {
      const minsAway = toMins(st.departure_time) - nowMins;
      const stopData = gtfs.stops.find(s => s.stop_id === st.stop_id);
      return {
        departure_time: st.departure_time,
        mins_away:      minsAway,
        stop_name:      stopData?.stop_name || st.stop_id,
      };
    });

  res.json({ route: shortName, trips: nextDepartures, now_mins: nowMins });
});

// Next arrivals at a stop
app.get('/api/arrivals/:stopId', (req, res) => {
  if (!gtfsLoaded) return res.json({ arrivals: [] });
  const { stopId } = req.params;
  const nowMins    = new Date().getHours() * 60 + new Date().getMinutes();

  const upcoming = gtfs.stop_times
    .filter(st => st.stop_id === stopId && !isNaN(toMins(st.departure_time)) && toMins(st.departure_time) > nowMins)
    .sort((a, b) => toMins(a.departure_time) - toMins(b.departure_time))
    .slice(0, 5)
    .map(st => {
      const meta  = idx.tripMeta[st.trip_id];
      const route = meta ? gtfs.routes.find(r => r.route_id === meta.route_id) : null;
      return {
        route_id:       route?.route_id || '?',
        short_name:     route?.route_short_name || '?',
        departure_time: st.departure_time,
        mins_away:      toMins(st.departure_time) - nowMins,
        headsign:       st.stop_headsign || meta?.headsign || '',
      };
    });

  res.json({ arrivals: upcoming, stop_id: stopId });
});

// ── LIVE VEHICLES — TransLoc with GTFS-enhanced next-stop data ───────────────
app.get('/api/vehicles', async (req, res) => {
  const nowMins = new Date().getHours() * 60 + new Date().getMinutes();

  try {
    const r = await fetch(
      `https://feeds.transloc.com/3/vehicle_statuses?agencies=${TRANSLOC_AGENCY}`,
      { timeout: 6000, headers: { Accept: 'application/json' } }
    );
    if (!r.ok) throw new Error(`TransLoc ${r.status}`);
    const data = await r.json();

    // Resolve route short name from GTFS (TransLoc route_id may differ from GTFS)
    const routeById = {};
    for (const route of gtfs.routes) {
      routeById[route.route_id] = route;
    }

    const vehicles = (data.vehicles ?? [])
      .filter(v => v.position?.lat && v.position?.lng)
      .map(v => {
        const rid       = v.route_id?.toString() || null;
        const gtfsRoute = rid ? (routeById[rid] || null) : null;
        const shortName = gtfsRoute?.route_short_name || rid || null;

        // Next stop + stops remaining (GTFS schedule approximation)
        const nextStop      = rid ? getNextStop(rid, nowMins)      : null;
        const stopsLeft     = rid ? getStopsRemaining(rid, nowMins) : null;

        return {
          id:            v.vehicle_id,
          call_name:     v.call_name || v.vehicle_id,
          route_id:      rid,
          route_name:    shortName,
          route_long:    gtfsRoute?.route_long_name || '',
          lat:           v.position.lat,
          lng:           v.position.lng,
          heading:       v.heading ?? null,
          heading_text:  headingToText(v.heading),
          speed_mph:     v.speed != null ? Math.round(v.speed * 0.621371) : null,
          headsign:      v.headsign || '',
          next_stop:     nextStop ? { name: nextStop.name, lat: nextStop.lat, lng: nextStop.lng, departure: nextStop.departure_time } : null,
          stops_left:    stopsLeft,
          passenger_load: v.passenger_load ?? null,
          updated:       v.last_updated_on || null,
          type:          'transloc',
        };
      });

    res.json({ vehicles, source: 'transloc', count: vehicles.length });
  } catch (err) {
    res.json({ vehicles: [], source: 'unavailable', error: err.message });
  }
});

// ── MOVEUNC — GMV Syncromatics live API (moveunc.com) ────────────────────────
// Route IDs confirmed from network inspection of moveunc.com/map:
//   6564 = Baity Hill  (#AD42FF purple)  pattern 25535
//   6566 = P2P Express (#1B31A8 blue)    pattern 25545
//   6565 = RR Lot      (white, usually inactive)
const MOVEUNC_BASE    = 'https://www.moveunc.com';
const MOVEUNC_ROUTES  = [
  { id: 6564, name: 'Baity Hill',  shortName: 'BH',  color: '#AD42FF', patternId: 25535 },
  { id: 6566, name: 'P2P Express', shortName: 'P2P', color: '#1B31A8', patternId: 25545 },
  { id: 6565, name: 'RR Lot',      shortName: 'RR',  color: '#888888', patternId: null   },
];

// Status + service hours
app.get('/api/moveunc', (req, res) => {
  const hour   = new Date().getHours();
  const active = hour >= 19 || hour < 3;
  res.json({
    active,
    hours:    '7 PM – 3 AM daily',
    dispatch: '919-962-7867',
    website:  'https://moveunc.com/map',
    message:  active
      ? 'MoveUNC P2P is active. Free on-campus rides for UNC students.'
      : 'MoveUNC P2P activates at 7 PM and runs until 3 AM.',
  });
});

// Live routes — includes NumberOfVehicles so frontend knows which are active
app.get('/api/moveunc/routes', async (req, res) => {
  try {
    const r    = await fetch(`${MOVEUNC_BASE}/Region/0/Routes`, { timeout: 6000 });
    const data = await r.json();
    const routes = (Array.isArray(data) ? data : []).map(route => ({
      id:              route.ID,
      name:            route.DisplayName || route.Name,
      shortName:       route.ShortName,
      color:           route.Color || '#888888',
      textColor:       route.TextColor || '#FFFFFF',
      vehicleCount:    route.NumberOfVehicles ?? 0,
      active:          (route.NumberOfVehicles ?? 0) > 0,
      patterns:        (route.Patterns || []).map(p => ({ id: p.ID, name: p.Name, direction: p.Direction })),
    }));
    res.json({ routes, source: 'moveunc.com', updated: new Date().toISOString() });
  } catch (err) {
    // Fallback to hardcoded routes if API unavailable
    res.json({
      routes: MOVEUNC_ROUTES.map(r => ({ ...r, vehicleCount: 0, active: false, patterns: [] })),
      source: 'fallback',
      error: err.message,
    });
  }
});

// Live vehicles for all MoveUNC routes
app.get('/api/moveunc/vehicles', async (req, res) => {
  try {
    const results = await Promise.allSettled(
      MOVEUNC_ROUTES.filter(r => r.id !== 6565).map(route =>
        fetch(`${MOVEUNC_BASE}/Route/${route.id}/Vehicles`, { timeout: 6000 })
          .then(r => r.json())
          .then(vehicles => vehicles.map(v => ({
            id:           `moveunc-${v.ID}`,
            raw_id:       v.ID,
            name:         v.Name,
            route_id:     route.id,
            route_name:   route.name,
            route_short:  route.shortName,
            route_color:  route.color,
            lat:          v.Latitude,
            lng:          v.Longitude,
            heading:      v.Heading,        // already a string: "N", "NE", etc.
            speed:        v.Speed,
            occupancy_pct: v.APCPercentage ?? null,
            door_status:  v.DoorStatus,
            updated:      v.Updated,
            updated_ago:  v.UpdatedAgo,
            pattern_id:   v.PatternId,
            type:         'moveunc',
          })))
      )
    );
    const vehicles = results
      .filter(r => r.status === 'fulfilled')
      .flatMap(r => r.value);
    res.json({ vehicles, count: vehicles.length, source: 'moveunc.com', updated: new Date().toISOString() });
  } catch (err) {
    res.json({ vehicles: [], count: 0, source: 'error', error: err.message });
  }
});

// Route shapes (waypoints) as GeoJSON — cached in memory, refreshed hourly
let moveuncShapesCache = null;
let moveuncShapesExpiry = 0;

app.get('/api/moveunc/shapes', async (req, res) => {
  const now = Date.now();
  if (moveuncShapesCache && now < moveuncShapesExpiry) {
    return res.json(moveuncShapesCache);
  }
  try {
    const results = await Promise.allSettled(
      MOVEUNC_ROUTES.filter(r => r.id !== 6565).map(route =>
        fetch(`${MOVEUNC_BASE}/Route/${route.id}/Waypoints/`, { timeout: 8000 })
          .then(r => r.json())
          .then(waypoints => {
            // waypoints is an array of arrays (one per direction)
            const dirs = Array.isArray(waypoints[0]) ? waypoints : [waypoints];
            return dirs.map((pts, dirIdx) => ({
              type: 'Feature',
              properties: {
                route_id:   route.id,
                short_name: route.shortName,
                name:       route.name,
                color:      route.color,
                direction:  dirIdx === 0 ? 'outbound' : 'inbound',
                source:     'moveunc',
              },
              geometry: {
                type: 'LineString',
                coordinates: pts.map(p => [p.Longitude, p.Latitude]),
              },
            }));
          })
      )
    );
    const features = results
      .filter(r => r.status === 'fulfilled')
      .flatMap(r => r.value);
    const geoJSON = { type: 'FeatureCollection', features };
    moveuncShapesCache  = geoJSON;
    moveuncShapesExpiry = now + 60 * 60 * 1000; // cache 1 hour
    res.json(geoJSON);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Stops for all MoveUNC routes
app.get('/api/moveunc/stops', async (req, res) => {
  try {
    const results = await Promise.allSettled(
      MOVEUNC_ROUTES.filter(r => r.patternId).map(route =>
        fetch(`${MOVEUNC_BASE}/Route/${route.patternId}/Direction/${route.id}/Stops`, { timeout: 6000 })
          .then(r => r.json())
          .then(stops => stops.map(s => ({
            id:         `moveunc-stop-${s.ID}`,
            raw_id:     s.ID,
            name:       s.Name,
            lat:        s.Latitude,
            lng:        s.Longitude,
            route_id:   route.id,
            route_name: route.name,
            route_color: route.color,
          })))
      )
    );
    const stops = results
      .filter(r => r.status === 'fulfilled')
      .flatMap(r => r.value);
    res.json({ stops, count: stops.length });
  } catch (err) {
    res.json({ stops: [], count: 0, error: err.message });
  }
});

// ── Start server ─────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`\n🚌  TarHeel Transit API  →  http://localhost:${PORT}\n`);
  await downloadAndParseGTFS();
  setInterval(downloadAndParseGTFS, REFRESH_MS);
});
