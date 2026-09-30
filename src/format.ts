// Turn AppyWay API records into compact objects an assistant can read quickly.
// Field names follow the schemas in AppyWay's three OpenAPI documents (Explorer, Traffic Data,
// Reference); the enum names below are copied from the "*Name (n) - ..." lists in those schemas'
// descriptions, and the test suite checks them against the spec.

type Rec = Record<string, any>;

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Phone-number-like sequences, a heuristic (the same one as the other servers in this series). Three
// shapes, digits optionally separated by a space, dot or hyphen:
//   international: "+" or "00", a 1-3 digit country code, an optional "(0)" trunk prefix, then 6-14
//     digits (+44 7700 900123, +447700900321, +44 (0)7700 900123, 0044 20 7946 0958);
//   bracketed UK area code: "(0...)" then 5-10 digits ((020) 7946 0958, (0117) 496 0000);
//   UK national: "0" then 8-10 more digits (07700 900789, 020 7946 0958, 07700.900123).
// Bounded by characters other than letters, digits, "_" and "-", so GUIDs, ETags, timestamps and
// hyphenated references are left alone. Any other 9-11 digit string starting with 0 is redacted too;
// the raw text is available with include_contact_details.
const PHONE = /(?<![\w-])(?:(?:\+|00)[ .-]?[1-9]\d{0,2}(?:[ .-]?\(0\))?(?:[ .-]?\d){6,14}|\(0\d{0,4}\)(?:[ .-]?\d){5,10}|0(?:[ .-]?\d){8,10})(?![\w-])/g;

const redactString = (text: string) => text.replace(EMAIL, "[email redacted]").replace(PHONE, "[phone redacted]");

/**
 * Replace email addresses and phone-number-like sequences inside free text (notes, names, addresses, error
 * messages) unless contact details were requested.
 */
export function redactContacts(text: unknown, includeContact: boolean): string | undefined {
  if (typeof text !== "string") return undefined;
  if (text === "") return undefined;
  return includeContact ? text : redactString(text);
}

const str = (v: unknown) => (v === undefined || v === null || v === "" ? undefined : String(v));
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const ints = (v: unknown) => (Array.isArray(v) ? v.filter((x) => Number.isInteger(x)) : undefined);

// ---- Enums (Explorer spec descriptions) ----
export const MAP_ENTITY_TYPES: Record<number, string> = { 1: "OnStreet", 2: "Carpark", 3: "Zone", 4: "Authority" };
export const PARKING_ALLOWED: Record<number, string> = { 1: "FullSession", 2: "TruncatedSession", 3: "NoParking" };
export const GENERAL_ONSTREET_POLICY: Record<number, string> = { 1: "Restricted", 2: "LikelyRestricted", 3: "LikelyUnrestricted", 4: "Unknown" };
export const ON_STREET_PARKING_TYPES: Record<number, string> = {
  1: "StandardBay", 2: "DisabledBay", 3: "MotorcycleBay", 4: "ElectricBay", 5: "CarClubBay", 6: "CoachBay", 7: "LoadingBay", 8: "TaxiBay",
  9: "ResidentBay", 10: "SpecialBay", 11: "SingleYellowLine", 12: "DoubleYellowLine", 13: "SingleRedLine", 14: "DoubleRedLine",
  15: "SingleYellowKerbMark", 16: "DoubleYellowKerbMark", 17: "KeepClearLine", 18: "DroppedKerbDriveway", 19: "RedRouteBay", 20: "BusStop",
  21: "BusinessBay", 22: "DoctorBay", 23: "HospitalBay", 24: "MarketTraderBay", 25: "HotelBay", 26: "PoliceBay", 27: "RnliBay",
  28: "SupremeCourtBay", 29: "AmbulanceBay", 30: "CycleHireBay", 31: "CycleHangar", 32: "AdvisorySchoolKeepClearLine", 33: "MobileLibraryBay",
  34: "DiplomatBay", 35: "FireBrigade", 36: "CycleRack", 37: "SchoolKeepClearLine", [-1]: "None",
};
export const ZONE_TYPES: Record<number, string> = {
  1: "ControlledParkingZone", 2: "RestrictedParkingZone", 3: "FreeParking", 4: "Private", 5: "CongestionCharge", 7: "Container",
  8: "ResidentsParkingScheme", 9: "PermitParkingArea", 10: "PedestrianZone",
};
export const OPEN_PERIOD_STATUS: Record<number, string> = { 1: "Free", 2: "Paid", 3: "Mixed" };
// Traffic Data spec, DataQuality.
export const DATA_QUALITY: Record<number, string> = { 1: "HdPlus", 2: "Hd", 3: "Md", 4: "Sd" };

const named = (map: Record<number, string>, v: unknown) => (typeof v === "number" ? map[v] ?? `unknown (${v})` : undefined);
const namedList = (map: Record<number, string>, v: unknown) => (Array.isArray(v) ? v.map((x) => named(map, x)) : undefined);

/**
 * A .NET TimeSpan string as documented in AppyWay's getting-started guide: "[-][d.]hh:mm:ss[.fffffff]".
 * Returns the length in seconds, or undefined for anything else.
 */
export function parseTimeSpan(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const m = /^(-)?(?:(\d+)\.)?(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,7}))?$/.exec(value.trim());
  if (!m) return undefined;
  const [, neg, d, h, mi, s, frac] = m;
  if (Number(h) > 23 || Number(mi) > 59 || Number(s) > 59) return undefined;
  const total = Number(d ?? 0) * 86400 + Number(h) * 3600 + Number(mi) * 60 + Number(s) + (frac ? Number(`0.${frac}`) : 0);
  return neg ? -total : total;
}

/** A TimeSpan as the raw string plus its length in minutes (rounded to 0.01). */
export function timeSpan(value: unknown) {
  const seconds = parseTimeSpan(value);
  if (value === undefined || value === null || value === "") return undefined;
  return { raw: String(value), minutes: seconds === undefined ? undefined : Math.round((seconds / 60) * 100) / 100 };
}

// ---- Explorer ----

export function vehicleOperatorContext(c: Rec | null | undefined) {
  if (!c || typeof c !== "object") return undefined;
  const out = {
    vehicle_type_id: num(c.vehicleTypeId),
    activity_type_id: num(c.activityTypeId),
    fuel_type_id: num(c.fuelTypeId),
    permit_type_ids: Array.isArray(c.permits) ? c.permits.map((p: Rec) => num(p?.permitTypeId)).filter((x: unknown) => x !== undefined) : undefined,
    co2_emissions: num(c.co2Emissions),
    vehicle_year: num(c.vehicleYear),
    engine_size: num(c.engineSize),
  };
  return Object.values(out).some((v) => v !== undefined && !(Array.isArray(v) && v.length === 0)) ? out : undefined;
}

export function quote(q: Rec) {
  return {
    cost: num(q.cost),
    currency: str(q.currency),
    is_free: typeof q.isFreeParking === "boolean" ? q.isFreeParking : undefined,
    min_cost: num(q.minCost),
    min_stay_until: str(q.minStayUntil),
    priced_until: str(q.pricedUntil),
    can_extend_until: str(q.canExtendUntil),
    no_return_until: str(q.noReturnUntil),
    free_until: str(q.freeUntil),
    becomes_free_at: str(q.becomesFreeAt),
    rules_apply_until: str(q.rulesApplyUntil),
    payment_method_ids: ints(q.paymentMethodIds),
    only_for: vehicleOperatorContext(q.permittedContext),
  };
}

export function searchResult(r: Rec) {
  return {
    entity_id: str(r.entityId),
    entity_type: named(MAP_ENTITY_TYPES, r.entityType),
    parking_allowed: named(PARKING_ALLOWED, r.parkingAllowed),
    distance_m: num(r.distance) !== undefined ? Math.round(r.distance) : undefined,
    quotes: Array.isArray(r.quotes) ? r.quotes.map(quote) : [],
  };
}

// Only a point in WGS84 is returned: a "Point" geometry with no CRS, or one that names EPSG:4326 /
// CRS84. The guide's example entity has an unmarked Point and a Polygon in EPSG:3857 (web-mercator
// metres); shapes and projected coordinates are left out rather than mislabelled.
const WGS84 = /(EPSG:?:?4326|CRS84)$/i;
function geometriesOf(e: Rec): Rec[] {
  const out: Rec[] = [];
  const add = (g: Rec | undefined) => {
    if (!g || typeof g !== "object") return;
    if (Array.isArray(g.geometries)) g.geometries.forEach(add);
    else out.push(g);
  };
  add(e.geometry);
  if (Array.isArray(e.features?.features)) for (const f of e.features.features) add(f?.geometry);
  return out;
}
export function pointOf(e: Rec): { lat: number; lng: number } | undefined {
  for (const g of geometriesOf(e)) {
    const crs = g.crs?.properties?.name;
    if (g.type !== "Point" || !Array.isArray(g.coordinates) || (crs && !WGS84.test(crs))) continue;
    const [lng, lat] = g.coordinates;
    if (typeof lat === "number" && typeof lng === "number" && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return { lat, lng };
  }
  return undefined;
}

// Payment providers and car park operators are businesses, but their telephone numbers are still
// contact details: returned only with include_contact_details. Card-payment and app links are the
// provider's own public pages, not anyone's payment data.
// paymentsAppDeepLinks is documented as a map "by platform" of {schemas, packageName}; the platform
// keys are not listed in the spec, so they are passed on as given.
function appLinks(v: unknown) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out: Rec = {};
  for (const [platform, link] of Object.entries(v as Rec)) {
    if (!link || typeof link !== "object") continue;
    out[platform] = {
      schemes: Array.isArray(link.schemas) ? link.schemas.filter((x: unknown) => typeof x === "string") : undefined,
      package: str(link.packageName),
    };
  }
  return Object.keys(out).length ? out : undefined;
}

export function paymentProvider(p: Rec, includeContact: boolean) {
  return {
    id: str(p.id),
    name: redactContacts(p.name, includeContact),
    payment_url: str(p.cardPaymentsExternalUrl ?? p.paymentsUrl),
    app_links: appLinks(p.paymentsAppDeepLinks),
    ...(includeContact ? { payments_telephone: str(p.paymentsTelephone) } : { has_pay_by_phone: p.paymentsTelephone ? true : undefined }),
  };
}

export function carParkOperator(o: Rec | null | undefined, includeContact: boolean) {
  if (!o || typeof o !== "object") return undefined;
  return {
    ...paymentProvider(o, includeContact),
    website: str(o.website),
    ...(includeContact ? { telephone: str(o.telephone) } : {}),
  };
}

export function parkingEntity(e: Rec, includeContact: boolean) {
  return {
    entity_id: str(e.entityId),
    entity_type: named(MAP_ENTITY_TYPES, e.entityType),
    name: redactContacts(e.name, includeContact),
    // Address lines and the location code are free text as far as the schema says ("Street address",
    // "Town or city", ...), so they get the same redaction as names and notes.
    address:
      e.address && typeof e.address === "object"
        ? {
            street: redactContacts(e.address.street, includeContact),
            city: redactContacts(e.address.city, includeContact),
            postcode: redactContacts(e.address.postcode, includeContact),
            country: redactContacts(e.address.country, includeContact),
          }
        : undefined,
    location: pointOf(e),
    on_street_parking_types: namedList(ON_STREET_PARKING_TYPES, e.onStreetParkingTypeIds),
    total_capacity: num(e.totalCapacity),
    facility_type_ids: ints(e.facilityTypeIds),
    payment_method_ids: ints(e.paymentMethodIds),
    // The payment provider's code for the entity (typically a few digits); only something shaped like a
    // phone number or an email is redacted, and the raw value comes back with include_contact_details.
    location_code: redactContacts(e.locationCode, includeContact),
    zone_id: str(e.zoneId),
    authority_id: str(e.authorityId),
    venue_id: str(e.venueId),
    operator: carParkOperator(e.operator, includeContact),
    etag: str(e.eTag),
  };
}

export const notes = (list: unknown, includeContact: boolean) =>
  Array.isArray(list) ? list.map((n: Rec) => redactContacts(n?.message, includeContact)).filter((x) => x !== undefined) : undefined;

export function zone(z: Rec, includeContact: boolean) {
  return {
    zone_id: str(z.entityId),
    name: redactContacts(z.name, includeContact),
    zone_type: named(ZONE_TYPES, z.zoneType),
    authority_id: str(z.authorityId),
    venue_id: str(z.venueId),
    notes: notes(z.notes, includeContact),
    etag: str(z.eTag),
  };
}

export function zoneDefault(d: Rec) {
  return {
    on_street_parking_type: named(ON_STREET_PARKING_TYPES, d.onStreetParkingTypeId),
    applies: Array.isArray(d.applicableTimes) ? d.applicableTimes.map((t: Rec) => ({ start: str(t.startTime), end: str(t.endTime), max_stay: num(t.maxStay) })) : [],
    does_not_apply: Array.isArray(d.notApplicableTimes) ? d.notApplicableTimes.map((t: Rec) => ({ start: str(t.startTime), end: str(t.endTime) })) : undefined,
  };
}

export function zoneRules(r: Rec) {
  return {
    zone_id: str(r.entityId),
    zone_type: named(ZONE_TYPES, r.zoneType),
    distance_m: num(r.distance) !== undefined ? Math.round(r.distance) : undefined,
    defaults: Array.isArray(r.defaults) ? r.defaults.map(zoneDefault) : [],
  };
}

const openPeriod = (p: Rec) => ({ date: str(p.date), start: str(p.start), end: str(p.end), status: named(OPEN_PERIOD_STATUS, p.status) });

export function operatingHours(r: Rec) {
  return {
    entity_id: str(r.entityId),
    time_zone: str(r.timeZoneId),
    hours: Array.isArray(r.operatingHours)
      ? r.operatingHours.map((h: Rec) => ({ payment_method_ids: ints(h.paymentMethodIds), only_for: vehicleOperatorContext(h.permittedContext), open_periods: Array.isArray(h.openPeriods) ? h.openPeriods.map(openPeriod) : [] }))
      : [],
    closed_periods: Array.isArray(r.closedPeriods) ? r.closedPeriods.map((p: Rec) => ({ start: str(p.start), end: str(p.end) })) : undefined,
  };
}

// Explorer Authority (fetchAuthorityById, fetchEntitiesByIds).
export function explorerAuthority(a: Rec, includeContact: boolean) {
  return {
    authority_id: str(a.entityId),
    name: redactContacts(a.name, includeContact),
    country_id: str(a.countryId),
    has_free_parking_outside_zone: typeof a.hasFreeParkingOutsideZone === "boolean" ? a.hasFreeParkingOutsideZone : undefined,
    notes: notes(a.notes, includeContact),
    payment_providers: Array.isArray(a.paymentProviders) ? a.paymentProviders.map((p: Rec) => paymentProvider(p, includeContact)) : undefined,
  };
}

// ---- Traffic Data ----

// NoteCms: title, message and url are free text or links; the telephone field is a contact detail.
export function cmsNote(n: Rec, includeContact: boolean) {
  return {
    title: redactContacts(n.title, includeContact),
    message: redactContacts(n.message, includeContact),
    url: str(n.url),
    applies_to_restriction_type_ids: ints(n.appliesToRestrictionTypeIds),
    priority: num(n.priority),
    ...(includeContact ? { telephone: str(n.telephone) } : {}),
  };
}

const latLng = (p: Rec | null | undefined) => (p && typeof p === "object" && typeof p.latitude === "number" && typeof p.longitude === "number" ? { lat: p.latitude, lng: p.longitude } : undefined);

/**
 * Traffic Data Authority / FullAuthority. The ordnanceSurvey object carries an Ordnance Survey API key
 * and licence; it is never returned. capabilities / capabilitiesState are AppyWay's own display flags
 * and are left out as noise.
 */
export function authority(a: Rec, includeContact: boolean) {
  return {
    id: str(a.id),
    name: redactContacts(a.name, includeContact),
    legal_name: redactContacts(a.legalName, includeContact),
    slugs: Array.isArray(a.authoritySlugs) ? a.authoritySlugs.filter((s: unknown) => typeof s === "string") : undefined,
    authority_type: num(a.authorityType),
    highway_authority: redactContacts(a.highwayAuthority, includeContact),
    region_id: str(a.regionId),
    country_id: str(a.countryId),
    time_zone: str(a.timeZoneId),
    has_free_parking_outside_zone: typeof a.hasFreeParkingOutsideZone === "boolean" ? a.hasFreeParkingOutsideZone : undefined,
    data_quality: named(DATA_QUALITY, a.dataQuality),
    last_traffic_order_update: str(a.lastTmoUpdate),
    default_payment_provider_id: str(a.paymentProviderId),
    fallback_zone_id: str(a.fallbackZoneId),
    centroid: latLng(a.centroid),
    bounding_box: a.boundingBox ? { top_left: latLng(a.boundingBox.topLeft), bottom_right: latLng(a.boundingBox.bottomRight) } : undefined,
    privacy_policy_url: str(a.privacyPolicyUrl),
    tags: Array.isArray(a.tags) ? a.tags.map((t: unknown) => redactContacts(t, includeContact)).filter((x: unknown) => x !== undefined) : undefined,
    notes: Array.isArray(a.notes) ? a.notes.map((n: Rec) => cmsNote(n, includeContact)) : undefined,
  };
}

/**
 * One of the four data-document links in fetchFullAuthorityInfoBySlug. The endpoint description says
 * "The initial object contains only the URLs", while the published schema describes the documents
 * behind them; a URL (or a list of URLs) is passed on, anything else is summarised and never inlined.
 */
export function documentLink(v: unknown): { url?: string; urls?: string[]; note?: string } | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v === "string") return { url: v };
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) return { urls: v as string[] };
  return { note: `AppyWay returned inline data here (${Array.isArray(v) ? `a list of ${v.length}` : "an object"}) instead of a URL; it is not passed on because these documents can be very large.` };
}

// ---- Reference ----

// Reference records nest (countries hold special days, regions hold venues holding events); the walk
// stops at this depth and replaces anything deeper with a placeholder rather than passing it on unredacted.
const MAX_REFERENCE_DEPTH = 8;

/**
 * Reference items are small {id, name, description, ...} records, returned with their own field names.
 * Free-text strings at any depth get the email/phone redaction; identifiers, codes and URLs are kept
 * as given; a payment provider's paymentsTelephone is only returned with include_contact_details.
 */
export function referenceItem(r: unknown, includeContact: boolean, depth = 0): unknown {
  if (Array.isArray(r)) return depth >= MAX_REFERENCE_DEPTH ? "[nested too deeply; omitted]" : r.map((x) => referenceItem(x, includeContact, depth + 1));
  if (typeof r === "string") return redactContacts(r, includeContact) ?? r;
  if (!r || typeof r !== "object") return r;
  if (depth >= MAX_REFERENCE_DEPTH) return "[nested too deeply; omitted]";
  const out: Rec = {};
  for (const [k, v] of Object.entries(r as Rec)) {
    if (k === "paymentsTelephone") {
      if (includeContact) out.paymentsTelephone = v;
      else if (v) out.has_pay_by_phone = true;
    } else if (typeof v === "string" && (/^id$|Id$|url$|Url$|code$|Code$/.test(k) || k === "dates")) out[k] = v;
    else out[k] = referenceItem(v, includeContact, depth + 1);
  }
  return out;
}
