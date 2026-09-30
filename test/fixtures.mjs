// Fake AppyWay data shaped exactly like the published OpenAPI schemas (validated in e2e.mjs).
// Every id is an obviously fake, low-entropy GUID; places and councils are invented.
const guid = (tail) => `00000000-0000-4000-8000-${tail.padStart(12, "0")}`;

// ---- Authorities ----
export const AUTH_NORTHGATE = guid("a001"); // entitled
export const AUTH_RIVERSIDE = guid("a002"); // entitled
export const AUTH_EASTBRIDGE = guid("a003"); // NOT entitled for the test key
export const ENTITLED = new Set([AUTH_NORTHGATE, AUTH_RIVERSIDE]);
export const OS_KEY = "os-test-key-not-real"; // an Ordnance Survey key inside the Authority record: must never be returned

// Traffic Data Authority / FullAuthority.
const cmsNote = (title, message, telephone = null) => ({ noteVisibilityTypeId: 1, appliesToRestrictionTypeIds: [11], priority: 1, title, message, url: "https://example.org/parking-info", telephone });
const trafficAuthority = (id, name, slug, extra = {}) => ({
  id,
  name,
  regionId: "region-london-test",
  countryId: "GB",
  authoritySlugs: [slug],
  ordnanceSurvey: { apiKey: OS_KEY, license: "test-licence-not-real" },
  hasFreeParkingOutsideZone: false,
  timeZoneId: "Europe/London",
  privacyPolicyUrl: `https://example.org/${slug}/privacy`,
  paymentProviderId: guid("c001"),
  centroid: { latitude: 51.5195, longitude: -0.1104 },
  boundingBox: { topLeft: { latitude: 51.53, longitude: -0.13 }, bottomRight: { latitude: 51.51, longitude: -0.09 } },
  fallbackZoneId: guid("b0ff"),
  notes: [],
  tags: [],
  authorityType: 1,
  legalName: `${name} (Test)`,
  highwayAuthority: name,
  dataQuality: 2,
  lastTmoUpdate: "2026-09-01T09:00:00Z",
  reviewTerminalIds: false,
  swaCode: 5000,
  ...extra,
});
export const trafficAuthorities = [
  trafficAuthority(AUTH_NORTHGATE, "Northgate Borough Council", "northgate", {
    notes: [cmsNote("Suspensions", "Bay suspensions: call 020 7946 0999 or email suspensions@example.com", "020 7946 0000")],
    dataQuality: 1,
  }),
  trafficAuthority(AUTH_RIVERSIDE, "Riverside District Council", "riverside", {
    centroid: { latitude: 51.47, longitude: -0.2 },
    lastTmoUpdate: null,
    dataQuality: 3,
    tags: ["pilot", "contact 01632 960123"],
    notes: [cmsNote("Questions? tro@example.com", "Traffic orders are published weekly.")],
  }),
  trafficAuthority(AUTH_EASTBRIDGE, "Eastbridge City Council", "eastbridge", { centroid: { latitude: 51.52, longitude: -0.05 } }),
];
export const fullAuthority = (a) => ({
  ...a,
  shape: { type: "Polygon", coordinates: [[[-0.13, 51.53], [-0.09, 51.53], [-0.09, 51.51], [-0.13, 51.51], [-0.13, 51.53]]] },
});
// fetchFullAuthorityInfoBySlug: the endpoint says "The initial object contains only the URLs"; these are
// written from that description (see README). The host is a reserved .invalid name so nothing can fetch it.
export const snapshotInfo = (slug) => ({
  ospsUrl: `https://cache.example.invalid/${slug}/osps-2026-09-01.json`,
  zonesUrl: `https://cache.example.invalid/${slug}/zones-2026-09-01.json`,
  setsUrl: `https://cache.example.invalid/${slug}/sets-2026-09-01.json`,
  mtfsUrl: `https://cache.example.invalid/${slug}/mtfs-2026-09-01.json`,
});

// Explorer Authority.
export const PROVIDER_ID = guid("c001");
const explorerProvider = {
  id: PROVIDER_ID,
  name: "PayTest Parking",
  cardPaymentsExternalUrl: "https://pay.example.org/northgate",
  paymentsTelephone: "020 7946 0123",
  paymentsAppDeepLinks: { android: { schemas: ["paytest://"], packageName: "org.example.paytest" }, ios: { schemas: ["paytest://"], packageName: null } },
};
const point = (lng, lat) => ({ type: "GeometryCollection", geometries: [{ type: "Point", coordinates: [lng, lat] }] });
export const explorerAuthorities = {
  [AUTH_NORTHGATE]: {
    entityId: AUTH_NORTHGATE,
    name: "Northgate Borough Council (parking@example.com)",
    eTag: "etag-auth-1",
    notes: [{ message: "Most of the borough is a controlled parking zone. Questions: parking@example.com" }],
    paymentProviders: [explorerProvider],
    entityType: 4,
    countryId: "GB",
    geometry: point(-0.1104, 51.5195),
    hasFreeParkingOutsideZone: false,
  },
  [AUTH_EASTBRIDGE]: { entityId: AUTH_EASTBRIDGE, name: "Eastbridge City Council", eTag: "etag-auth-3", notes: [], paymentProviders: [], entityType: 4, countryId: "GB", geometry: point(-0.05, 51.52), hasFreeParkingOutsideZone: true },
};

// ---- Zones ----
export const ZONE_CPZ = guid("b001");
export const zones = {
  [ZONE_CPZ]: {
    entityId: ZONE_CPZ,
    name: "Northgate CPZ A (wardens 020 7946 0666)",
    eTag: "etag-zone-1",
    geometry: point(-0.111, 51.5196),
    notes: [{ message: "Permit enquiries: permits@example.com or 020 7946 0555" }, { message: "Event day controls apply on match days." }],
    authorityId: AUTH_NORTHGATE,
    zoneType: 1,
    venueId: null,
    entityType: 3,
  },
};
// ZoneSearchResult / ZoneDefaultRulesResult: single yellow lines controlled Mon-Fri 08:30-18:30.
export const zoneDefaults = [
  {
    onStreetParkingTypeId: 11,
    applicableTimes: [{ startTime: "2026-10-01T07:30:00Z", endTime: "2026-10-01T17:30:00Z", maxStay: null }],
    notApplicableTimes: [{ startTime: "2026-10-01T17:30:00Z", endTime: "2026-10-02T07:30:00Z" }],
  },
  { onStreetParkingTypeId: 1, applicableTimes: [{ startTime: "2026-10-01T07:30:00Z", endTime: "2026-10-01T17:30:00Z", maxStay: 240 }], notApplicableTimes: [] },
];
export const zoneSearchResult = { entityId: ZONE_CPZ, entityETag: "etag-zone-1", zoneType: 1, defaults: zoneDefaults, distance: 0 };

// ---- Parking entities (Explorer ParkingEntity) ----
export const ENT_BAY = guid("e001");
export const ENT_DISABLED = guid("e002");
export const ENT_SYL = guid("e003");
export const ENT_CARPARK = guid("e004");
export const ENT_LOADING = guid("e005");
export const ENT_EAST = guid("e009"); // in an authority the key is not entitled to
export const ENT_PROJECTED = guid("e00a"); // its only Point is labelled EPSG:3857

const features = (lng, lat, id) => ({
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      id,
      // The spec's Geometry schema lists only type and crs; the guide's example entity carries coordinates
      // on each geometry, which e2e.mjs allows explicitly (see README). The polygon is in EPSG:3857 as in the guide.
      geometry: {
        type: "GeometryCollection",
        geometries: [
          { type: "Point", coordinates: [lng, lat] },
          { type: "Polygon", crs: { type: "name", properties: { name: "urn:ogc:def:crs:EPSG::3857" } }, coordinates: [[[-12288.1, 6712111.2], [-12275.9, 6712118.1], [-12288.1, 6712111.2]]] },
        ],
      },
      properties: { basemap: 1 },
    },
  ],
  properties: null,
});
const entity = (entityId, name, street, lng, lat, extra = {}) => ({
  entityId,
  entityType: 1,
  name,
  eTag: `etag-${entityId.slice(-4)}`,
  address: { street, city: "Northgate", country: "UK", postcode: "NG1 1AA" },
  locationCode: `LOC${entityId.slice(-4)}`,
  totalCapacity: 4,
  zoneId: ZONE_CPZ,
  authorityId: AUTH_NORTHGATE,
  features: features(lng, lat, entityId),
  paymentMethodIds: [3, 2, 1],
  onStreetParkingTypeIds: [1],
  facilityTypeIds: [],
  venueId: null,
  ...extra,
});
export const entities = [
  entity(ENT_BAY, "Dorrington Street", "Dorrington Street", -0.110386, 51.519519),
  entity(ENT_DISABLED, "Dorrington Street disabled bay", "Dorrington Street", -0.110505, 51.519499, { onStreetParkingTypeIds: [2], totalCapacity: 1, paymentMethodIds: [] }),
  // Contact details in the name, address and location code, to prove they are redacted by default.
  entity(ENT_SYL, "Leather Lane single yellow line (enquiries 020 7946 0444)", "Leather Lane, ask lines@example.com", -0.1095, 51.5201, {
    onStreetParkingTypeIds: [11],
    totalCapacity: 6,
    paymentMethodIds: [],
    locationCode: "07700 900456",
    address: { street: "Leather Lane, ask lines@example.com", city: "Northgate +44 20 7946 0445", country: "UK (uk-desk@example.com)", postcode: "NG1 1AA" },
  }),
  entity(ENT_CARPARK, "Northgate Multi-Storey", "Saffron Hill", -0.1082, 51.5208, {
    entityType: 2,
    totalCapacity: 350,
    zoneId: null,
    onStreetParkingTypeIds: null,
    facilityTypeIds: null,
    operator: {
      id: guid("c002"),
      name: "TestPark Operators",
      cardPaymentsExternalUrl: "https://pay.example.org/testpark",
      paymentsTelephone: "0117 496 0000",
      paymentsAppDeepLinks: { android: { schemas: ["testpark://"], packageName: "org.example.testpark" } },
      telephone: "+44 20 7946 0321",
      website: "https://testpark.example.org",
    },
  }),
  entity(ENT_LOADING, "Hatton Garden loading bay", "Hatton Garden", -0.1089, 51.5199, { onStreetParkingTypeIds: [7], totalCapacity: 2, paymentMethodIds: [] }),
  entity(ENT_EAST, "Eastbridge High Street", "High Street", -0.05, 51.52, { authorityId: AUTH_EASTBRIDGE, zoneId: null }),
  entity(ENT_PROJECTED, "Projected Point Road", "Projected Point Road", 1.0, 52.0, {
    features: {
      type: "FeatureCollection",
      features: [{ type: "Feature", id: ENT_PROJECTED, geometry: { type: "GeometryCollection", geometries: [{ type: "Point", crs: { type: "name", properties: { name: "urn:ogc:def:crs:EPSG::3857" } }, coordinates: [1.0, 52.0] }] }, properties: { basemap: 1 } }],
      properties: null,
    },
  }),
];
// 120 more standard bays for the id-chunking checks (ids ...f00000000000 to ...f00000000077).
export const bulkEntities = Array.from({ length: 120 }, (_, i) =>
  entity(`00000000-0000-4000-8000-${(0xf00000000000 + i).toString(16)}`, `Test Road bay ${i + 1}`, "Test Road", -0.111 + i * 0.00001, 51.5190, { locationCode: null }),
);
export const allEntities = [...entities, ...bulkEntities];

// ---- Parking quotes (Explorer ParkingEntitySearchResult) ----
const q = (cost, extra = {}) => ({
  cost,
  currency: "GBP",
  minCost: null,
  minStayUntil: null,
  canExtendUntil: "2026-10-01T21:00:00Z",
  pricedUntil: "2026-10-01T18:00:00Z",
  noReturnUntil: null,
  freeUntil: null,
  becomesFreeAt: null,
  isFreeParking: cost === 0,
  paymentMethodIds: [3, 2, 1],
  rulesApplyUntil: "2026-10-01T17:30:00Z",
  ...extra,
});
export const BLUE_BADGE = 1; // permitTypeId in the fixture reference list below
/** Search results for the fixture entities; the disabled bay depends on the vehicle operator context. */
export function quotesFor(voc) {
  const blueBadge = Array.isArray(voc?.permits) && voc.permits.some((p) => p.permitTypeId === BLUE_BADGE);
  return [
    { entityId: ENT_BAY, entityType: 1, quotes: [q(2.54), q(1.9, { paymentMethodIds: [3], permittedContext: { vehicleTypeId: 1, activityTypeId: null, fuelTypeId: 4, permits: null, co2Emissions: null, vehicleYear: null, engineSize: null } })], distance: 12.4, parkingAllowed: 1, entityETag: "etag-e001" },
    blueBadge
      ? { entityId: ENT_DISABLED, entityType: 1, quotes: [q(0, { permittedContext: { vehicleTypeId: null, activityTypeId: null, fuelTypeId: null, permits: [{ permitTypeId: BLUE_BADGE }], co2Emissions: null, vehicleYear: null, engineSize: null } })], distance: 18.9, parkingAllowed: 1, entityETag: "etag-e002" }
      : { entityId: ENT_DISABLED, entityType: 1, quotes: [], distance: 18.9, parkingAllowed: 3, entityETag: "etag-e002" },
    { entityId: ENT_SYL, entityType: 1, quotes: [q(0, { freeUntil: "2026-10-01T07:30:00Z", pricedUntil: null, paymentMethodIds: [] })], distance: 40.2, parkingAllowed: 2, entityETag: "etag-e003" },
    { entityId: ENT_CARPARK, entityType: 2, quotes: [q(6.5, { minCost: 3, minStayUntil: "2026-10-01T18:00:00Z" })], distance: 95.7, parkingAllowed: 1, entityETag: "etag-e004" },
    { entityId: ENT_LOADING, entityType: 1, quotes: [], distance: 120.3, parkingAllowed: 3, entityETag: "etag-e005" },
  ];
}

// ---- Operating hours (ParkingEntityOperatingHoursResult) and payment providers ----
// closedPeriods only when the query sets includeClosedPeriods ("Include closed periods that apply for the
// given context"); the car park is closed overnight on the date asked for.
export const operatingHours = (entityId, date, includeClosedPeriods = false) => ({
  entityId,
  entityType: entityId === ENT_CARPARK ? 2 : 1,
  entityETag: `etag-${entityId.slice(-4)}`,
  timeZoneId: "Europe/London",
  operatingHours: [
    {
      paymentMethodIds: [3, 2, 1],
      openPeriods: [
        { start: "00:00:00", end: "08:30:00", date, status: 1 },
        { start: "08:30:00", end: "18:30:00", date, status: 2 },
        { start: "18:30:00", end: "23:59:59", date, status: 1 },
      ],
    },
  ],
  notApplicableOperatingHours: null,
  applicableOperatingHoursDetail: null,
  closedPeriods: includeClosedPeriods ? (entityId === ENT_CARPARK ? [{ start: `${date}T00:00:00`, end: `${date}T06:00:00` }] : []) : null,
});
export const paymentProviders = { [ENT_BAY]: [explorerProvider], [ENT_CARPARK]: [{ ...explorerProvider, id: guid("c002"), name: "TestPark Operators", paymentsTelephone: null }] };

// ---- Reference lists ----
export const reference = {
  "/fetchAllVehicleTypes": [
    { id: 1, name: "Car", description: "A standard car" },
    { id: 2, name: "Motorcycle", description: "A motorcycle or scooter" },
    { id: 3, name: "Van", description: "A light goods vehicle" },
  ],
  "/fetchAllPermitTypes": [
    { id: BLUE_BADGE, name: "Blue Badge", description: "Disabled person's badge" },
    { id: 2, name: "Car Club", description: "Car club permit" },
  ],
  "/fetchAllFuelTypes": [
    { id: 1, name: "Petrol", description: "Petrol" },
    { id: 4, name: "Electric", description: "Battery electric" },
  ],
  "/fetchAllRestrictionTypes": [
    { id: 11, name: "Single Yellow Line", description: "No waiting during controlled hours", code: "SYL", canHaveNoLoadingRules: true, canHavePermits: false, canHaveTariff: false, canHaveEmptyEntitlements: false, defaultWidth: 0.1, isTroItem: true, legalName: "No waiting", hasBayCount: false, validOrderTypes: [1] },
  ],
  "/fetchAllPaymentProviders": [
    { id: PROVIDER_ID, name: "PayTest Parking", paymentsUrl: "https://pay.example.org", paymentsTelephone: "020 7946 0123", paymentsAppDeepLinks: { android: { schemas: ["paytest://"], packageName: "org.example.paytest" } } },
  ],
  "/fetchAllCountries": [
    {
      id: "GB",
      name: "United Kingdom",
      specialDays: [{ id: "xmas", name: "Christmas Day", isHoliday: true, dates: ["2026-12-25"] }],
      bounds: [[-8.6, 49.9], [1.8, 60.9]],
      defaultBaseMapId: 1,
      entitlementTypes: [1, 2],
      restrictionTypes: [11],
      assetTypes: [],
      countryCode: "GB",
      currencyCode: "GBP",
      languageCode: "en",
      hasMetricSpeedLimits: false,
    },
  ],
  "/fetchAllRegions": [
    { id: "region-london-test", countryId: "GB", name: "Test Region", venues: [{ id: "venue-1", name: "Northgate Stadium (box office 020 7946 0777)", eventsMustSupplyHours: false, events: [{ name: "Cup match", date: "2026-10-03", start: "15:00:00", end: "17:00:00" }] }] },
  ],
};
