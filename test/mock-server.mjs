// Local stand-in for api.appyway.com/v1/{explorer,traffic-data,reference}, serving the fixtures.
// The API has no pagination: every documented endpoint answers in one response.
import http from "node:http";
import * as fx from "./fixtures.mjs";

export const API_KEY = "aw-test-key-not-real";

// Error bodies. BadRequestResponse and NotFoundResponse are the specs' schemas; the 401 for an authority
// outside the key's entitlement is the getting-started guide's example, with a fixture GUID. The specs
// document 401, 403 and 429 with a description only (no body), so the mock sends those without a body.
const badRequest = (errors, message = "The request is not valid.") => ({ success: false, message, errors });
const notFound = (message) => ({ success: false, message });
const noPermission = (authorityId) => badRequest([{ property: "authority", message: `No permissions to authority ‘{${authorityId.toUpperCase()}}’` }]);
const ok = (result) => ({ success: true, result });

const inBox = (e, box) => {
  const p = e.features?.features?.[0]?.geometry?.geometries?.find((g) => g.type === "Point")?.coordinates;
  return p && p[0] >= box.west && p[0] <= box.east && p[1] >= box.south && p[1] <= box.north;
};
const boxOfPolygon = (poly) => {
  const ring = poly?.coordinates?.[0] ?? [];
  const xs = ring.map((c) => c[0]);
  const ys = ring.map((c) => c[1]);
  return { west: Math.min(...xs), east: Math.max(...xs), south: Math.min(...ys), north: Math.max(...ys) };
};
const boxOfCentre = (c, size) => {
  const dLat = size / 2 / 111320;
  const dLng = size / 2 / (111320 * Math.cos((c.lat * Math.PI) / 180));
  return { west: c.lng - dLng, east: c.lng + dLng, south: c.lat - dLat, north: c.lat + dLat };
};

export function startMock() {
  const requests = [];
  // Injected failures: { method, path, status, times, headers, body }. body undefined = no body (as the
  // specs document 401/403/429); body "html" = a gateway-style HTML page.
  const failure429 = () => ({ method: "POST", path: "/reference/fetchAllVehicleTypes", status: 429, times: 1, headers: { "Retry-After": "1" } });
  let failures = [failure429()];

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname.replace(/^\/v1(?=\/)/, "");
    let raw = "";
    for await (const chunk of req) raw += chunk;
    let body;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      body = { unparsable: raw };
    }
    requests.push({ method: req.method, path, query: Object.fromEntries(url.searchParams), headers: { ...req.headers }, body, t: Date.now() });

    const send = (status, json, headers = {}) => {
      res.writeHead(status, { "Content-Type": "application/json", ...headers });
      res.end(json === undefined ? "" : JSON.stringify(json));
    };
    if (req.headers["api-key"] !== API_KEY) return send(401, undefined);

    const failure = failures.find((f) => f.times > 0 && f.method === req.method && f.path === path);
    if (failure) {
      failure.times--;
      if (failure.body === "html") {
        res.writeHead(failure.status, { "Content-Type": "text/html", ...(failure.headers ?? {}) });
        return res.end(`<html><body><h1>${failure.status}</h1></body></html>`);
      }
      return send(failure.status, failure.body, failure.headers ?? {});
    }

    const m = req.method;
    const b = body ?? {};
    if (m === "GET" && /^\/(explorer|traffic-data|reference)\/ping$/.test(path)) return send(200, ok("pong"));
    if (m !== "POST") return send(404, notFound(`No route for ${m} ${path}`));

    // ---- Explorer ----
    const window = () => (!b.startTime ? badRequest([{ property: "startTime", code: "Required", message: "startTime is required" }]) : undefined);
    const tooBig = (size) => (size * size > 1.5e6 ? badRequest([{ property: "viewportSize", code: "Range", message: "Viewport limited to 1.5 km2" }]) : undefined);
    const withDistance = (list, box) => list.filter((e) => inBox(e, box));
    const applyQuoteFilters = (results) => {
      const f = b.filters ?? {};
      return results.filter((r) => {
        if (f.excludeEntityTypes?.includes(r.entityType)) return false;
        if (f.excludeNoParking && r.parkingAllowed === 3) return false;
        if (f.excludeTruncatedParking && r.parkingAllowed === 2) return false;
        const cost = r.quotes[0]?.cost;
        if (f.excludePaidParking && r.quotes.length && !r.quotes[0].isFreeParking) return false;
        if (f.excludeFreeParking && r.quotes.length && r.quotes[0].isFreeParking) return false;
        if (!f.excludePaidParking && f.excludeCostGreaterThan !== undefined && cost !== undefined && cost > f.excludeCostGreaterThan) return false;
        return true;
      });
    };
    switch (path) {
      case "/explorer/findParkingQuotesByCentreAndViewportSize":
      case "/explorer/findParkingQuotesByViewport": {
        const err = window() ?? (path.endsWith("Size") ? tooBig(b.viewportSize ?? 0) : undefined);
        if (err) return send(400, err);
        const box = path.endsWith("Size") ? boxOfCentre(b.viewportCenter, b.viewportSize) : boxOfPolygon(b.viewport);
        const ids = new Set(withDistance(fx.entities, box).map((e) => e.entityId));
        const parking = applyQuoteFilters(fx.quotesFor(b.vehicleOperatorContext).filter((r) => ids.has(r.entityId)));
        const start = new Date(b.startTime).toISOString().replace(".000Z", "Z");
        const minutes = b.endTime ? Math.round((Date.parse(b.endTime) - Date.parse(b.startTime)) / 60000) : 60;
        const days = Math.floor(minutes / 1440);
        const duration = `${days ? days + "." : ""}${String(Math.floor((minutes % 1440) / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}:00`; // .NET TimeSpan "[d.]hh:mm:ss"
        return send(200, ok({ requestedStartTime: start, requestedDuration: duration, parking, generalOnstreetPolicy: 2 }));
      }
      case "/explorer/findParkingEntitiesByCentreAndViewportSize":
      case "/explorer/findParkingEntitiesByViewport": {
        const err = path.endsWith("Size") ? tooBig(b.viewportSize ?? 0) : undefined;
        if (err) return send(400, err);
        const box = path.endsWith("Size") ? boxOfCentre(b.viewportCenter, b.viewportSize) : boxOfPolygon(b.viewport);
        const types = b.onStreetParkingTypes;
        const found = withDistance(fx.allEntities, box)
          .filter((e) => !b.filters?.excludeEntityTypes?.includes(e.entityType))
          .filter((e) => !types || (e.entityType === 1 && e.onStreetParkingTypeIds?.some((t) => types.includes(t))));
        return send(200, ok({ entities: found.map((entity, i) => ({ entity, distance: 10 + i * 5 })) }));
      }
      case "/explorer/findZoneDefaultRulesByViewport": {
        const err = window();
        if (err) return send(400, err);
        return send(200, ok({ zones: [fx.zoneSearchResult], zoneContainingLocation: fx.zoneSearchResult }));
      }
      case "/explorer/fetchEntitiesByIds": {
        const ids = b.ids ?? [];
        return send(200, ok({
          parkingEntities: fx.allEntities.filter((e) => ids.includes(e.entityId)),
          zones: Object.values(fx.zones).filter((z) => ids.includes(z.entityId)),
          authorities: Object.values(fx.explorerAuthorities).filter((a) => ids.includes(a.entityId)),
        }));
      }
      case "/explorer/fetchParkingEntityById": {
        const e = fx.allEntities.find((x) => x.entityId === b.id);
        if (!e) return send(404, notFound("Parking entity not found."));
        if (!fx.ENTITLED.has(e.authorityId)) return send(401, noPermission(e.authorityId));
        return send(200, ok(e));
      }
      case "/explorer/fetchOperatingHoursById": {
        const e = fx.allEntities.find((x) => x.entityId === b.entityId);
        if (!e) return send(404, notFound("Parking entity not found."));
        return send(200, ok(fx.operatingHours(e.entityId, b.date ?? "2026-10-01", b.includeClosedPeriods === true)));
      }
      case "/explorer/fetchOperatingHoursByIds":
        return send(200, ok((b.ids ?? []).filter((id) => fx.allEntities.some((e) => e.entityId === id)).map((id) => fx.operatingHours(id, b.date ?? "2026-10-01", b.includeClosedPeriods === true))));
      case "/explorer/fetchPaymentProvidersByParkingEntityId": {
        const e = fx.allEntities.find((x) => x.entityId === b.entityId);
        if (!e) return send(404, notFound("Parking entity not found."));
        return send(200, ok({ paymentProviders: fx.paymentProviders[e.entityId] ?? [] }));
      }
      case "/explorer/fetchParkingQuoteById": {
        const err = window();
        if (err) return send(400, err);
        const r = fx.quotesFor(b.vehicleOperatorContext).find((x) => x.entityId === b.entityId);
        if (!r) return send(404, notFound("Parking entity not found."));
        return send(200, ok({ ...r, distance: null }));
      }
      case "/explorer/fetchZoneById": {
        const z = fx.zones[b.id];
        return z ? send(200, ok(z)) : send(404, notFound("Zone not found."));
      }
      case "/explorer/fetchZoneDefaultRulesById": {
        // The spec documents 200 and 400 (no 404) for this endpoint.
        const err = window();
        if (err) return send(400, err);
        if (!fx.zones[b.id]) return send(400, badRequest([{ property: "id", code: "NotFound", message: "Zone not found" }]));
        const types = b.onStreetParkingTypeIds;
        const defaults = fx.zoneDefaults
          .filter((d) => !types || types.includes(d.onStreetParkingTypeId))
          .map((d) => (b.includeNotApplicableTimes ? d : { ...d, notApplicableTimes: [] }));
        return send(200, ok({ entityId: b.id, entityETag: "etag-zone-1", zoneType: 1, defaults }));
      }
      case "/explorer/findAuthorityIdsByViewport": {
        const box = boxOfPolygon(b.viewport);
        const hits = [fx.AUTH_NORTHGATE, fx.AUTH_EASTBRIDGE].filter((id) => {
          const a = fx.trafficAuthorities.find((x) => x.id === id);
          return a.centroid.longitude >= box.west - 0.05 && a.centroid.longitude <= box.east + 0.05 && a.centroid.latitude >= box.south - 0.05 && a.centroid.latitude <= box.north + 0.05;
        });
        return send(200, ok({ authorities: hits.map((id) => ({ entityId: id, countryId: "GB", entityETag: `etag-${id.slice(-4)}` })) }));
      }
      case "/explorer/fetchAuthorityById": {
        const a = fx.explorerAuthorities[b.id];
        if (!a) return send(404, notFound("Authority not found."));
        if (!fx.ENTITLED.has(b.id)) return send(401, noPermission(b.id));
        return send(200, ok(a));
      }
    }

    // ---- Traffic Data ----
    const bySlug = () => fx.trafficAuthorities.find((a) => a.authoritySlugs.includes(b.slug));
    switch (path) {
      case "/traffic-data/fetchAllAuthorities":
        // "Fetch basic authority information for all authorities that you are entitled to access."
        return send(200, ok(fx.trafficAuthorities.filter((a) => fx.ENTITLED.has(a.id))));
      case "/traffic-data/fetchFullAuthorityBySlug":
      case "/traffic-data/fetchFullAuthorityInfoBySlug": {
        // The spec documents 200 and 400 (no 404) for these endpoints.
        const a = bySlug();
        if (!a) return send(400, badRequest([{ property: "slug", code: "NotFound", message: `No authority with slug '${b.slug}'` }]));
        if (!fx.ENTITLED.has(a.id)) return send(401, noPermission(a.id));
        return send(200, ok(path.endsWith("InfoBySlug") ? fx.snapshotInfo(b.slug) : fx.fullAuthority(a)));
      }
    }

    // ---- Reference ----
    if (path.startsWith("/reference/")) {
      const p = path.slice("/reference".length);
      if (p === "/fetchCountryById" || p === "/fetchRegionById") {
        const list = fx.reference[p === "/fetchCountryById" ? "/fetchAllCountries" : "/fetchAllRegions"];
        const item = list.find((x) => x.id === b.id);
        // The spec documents 200 and 400 (no 404) for these endpoints.
        return item ? send(200, ok(item)) : send(400, badRequest([{ property: "id", code: "NotFound", message: "Not found" }]));
      }
      if (/^\/fetchAll\w+$/.test(p)) return send(200, ok(fx.reference[p] ?? []));
    }
    return send(404, notFound(`No route for ${m} ${path}`));
  });

  /** Queue a failure for the next `times` requests matching method+path (path includes the section, e.g. /explorer/fetchZoneById). */
  const arm = ({ method, path, status, times = 1, headers, body }) => {
    failures.push({ method, path, status, times, headers, body });
  };
  // retryAfter null sends the 429 without a Retry-After header.
  const arm429 = ({ persistent = false, retryAfter = "1" } = {}) => {
    failures = [{ ...failure429(), times: persistent ? Infinity : 1, headers: retryAfter === null ? {} : { "Retry-After": retryAfter } }];
  };
  const disarm = () => {
    failures = [];
  };
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, requests, arm, arm429, disarm })));
}
