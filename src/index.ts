#!/usr/bin/env node
// AppyWay MCP server: lets Claude, ChatGPT and other MCP clients look up UK kerbside parking rules,
// prices, parking entities, zones and authorities through the AppyWay API. Every tool is read-only.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { AppyWayClient, AppyWayError, SECTION_NAMES, type Section } from "./client.js";
import * as fmt from "./format.js";

const apiKey = process.env.APPYWAY_API_KEY?.trim();
if (!apiKey) {
  console.error("APPYWAY_API_KEY is not set. AppyWay issues API keys on request (apisupport@appyway.com).");
  process.exit(1);
}
let api: AppyWayClient;
try {
  api = new AppyWayClient(apiKey, process.env.APPYWAY_BASE_URL || undefined);
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

const server = new McpServer(
  { name: "appyway", version: "0.1.0" },
  {
    instructions: [
      "Read-only tools for the AppyWay API: UK kerbside parking rules, prices, parking entities (on-street bays and lines, car parks), zones and local authorities.",
      "Coordinates are WGS84 latitude/longitude. Times are ISO 8601 with a Z or an offset (AppyWay returns UTC).",
      "Typical flow for 'can I park here at 6pm, and what does it cost?': find_parking_rules_near with the point and the time window; get_parking_entity for the hours and payment options of one result; get_zone_rules for the controlled-zone hours.",
      "list_authorities without a location shows the authorities this API key is entitled to; a key does not cover authorities outside its entitlement.",
      "Numeric ids for vehicle types, permits, payment methods and the like come from list_reference_values.",
      "Telephone numbers of payment providers, operators and notes are only returned when explicitly requested with include_contact_details.",
    ].join("\n"),
  },
);

// Every AppyWay endpoint used here is a query: the POSTs carry a search in the body and change nothing.
const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

type Json = Record<string, unknown> | unknown[];
const ok = (data: Json) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const fail = (err: unknown) => ({
  isError: true,
  content: [{ type: "text" as const, text: err instanceof AppyWayError ? err.message : `Unexpected error: ${(err as Error)?.message ?? String(err)}` }],
});
const safe = <A>(fn: (args: A) => Promise<Json>) => async (args: A) => {
  try {
    return ok(await fn(args));
  } catch (err) {
    return fail(err);
  }
};
const refuse = (message: string): never => {
  throw new AppyWayError(message);
};

// ---- Shared input pieces ----

// The specs type entity, zone and authority ids as plain strings; every example in AppyWay's guides is
// a GUID (the 401 example wraps one in braces). Only values that could not be an id are refused. A
// braced id ({...}, both braces or neither) is accepted and sent without the braces, as in every
// documented request example.
const entityId = (what: string) =>
  z.string().regex(/^(?:\{[A-Za-z0-9_-]{1,64}\}|[A-Za-z0-9_-]{1,64})$/, `${what} ids are GUID-like strings of letters, digits and hyphens, e.g. 5114b7aa-4652-42b4-a926-5382fe192dd9`);
const bareId = (id: string) => id.replace(/^\{(.*)\}$/, "$1");
const slug = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/, "Authority slugs are short strings of letters, digits, - and _ (see list_authorities)");
/** True for a real calendar date "YYYY-MM-DD" (Date.parse alone accepts 2026-02-30 and rolls it over). */
const isCalendarDate = (d: string) => {
  const t = Date.parse(d + "T00:00:00Z");
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === d;
};
// The specs document startTime, endTime and maxDate as format date-time, "YYYY-MM-DDThh:mm:ssTZD".
// Seconds may be left out in the input; toApiTime adds ":00" so what is sent always has them.
const ISO_DATE_TIME = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}(:\d{2}(\.\d{1,7})?)?(Z|[+-]\d{2}:\d{2})$/;
const isoDateTime = z
  .string()
  .regex(ISO_DATE_TIME, "Use ISO 8601 with a Z or an offset, e.g. 2026-10-01T18:00:00+01:00")
  .refine((s) => !Number.isNaN(Date.parse(s)) && isCalendarDate(s.slice(0, 10)), "Not a valid date and time");
function toApiTime(s: string): string;
function toApiTime(s: string | undefined): string | undefined;
function toApiTime(s: string | undefined) {
  if (s === undefined) return undefined;
  const m = ISO_DATE_TIME.exec(s);
  return m && !m[2] ? s.slice(0, s.length - m[4].length) + ":00" + m[4] : s;
}
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").refine(isCalendarDate, "Not a valid date");
const lat = z.number().min(-90).max(90);
const lng = z.number().min(-180).max(180);
const bbox = z
  .object({ west: lng, south: lat, east: lng, north: lat })
  .describe("Bounding box in WGS84 degrees; sent to AppyWay as a closed GeoJSON polygon");
const ON_STREET_NAMES = Object.entries(fmt.ON_STREET_PARKING_TYPES).filter(([id]) => Number(id) > 0);
const onStreetType = z.enum(ON_STREET_NAMES.map(([, name]) => name) as [string, ...string[]]);
const onStreetIds = (names?: string[]) => (names?.length ? names.map((n) => Number(ON_STREET_NAMES.find(([, name]) => name === n)![0])) : undefined);

const vehicleInputs = {
  vehicle_type_id: z.number().int().optional().describe("Vehicle type id (list_reference_values vehicle_types); AppyWay assumes a standard petrol car when no vehicle details are given"),
  activity_type_id: z.number().int().optional().describe("Activity type id, e.g. parking or loading (list_reference_values activity_types)"),
  fuel_type_id: z.number().int().optional().describe("Fuel type id (list_reference_values fuel_types)"),
  permit_type_ids: z.array(z.number().int()).max(20).optional().describe("Permit type ids the driver holds, e.g. a blue badge (list_reference_values permit_types)"),
  co2_emissions: z.number().int().min(0).optional().describe("Vehicle CO2 emissions in g/km"),
  vehicle_year: z.number().int().min(1900).max(2100).optional().describe("Vehicle registration year"),
  engine_size_cc: z.number().int().min(0).optional().describe("Engine size in cc"),
};
type VehicleArgs = { vehicle_type_id?: number; activity_type_id?: number; fuel_type_id?: number; permit_type_ids?: number[]; co2_emissions?: number; vehicle_year?: number; engine_size_cc?: number };
/** VehicleOperatorContext as documented; undefined when no vehicle detail was given. */
function vehicleContext(a: VehicleArgs) {
  const c = {
    ...(a.vehicle_type_id !== undefined ? { vehicleTypeId: a.vehicle_type_id } : {}),
    ...(a.activity_type_id !== undefined ? { activityTypeId: a.activity_type_id } : {}),
    ...(a.fuel_type_id !== undefined ? { fuelTypeId: a.fuel_type_id } : {}),
    ...(a.permit_type_ids?.length ? { permits: a.permit_type_ids.map((permitTypeId) => ({ permitTypeId })) } : {}),
    ...(a.co2_emissions !== undefined ? { co2Emissions: a.co2_emissions } : {}),
    ...(a.vehicle_year !== undefined ? { vehicleYear: a.vehicle_year } : {}),
    ...(a.engine_size_cc !== undefined ? { engineSize: a.engine_size_cc } : {}),
  };
  return Object.keys(c).length ? c : undefined;
}

const M_PER_DEG_LAT = 111_320;
const mPerDegLng = (latitude: number) => M_PER_DEG_LAT * Math.cos((latitude * Math.PI) / 180);

/** A GeoJSON polygon ring (lng, lat) for a bounding box, closed, in the order of the guide's example. */
function bboxPolygon(b: { west: number; south: number; east: number; north: number }) {
  return {
    type: "Polygon",
    coordinates: [[[b.west, b.north], [b.east, b.north], [b.east, b.south], [b.west, b.south], [b.west, b.north]]],
  };
}
function squareBbox(centreLat: number, centreLng: number, sideM: number) {
  const dLat = sideM / 2 / M_PER_DEG_LAT;
  const dLng = sideM / 2 / mPerDegLng(centreLat);
  return { west: centreLng - dLng, south: centreLat - dLat, east: centreLng + dLng, north: centreLat + dLat };
}
/** Approximate area of a bounding box in km2 (equirectangular; good enough to apply AppyWay's documented area limits). */
const bboxAreaKm2 = (b: { west: number; south: number; east: number; north: number }) =>
  ((b.east - b.west) * mPerDegLng((b.north + b.south) / 2) * (b.north - b.south) * M_PER_DEG_LAT) / 1e6;

type AreaArgs = { lat?: number; lng?: number; viewport_size_m?: number; bbox?: { west: number; south: number; east: number; north: number } };
/**
 * The search area: a centre point with a square viewport, or a bounding box. Refused locally (before
 * any call) when both or neither are given, when the box is inverted, or when it exceeds the area the
 * endpoint documents ("Limited to 1.5 km2", "70km2", "300km2").
 */
function area(a: AreaArgs, maxKm2: number, what: string) {
  const hasPoint = a.lat !== undefined || a.lng !== undefined;
  if (hasPoint && a.bbox) refuse("Give either lat/lng (with viewport_size_m) or bbox, not both.");
  if (!hasPoint && !a.bbox) refuse("Give a location: lat and lng (with viewport_size_m), or bbox.");
  if (hasPoint && (a.lat === undefined || a.lng === undefined)) refuse("Give both lat and lng.");
  if (a.bbox) {
    const b = a.bbox;
    if (b.east <= b.west || b.north <= b.south) refuse("bbox must have east > west and north > south.");
    const km2 = bboxAreaKm2(b);
    if (km2 > maxKm2) refuse(`The bbox covers about ${km2.toFixed(2)} km2; AppyWay limits ${what} to ${maxKm2} km2. Use a smaller box.`);
    return { kind: "bbox" as const, bbox: b, polygon: bboxPolygon(b) };
  }
  const side = a.viewport_size_m ?? 300;
  const km2 = (side * side) / 1e6;
  if (km2 > maxKm2) refuse(`A ${side} m square covers ${km2.toFixed(2)} km2; AppyWay limits ${what} to ${maxKm2} km2 (a side of at most ${Math.floor(Math.sqrt(maxKm2) * 1000)} m).`);
  const b = squareBbox(a.lat!, a.lng!, side);
  return { kind: "centre" as const, centre: { lat: a.lat!, lng: a.lng! }, side, bbox: b, polygon: bboxPolygon(b) };
}

/** Start and end of the time window: start defaults to now, end to start + defaultHours. */
function timeWindow(startIn: string | undefined, endIn: string | undefined, defaultHours: number) {
  const start = toApiTime(startIn);
  const end = toApiTime(endIn);
  const startMs = start ? Date.parse(start) : Math.floor(Date.now() / 60000) * 60000;
  const startTime = start ?? new Date(startMs).toISOString().replace(".000Z", "Z");
  const endTime = end ?? new Date(startMs + defaultHours * 3600_000).toISOString().replace(".000Z", "Z");
  if (Date.parse(endTime) <= startMs) refuse("end_time must be after start_time.");
  return { startTime, endTime };
}

const chunk = <T>(list: T[], size: number) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, i * size + size));
// fetchEntitiesByIds and fetchOperatingHoursByIds document no maximum number of ids; 50 per request is
// this server's own cap, so one call never sends a huge body.
const IDS_PER_REQUEST = 50;

async function fetchEntities(ids: string[]) {
  const out: any = { parkingEntities: [], zones: [], authorities: [] };
  for (const part of chunk(ids, IDS_PER_REQUEST)) {
    // geometryPreference POI: a single point per entity is enough here, and keeps responses small.
    const r = await api.post("explorer", "/fetchEntitiesByIds", { ids: part, geometryPreference: { geometryTypes: [1] } });
    for (const k of Object.keys(out)) if (Array.isArray(r?.[k])) out[k].push(...r[k]);
  }
  return out as { parkingEntities: any[]; zones: any[]; authorities: any[] };
}

async function fetchHours(ids: string[], date: string, context?: object) {
  const out: any[] = [];
  for (const part of chunk(ids, IDS_PER_REQUEST)) {
    // includeClosedPeriods: "Include closed periods that apply for the given context"; without it the
    // closedPeriods the server returns would not be asked for.
    const r = await api.post("explorer", "/fetchOperatingHoursByIds", { ids: part, date, includeClosedPeriods: true, ...(context ? { vehicleOperatorContext: context } : {}) });
    if (Array.isArray(r)) out.push(...r);
  }
  return out;
}

const includeContactInput = z.boolean().default(false).describe("Return telephone numbers of payment providers, car park operators and notes, and stop redacting email addresses and phone numbers from names, notes, tags, addresses and location codes");

// ---- Tools ----

server.registerTool(
  "ping",
  {
    title: "Check the API key",
    description: "Calls GET /ping on each AppyWay API section (Explorer, Traffic Data, Reference) and reports which ones this API key can reach. Use it first when other tools report 401 or 403.",
    inputSchema: {},
    annotations: READ,
  },
  safe(async () => {
    const sections: Record<string, unknown> = {};
    for (const s of ["explorer", "traffic-data", "reference"] as Section[]) {
      try {
        const r = await api.ping(s);
        sections[s] = { name: SECTION_NAMES[s], ok: true, status: r.status, answer: r.result };
      } catch (err) {
        sections[s] = { name: SECTION_NAMES[s], ok: false, error: err instanceof AppyWayError ? err.message : String(err) };
      }
    }
    return { sections };
  }),
);

server.registerTool(
  "find_parking_rules_near",
  {
    title: "Find parking rules and prices near a place",
    description:
      "For a time window and an area (a point with a square viewport, or a bounding box, at most 1.5 km2), returns every parking entity AppyWay knows there (on-street bays and lines, car parks), nearest first: whether parking is allowed for the whole window, part of it or not at all, and the quotes (cost, currency, max stay, no-return, free-until, payment methods). Adds each entity's name, address, bay types and zone, and the controlled-zone default rules (e.g. single yellow line hours) for the same area. Vehicle details (type, permits such as a blue badge, fuel) change the answer, they do not filter it; the exclude_* options filter.",
    inputSchema: {
      lat: lat.optional().describe("Latitude of the centre point"),
      lng: lng.optional().describe("Longitude of the centre point"),
      viewport_size_m: z.number().int().min(10).max(1224).default(300).describe("Side of the square around lat/lng, in metres (AppyWay limit: 1.5 km2, so at most 1224 m)"),
      bbox: bbox.optional(),
      start_time: isoDateTime.optional().describe("Start of the parking window; defaults to now"),
      end_time: isoDateTime.optional().describe("End of the parking window; defaults to one hour after start_time"),
      distance_from: z.object({ lat, lng }).optional().describe("Point inside the area to measure distances and order results from (defaults to the centre)"),
      ...vehicleInputs,
      exclude_car_parks: z.boolean().optional().describe("Leave out off-street car parks"),
      exclude_on_street: z.boolean().optional().describe("Leave out on-street parking"),
      exclude_paid: z.boolean().optional().describe("Leave out paid parking"),
      exclude_free: z.boolean().optional().describe("Leave out free parking"),
      exclude_no_parking: z.boolean().optional().describe("Leave out places where parking is not allowed at all during the window"),
      exclude_truncated: z.boolean().optional().describe("Leave out places where parking is allowed for only part of the window"),
      max_cost: z.number().min(0).optional().describe("Leave out places costing more than this for the window (no effect with exclude_paid)"),
      max_results: z.number().int().min(1).max(200).default(20).describe("Maximum number of results to return (nearest first)"),
      include_entity_details: z.boolean().default(true).describe("Fetch each result's name, address, bay types and zone (fetchEntitiesByIds)"),
      include_zone_rules: z.boolean().default(true).describe("Also return the zone default rules for the area (findZoneDefaultRulesByViewport)"),
      include_contact_details: includeContactInput,
    },
    annotations: READ,
  },
  safe(async (a) => {
    const where = area(a, 1.5, "parking searches");
    const { startTime, endTime } = timeWindow(a.start_time, a.end_time, 1);
    const context = vehicleContext(a);
    const excludeEntityTypes = [...(a.exclude_on_street ? [1] : []), ...(a.exclude_car_parks ? [2] : [])];
    const filters = {
      ...(excludeEntityTypes.length ? { excludeEntityTypes } : {}),
      ...(a.exclude_paid !== undefined ? { excludePaidParking: a.exclude_paid } : {}),
      ...(a.exclude_free !== undefined ? { excludeFreeParking: a.exclude_free } : {}),
      ...(a.exclude_no_parking !== undefined ? { excludeNoParking: a.exclude_no_parking } : {}),
      ...(a.exclude_truncated !== undefined ? { excludeTruncatedParking: a.exclude_truncated } : {}),
      ...(a.max_cost !== undefined ? { excludeCostGreaterThan: a.max_cost } : {}),
    };
    const common = {
      startTime,
      endTime,
      ...(a.distance_from ? { distanceCalculationLocation: a.distance_from } : {}),
      ...(context ? { vehicleOperatorContext: context } : {}),
      ...(Object.keys(filters).length ? { filters } : {}),
    };
    const res =
      where.kind === "centre"
        ? await api.post("explorer", "/findParkingQuotesByCentreAndViewportSize", { viewportCenter: where.centre, viewportSize: where.side, ...common })
        : await api.post("explorer", "/findParkingQuotesByViewport", { viewport: where.polygon, ...common });
    const all: any[] = Array.isArray(res?.parking) ? res.parking : [];
    const results = all.slice(0, a.max_results).map(fmt.searchResult);

    if (a.include_entity_details && results.length) {
      const ids = [...new Set(results.map((r) => r.entity_id).filter((x): x is string => !!x))];
      const { parkingEntities } = await fetchEntities(ids);
      const byId = new Map(parkingEntities.map((e: any) => [e.entityId, fmt.parkingEntity(e, a.include_contact_details)]));
      for (const r of results as any[]) {
        const e = byId.get(r.entity_id);
        if (e) {
          const { entity_id: _id, entity_type: _type, etag: _etag, ...rest } = e;
          r.entity = rest;
        }
      }
    }

    let zones: unknown;
    let zoneContainingLocation: unknown;
    if (a.include_zone_rules) {
      const z = await api.post("explorer", "/findZoneDefaultRulesByViewport", {
        viewport: where.polygon,
        startTime,
        endTime,
        ...(a.distance_from ? { distanceCalculationLocation: a.distance_from } : where.kind === "centre" ? { distanceCalculationLocation: where.centre } : {}),
      });
      zones = Array.isArray(z?.zones) ? z.zones.map(fmt.zoneRules) : [];
      zoneContainingLocation = z?.zoneContainingLocation ? fmt.zoneRules(z.zoneContainingLocation) : undefined;
    }

    return {
      window: { start: res?.requestedStartTime ?? startTime, end: endTime, requested_duration: fmt.timeSpan(res?.requestedDuration) },
      area: where.kind === "centre" ? { centre: where.centre, viewport_size_m: where.side } : { bbox: where.bbox },
      general_onstreet_policy: res?.generalOnstreetPolicy !== undefined ? fmt.GENERAL_ONSTREET_POLICY[res.generalOnstreetPolicy] ?? `unknown (${res.generalOnstreetPolicy})` : undefined,
      general_onstreet_policy_meaning: "What applies to kerb sections with no specific entity: Restricted (no parking for anyone), LikelyRestricted, LikelyUnrestricted (likely free parking), Unknown.",
      count: results.length,
      total_results: all.length,
      note: all.length > results.length ? `${all.length - results.length} more results were left out; raise max_results (up to 200) or narrow the area.` : undefined,
      results,
      zone_containing_location: zoneContainingLocation,
      zone_rules: zones,
    };
  }),
);

server.registerTool(
  "fetch_kerb_segments",
  {
    title: "Fetch kerb segments and car parks",
    description:
      "The static parking map for an area (point with square viewport or bounding box, at most 1.5 km2) or for given entity ids: on-street segments (bays and yellow/red lines, with their bay types and capacity) and car parks, with name, address, a WGS84 point where AppyWay gives one, zone and authority. Optionally adds each entity's operating hours for one date. No prices: use find_parking_rules_near for those.",
    inputSchema: {
      lat: lat.optional().describe("Latitude of the centre point"),
      lng: lng.optional().describe("Longitude of the centre point"),
      viewport_size_m: z.number().int().min(10).max(1224).default(300).describe("Side of the square around lat/lng, in metres (AppyWay limit: 1.5 km2)"),
      bbox: bbox.optional(),
      entity_ids: z.array(entityId("Parking entity")).min(1).max(200).optional().describe("Fetch these entities instead of searching an area"),
      on_street_parking_types: z.array(onStreetType).min(1).optional().describe("Only on-street entities of these types (area search only), e.g. LoadingBay, DisabledBay, SingleYellowLine"),
      exclude_car_parks: z.boolean().optional().describe("Leave out car parks (area search only)"),
      exclude_on_street: z.boolean().optional().describe("Leave out on-street entities (area search only)"),
      distance_from: z.object({ lat, lng }).optional().describe("Point to measure distances and order results from (area search only)"),
      operating_hours_date: isoDate.optional().describe("Also fetch each entity's operating hours for this local date (YYYY-MM-DD)"),
      max_results: z.number().int().min(1).max(500).default(50),
      include_contact_details: includeContactInput,
    },
    annotations: READ,
  },
  safe(async (a) => {
    let entities: any[];
    let distances = new Map<string, number>();
    let total: number;
    let requested: string[] = [];
    if (a.entity_ids) {
      if (a.lat !== undefined || a.lng !== undefined || a.bbox) refuse("Give either entity_ids or an area (lat/lng or bbox), not both.");
      if (a.on_street_parking_types || a.exclude_car_parks !== undefined || a.exclude_on_street !== undefined || a.distance_from) refuse("on_street_parking_types, exclude_car_parks, exclude_on_street and distance_from only apply to an area search.");
      requested = [...new Set(a.entity_ids.map(bareId))];
      const r = await fetchEntities(requested);
      entities = r.parkingEntities;
      total = entities.length;
    } else {
      const where = area(a, 1.5, "parking entity searches");
      const excludeEntityTypes = [...(a.exclude_on_street ? [1] : []), ...(a.exclude_car_parks ? [2] : [])];
      const common = {
        geometryPreference: { geometryTypes: [1] },
        ...(a.distance_from ? { distanceCalculationLocation: a.distance_from } : {}),
        ...(excludeEntityTypes.length ? { filters: { excludeEntityTypes } } : {}),
        ...(a.on_street_parking_types ? { onStreetParkingTypes: onStreetIds(a.on_street_parking_types) } : {}),
      };
      const r =
        where.kind === "centre"
          ? await api.post("explorer", "/findParkingEntitiesByCentreAndViewportSize", { viewportCenter: where.centre, viewportSize: where.side, ...common })
          : await api.post("explorer", "/findParkingEntitiesByViewport", { viewport: where.polygon, ...common });
      const found: any[] = Array.isArray(r?.entities) ? r.entities : [];
      total = found.length;
      entities = found.map((x) => x?.entity).filter(Boolean);
      distances = new Map(found.filter((x) => x?.entity?.entityId && typeof x.distance === "number").map((x) => [x.entity.entityId, Math.round(x.distance)]));
    }
    const shown = entities.slice(0, a.max_results);
    const out: any[] = shown.map((e) => ({ distance_m: distances.get(e.entityId), ...fmt.parkingEntity(e, a.include_contact_details) }));
    if (a.operating_hours_date && out.length) {
      const hours = await fetchHours(out.map((e) => e.entity_id).filter(Boolean), a.operating_hours_date);
      const byId = new Map(hours.map((h: any) => [h.entityId, fmt.operatingHours(h)]));
      for (const e of out) {
        const h = byId.get(e.entity_id);
        if (h) e.operating_hours = { time_zone: h.time_zone, hours: h.hours, closed_periods: h.closed_periods };
      }
    }
    const found = new Set(entities.map((e) => e.entityId));
    const missing = requested.filter((id) => !found.has(id));
    return {
      count: out.length,
      total,
      note: total > out.length ? `${total - out.length} more entities were left out; raise max_results (up to 500) or narrow the area.` : undefined,
      not_found: missing.length ? missing : undefined,
      entities: out,
    };
  }),
);

server.registerTool(
  "get_parking_entity",
  {
    title: "Get one parking entity",
    description:
      "One on-street segment or car park by id: name, address, bay types, capacity, zone and authority; its operating hours for a date (open periods marked Free, Paid or Mixed); how to pay (payment providers and links); and, when start_time is given, the parking quote for that window.",
    inputSchema: {
      entity_id: entityId("Parking entity").describe("Entity id from find_parking_rules_near or fetch_kerb_segments"),
      date: isoDate.optional().describe("Local date (YYYY-MM-DD) for the operating hours; defaults to today (UTC date)"),
      start_time: isoDateTime.optional().describe("Also quote parking from this time"),
      end_time: isoDateTime.optional().describe("End of the quoted window; defaults to one hour after start_time"),
      ...vehicleInputs,
      include_contact_details: includeContactInput,
    },
    annotations: READ,
  },
  safe(async (a) => {
    if (a.end_time && !a.start_time) refuse("end_time needs a start_time.");
    const context = vehicleContext(a);
    const window = a.start_time ? timeWindow(a.start_time, a.end_time, 1) : undefined;
    const id = bareId(a.entity_id);
    const entity = await api.post("explorer", "/fetchParkingEntityById", { id });
    const date = a.date ?? new Date().toISOString().slice(0, 10);
    const hours = await api.post("explorer", "/fetchOperatingHoursById", { entityId: id, date, includeClosedPeriods: true, ...(context ? { vehicleOperatorContext: context } : {}) });
    const providers = await api.post("explorer", "/fetchPaymentProvidersByParkingEntityId", { entityId: id });
    const quote = window
      ? await api.post("explorer", "/fetchParkingQuoteById", { entityId: id, ...window, ...(context ? { vehicleOperatorContext: context } : {}) })
      : undefined;
    const h = hours ? fmt.operatingHours(hours) : undefined;
    return {
      entity: fmt.parkingEntity(entity ?? {}, a.include_contact_details),
      operating_hours: h ? { date, time_zone: h.time_zone, hours: h.hours, closed_periods: h.closed_periods } : undefined,
      payment_providers: Array.isArray(providers?.paymentProviders) ? providers.paymentProviders.map((p: any) => fmt.paymentProvider(p, a.include_contact_details)) : [],
      quote: quote ? { window, ...fmt.searchResult(quote) } : undefined,
    };
  }),
);

server.registerTool(
  "get_zone_rules",
  {
    title: "Get a zone and its default rules",
    description:
      "One zone (e.g. a controlled parking zone) by id with its type, notes and the default rules that apply to its kerb types over a time window: when each default (single yellow line, paid bay, ...) is in force and the maximum stay. Rules set on an individual bay override these defaults.",
    inputSchema: {
      zone_id: entityId("Zone").describe("Zone id (zone_id from find_parking_rules_near, fetch_kerb_segments or get_parking_entity)"),
      start_time: isoDateTime.optional().describe("Start of the window; defaults to now"),
      end_time: isoDateTime.optional().describe("End of the window; defaults to 24 hours after start_time"),
      on_street_parking_types: z.array(onStreetType).min(1).optional().describe("Only these kerb types (default: every type the zone defines a default for)"),
      include_not_applicable_times: z.boolean().default(false).describe("Also list the windows in which each default does not apply"),
      include_contact_details: includeContactInput,
    },
    annotations: READ,
  },
  safe(async (a) => {
    const window = timeWindow(a.start_time, a.end_time, 24);
    const zoneId = bareId(a.zone_id);
    const zone = await api.post("explorer", "/fetchZoneById", { id: zoneId });
    const rules = await api.post("explorer", "/fetchZoneDefaultRulesById", {
      id: zoneId,
      ...window,
      ...(a.on_street_parking_types ? { onStreetParkingTypeIds: onStreetIds(a.on_street_parking_types) } : {}),
      includeNotApplicableTimes: a.include_not_applicable_times,
    });
    const r = rules ? fmt.zoneRules(rules) : undefined;
    return { zone: fmt.zone(zone ?? {}, a.include_contact_details), window, defaults: r?.defaults ?? [] };
  }),
);

server.registerTool(
  "list_authorities",
  {
    title: "List local authorities",
    description:
      "Without a location: every authority this API key is entitled to (Traffic Data fetchAllAuthorities), with slug, data quality, the date of the last traffic-order update, centroid and notes; filter by name with query. With a point or a bounding box (at most 300 km2): the authorities covering that area (Explorer), with their notes and payment providers; an authority outside the key's entitlement is listed under not_accessible with AppyWay's reason.",
    inputSchema: {
      query: z.string().min(2).max(100).optional().describe("Case-insensitive match on name, legal name or slug (without a location)"),
      lat: lat.optional().describe("Latitude of a point to find the covering authority"),
      lng: lng.optional().describe("Longitude of a point"),
      bbox: bbox.optional(),
      max_results: z.number().int().min(1).max(500).default(50),
      include_contact_details: includeContactInput,
    },
    annotations: READ,
  },
  safe(async (a) => {
    const located = a.lat !== undefined || a.lng !== undefined || a.bbox;
    if (!located) {
      const q = a.query?.trim().toLowerCase();
      if (q !== undefined && q.length < 2) refuse("query needs at least 2 characters other than spaces.");
      const all: any[] = (await api.post("traffic-data", "/fetchAllAuthorities")) ?? [];
      const matching = q
        ? all.filter((x) => [x?.name, x?.legalName, ...(Array.isArray(x?.authoritySlugs) ? x.authoritySlugs : [])].some((v) => typeof v === "string" && v.toLowerCase().includes(q)))
        : all;
      const shown = matching.slice(0, a.max_results);
      return {
        count: shown.length,
        total_entitled: all.length,
        total_matching: matching.length,
        note: matching.length > shown.length ? `${matching.length - shown.length} more authorities match; raise max_results.` : undefined,
        authorities: shown.map((x) => fmt.authority(x, a.include_contact_details)),
      };
    }
    if (a.query !== undefined) refuse("query only applies without a location.");
    // A point becomes a 100 m square (findAuthorityIdsByViewport takes a polygon, at most 300 km2).
    const where = area({ lat: a.lat, lng: a.lng, bbox: a.bbox, viewport_size_m: 100 }, 300, "authority searches");
    const found = await api.post("explorer", "/findAuthorityIdsByViewport", { viewport: where.polygon });
    const ids: string[] = (Array.isArray(found?.authorities) ? found.authorities : []).map((x: any) => x?.entityId).filter((x: unknown): x is string => typeof x === "string");
    const shown = ids.slice(0, Math.min(a.max_results, 20));
    const authorities: unknown[] = [];
    const notAccessible: unknown[] = [];
    for (const id of shown) {
      try {
        authorities.push(fmt.explorerAuthority(await api.post("explorer", "/fetchAuthorityById", { id }), a.include_contact_details));
      } catch (err) {
        if (err instanceof AppyWayError && (err.status === 401 || err.status === 403 || err.status === 404)) notAccessible.push({ authority_id: id, error: err.message });
        else throw err;
      }
    }
    return {
      area: where.kind === "centre" ? { point: where.centre } : { bbox: where.bbox },
      count: authorities.length,
      total_found: ids.length,
      note: ids.length > shown.length ? `${ids.length - shown.length} more authorities cover this area; narrow it or raise max_results (details are fetched for at most 20).` : undefined,
      authorities,
      not_accessible: notAccessible.length ? notAccessible : undefined,
    };
  }),
);

server.registerTool(
  "get_authority_restrictions",
  {
    title: "Get an authority's restriction data",
    description:
      "For one authority slug (from list_authorities): the authority record and the links to its full restriction data as published by AppyWay's Traffic Data API: zones, on-street parking (bays and lines with their restriction sets), sets (operating hours, tariffs, exceptions, exemptions) and moving-traffic features, optionally as they stood at max_date. The documents behind the links can be very large; this server returns the links and never downloads them.",
    inputSchema: {
      slug: slug.describe("Authority slug, e.g. from list_authorities"),
      max_date: isoDateTime.optional().describe("See the restrictions in force at this date (default: now)"),
      include_contact_details: includeContactInput,
    },
    annotations: READ,
  },
  safe(async (a) => {
    const full = await api.post("traffic-data", "/fetchFullAuthorityBySlug", { slug: a.slug });
    const maxDate = toApiTime(a.max_date);
    const info = await api.post("traffic-data", "/fetchFullAuthorityInfoBySlug", { slug: a.slug, ...(maxDate ? { maxDate } : {}) });
    return {
      authority: { ...fmt.authority(full ?? {}, a.include_contact_details), has_boundary_shape: !!full?.shape },
      data_documents: {
        zones: fmt.documentLink(info?.zonesUrl),
        on_street_parking: fmt.documentLink(info?.ospsUrl),
        sets: fmt.documentLink(info?.setsUrl),
        moving_traffic_features: fmt.documentLink(info?.mtfsUrl),
      },
      max_date: maxDate,
      note: "These are AppyWay's cached GeoJSON/JSON documents for the whole authority. AppyWay says they do not change and can be cached until the endpoint returns different links. They can be very large and are not downloaded here.",
    };
  }),
);

// Reference API: every list endpoint is a POST without a request body; restriction types take an
// optional localeCode.
const REFERENCE_LISTS = {
  activity_types: "/fetchAllActivityTypes",
  authority_types: "/fetchAllAuthorityTypes",
  base_maps: "/fetchAllBaseMaps",
  countries: "/fetchAllCountries",
  entitlement_types: "/fetchAllEntitlementTypes",
  exception_types: "/fetchAllExceptionTypes",
  exemption_time_types: "/fetchAllExemptionTimeTypes",
  exemption_types: "/fetchAllExemptionTypes",
  facility_types: "/fetchAllFacilityTypes",
  fuel_types: "/fetchAllFuelTypes",
  moving_exception_types: "/fetchAllMovingExceptionTypes",
  moving_restriction_types: "/fetchAllMovingRestrictionTypes",
  note_visibility_types: "/fetchAllNoteVisibilityTypes",
  off_street_restriction_types: "/fetchAllOffStreetRestrictionTypes",
  on_street_parking_types: "/fetchAllOnStreetParkingTypes",
  payment_methods: "/fetchAllPaymentMethods",
  payment_providers: "/fetchAllPaymentProviders",
  permitted_vehicle_types: "/fetchAllPermittedVehicleTypes",
  permit_types: "/fetchAllPermitTypes",
  regions: "/fetchAllRegions",
  restriction_types: "/fetchAllRestrictionTypes",
  vehicle_types: "/fetchAllVehicleTypes",
  zone_types: "/fetchAllZoneTypes",
} as const;
type ReferenceList = keyof typeof REFERENCE_LISTS;

server.registerTool(
  "list_reference_values",
  {
    title: "List reference values",
    description:
      "AppyWay's reference data: the numeric ids used by the other tools (vehicle_types, permit_types, fuel_types, activity_types, payment_methods, restriction_types, zone_types, ...), plus countries (with public holidays), regions (with event venues) and payment providers. For countries and regions an id fetches one record.",
    inputSchema: {
      list: z.enum(Object.keys(REFERENCE_LISTS) as [ReferenceList, ...ReferenceList[]]).describe("Which reference list"),
      id: z.string().regex(/^[A-Za-z0-9_-]{1,36}$/, "Country and region ids are up to 36 letters, digits, - and _").optional().describe("For countries or regions: fetch this one record"),
      locale_code: z.string().regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, "An IETF BCP 47 locale code such as en-GB").optional().describe("For restriction_types: the IETF BCP 47 locale for names (e.g. en-GB)"),
      query: z.string().min(1).max(100).optional().describe("Case-insensitive match on name"),
      max_results: z.number().int().min(1).max(500).default(200),
      include_contact_details: includeContactInput,
    },
    annotations: READ,
  },
  safe(async (a) => {
    if (a.id && a.list !== "countries" && a.list !== "regions") refuse("id only applies to countries and regions.");
    if (a.locale_code && a.list !== "restriction_types") refuse("locale_code only applies to restriction_types.");
    const q = a.query?.trim().toLowerCase();
    if (q === "") refuse("query is empty after removing spaces.");
    if (a.id) {
      const one = await api.post("reference", a.list === "countries" ? "/fetchCountryById" : "/fetchRegionById", { id: a.id });
      return { list: a.list, item: fmt.referenceItem(one ?? {}, a.include_contact_details) };
    }
    const path = REFERENCE_LISTS[a.list];
    const all = await api.post("reference", path, a.list === "restriction_types" ? { ...(a.locale_code ? { localeCode: a.locale_code } : {}) } : undefined);
    const items: any[] = Array.isArray(all) ? all : [];
    const matching = q ? items.filter((x) => typeof x?.name === "string" && x.name.toLowerCase().includes(q)) : items;
    const shown = matching.slice(0, a.max_results);
    return {
      list: a.list,
      count: shown.length,
      total: items.length,
      note: matching.length > shown.length ? `${matching.length - shown.length} more match; raise max_results.` : undefined,
      items: shown.map((x) => fmt.referenceItem(x, a.include_contact_details)),
    };
  }),
);

await server.connect(new StdioServerTransport());
console.error("AppyWay MCP server running (read-only).");
