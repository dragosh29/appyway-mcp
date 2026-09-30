# AppyWay MCP server

An [MCP](https://modelcontextprotocol.io) server that lets Claude, ChatGPT and other MCP clients use the AppyWay API: UK kerbside parking rules and prices, parking entities (on-street bays and lines, car parks), controlled zones, local authorities and AppyWay's reference data. It is built from AppyWay's public documentation and its three published OpenAPI documents (Explorer, Traffic Data, Reference). Every tool is read-only.

Once it's connected, someone with an AppyWay API key can ask things like:

- "Can I park near 51.5195, -0.1100 between 6 and 8pm tonight, and what will it cost?"
- "I have a blue badge and an electric car. Where in this area can I park for the next two hours, and for how much?"
- "When do the single yellow lines in this controlled zone apply tomorrow?"
- "What are the operating hours of this bay on Saturday, and how do I pay for it?"
- "Which authorities does our key cover, and when were their traffic orders last updated?"
- "Give me the links to Northgate's full restriction data as it stood on 1 September."

## Tools

| Tool | What it does | API calls |
|---|---|---|
| `ping` | Checks which of the three API sections the key can reach. | `GET /explorer/ping`, `/traffic-data/ping`, `/reference/ping` |
| `find_parking_rules_near` | For a time window and an area (a point with a square viewport, or a bounding box; at most 1.5 km2, as documented): every parking entity, nearest first, with whether parking is allowed for the whole window, part of it or not at all, and the quotes (cost, max stay, no-return, free-until, payment methods). Adds each entity's name, address, bay types and zone, and the zone default rules for the same area. Vehicle details (type, fuel, permits such as a blue badge, emissions, year, engine size) and the documented filters are passed through. | `POST /explorer/findParkingQuotesByCentreAndViewportSize` or `/findParkingQuotesByViewport`, `/fetchEntitiesByIds`, `/findZoneDefaultRulesByViewport` |
| `fetch_kerb_segments` | The static parking map for an area or for given entity ids: on-street segments (bays, yellow and red lines) and car parks with bay types, capacity, address, a WGS84 point, zone and authority. Optionally the operating hours of each for one date. | `POST /explorer/findParkingEntitiesByCentreAndViewportSize` or `/findParkingEntitiesByViewport`, or `/fetchEntitiesByIds`; `/fetchOperatingHoursByIds` |
| `get_parking_entity` | One entity: details, operating hours for a date (periods marked Free, Paid or Mixed, and closed periods), payment providers and links, and a quote when a start time is given. | `POST /explorer/fetchParkingEntityById`, `/fetchOperatingHoursById`, `/fetchPaymentProvidersByParkingEntityId`, `/fetchParkingQuoteById` |
| `get_zone_rules` | One zone with its type and notes, and the default rules for its kerb types over a window (when each applies, max stay). | `POST /explorer/fetchZoneById`, `/fetchZoneDefaultRulesById` |
| `list_authorities` | Without a location: the authorities the key is entitled to, with slug, data quality, last traffic-order update, centroid and notes. With a point or a bounding box (at most 300 km2): the authorities covering it, with notes and payment providers; one outside the key's entitlement is listed under `not_accessible` with AppyWay's reason. | `POST /traffic-data/fetchAllAuthorities`; or `/explorer/findAuthorityIdsByViewport`, `/explorer/fetchAuthorityById` |
| `get_authority_restrictions` | One authority by slug, and the links to its full restriction data (zones, on-street parking, sets of hours and tariffs, moving-traffic features), optionally as at a date. The links are returned; the documents are never downloaded. | `POST /traffic-data/fetchFullAuthorityBySlug`, `/fetchFullAuthorityInfoBySlug` |
| `list_reference_values` | Any of the 23 reference lists (vehicle, permit, fuel, activity, restriction, zone types, payment methods and providers, countries, regions, ...), or one country or region by id. | `POST /reference/fetchAll*`, `/fetchCountryById`, `/fetchRegionById` |

Almost every AppyWay endpoint is a `POST` with a JSON body, but these POSTs are queries: they search or fetch and change nothing, which is why every tool carries the MCP `readOnlyHint` annotation. The API has no write endpoints in the published specs, so there is no write switch.

Not covered on purpose: the Traffic Data file exports (`exportAuthorityRestrictions*.geojson`, `.dxf`, `exportAuthorityMovingRestrictionsById`) and `wfs`, because they are downloads; `fetchParkingQuotesByIds` and `fetchEventDatesById`, which the tools above do not need. The Traffic Data spec defines schemas for traffic orders (`Order`, `FullOrder`, ...) but no endpoint that returns them, so there is no traffic-order tool; `list_authorities` reports each authority's `lastTmoUpdate` as `last_traffic_order_update`.

## Setup

Requires Node 18 or later.

```bash
npm install
npm run build
```

You need an AppyWay API key. AppyWay's getting-started guide says keys are obtained from AppyWay by emailing apisupport@appyway.com; the key is sent in the `API-KEY` header. A key only covers the authorities it has been granted.

**Claude Desktop:** add this to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "appyway": {
      "command": "node",
      "args": ["/absolute/path/to/appyway-mcp/dist/index.js"],
      "env": { "APPYWAY_API_KEY": "your-key" }
    }
  }
}
```

**Claude Code:**

```bash
claude mcp add appyway -e APPYWAY_API_KEY=your-key -- node /absolute/path/to/appyway-mcp/dist/index.js
```

| Variable | Required | Meaning |
|---|---|---|
| `APPYWAY_API_KEY` | yes | Your API key, sent in the `API-KEY` header. |
| `APPYWAY_BASE_URL` | no | Defaults to `https://api.appyway.com/v1`; the server appends `/explorer`, `/traffic-data` and `/reference`. Used by the tests. |

## Safety defaults

- Read-only: every tool is a query and carries `readOnlyHint: true` and `destructiveHint: false`. There is no write tool and no write switch.
- No personal data is expected in this API. Still, telephone numbers (a payment provider's pay-by-phone number, a car park operator's number, the telephone on an authority note) are only returned when the assistant explicitly asks (`include_contact_details`); by default the output only says `has_pay_by_phone: true`. In free text (zone and authority notes and note titles, entity, zone and authority names, authority tags, entity address lines and location codes, reference-list names such as event venues, and AppyWay's own error messages, whatever the HTTP status) email addresses are replaced with `[email redacted]` and phone-number-like sequences with `[phone redacted]`, using the same heuristic as the other servers in this series (international `+`/`00` numbers including `+44 (0)…`, bracketed UK area codes, and `0…` numbers of 9 to 11 digits; GUIDs, ETags and dates are left alone). `include_contact_details` returns the text unredacted. The heuristic only looks for emails and phone numbers. Ids, URLs (payment pages, app links, websites, note links) and the `id`/`code`/`url` fields of reference records are passed on as given.
- The Traffic Data `Authority` record contains an `ordnanceSurvey` object with an Ordnance Survey API key and licence. It is never returned, not even with `include_contact_details`.
- No bank, card or payment data exists in these endpoints. Payment-provider links (`cardPaymentsExternalUrl`, `paymentsUrl`) are the provider's own public payment pages and are returned; app deep links are returned per platform as given.
- Nothing is downloaded: `get_authority_restrictions` returns the four data-document links and never fetches them (AppyWay says they can be large; they are cached indefinitely and can be kept until the endpoint returns different links). Entity geometry is reduced to one WGS84 point (a `Point` without a CRS, or with EPSG:4326/CRS84); shapes and projected (EPSG:3857) coordinates are left out.
- Input is checked before any call is made: a location must be either `lat`+`lng` or a `bbox`, never both; the area limits AppyWay documents are enforced locally (1.5 km2 for parking and entity searches, so a square side of at most 1224 m; 300 km2 for authority searches); times must be ISO 8601 with a `Z` or an offset (a time given without seconds is sent with `:00` added, since the specs document `YYYY-MM-DDThh:mm:ssTZD`), dates `YYYY-MM-DD` and real calendar dates (`2026-02-30` is refused), and an end time after the start. Entity, zone and authority ids must be GUID-like strings (letters, digits, `-`, `_`, up to 64 characters, optionally wrapped in a pair of braces, which are removed before sending): the specs type them as plain strings, and every request example in AppyWay's guides is a bare GUID. Slugs must be letters, digits, `-` and `_`. Name filters (`query`) are trimmed, and one that is empty after trimming is refused.
- Operating-hours requests set the documented `includeClosedPeriods: true`, so the closed periods AppyWay has for that date are returned as `closed_periods`.
- Defaults: a parking window starts now and lasts one hour; a zone-rules window lasts 24 hours; operating hours are for today's UTC date; a square viewport is 300 m; a point given to `list_authorities` becomes a 100 m square. Ids sent to `fetchEntitiesByIds` and `fetchOperatingHoursByIds` go 50 per request; that cap is this server's choice (no maximum is documented).
- Rate limits: AppyWay documents a `429 Too many requests` response on every operation but no limit, quota or `Retry-After` behaviour. Requests are spaced 250 ms apart (about four per second). A 429 is retried at most twice for any method (a rate-limited request was not processed), waiting for `Retry-After` (whole or fractional seconds, or an HTTP-date; 2 s then 4 s when the header is absent or unreadable). Each wait is capped at 10 seconds; if AppyWay asks for a longer wait, the call gives up at once and says how long to wait. A tool call that makes several requests can still run past the MCP client's default 60-second request timeout.
- 502, 503 and 504 are retried the same way for `GET` (the pings) only. A `POST` is never repeated after a gateway error, even though every POST here is a query; the error says it is safe to call the tool again. A `GET` that fails three times is reported with advice and without the gateway's HTML.
- A 200 whose body is not JSON (a proxy or login page in the way) or whose envelope says `success: false` is reported as an error, never as an empty result.
- Errors say what to do: a wrong key (401) names `APPYWAY_API_KEY`; the documented 401 for an authority outside the key's entitlement ("No permissions to authority …") says the key is not entitled to that authority and points to `list_authorities` and apisupport@appyway.com; a 403 says the key may not be enabled for that API section and suggests `ping`; 400 and 404 pass on AppyWay's message and per-field errors.

## Tests

```bash
npm test
```

The test suite:

1. Validates every fixture record against the component schemas in AppyWay's three published OpenAPI documents (Explorer `ParkingEntity`, `ParkingEntitySearchResult`, `Zone`, `ZoneSearchResult`, `Authority`, `ParkingEntityOperatingHoursResult`, `PaymentProvider`; Traffic Data `Authority`, `FullAuthority`; Reference list responses), with negative controls. The specs are downloaded from Stoplight to `spec-explorer.json`, `spec-traffic-data.json` and `spec-reference.json` on the first run. Three adjustments are made so Ajv can use the documents, and the test says so in code: `{"nullable": true}` without a `type` (10 places) is read as "any value"; the OpenAPI 3.0 boolean `exclusiveMinimum` (once) is converted to the numeric form; and the Explorer `Geometry` schema, which lists only `type` and `crs` and forbids other keys, is allowed a `coordinates` array, because the Explorer guide's example entity has coordinates on every geometry (a check proves the unadjusted schema rejects the fixtures). The response of `fetchFullAuthorityInfoBySlug` is validated against a schema written by hand from the endpoint's description ("The initial object contains only the URLs"), because the published `AuthoritySnapshotInfoDoc` schema describes the documents behind the links, not the links; a check shows the published schema rejects a links-only response.
2. Starts a local mock of the API under `/v1/explorer`, `/v1/traffic-data` and `/v1/reference` that checks the `API-KEY` header and serves the fixtures (the API has no pagination). Its results are validated against each operation's documented response schema, and its errors against the documented shapes: 400 `BadRequestResponse`, 404 `NotFoundResponse`, and the getting-started guide's 401 example for an authority outside the key's entitlement. A wrong key and 429s get no body, as the specs document those responses with a description only. The Explorer guide's example search request is validated against the request schema and accepted by the mock. The enum names the server prints are checked against the specs' descriptions, and the TimeSpan parser against the documented `[-][d.]hh:mm:ss[.fffffff]` format and the spec's own example.
3. Starts the built server and drives it over stdio with the official MCP client: 21 checks covering tools/list and annotations (the same 8 read-only tools with `APPYWAY_ALLOW_WRITES=true`); every tool; the centre-and-size and polygon forms of the searches with every documented filter, vehicle detail, `onStreetParkingTypes`, `includeNotApplicableTimes`, `maxDate` and `localeCode` passed through exactly; the defaults (window, viewport, date); times without seconds sent with them; the 50-per-request batching of ids, braced ids sent bare and a repeated id reported once; `includeClosedPeriods` sent and the closed periods returned; an empty area making no follow-up calls; refusal of bad input before any call (two or no locations, inverted windows, bad ids, slugs, impossible dates, blank queries); the area limits just under and just over 1.5 km2 and 300 km2; redaction of emails and phone numbers in notes, note titles, entity, zone and authority names, tags, address lines, location codes and error messages (including a `success: false` 200) and the withholding of telephone numbers by default, and their return on request; a `Point` in EPSG:3857 left out; a data-document link given as a list passed on and an inline document summarised; the Ordnance Survey key never returned; the entitlement 401 and a 403 (on a `GET` and on a `POST`) reported with advice; a 404 for an unknown id; requests spaced about 250 ms apart; the 429 retry waiting for `Retry-After` in the seconds, fractional-seconds and HTTP-date forms and 2 s when the header is missing or unreadable, giving up after three attempts on a persistent 429 and at once on a `Retry-After` just above the 10 s cap (10.5 s); a 502 retried for `GET` and never for a `POST`; a `GET` failing three times with 503 reported without the gateway's HTML; a non-JSON 200 and a `success: false` envelope reported as errors; a wrong key; and that every request carried the `API-KEY` header and no other credential, hit a documented method and path, and sent a body that validates against the operation's documented request schema (or no body where none is documented).

All three parts (24 checks) run in about 45 seconds.

## Status

This is a working prototype. It has **not been run against the live API**, because it was built without an AppyWay account (AppyWay offers no self-serve key or sandbox). Everything below is taken from the published specs and guides and should be confirmed on a real account:

- The error bodies for a wrong key (401), 403 and 429: the specs document them with a description only. The server handles any JSON `message`/`errors[]` and no body at all. Whether a 429 carries `Retry-After`, and what the rate limit is, are not documented.
- The entitlement error: the guide's 401 example ("No permissions to authority '{GUID}'", property `authority`). Which endpoints return it, and whether searches in an area outside the entitlement return it or just return fewer results, is not documented; the mock returns it for id and slug lookups.
- The body of `GET /explorer/ping` and `GET /traffic-data/ping` (not documented; the Reference ping documents `{success, result: string}`, and the description says "pong").
- The response of `fetchFullAuthorityInfoBySlug`: the schema describes FeatureCollections while the description says the object contains only URLs. The server passes on a string or a list of strings and summarises anything else without inlining it. Whether `ospsUrl` is one URL or several is not clear from the docs.
- Geometry: whether Explorer geometries carry `coordinates` (the schema omits them; the guide's example has them), and which CRS the `Point` uses when none is given (assumed WGS84, as in the guide's example; a point with another CRS is left out).
- The format of entity, zone and authority ids (all examples are GUIDs; the Traffic Data authority id is `format: uuid`), of slugs, and of country and region ids (up to 36 characters, as documented).
- Whether the list endpoints of the Reference API and `fetchAllAuthorities` accept a `POST` with no body (no request body is documented; that is what the server sends), and whether `fetchAllRestrictionTypes` accepts `{}` when no locale is given.
- The time window: the Explorer query schemas list `endTime` as optional but describe it as "Required"; the server always sends it. `duration` is read-only in the spec and is never sent. The format of `requestedDuration` in responses (a .NET TimeSpan per the guide) and how times are normalised.
- The operating hours returned when no date is sent (not documented); the server always sends one (today's UTC date by default, while AppyWay describes dates as local). What `includeClosedPeriods` adds on the live API, and the format of the closed periods' times (the spec's `DateTimeRange` example has no time zone), are not confirmed; the mock returns them only when the flag is set.
- The platform keys of `paymentsAppDeepLinks` (documented as a map "by platform" without naming the platforms) and whether `paymentsTelephone` is ever something other than a public pay-by-phone number.
- The area limits: the server enforces 1.5 km2 and 300 km2 with its own approximate area calculation for bounding boxes; AppyWay's own calculation may differ slightly at the edges. The documented `viewportSize` maximum on `findParkingEntitiesByCentreAndViewportSize` is 1225 m; the server allows at most 1224 m everywhere.
- Whether `fetchEntitiesByIds` and `fetchOperatingHoursByIds` accept 50 ids per request, or more (no maximum is documented).
- How many requests per second the API tolerates; the throttle here is a guess on the polite side.

## Going to production

This version runs locally over stdio, with the key holder's own API key. For AppyWay's customers to connect from claude.ai or ChatGPT without handling keys, the next step is a remote server (Streamable HTTP) behind OAuth, hosted by AppyWay, and then a listing in the Claude and ChatGPT connector directories.

## Licence

MIT. Built by Alexandru Dragoș (alexandru.dragos96@gmail.com) with an AI agent (Claude) working under his direction.
