// End-to-end test: fixtures are validated against AppyWay's three published OpenAPI documents, then the
// built MCP server is driven over stdio by a real MCP client against a local mock of the API.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as fx from "./fixtures.mjs";
import { startMock, API_KEY } from "./mock-server.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const started = Date.now();
let passed = 0;
const check = async (name, fn) => {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
};

// 1. Fixtures match the published specs (so the mock returns what the real API documents).
const STOPLIGHT = "https://stoplight.io/api/v1/projects/appyway/public-docs/nodes/reference";
const SPECS = {
  explorer: { file: "spec-explorer.json", url: `${STOPLIGHT}/AppyWay-YlpExplorerApi-v1.oas.json` },
  "traffic-data": { file: "spec-traffic-data.json", url: `${STOPLIGHT}/AppyWay-YlpCmsDataApi-v1.oas.json` },
  reference: { file: "spec-reference.json", url: `${STOPLIGHT}/AppyWay-YlpReferenceApi-v1.oas.json` },
};
const spec = {};
for (const [section, { file, url }] of Object.entries(SPECS)) {
  if (!existsSync(`${root}${file}`)) {
    try {
      const text = await (await fetch(url, { headers: { Accept: "application/json" } })).text();
      JSON.parse(text); // fail here, not later, if the download was an error page
      writeFileSync(`${root}${file}`, text);
    } catch (err) {
      console.error(`Could not download the AppyWay ${section} spec (${err?.cause?.code ?? err.message}). Save it manually:\n  curl -o ${file} ${url}`);
      process.exit(1);
    }
  }
  spec[section] = JSON.parse(readFileSync(`${root}${file}`, "utf8"));
  assert.equal(spec[section].openapi, "3.0.1");
  assert.deepEqual(spec[section].components.securitySchemes.apiKey, { name: "API-KEY", in: "header", type: "apiKey" }, `${section}: the documented auth is the API-KEY header`);
}

// OpenAPI 3.0 schemas. Three adjustments, all needed for Ajv to use the documents as published:
// - `{"nullable": true}` with no `type` (10 places, e.g. a FeatureCollection's `properties`) means "any
//   value or null"; Ajv refuses `nullable` without `type`, so those become `{}` (any value).
// - Explorer `Geometry` lists only `type` and `crs`, with additionalProperties: false, yet the Explorer
//   guide's example entity has `coordinates` on every geometry (a geometry without coordinates is
//   useless). The test allows a `coordinates` array on that one schema and nothing else; a check below
//   proves the unadjusted schema rejects the fixtures, so the adjustment is not silent.
// - OpenAPI 3.0 writes an exclusive bound as `exclusiveMinimum: true` next to `minimum` (draft-04 style;
//   once, on findParkingEntitiesByCentreAndViewportSize's viewportSize); Ajv's draft-07 wants the number.
const loosenNullable = (node) => {
  if (Array.isArray(node)) return node.map(loosenNullable);
  if (!node || typeof node !== "object") return node;
  if (node.nullable === true && node.type === undefined && node.$ref === undefined && Object.keys(node).every((k) => ["nullable", "description"].includes(k))) return {};
  const out = Object.fromEntries(Object.entries(node).map(([k, v]) => [k, loosenNullable(v)]));
  for (const [flag, bound] of [["exclusiveMinimum", "minimum"], ["exclusiveMaximum", "maximum"]]) {
    if (typeof out[flag] !== "boolean") continue;
    if (out[flag]) {
      out[flag] = out[bound];
      delete out[bound];
    } else delete out[flag];
  }
  return out;
};
const components = Object.fromEntries(Object.entries(spec).map(([s, doc]) => [s, loosenNullable(doc.components)]));
const explorerStrict = structuredClone(components.explorer);
components.explorer.schemas.Geometry.properties.coordinates = { type: "array" };

const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema({ $id: "explorer", components: components.explorer });
ajv.addSchema({ $id: "explorer-strict", components: explorerStrict });
ajv.addSchema({ $id: "traffic-data", components: components["traffic-data"] });
ajv.addSchema({ $id: "reference", components: components.reference });
const compiled = new Map();
const validatorFor = (section, name) => {
  const key = `${section}#${name}`;
  if (!compiled.has(key)) compiled.set(key, ajv.compile({ $ref: `${section}#/components/schemas/${name}` }));
  return compiled.get(key);
};
const validate = (section, name, obj, label = "") => {
  const v = validatorFor(section, name);
  assert.ok(v(obj), `${section} ${name} ${label}: ${ajv.errorsText(v.errors)}`);
};
const refName = (schema) => schema.$ref.split("/").pop();
const opOf = (section, path, method = "post") => spec[section].paths[path]?.[method];
const responseSchema = (section, path, status = "200", method = "post") => opOf(section, path, method).responses[status].content["application/json"].schema;
const requestSchema = (section, path) => opOf(section, path).requestBody?.content?.["application/json"]?.schema;

// fetchFullAuthorityInfoBySlug: the operation's description says "The initial object contains only the
// URLs" and that the schema shows "the model you will find at these locations". The published schema is
// therefore not the shape of the response; this one is written from the description (see README).
const SNAPSHOT_INFO_SCHEMA = {
  type: "object",
  required: ["success", "result"],
  additionalProperties: false,
  properties: {
    success: { type: "boolean" },
    result: {
      type: "object",
      additionalProperties: false,
      properties: Object.fromEntries(["ospsUrl", "zonesUrl", "setsUrl", "mtfsUrl"].map((k) => [k, { type: "string", format: "uri" }])),
    },
  },
};
const validateSnapshot = ajv.compile(SNAPSHOT_INFO_SCHEMA);

console.log("fixtures vs OpenAPI specs");
await check("authorities, zones, zone rules, parking entities, quotes, operating hours, payment providers and reference lists match the published schemas", async () => {
  fx.trafficAuthorities.forEach((a) => validate("traffic-data", "Authority", a, a.name));
  fx.trafficAuthorities.forEach((a) => validate("traffic-data", "FullAuthority", fx.fullAuthority(a), a.name));
  Object.values(fx.explorerAuthorities).forEach((a) => validate("explorer", "Authority", a, a.name));
  Object.values(fx.zones).forEach((z) => validate("explorer", "Zone", z, z.name));
  validate("explorer", "ZoneSearchResult", fx.zoneSearchResult);
  fx.allEntities.forEach((e) => validate("explorer", "ParkingEntity", e, e.name));
  [...fx.quotesFor(undefined), ...fx.quotesFor({ permits: [{ permitTypeId: fx.BLUE_BADGE }] })].forEach((r) => validate("explorer", "ParkingEntitySearchResult", r, r.entityId));
  fx.entities.forEach((e) => validate("explorer", "ParkingEntityOperatingHoursResult", fx.operatingHours(e.entityId, "2026-10-01"), e.name));
  fx.entities.forEach((e) => validate("explorer", "ParkingEntityOperatingHoursResult", fx.operatingHours(e.entityId, "2026-10-01", true), `${e.name} with closed periods`));
  Object.values(fx.paymentProviders).flat().forEach((p) => validate("explorer", "PaymentProvider", p, p.name));
  for (const [path, items] of Object.entries(fx.reference)) validate("reference", refName(responseSchema("reference", path)), { success: true, result: items }, path);
  Object.values(fx.trafficAuthorities).forEach((a) => assert.ok(validateSnapshot({ success: true, result: fx.snapshotInfo(a.authoritySlugs[0]) }), ajv.errorsText(validateSnapshot.errors)));
  // Negative controls: a schema that accepted anything would be noticed.
  assert.equal(validatorFor("explorer", "ParkingEntity")({ ...fx.entities[0], nickname: "x" }), false, "additionalProperties: false must reject an undeclared key");
  assert.equal(validatorFor("traffic-data", "Authority")({ id: "not-a-uuid" }), false, "Authority.id is format uuid");
  assert.equal(validatorFor("explorer", "ParkingQuote")({ cost: "2.54" }), false, "cost is a number");
  // The Geometry adjustment is needed (the published schema has no coordinates) and is the only one.
  assert.equal(ajv.compile({ $ref: "explorer-strict#/components/schemas/ParkingEntity" })(fx.entities[0]), false, "the unadjusted Geometry schema rejects a geometry with coordinates");
  assert.deepEqual(Object.keys(components.explorer.schemas.Geometry.properties).sort(), ["coordinates", "crs", "type"]);
  // The published AuthoritySnapshotInfoDoc describes the documents, not the URLs the endpoint returns.
  assert.equal(validatorFor("traffic-data", "AuthoritySnapshotInfoDocOkResponse")({ success: true, result: fx.snapshotInfo("northgate") }), false, "the spec's schema types the links as FeatureCollections");
});

// 2. The mock's responses (results and errors) match the documented response schemas.
const { server: mock, port, requests, arm, arm429, disarm } = await startMock();
const base = `http://127.0.0.1:${port}/v1`;
const raw = async (method, path, body, key = API_KEY) => {
  const res = await fetch(base + path, { method, headers: { "API-KEY": key, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : undefined };
};
const WINDOW = { startTime: "2026-10-01T16:00:00Z", endTime: "2026-10-01T18:00:00Z" };
const CENTRE = { lat: 51.5195, lng: -0.11 };
// The Explorer guide's "Example Parking Search Request", verbatim.
const GUIDE_SEARCH = {
  startTime: "2020-02-05T17:00:00.000Z",
  endTime: "2020-02-05T19:00:00.000Z",
  viewport: { type: "Polygon", coordinates: [[[-0.12981344266095543, 51.49795047512468], [-0.12507129712262535, 51.49795047512468], [-0.12507129712262535, 51.49565278691962], [-0.12981344266095543, 51.49565278691962], [-0.12981344266095543, 51.49795047512468]]] },
};
await check("mock responses match the documented result and error schemas for every endpoint the server uses", async () => {
  const ok200 = async (section, path, body) => {
    const r = await raw("POST", `/${section}${path}`, body);
    assert.equal(r.status, 200, `${path}: ${JSON.stringify(r.json)}`);
    validate(section, refName(responseSchema(section, path)), r.json, path);
    assert.equal(r.json.success, true);
    return r.json.result;
  };
  const quotes = await ok200("explorer", "/findParkingQuotesByCentreAndViewportSize", { viewportCenter: CENTRE, viewportSize: 300, ...WINDOW });
  assert.equal(quotes.parking.length, 5);
  assert.equal(quotes.requestedDuration, "02:00:00");
  validate("explorer", refName(requestSchema("explorer", "/findParkingQuotesByViewport")), GUIDE_SEARCH, "the guide's example search request");
  await ok200("explorer", "/findParkingQuotesByViewport", GUIDE_SEARCH);
  await ok200("explorer", "/findParkingEntitiesByCentreAndViewportSize", { viewportCenter: CENTRE, viewportSize: 300 });
  await ok200("explorer", "/findParkingEntitiesByViewport", { viewport: GUIDE_SEARCH.viewport });
  await ok200("explorer", "/findZoneDefaultRulesByViewport", { viewport: GUIDE_SEARCH.viewport, ...WINDOW });
  const many = await ok200("explorer", "/fetchEntitiesByIds", { ids: [fx.ENT_BAY, fx.ZONE_CPZ, fx.AUTH_NORTHGATE] });
  assert.deepEqual([many.parkingEntities.length, many.zones.length, many.authorities.length], [1, 1, 1]);
  await ok200("explorer", "/fetchParkingEntityById", { id: fx.ENT_BAY });
  await ok200("explorer", "/fetchOperatingHoursById", { entityId: fx.ENT_BAY, date: "2026-10-01" });
  const noClosed = await ok200("explorer", "/fetchOperatingHoursByIds", { ids: [fx.ENT_BAY, fx.ENT_CARPARK], date: "2026-10-01" });
  assert.deepEqual(noClosed.map((h) => h.closedPeriods), [null, null], "the mock gives closed periods only when asked (includeClosedPeriods)");
  const closed = await ok200("explorer", "/fetchOperatingHoursByIds", { ids: [fx.ENT_BAY, fx.ENT_CARPARK], date: "2026-10-01", includeClosedPeriods: true });
  assert.deepEqual(closed.map((h) => h.closedPeriods.length), [0, 1]);
  await ok200("explorer", "/fetchPaymentProvidersByParkingEntityId", { entityId: fx.ENT_BAY });
  await ok200("explorer", "/fetchParkingQuoteById", { entityId: fx.ENT_BAY, ...WINDOW });
  await ok200("explorer", "/fetchZoneById", { id: fx.ZONE_CPZ });
  await ok200("explorer", "/fetchZoneDefaultRulesById", { id: fx.ZONE_CPZ, ...WINDOW });
  await ok200("explorer", "/findAuthorityIdsByViewport", { viewport: GUIDE_SEARCH.viewport });
  await ok200("explorer", "/fetchAuthorityById", { id: fx.AUTH_NORTHGATE });
  const all = await ok200("traffic-data", "/fetchAllAuthorities");
  assert.deepEqual(all.map((a) => a.name), ["Northgate Borough Council", "Riverside District Council"], "only the entitled authorities");
  await ok200("traffic-data", "/fetchFullAuthorityBySlug", { slug: "northgate" });
  const info = await raw("POST", "/traffic-data/fetchFullAuthorityInfoBySlug", { slug: "northgate" });
  assert.ok(validateSnapshot(info.json), ajv.errorsText(validateSnapshot.errors));
  const limited = await raw("POST", "/reference/fetchAllVehicleTypes"); // the mock answers the first call with a 429
  assert.equal(limited.status, 429);
  assert.equal(limited.json, undefined, "429 is documented without a body");
  for (const path of Object.keys(fx.reference)) await ok200("reference", path);
  await ok200("reference", "/fetchAllRestrictionTypes", { localeCode: "en-GB" });
  await ok200("reference", "/fetchCountryById", { id: "GB" });
  await ok200("reference", "/fetchRegionById", { id: "region-london-test" });
  const ping = await raw("GET", "/reference/ping");
  validate("reference", refName(responseSchema("reference", "/ping", "200", "get")), ping.json);
  // Errors: 404 NotFoundResponse, 400 BadRequestResponse, the guide's 401 for an authority outside the entitlement, bare 401 for a bad key.
  const nf = await raw("POST", "/explorer/fetchParkingEntityById", { id: "00000000-0000-4000-8000-00000000dead" });
  assert.equal(nf.status, 404);
  validate("explorer", refName(responseSchema("explorer", "/fetchParkingEntityById", "404")), nf.json);
  const bad = await raw("POST", "/explorer/findParkingQuotesByCentreAndViewportSize", { viewportCenter: CENTRE, viewportSize: 5000, ...WINDOW });
  assert.equal(bad.status, 400);
  validate("explorer", refName(responseSchema("explorer", "/findParkingQuotesByCentreAndViewportSize", "400")), bad.json);
  const denied = await raw("POST", "/traffic-data/fetchFullAuthorityBySlug", { slug: "eastbridge" });
  assert.equal(denied.status, 401);
  validate("traffic-data", "BadRequestResponse", denied.json, "(the guide's 401 example has the same keys)");
  assert.match(denied.json.errors[0].message, /^No permissions to authority ‘\{00000000-0000-4000-8000-00000000A003\}’$/);
  assert.equal((await raw("POST", "/traffic-data/fetchAllAuthorities", undefined, "aw-wrong-key")).status, 401);
  assert.equal((await raw("GET", "/explorer/ping", undefined, "aw-wrong-key")).json, undefined);
});

await check("enum names match the specs' descriptions; TimeSpan strings parse as documented", async () => {
  const fmt = await import(`${root}dist/format.js`);
  const fromSpec = (section, name) => Object.fromEntries([...components[section].schemas[name].description.matchAll(/\*(\w+) \((-?\d+)\)/g)].map((m) => [m[2], m[1]]));
  const asStrings = (map) => Object.fromEntries(Object.entries(map).map(([k, v]) => [String(k), v]));
  assert.deepEqual(asStrings(fmt.MAP_ENTITY_TYPES), fromSpec("explorer", "MapEntityType"));
  assert.deepEqual(asStrings(fmt.PARKING_ALLOWED), fromSpec("explorer", "ParkingAllowed"));
  assert.deepEqual(asStrings(fmt.GENERAL_ONSTREET_POLICY), fromSpec("explorer", "GeneralOnStreetPolicyType"));
  assert.deepEqual(asStrings(fmt.ON_STREET_PARKING_TYPES), fromSpec("explorer", "OnStreetParkingType"));
  assert.deepEqual(asStrings(fmt.ZONE_TYPES), fromSpec("explorer", "ZoneType"));
  assert.deepEqual(asStrings(fmt.OPEN_PERIOD_STATUS), fromSpec("explorer", "OpenPeriodStatus"));
  assert.deepEqual(asStrings(fmt.DATA_QUALITY), fromSpec("traffic-data", "DataQuality"));
  // Getting-started guide: "[-][d.]hh:mm:ss[.fffffff]"; the spec's own example is "3.17:25:30.5000000".
  assert.equal(fmt.parseTimeSpan("3.17:25:30.5000000"), 3 * 86400 + 17 * 3600 + 25 * 60 + 30.5);
  assert.equal(fmt.parseTimeSpan("01:30:00"), 5400);
  assert.equal(fmt.parseTimeSpan("-00:15:00"), -900);
  assert.equal(fmt.parseTimeSpan("25:00:00"), undefined, "hours above 23 are not a TimeSpan");
  assert.equal(fmt.parseTimeSpan("PT1H"), undefined, "ISO 8601 durations are not what AppyWay documents");
  assert.deepEqual(fmt.timeSpan("3.17:25:30.5000000"), { raw: "3.17:25:30.5000000", minutes: 5365.51 });
});
requests.length = 0; // only count what the MCP server does from here on

// 3. Drive the server through MCP.
const connect = async (key, extraEnv = {}) => {
  const client = new Client({ name: "e2e", version: "1.0.0" });
  const env = { ...process.env, APPYWAY_API_KEY: key, APPYWAY_BASE_URL: base, ...extraEnv };
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [`${root}dist/index.js`], env, stderr: "ignore" }));
  return client;
};
const call = async (client, name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  return { res, data: res.isError ? undefined : JSON.parse(res.content[0].text), text: res.content[0].text };
};
const since = (n) => requests.slice(n);
const TOOLS = ["fetch_kerb_segments", "find_parking_rules_near", "get_authority_restrictions", "get_parking_entity", "get_zone_rules", "list_authorities", "list_reference_values", "ping"];

const client = await connect(API_KEY);
console.log("mcp tools");

await check("tools/list exposes the 8 tools, all read-only and non-destructive; APPYWAY_ALLOW_WRITES adds nothing", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), TOOLS);
  for (const t of tools) {
    assert.equal(t.annotations?.readOnlyHint, true, `${t.name} readOnlyHint`);
    assert.equal(t.annotations?.destructiveHint, false, `${t.name} destructiveHint`);
  }
  const withWrites = await connect(API_KEY, { APPYWAY_ALLOW_WRITES: "true" });
  assert.deepEqual((await withWrites.listTools()).tools.map((t) => t.name).sort(), TOOLS);
  await withWrites.close();
});

await check("ping calls GET /ping on the three API sections and reports each; a 403 on one section is reported without hiding the others", async () => {
  const n = requests.length;
  const { data } = await call(client, "ping");
  assert.deepEqual(since(n).map((r) => `${r.method} ${r.path}`), ["GET /explorer/ping", "GET /traffic-data/ping", "GET /reference/ping"]);
  for (const s of ["explorer", "traffic-data", "reference"]) assert.deepEqual([data.sections[s].ok, data.sections[s].answer], [true, "pong"]);
  arm({ method: "GET", path: "/traffic-data/ping", status: 403 });
  const partial = await call(client, "ping");
  assert.equal(partial.data.sections.explorer.ok, true);
  assert.equal(partial.data.sections["traffic-data"].ok, false);
  assert.match(partial.data.sections["traffic-data"].error, /refused GET \/traffic-data\/ping \(403 Forbidden\)\. The key may not be enabled for the Traffic Data API/);
  disarm();
});

await check("find_parking_rules_near (point): documented centre+size query, entity details via fetchEntitiesByIds, zone defaults for the same area; quotes, TimeSpan and enums readable", async () => {
  const n = requests.length;
  const { data } = await call(client, "find_parking_rules_near", { lat: CENTRE.lat, lng: CENTRE.lng, viewport_size_m: 300, start_time: WINDOW.startTime, end_time: WINDOW.endTime });
  assert.deepEqual(since(n).map((r) => r.path), ["/explorer/findParkingQuotesByCentreAndViewportSize", "/explorer/fetchEntitiesByIds", "/explorer/findZoneDefaultRulesByViewport"]);
  const [search, ents, zonesReq] = since(n);
  assert.deepEqual(search.body, { viewportCenter: CENTRE, viewportSize: 300, ...WINDOW }, "no vehicle context or filters unless asked");
  assert.deepEqual(ents.body, { ids: [fx.ENT_BAY, fx.ENT_DISABLED, fx.ENT_SYL, fx.ENT_CARPARK, fx.ENT_LOADING], geometryPreference: { geometryTypes: [1] } });
  assert.deepEqual([zonesReq.body.startTime, zonesReq.body.endTime, zonesReq.body.viewport.type], [WINDOW.startTime, WINDOW.endTime, "Polygon"]);
  const ring = zonesReq.body.viewport.coordinates[0];
  assert.equal(ring.length, 5);
  assert.deepEqual(ring[0], ring[4], "the polygon ring is closed");
  assert.deepEqual(data.window.requested_duration, { raw: "02:00:00", minutes: 120 });
  assert.equal(data.general_onstreet_policy, "LikelyRestricted");
  assert.deepEqual(data.results.map((r) => [r.entity_id, r.parking_allowed]), [[fx.ENT_BAY, "FullSession"], [fx.ENT_DISABLED, "NoParking"], [fx.ENT_SYL, "TruncatedSession"], [fx.ENT_CARPARK, "FullSession"], [fx.ENT_LOADING, "NoParking"]]);
  const bay = data.results[0];
  assert.deepEqual([bay.quotes[0].cost, bay.quotes[0].currency, bay.quotes[0].is_free, bay.distance_m], [2.54, "GBP", false, 12]);
  assert.deepEqual(bay.quotes[1].only_for, { vehicle_type_id: 1, fuel_type_id: 4 }, "a quote limited to a vehicle context says so");
  assert.deepEqual([bay.entity.name, bay.entity.on_street_parking_types, bay.entity.location, bay.entity.zone_id], ["Dorrington Street", ["StandardBay"], { lat: 51.519519, lng: -0.110386 }, fx.ZONE_CPZ]);
  assert.equal(data.results[2].quotes[0].free_until, "2026-10-01T07:30:00Z");
  const syl = data.results[2].entity;
  assert.deepEqual(
    [syl.name, syl.address, syl.location_code],
    ["Leather Lane single yellow line (enquiries [phone redacted])", { street: "Leather Lane, ask [email redacted]", city: "Northgate [phone redacted]", postcode: "NG1 1AA", country: "UK ([email redacted])" }, "[phone redacted]"],
    "names, address lines and location codes are redacted by default",
  );
  assert.equal(data.results[3].entity.entity_type, undefined);
  assert.equal(data.results[3].entity_type, "Carpark");
  assert.equal(data.results[3].entity.operator.has_pay_by_phone, true);
  assert.equal(data.results[3].entity.operator.telephone, undefined, "operator telephone only on request");
  assert.deepEqual(data.zone_rules[0].defaults.map((d) => d.on_street_parking_type), ["SingleYellowLine", "StandardBay"]);
  assert.equal(data.zone_rules[0].defaults[1].applies[0].max_stay, 240);
  assert.equal(data.zone_containing_location.zone_type, "ControlledParkingZone");
});

await check("find_parking_rules_near (bbox): documented GeoJSON polygon; every filter and vehicle detail passed through exactly as documented", async () => {
  const n = requests.length;
  const { data } = await call(client, "find_parking_rules_near", {
    bbox: { west: -0.1115, south: 51.5185, east: -0.1075, north: 51.5212 },
    ...WINDOW_ARGS(),
    vehicle_type_id: 1,
    fuel_type_id: 4,
    permit_type_ids: [fx.BLUE_BADGE],
    vehicle_year: 2022,
    co2_emissions: 0,
    exclude_car_parks: true,
    exclude_no_parking: true,
    max_cost: 5,
    include_entity_details: false,
    include_zone_rules: false,
  });
  assert.deepEqual(since(n).map((r) => r.path), ["/explorer/findParkingQuotesByViewport"]);
  const body = requests.at(-1).body;
  assert.deepEqual(body.viewport, { type: "Polygon", coordinates: [[[-0.1115, 51.5212], [-0.1075, 51.5212], [-0.1075, 51.5185], [-0.1115, 51.5185], [-0.1115, 51.5212]]] });
  assert.deepEqual(body.vehicleOperatorContext, { vehicleTypeId: 1, fuelTypeId: 4, permits: [{ permitTypeId: fx.BLUE_BADGE }], co2Emissions: 0, vehicleYear: 2022 });
  assert.deepEqual(body.filters, { excludeEntityTypes: [2], excludeNoParking: true, excludeCostGreaterThan: 5 });
  assert.deepEqual(data.results.map((r) => [r.entity_id, r.parking_allowed]), [[fx.ENT_BAY, "FullSession"], [fx.ENT_DISABLED, "FullSession"], [fx.ENT_SYL, "TruncatedSession"]], "a blue badge makes the disabled bay available");
  assert.deepEqual(data.results[1].quotes[0].only_for, { permit_type_ids: [fx.BLUE_BADGE] });
  const rest = await call(client, "find_parking_rules_near", { lat: CENTRE.lat, lng: CENTRE.lng, exclude_on_street: true, exclude_paid: false, exclude_free: true, exclude_truncated: true, include_entity_details: false, include_zone_rules: false, ...WINDOW_ARGS() });
  assert.deepEqual(requests.at(-1).body.filters, { excludeEntityTypes: [1], excludePaidParking: false, excludeFreeParking: true, excludeTruncatedParking: true });
  assert.deepEqual(rest.data.results.map((r) => r.entity_id), [fx.ENT_CARPARK]);
  const defaults = await call(client, "find_parking_rules_near", { lat: CENTRE.lat, lng: CENTRE.lng, include_entity_details: false, include_zone_rules: false, max_results: 2 });
  const d = requests.at(-1).body;
  assert.equal(Date.parse(d.endTime) - Date.parse(d.startTime), 3600_000, "the window defaults to one hour from now");
  assert.ok(Math.abs(Date.parse(d.startTime) - Date.now()) < 120_000);
  assert.equal(d.viewportSize, 300, "the viewport defaults to 300 m");
  assert.deepEqual([defaults.data.count, defaults.data.total_results], [2, 5]);
  assert.match(defaults.data.note, /3 more results were left out/);
});
function WINDOW_ARGS() {
  return { start_time: WINDOW.startTime, end_time: WINDOW.endTime };
}

// zod's messages for a number above its maximum and for a value outside an enum.
const LAT_TOO_BIG = /Too big: expected number to be <=90/;
const LIST_UNKNOWN = /Invalid option: expected one of "activity_types"\|/;

await check("bad input is refused before any API call: two or no locations, areas over the documented limits, inverted windows, bad ids, slugs and dates", async () => {
  const before = requests.length;
  const refused = [
    ["find_parking_rules_near", { lat: 51.5, lng: -0.1, bbox: { west: -0.11, south: 51.5, east: -0.1, north: 51.51 } }, /either lat\/lng .* or bbox, not both/],
    ["find_parking_rules_near", {}, /Give a location/],
    ["find_parking_rules_near", { lat: 51.5 }, /Give both lat and lng/],
    ["find_parking_rules_near", { lat: 51.5, lng: -0.1, viewport_size_m: 2000 }, /1224/],
    ["find_parking_rules_near", { bbox: { west: -0.13, south: 51.5, east: -0.1, north: 51.52 } }, /covers about [\d.]+ km2; AppyWay limits parking searches to 1.5 km2/],
    ["find_parking_rules_near", { bbox: { west: -0.1, south: 51.5, east: -0.11, north: 51.51 } }, /east > west/],
    ["find_parking_rules_near", { lat: 51.5, lng: -0.1, start_time: "2026-10-01T18:00:00Z", end_time: "2026-10-01T17:00:00Z" }, /end_time must be after start_time/],
    ["find_parking_rules_near", { lat: 51.5, lng: -0.1, start_time: "tomorrow at six" }, /ISO 8601/],
    ["find_parking_rules_near", { lat: 91, lng: -0.1 }, LAT_TOO_BIG],
    ["find_parking_rules_near", { lat: 51.5, lng: -0.1, start_time: "2026-02-30T10:00:00Z" }, /Not a valid date and time/],
    ["fetch_kerb_segments", { entity_ids: [fx.ENT_BAY], lat: 51.5, lng: -0.1 }, /either entity_ids or an area/],
    ["fetch_kerb_segments", { entity_ids: ["../fetchZoneById"] }, /GUID-like/],
    ["fetch_kerb_segments", { lat: 51.5, lng: -0.1, on_street_parking_types: ["GoldBay"] }, /on_street_parking_types/],
    ["get_parking_entity", { entity_id: "bad id" }, /GUID-like/],
    ["get_parking_entity", { entity_id: fx.ENT_BAY, date: "2026-13-45" }, /Not a valid date/],
    ["get_parking_entity", { entity_id: fx.ENT_BAY, date: "2026-02-30" }, /Not a valid date/],
    ["get_parking_entity", { entity_id: `{${fx.ENT_BAY}` }, /GUID-like/],
    ["get_parking_entity", { entity_id: `${fx.ENT_BAY}}` }, /GUID-like/],
    ["list_authorities", { query: "   " }, /at least 2 characters other than spaces/],
    ["list_reference_values", { list: "permit_types", query: "  " }, /query is empty/],
    ["get_parking_entity", { entity_id: fx.ENT_BAY, end_time: "2026-10-01T18:00:00Z" }, /end_time needs a start_time/],
    ["get_zone_rules", { zone_id: "" }, /GUID-like/],
    ["get_authority_restrictions", { slug: "north gate" }, /slugs are short strings/],
    ["list_authorities", { bbox: { west: -1, south: 51, east: 0, north: 52 } }, /AppyWay limits authority searches to 300 km2/],
    ["list_authorities", { lat: 51.5, lng: -0.1, query: "north" }, /query only applies without a location/],
    ["list_reference_values", { list: "vehicle_types", id: "GB" }, /id only applies to countries and regions/],
    ["list_reference_values", { list: "countries", id: "../x" }, /Country and region ids/],
    ["list_reference_values", { list: "unicorns" }, LIST_UNKNOWN],
  ];
  for (const [tool, args, pattern] of refused) {
    const { res, text } = await call(client, tool, args);
    assert.ok(res.isError, `${tool} should refuse ${JSON.stringify(args)}`);
    assert.match(text, pattern, `${tool} ${JSON.stringify(args)}: ${text}`);
  }
  assert.equal(requests.length, before, "no request for invalid input");
});

// A square bounding box of the given side in metres, computed the way the server estimates areas.
const squareBox = (lat, lng, sideM) => {
  const dLat = sideM / 2 / 111320;
  const dLng = sideM / 2 / (111320 * Math.cos((lat * Math.PI) / 180));
  return { west: lng - dLng, south: lat - dLat, east: lng + dLng, north: lat + dLat };
};
await check("the documented area limits hold at the boundary: 1.5 km2 for parking searches (1220 m square accepted, 1230 m refused) and 300 km2 for authority searches (17.3 km accepted, 17.4 km refused)", async () => {
  const quiet = { include_entity_details: false, include_zone_rules: false, ...WINDOW_ARGS() };
  let n = requests.length;
  const under = await call(client, "find_parking_rules_near", { bbox: squareBox(CENTRE.lat, CENTRE.lng, 1220), ...quiet });
  assert.ok(!under.res.isError, under.text);
  assert.equal(since(n).length, 1);
  n = requests.length;
  const over = await call(client, "find_parking_rules_near", { bbox: squareBox(CENTRE.lat, CENTRE.lng, 1230), ...quiet });
  assert.match(over.text, /covers about 1\.51 km2; AppyWay limits parking searches to 1\.5 km2/);
  const overSegments = await call(client, "fetch_kerb_segments", { bbox: squareBox(CENTRE.lat, CENTRE.lng, 1230) });
  assert.match(overSegments.text, /covers about 1\.51 km2; AppyWay limits parking entity searches to 1\.5 km2/);
  assert.equal(since(n).length, 0, "refused before any call");
  const authUnder = await call(client, "list_authorities", { bbox: squareBox(51.5, -0.1, 17300) });
  assert.ok(!authUnder.res.isError, authUnder.text);
  assert.equal(requests.at(-3)?.path, "/explorer/findAuthorityIdsByViewport");
  n = requests.length;
  const authOver = await call(client, "list_authorities", { bbox: squareBox(51.5, -0.1, 17400) });
  assert.match(authOver.text, /covers about 302\.\d\d km2; AppyWay limits authority searches to 300 km2/);
  assert.equal(since(n).length, 0);
});

await check("an area with nothing in it: only the search (and the zone rules) are requested, no follow-up for entity details or operating hours", async () => {
  const EMPTY = { lat: 51.4, lng: -0.3 };
  let n = requests.length;
  const near = await call(client, "find_parking_rules_near", { ...EMPTY, ...WINDOW_ARGS() });
  assert.deepEqual(since(n).map((r) => r.path), ["/explorer/findParkingQuotesByCentreAndViewportSize", "/explorer/findZoneDefaultRulesByViewport"]);
  assert.deepEqual([near.data.count, near.data.total_results, near.data.results], [0, 0, []]);
  n = requests.length;
  const segs = await call(client, "fetch_kerb_segments", { ...EMPTY, operating_hours_date: "2026-10-01" });
  assert.deepEqual(since(n).map((r) => r.path), ["/explorer/findParkingEntitiesByCentreAndViewportSize"]);
  assert.deepEqual([segs.data.count, segs.data.total, segs.data.entities], [0, 0, []]);
});

await check("times given without seconds are sent with them (the specs' date-time format), in every tool that takes a time", async () => {
  await call(client, "find_parking_rules_near", { ...CENTRE, start_time: "2026-10-01T18:00+01:00", end_time: "2026-10-01T19:30+01:00", include_entity_details: false, include_zone_rules: false });
  assert.deepEqual([requests.at(-1).body.startTime, requests.at(-1).body.endTime], ["2026-10-01T18:00:00+01:00", "2026-10-01T19:30:00+01:00"]);
  await call(client, "find_parking_rules_near", { ...CENTRE, start_time: "2026-10-01T18:00Z", include_entity_details: false, include_zone_rules: true });
  assert.deepEqual([requests.at(-1).path, requests.at(-1).body.startTime, requests.at(-1).body.endTime], ["/explorer/findZoneDefaultRulesByViewport", "2026-10-01T18:00:00Z", "2026-10-01T19:00:00Z"]);
  const zr = await call(client, "get_zone_rules", { zone_id: fx.ZONE_CPZ, start_time: "2026-10-01T18:00Z", end_time: "2026-10-02T06:00Z" });
  assert.deepEqual([requests.at(-1).body.startTime, requests.at(-1).body.endTime], ["2026-10-01T18:00:00Z", "2026-10-02T06:00:00Z"]);
  assert.deepEqual(zr.data.window, { startTime: "2026-10-01T18:00:00Z", endTime: "2026-10-02T06:00:00Z" });
  await call(client, "get_parking_entity", { entity_id: fx.ENT_BAY, start_time: "2026-10-01T18:00+01:00" });
  assert.deepEqual([requests.at(-1).path, requests.at(-1).body.startTime], ["/explorer/fetchParkingQuoteById", "2026-10-01T18:00:00+01:00"]);
  const ar = await call(client, "get_authority_restrictions", { slug: "northgate", max_date: "2026-09-01T00:00Z" });
  assert.deepEqual([requests.at(-1).body.maxDate, ar.data.max_date], ["2026-09-01T00:00:00Z", "2026-09-01T00:00:00Z"]);
  const dt = ajv.compile({ type: "string", format: "date-time" });
  assert.equal(dt("2026-10-01T18:00Z"), false, "control: the minutes-only form is not a valid date-time");
  assert.equal(dt("2026-10-01T18:00:00Z"), true);
});

await check("fetch_kerb_segments (area) passes onStreetParkingTypes and the entity-type filter as documented and caps the result; (ids) batches ids 50 per request and fetches operating hours for a date", async () => {
  const n = requests.length;
  const area = await call(client, "fetch_kerb_segments", { lat: 51.519, lng: -0.1105, viewport_size_m: 400, on_street_parking_types: ["StandardBay"], exclude_car_parks: true, distance_from: { lat: 51.519, lng: -0.111 } });
  assert.deepEqual(since(n).map((r) => r.path), ["/explorer/findParkingEntitiesByCentreAndViewportSize"]);
  assert.deepEqual(requests.at(-1).body, { viewportCenter: { lat: 51.519, lng: -0.1105 }, viewportSize: 400, geometryPreference: { geometryTypes: [1] }, distanceCalculationLocation: { lat: 51.519, lng: -0.111 }, filters: { excludeEntityTypes: [2] }, onStreetParkingTypes: [1] });
  assert.deepEqual([area.data.count, area.data.total], [50, 121]);
  assert.match(area.data.note, /71 more entities were left out/);
  assert.deepEqual([area.data.entities[0].entity_id, area.data.entities[0].distance_m, area.data.entities[0].on_street_parking_types], [fx.ENT_BAY, 10, ["StandardBay"]]);
  const box = await call(client, "fetch_kerb_segments", { bbox: { west: -0.1115, south: 51.5185, east: -0.1075, north: 51.5212 }, on_street_parking_types: ["LoadingBay", "DisabledBay"] });
  assert.deepEqual(requests.at(-1).path, "/explorer/findParkingEntitiesByViewport");
  assert.deepEqual(requests.at(-1).body.onStreetParkingTypes, [7, 2]);
  assert.deepEqual(box.data.entities.map((e) => e.name).sort(), ["Dorrington Street disabled bay", "Hatton Garden loading bay"]);

  const ids = [...fx.bulkEntities.map((e) => e.entityId), fx.ENT_BAY, "00000000-0000-4000-8000-00000000dead"];
  const m = requests.length;
  const byIds = await call(client, "fetch_kerb_segments", { entity_ids: ids, operating_hours_date: "2026-10-01", max_results: 500 });
  const calls = since(m);
  assert.deepEqual(calls.map((r) => [r.path, r.body.ids.length]), [
    ["/explorer/fetchEntitiesByIds", 50], ["/explorer/fetchEntitiesByIds", 50], ["/explorer/fetchEntitiesByIds", 22],
    ["/explorer/fetchOperatingHoursByIds", 50], ["/explorer/fetchOperatingHoursByIds", 50], ["/explorer/fetchOperatingHoursByIds", 21],
  ]);
  assert.deepEqual(calls.flatMap((r) => r.body.ids).slice(0, 122), ids, "every id sent once, in order");
  assert.ok(calls.slice(3).every((r) => r.body.date === "2026-10-01" && r.body.includeClosedPeriods === true), "closed periods are asked for");
  assert.deepEqual([byIds.data.count, byIds.data.total, byIds.data.not_found], [121, 121, ["00000000-0000-4000-8000-00000000dead"]]);
  const hours = byIds.data.entities[0].operating_hours;
  assert.deepEqual([hours.time_zone, hours.hours[0].open_periods.map((p) => p.status)], ["Europe/London", ["Free", "Paid", "Free"]]);
  assert.deepEqual(hours.hours[0].open_periods[1], { date: "2026-10-01", start: "08:30:00", end: "18:30:00", status: "Paid" });
  assert.deepEqual(hours.closed_periods, []);

  // Braced ids are sent bare, a repeated id is sent and reported once, a Point in a projected CRS is left out.
  const DEAD = "00000000-0000-4000-8000-00000000dead";
  const mixed = await call(client, "fetch_kerb_segments", { entity_ids: [`{${fx.ENT_CARPARK}}`, fx.ENT_PROJECTED, DEAD, DEAD, fx.ENT_SYL], operating_hours_date: "2026-10-01", include_contact_details: true });
  const [entReq, hoursReq] = requests.slice(-2);
  assert.deepEqual(entReq.body.ids, [fx.ENT_CARPARK, fx.ENT_PROJECTED, DEAD, fx.ENT_SYL]);
  assert.deepEqual({ ...hoursReq.body, ids: [...hoursReq.body.ids].sort() }, { ids: [fx.ENT_CARPARK, fx.ENT_PROJECTED, fx.ENT_SYL].sort(), date: "2026-10-01", includeClosedPeriods: true });
  assert.deepEqual(mixed.data.not_found, [DEAD], "a repeated missing id is listed once");
  const byId = Object.fromEntries(mixed.data.entities.map((e) => [e.entity_id, e]));
  assert.equal(byId[fx.ENT_PROJECTED].location, undefined, "a Point labelled EPSG:3857 is not passed off as WGS84");
  assert.deepEqual(byId[fx.ENT_CARPARK].location, { lat: 51.5208, lng: -0.1082 });
  assert.deepEqual(byId[fx.ENT_CARPARK].operating_hours.closed_periods, [{ start: "2026-10-01T00:00:00", end: "2026-10-01T06:00:00" }]);
  const syl = byId[fx.ENT_SYL];
  assert.deepEqual([syl.name, syl.address.street, syl.address.city, syl.address.country, syl.location_code], ["Leather Lane single yellow line (enquiries 020 7946 0444)", "Leather Lane, ask lines@example.com", "Northgate +44 20 7946 0445", "UK (uk-desk@example.com)", "07700 900456"], "raw text with include_contact_details");
});

await check("get_parking_entity: entity, operating hours, payment providers and a quote; operator and pay-by-phone numbers only on request", async () => {
  const n = requests.length;
  const { data, text } = await call(client, "get_parking_entity", { entity_id: fx.ENT_CARPARK, date: "2026-10-01", start_time: WINDOW.startTime, vehicle_type_id: 1 });
  assert.deepEqual(since(n).map((r) => [r.path, r.body]), [
    ["/explorer/fetchParkingEntityById", { id: fx.ENT_CARPARK }],
    ["/explorer/fetchOperatingHoursById", { entityId: fx.ENT_CARPARK, date: "2026-10-01", includeClosedPeriods: true, vehicleOperatorContext: { vehicleTypeId: 1 } }],
    ["/explorer/fetchPaymentProvidersByParkingEntityId", { entityId: fx.ENT_CARPARK }],
    ["/explorer/fetchParkingQuoteById", { entityId: fx.ENT_CARPARK, startTime: WINDOW.startTime, endTime: "2026-10-01T17:00:00Z", vehicleOperatorContext: { vehicleTypeId: 1 } }],
  ]);
  assert.deepEqual([data.entity.entity_type, data.entity.name, data.entity.total_capacity, data.entity.operator.name, data.entity.operator.website], ["Carpark", "Northgate Multi-Storey", 350, "TestPark Operators", "https://testpark.example.org"]);
  assert.equal(data.operating_hours.hours[0].open_periods.length, 3);
  assert.deepEqual(data.operating_hours.closed_periods, [{ start: "2026-10-01T00:00:00", end: "2026-10-01T06:00:00" }]);
  const ts = since(n).map((r) => r.t);
  const gaps = ts.slice(1).map((t, i) => t - ts[i]);
  assert.ok(gaps.every((g) => g >= 240), `requests are spaced about 250 ms apart (gaps ${gaps.join(", ")} ms)`);
  assert.deepEqual([data.payment_providers[0].name, data.payment_providers[0].payment_url, data.payment_providers[0].has_pay_by_phone], ["TestPark Operators", "https://pay.example.org/northgate", undefined]);
  assert.deepEqual([data.quote.parking_allowed, data.quote.quotes[0].cost, data.quote.quotes[0].min_cost], ["FullSession", 6.5, 3]);
  for (const phone of ["7946 0321", "496 0000"]) assert.ok(!text.includes(phone), `${phone} leaked by default`);
  const withContact = await call(client, "get_parking_entity", { entity_id: fx.ENT_CARPARK, date: "2026-10-01", include_contact_details: true });
  assert.deepEqual([withContact.data.entity.operator.telephone, withContact.data.entity.operator.payments_telephone], ["+44 20 7946 0321", "0117 496 0000"]);
  assert.equal(withContact.data.quote, undefined, "no quote without start_time");
  const bay = await call(client, "get_parking_entity", { entity_id: fx.ENT_BAY });
  assert.equal(requests.at(-2).body.date, new Date().toISOString().slice(0, 10), "operating hours default to today's (UTC) date");
  assert.deepEqual([bay.data.payment_providers[0].has_pay_by_phone, bay.data.payment_providers[0].payments_telephone, bay.data.payment_providers[0].app_links.android], [true, undefined, { schemes: ["paytest://"], package: "org.example.paytest" }]);
});

await check("an authority outside the key's entitlement gives the documented 401 with an actionable message; an unknown id gives a clear 404", async () => {
  const denied = await call(client, "get_parking_entity", { entity_id: fx.ENT_EAST });
  assert.ok(denied.res.isError);
  assert.match(denied.text, /refused POST \/explorer\/fetchParkingEntityById \(401\): the API key is not entitled to this authority\. .*No permissions to authority.*list_authorities .*apisupport@appyway\.com/);
  const missing = await call(client, "get_parking_entity", { entity_id: "00000000-0000-4000-8000-00000000dead" });
  assert.ok(missing.res.isError);
  assert.match(missing.text, /^Not found: POST \/explorer\/fetchParkingEntityById\. Check the ID\. Parking entity not found\.$/);
  const noZone = await call(client, "get_zone_rules", { zone_id: "00000000-0000-4000-8000-00000000dead" });
  assert.match(noZone.text, /^Not found: POST \/explorer\/fetchZoneById\. Check the ID\. Zone not found\.$/);
  assert.equal(requests.at(-1).path, "/explorer/fetchZoneById", "no rules request for an unknown zone");
});

await check("get_zone_rules sends the documented body (kerb types, includeNotApplicableTimes), redacts emails and phone numbers in zone notes by default and returns them on request", async () => {
  const { data } = await call(client, "get_zone_rules", { zone_id: fx.ZONE_CPZ, ...WINDOW_ARGS(), on_street_parking_types: ["SingleYellowLine"], include_not_applicable_times: true });
  assert.deepEqual(requests.at(-1).body, { id: fx.ZONE_CPZ, ...WINDOW, onStreetParkingTypeIds: [11], includeNotApplicableTimes: true });
  assert.deepEqual([data.zone.name, data.zone.zone_type, data.zone.authority_id], ["Northgate CPZ A (wardens [phone redacted])", "ControlledParkingZone", fx.AUTH_NORTHGATE]);
  assert.deepEqual(data.zone.notes, ["Permit enquiries: [email redacted] or [phone redacted]", "Event day controls apply on match days."]);
  assert.deepEqual(data.defaults, [{ on_street_parking_type: "SingleYellowLine", applies: [{ start: "2026-10-01T07:30:00Z", end: "2026-10-01T17:30:00Z" }], does_not_apply: [{ start: "2026-10-01T17:30:00Z", end: "2026-10-02T07:30:00Z" }] }]);
  const raw = await call(client, "get_zone_rules", { zone_id: fx.ZONE_CPZ, include_contact_details: true });
  assert.equal(raw.data.zone.notes[0], "Permit enquiries: permits@example.com or 020 7946 0555");
  assert.equal(raw.data.zone.name, "Northgate CPZ A (wardens 020 7946 0666)");
  const b = requests.at(-1).body;
  assert.deepEqual([Date.parse(b.endTime) - Date.parse(b.startTime), b.includeNotApplicableTimes, b.onStreetParkingTypeIds], [24 * 3600_000, false, undefined], "window defaults to 24 h; all kerb types");
});

await check("list_authorities: the entitled authorities from Traffic Data, name filter, notes redacted, the Ordnance Survey key never returned", async () => {
  const { data, text } = await call(client, "list_authorities");
  assert.equal(requests.at(-1).path, "/traffic-data/fetchAllAuthorities");
  assert.equal(requests.at(-1).body, undefined, "fetchAllAuthorities documents no request body");
  assert.deepEqual([data.count, data.total_entitled], [2, 2]);
  const ng = data.authorities[0];
  assert.deepEqual([ng.name, ng.slugs, ng.data_quality, ng.last_traffic_order_update, ng.centroid], ["Northgate Borough Council", ["northgate"], "HdPlus", "2026-09-01T09:00:00Z", { lat: 51.5195, lng: -0.1104 }]);
  assert.deepEqual(ng.notes[0], { title: "Suspensions", message: "Bay suspensions: call [phone redacted] or email [email redacted]", url: "https://example.org/parking-info", applies_to_restriction_type_ids: [11], priority: 1 });
  assert.ok(!text.includes(fx.OS_KEY) && !text.includes("ordnance") && !text.includes("test-licence"), "the Ordnance Survey key and licence are never returned");
  assert.ok(!text.includes("020 7946 0000") && !text.includes("suspensions@example.com"));
  const filtered = await call(client, "list_authorities", { query: "  RIVER " });
  assert.deepEqual(filtered.data.authorities.map((a) => a.slugs[0]), ["riverside"], "the query is trimmed");
  const rs = filtered.data.authorities[0];
  assert.deepEqual([rs.tags, rs.notes[0].title], [["pilot", "contact [phone redacted]"], "Questions? [email redacted]"], "tags and note titles are redacted by default");
  const rsRaw = await call(client, "list_authorities", { query: "riverside", include_contact_details: true });
  assert.deepEqual([rsRaw.data.authorities[0].tags[1], rsRaw.data.authorities[0].notes[0].title], ["contact 01632 960123", "Questions? tro@example.com"]);
  const withContact = await call(client, "list_authorities", { query: "northgate", include_contact_details: true });
  assert.deepEqual([withContact.data.authorities[0].notes[0].telephone, withContact.data.authorities[0].notes[0].message], ["020 7946 0000", "Bay suspensions: call 020 7946 0999 or email suspensions@example.com"]);
  assert.ok(!withContact.text.includes(fx.OS_KEY), "not even with include_contact_details");
});

await check("list_authorities (point): findAuthorityIdsByViewport with a 100 m polygon, then fetchAuthorityById; an authority outside the entitlement is listed as not accessible with AppyWay's reason", async () => {
  const n = requests.length;
  const { data } = await call(client, "list_authorities", { lat: 51.52, lng: -0.08 });
  const calls = since(n);
  assert.deepEqual(calls.map((r) => [r.path, r.body.id]), [["/explorer/findAuthorityIdsByViewport", undefined], ["/explorer/fetchAuthorityById", fx.AUTH_NORTHGATE], ["/explorer/fetchAuthorityById", fx.AUTH_EASTBRIDGE]]);
  const ring = calls[0].body.viewport.coordinates[0];
  const heightM = (ring[0][1] - ring[2][1]) * 111320;
  assert.ok(Math.abs(heightM - 100) < 1, `the point becomes a 100 m square (got ${heightM} m)`);
  assert.deepEqual(data.authorities.map((a) => a.name), ["Northgate Borough Council ([email redacted])"], "authority names are redacted by default");
  assert.deepEqual(data.authorities[0].payment_providers[0], { id: fx.PROVIDER_ID, name: "PayTest Parking", payment_url: "https://pay.example.org/northgate", app_links: { android: { schemes: ["paytest://"], package: "org.example.paytest" }, ios: { schemes: ["paytest://"] } }, has_pay_by_phone: true });
  assert.deepEqual(data.authorities[0].notes, ["Most of the borough is a controlled parking zone. Questions: [email redacted]"]);
  assert.equal(data.not_accessible[0].authority_id, fx.AUTH_EASTBRIDGE);
  assert.match(data.not_accessible[0].error, /not entitled to this authority.*No permissions to authority/);
  const withContact = await call(client, "list_authorities", { lat: 51.52, lng: -0.08, include_contact_details: true });
  assert.equal(withContact.data.authorities[0].name, "Northgate Borough Council (parking@example.com)");
});

await check("get_authority_restrictions returns the authority and the four data-document links (maxDate passed as documented) and downloads nothing", async () => {
  const n = requests.length;
  const { data, text } = await call(client, "get_authority_restrictions", { slug: "northgate", max_date: "2026-09-01T00:00:00Z" });
  assert.deepEqual(since(n).map((r) => [r.path, r.body]), [["/traffic-data/fetchFullAuthorityBySlug", { slug: "northgate" }], ["/traffic-data/fetchFullAuthorityInfoBySlug", { slug: "northgate", maxDate: "2026-09-01T00:00:00Z" }]]);
  const links = fx.snapshotInfo("northgate");
  assert.deepEqual(data.data_documents, { zones: { url: links.zonesUrl }, on_street_parking: { url: links.ospsUrl }, sets: { url: links.setsUrl }, moving_traffic_features: { url: links.mtfsUrl } });
  assert.equal(data.authority.has_boundary_shape, true);
  assert.equal(data.authority.name, "Northgate Borough Council");
  assert.ok(!text.includes(fx.OS_KEY));
  assert.ok(!text.includes("-0.13, 51.53") && !text.includes("coordinates"), "the boundary polygon is not inlined");
  await call(client, "get_authority_restrictions", { slug: "northgate" });
  assert.deepEqual(requests.at(-1).body, { slug: "northgate" }, "maxDate is left out unless given");
  const denied = await call(client, "get_authority_restrictions", { slug: "eastbridge" });
  assert.match(denied.text, /\(401\): the API key is not entitled to this authority/);
  // The docs are unclear whether a link can be a list; an inline document must never be passed on.
  const inline = { type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "Point", coordinates: [-0.11, 51.52] }, properties: { note: "call 020 7946 0999" } }] };
  arm({ method: "POST", path: "/traffic-data/fetchFullAuthorityInfoBySlug", status: 200, body: { success: true, result: { ospsUrl: ["https://cache.example.invalid/a.json", "https://cache.example.invalid/b.json"], zonesUrl: inline, setsUrl: [inline], mtfsUrl: null } } });
  const odd = await call(client, "get_authority_restrictions", { slug: "northgate" });
  disarm();
  assert.deepEqual(odd.data.data_documents.on_street_parking, { urls: ["https://cache.example.invalid/a.json", "https://cache.example.invalid/b.json"] });
  assert.match(odd.data.data_documents.zones.note, /inline data here \(an object\) instead of a URL; it is not passed on/);
  assert.match(odd.data.data_documents.sets.note, /inline data here \(a list of 1\)/);
  assert.equal(odd.data.data_documents.moving_traffic_features, undefined);
  assert.ok(!odd.text.includes("7946 0999") && !odd.text.includes("coordinates"), "inline documents are summarised, not inlined");
  const unknown = await call(client, "get_authority_restrictions", { slug: "nowhere" });
  assert.match(unknown.text, /refused the query POST \/traffic-data\/fetchFullAuthorityBySlug \(400\)\. The request is not valid\. slug: No authority with slug 'nowhere' \(NotFound\)/);
});

await check("list_reference_values maps every list to its documented endpoint (after a 429 retry that waits for Retry-After), passes localeCode and ids, redacts free text and hides pay-by-phone numbers", async () => {
  arm429(); // the one-off 429 with Retry-After: 1 on POST /reference/fetchAllVehicleTypes (checks above clear injected failures)
  const n = requests.length;
  const vehicles = await call(client, "list_reference_values", { list: "vehicle_types" });
  const tries = since(n).filter((r) => r.path === "/reference/fetchAllVehicleTypes");
  assert.equal(tries.length, 2, "retried once after the 429 (a rate-limited POST was not processed)");
  const gap = tries[1].t - tries[0].t;
  assert.ok(gap >= 1000 && gap < 1900, `retry should wait the Retry-After of 1 s, not the 2 s fallback (waited ${gap} ms)`);
  assert.equal(tries[1].body, undefined, "list endpoints document no request body");
  assert.deepEqual(vehicles.data.items.map((v) => [v.id, v.name]), [[1, "Car"], [2, "Motorcycle"], [3, "Van"]]);
  await call(client, "list_reference_values", { list: "restriction_types", locale_code: "en-GB" });
  assert.deepEqual(requests.at(-1).body, { localeCode: "en-GB" });
  await call(client, "list_reference_values", { list: "restriction_types" });
  assert.deepEqual(requests.at(-1).body, {});
  const gb = await call(client, "list_reference_values", { list: "countries", id: "GB" });
  assert.deepEqual([requests.at(-1).path, requests.at(-1).body, gb.data.item.currencyCode, gb.data.item.specialDays[0].dates], ["/reference/fetchCountryById", { id: "GB" }, "GBP", ["2026-12-25"]]);
  const regions = await call(client, "list_reference_values", { list: "regions" });
  const region = await call(client, "list_reference_values", { list: "regions", id: "region-london-test" });
  assert.deepEqual([requests.at(-1).path, requests.at(-1).body, region.data.item.name], ["/reference/fetchRegionById", { id: "region-london-test" }, "Test Region"]);
  assert.equal(regions.data.items[0].venues[0].name, "Northgate Stadium (box office [phone redacted])");
  assert.equal(regions.data.items[0].venues[0].events[0].date, "2026-10-03");
  const providers = await call(client, "list_reference_values", { list: "payment_providers" });
  assert.deepEqual([providers.data.items[0].has_pay_by_phone, providers.data.items[0].paymentsTelephone, providers.data.items[0].paymentsUrl], [true, undefined, "https://pay.example.org"]);
  const providersRaw = await call(client, "list_reference_values", { list: "payment_providers", include_contact_details: true });
  assert.equal(providersRaw.data.items[0].paymentsTelephone, "020 7946 0123");
  const permits = await call(client, "list_reference_values", { list: "permit_types", query: " badge " });
  assert.deepEqual(permits.data.items.map((p) => p.name), ["Blue Badge"]);
  const lists = ["activity_types", "authority_types", "base_maps", "countries", "entitlement_types", "exception_types", "exemption_time_types", "exemption_types", "facility_types", "fuel_types", "moving_exception_types", "moving_restriction_types", "note_visibility_types", "off_street_restriction_types", "on_street_parking_types", "payment_methods", "permitted_vehicle_types", "zone_types"];
  const m = requests.length;
  for (const list of lists) assert.ok(!(await call(client, "list_reference_values", { list })).res.isError, list);
  const referencePaths = Object.keys(spec.reference.paths).filter((p) => p.startsWith("/fetchAll"));
  const used = new Set([...since(n), ...since(m)].map((r) => r.path.replace("/reference", "")).filter((p) => p.startsWith("/fetchAll")));
  assert.deepEqual([...used].sort(), referencePaths.sort(), "every documented Reference list endpoint is reachable through the tool");
});

await check("a persistent 429 gives up after 3 attempts; a Retry-After above the cap gives up at once; HTTP-date and fractional Retry-After are honoured", async () => {
  const vt = () => since(n).filter((r) => r.path === "/reference/fetchAllVehicleTypes");
  let n = requests.length;
  arm429({ persistent: true, retryAfter: "0" });
  const persistent = await call(client, "list_reference_values", { list: "vehicle_types" });
  assert.equal(vt().length, 3, "exactly three attempts");
  assert.match(persistent.text, /AppyWay rate limit reached \(AppyWay does not document the limit\)\. Wait a minute and try again\./);
  n = requests.length;
  arm429({ retryAfter: "10.5" }); // just above the 10 s cap
  const long = await call(client, "list_reference_values", { list: "vehicle_types" });
  assert.equal(vt().length, 1, "no retry when the server asks for a wait longer than the cap");
  assert.match(long.text, /asked to wait 11 seconds before retrying POST \/reference\/fetchAllVehicleTypes \(HTTP 429\)/);
  // No Retry-After, or one that cannot be read: the 2 s fallback.
  for (const retryAfter of [null, "soon"]) {
    n = requests.length;
    arm429({ retryAfter });
    assert.ok(!(await call(client, "list_reference_values", { list: "vehicle_types" })).res.isError);
    const g = vt()[1].t - vt()[0].t;
    assert.ok(g >= 1900 && g < 3000, `Retry-After ${retryAfter}: the fallback waits 2 s (waited ${g} ms)`);
  }
  // HTTP-dates have 1 s resolution, so aim at a whole second 4 to 5 s ahead: after the first request's
  // round trip the wait is 3.5 to 5 s, clearly apart from both "retry at once" and the 2 s fallback.
  n = requests.length;
  arm429({ retryAfter: new Date(Math.ceil((Date.now() + 4000) / 1000) * 1000).toUTCString() });
  assert.ok(!(await call(client, "list_reference_values", { list: "vehicle_types" })).res.isError);
  let gap = vt()[1].t - vt()[0].t;
  assert.ok(gap >= 3000 && gap < 5600, `retry should wait until the given date (waited ${gap} ms)`);
  n = requests.length;
  arm429({ retryAfter: "1.5" }); // Date.parse("1.5") is a date in 2001, which would mean "retry now"
  assert.ok(!(await call(client, "list_reference_values", { list: "vehicle_types" })).res.isError);
  gap = vt()[1].t - vt()[0].t;
  assert.ok(gap >= 1400 && gap < 1900, `retry should wait 1.5 s (waited ${gap} ms)`);
  disarm();
});

await check("gateway errors: a GET is retried (even with an HTML body) and reported with advice after three failures; a POST query is never repeated and the message says it is safe to call again", async () => {
  arm({ method: "GET", path: "/explorer/ping", status: 502, headers: { "Retry-After": "0" }, body: "html" });
  let n = requests.length;
  const once = await call(client, "ping");
  assert.equal(once.data.sections.explorer.ok, true);
  assert.equal(since(n).filter((r) => r.path === "/explorer/ping").length, 2);
  arm({ method: "GET", path: "/explorer/ping", status: 503, times: 3, headers: { "Retry-After": "0" }, body: "html" });
  n = requests.length;
  const down = await call(client, "ping");
  assert.equal(since(n).filter((r) => r.path === "/explorer/ping").length, 3);
  assert.match(down.data.sections.explorer.error, /AppyWay returned 503 for GET \/explorer\/ping 3 times in a row\. The service may be unavailable; try again in a few minutes\.$/);
  assert.ok(!down.text.includes("<html>"));
  arm({ method: "POST", path: "/explorer/fetchZoneById", status: 502, headers: { "Retry-After": "0" }, body: "html" });
  n = requests.length;
  const post = await call(client, "get_zone_rules", { zone_id: fx.ZONE_CPZ });
  assert.ok(post.res.isError);
  assert.equal(since(n).length, 1, "exactly one POST");
  assert.match(post.text, /^AppyWay returned 502 for POST \/explorer\/fetchZoneById\. This server does not repeat a POST after a gateway error, but this call is a read-only query, so it is safe to call the tool again\.$/);
  arm({ method: "POST", path: "/explorer/fetchZoneById", status: 403 });
  n = requests.length;
  const forbidden = await call(client, "get_zone_rules", { zone_id: fx.ZONE_CPZ });
  assert.equal(since(n).length, 1, "a 403 is not retried");
  assert.match(forbidden.text, /^AppyWay refused POST \/explorer\/fetchZoneById \(403 Forbidden\)\. The key may not be enabled for the Explorer API or for this endpoint; the ping tool shows which API sections the key can reach\.$/);
  disarm();
});

await check("a 200 that is not JSON, or that says success: false, is an error; API error text is passed on with emails and phone numbers redacted", async () => {
  arm({ method: "POST", path: "/traffic-data/fetchAllAuthorities", status: 200, body: "html" });
  const html = await call(client, "list_authorities");
  assert.ok(html.res.isError);
  assert.match(html.text, /returned 200 for POST \/traffic-data\/fetchAllAuthorities but the body was not JSON \(starts with: "<html>.*Check APPYWAY_BASE_URL/);
  arm({ method: "POST", path: "/traffic-data/fetchAllAuthorities", status: 200, body: { success: false, message: "An unexpected error occurred." } });
  const unsuccessful = await call(client, "list_authorities");
  assert.match(unsuccessful.text, /^AppyWay answered POST \/traffic-data\/fetchAllAuthorities with success: false\. An unexpected error occurred\.$/);
  arm({ method: "POST", path: "/traffic-data/fetchAllAuthorities", status: 200, body: { success: false, message: "Contact jane.doe@leak.test", errors: [{ property: "p", code: "c", message: "or call +44 7700 900123" }] } });
  const leaky = await call(client, "list_authorities");
  assert.match(leaky.text, /with success: false\. Contact \[email redacted\] p: or call \[phone redacted\] \(c\)$/);
  assert.ok(!leaky.text.includes("jane.doe") && !leaky.text.includes("900123"), "a 200 success: false message is redacted like any other error");
  arm({ method: "POST", path: "/explorer/fetchZoneById", status: 400, body: { success: false, message: "The request is not valid.", errors: [{ property: "id", code: "Other", message: "Ask ops@example.com or 020 7946 0888" }] } });
  const bad = await call(client, "get_zone_rules", { zone_id: fx.ZONE_CPZ });
  assert.match(bad.text, /\(400\)\. The request is not valid\. id: Ask \[email redacted\] or \[phone redacted\] \(Other\)$/);
  disarm();
  assert.ok(!(await call(client, "list_authorities")).res.isError, "mock back to normal");
});

await check("every request carried the documented API-KEY header (and no other credential), hit a documented method+path, and every POST body validates against the documented request schema", async () => {
  const templates = Object.entries(spec).flatMap(([section, doc]) => Object.entries(doc.paths).flatMap(([p, ops]) => Object.keys(ops).map((m) => ({ section, path: p, m: m.toUpperCase(), full: `/${section}${p}` }))));
  assert.ok(requests.length > 80, `only ${requests.length} requests`);
  const used = new Set();
  for (const r of requests) {
    assert.equal(r.headers["api-key"], API_KEY, `${r.path} API-KEY header`);
    assert.equal(r.headers.authorization, undefined, "no Authorization header");
    const t = templates.find((x) => x.m === r.method && x.full === r.path);
    assert.ok(t, `undocumented call ${r.method} ${r.path}`);
    used.add(`${r.method} ${r.path}`);
    if (r.method === "POST") {
      const schema = requestSchema(t.section, t.path);
      if (!schema) assert.equal(r.body, undefined, `${r.path} documents no request body`);
      else {
        assert.equal(r.headers["content-type"], "application/json");
        validate(t.section, refName(schema), r.body, `request body of ${r.path}`);
      }
    }
  }
  const neverUsed = templates.filter((t) => !used.has(`${t.m} ${t.full}`)).map((t) => `${t.m} ${t.full}`).sort();
  // Not used on purpose: file exports and WFS (downloads), the batch/ETag variants the tools do not need, and event dates.
  assert.deepEqual(neverUsed, [
    "GET /traffic-data/exportAuthorityMovingRestrictionsById/{authorityId}.geojson",
    "GET /traffic-data/exportAuthorityRestrictionsById/{authorityId}.geojson",
    "GET /traffic-data/exportAuthorityRestrictionsBySlug/{slug}.dxf",
    "GET /traffic-data/exportAuthorityRestrictionsBySlug/{slug}.geojson",
    "GET /traffic-data/wfs",
    "POST /explorer/fetchEventDatesById",
    "POST /explorer/fetchParkingQuotesByIds",
  ]);
});
await client.close();

await check("a wrong API key gives an actionable error", async () => {
  const bad = await connect("aw-wrong-key");
  const { res, text } = await call(bad, "list_authorities");
  assert.ok(res.isError);
  assert.match(text, /^AppyWay rejected the API key \(401\) for POST \/traffic-data\/fetchAllAuthorities\. Check APPYWAY_API_KEY: it is sent in the API-KEY header/);
  const ping = await call(bad, "ping");
  assert.ok(Object.values(ping.data.sections).every((s) => !s.ok && /rejected the API key \(401\)/.test(s.error)));
  await bad.close();
});

mock.close();
console.log(`\n${passed} checks passed, ${requests.length} API calls made against the mock, in ${((Date.now() - started) / 1000).toFixed(1)} s.`);
