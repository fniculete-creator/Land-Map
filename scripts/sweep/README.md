# SB 1123 sweep (new filings and approvals)

Keeps `data/projects.json` current with every City of LA SB 1123 / SB 684
subdivision case, and emails Filip when there is a new filing or a decision.

**Where it runs:** a scheduled task on Filip's work PC, "LAAA Land SB 1123
sweep", weekdays at 7:30am (Claude desktop app, Scheduled). It only runs while
the PC is on and Filip is signed in; a missed run catches up on the next one.
The cloud routine "LAAA Land Monday PDIS sweep" is paused because the cloud
cannot reach planning.lacity.gov (11/12/2026).

## Steps

1. Pull the branch: `git pull` on `claude/ideal-land-site-targeting-egjr29`
   (the production branch; Vercel deploys it to land.laaa.com).
2. Run the finder (about 10 to 15 minutes, mostly the case-number probe):

       python scripts/sweep/sweep_sb1123.py --report <scratch>\sweep.json --apply

   `--apply` writes approvals, closures, renamed case numbers and hold changes
   into `data/projects.json` (status, rawStatus, decided, case only). It prints
   one line per new filing and per change; the report file has the PDIS facts.
3. For each status change, update that record's `desc` sentence to match
   (approval date and conditions, "on hold as of MM/DD/YYYY", or hold released).
4. For each new filing, build a record keyed by the 10-digit AIN, in the same
   shape as its neighbors (case, status "submitted", rawStatus, bill, filed,
   decided null, address, zoning, units, owner, entity, rep, repCompany, phone,
   desc, lng, lat, lotSqft, vacant):
   - Parcel: point from the AGOL layer or the Census geocoder, then
     point-in-polygon on the County parcel layer. A geocode that lands in the
     street returns nothing: fall back to the case's ZIMAS PIN (`zimasPin` in
     the report) and `maps.lacity.org/arcgis/rest/services/Core/Master_landbase/MapServer/2`
     (field BPP is the AIN). Check the parcel's situs matches the case address.
   - lotSqft: geodesic area of the parcel polygon fetched in 4326 (the layer's
     own area field is unreliable). vacant: 1 when the use code ends in V.
   - Owner and last sale: la-property-data `lookup_property`.
   - bill from the requested entitlement (SB 684 starter house, SB 1123, or
     both); units from the description. desc ends with the filed date, the
     council district and the hold state.
   - Then `python scripts/listings/add_widths.py` to fill `w`.
   - A companion case on the same or an adjoining parcel of a tracked project
     (same owner, filed together) goes into that record's desc as "Companion
     case {full case number} ..." instead of a new record. The finder treats any
     case number written in a desc as known, so it is not flagged again.
5. Check: `python -c "import json; json.load(open('data/projects.json'))"`.
   The file is 1-space indent, ASCII-escaped, no trailing newline.
6. Commit `data/projects.json` only ("SB 1123 sweep MM/DD: ...") and push. No
   changes, no commit.
7. Email Filip (Filip.Niculete@marcusmillichap.com) through Prompts
   `scripts/outlook_draft.py new`, then `send` with the returned entry id and
   subject, only when there is a new filing or a decision (approved or
   closed). Subject "SB 1123: New Filing at {address}" or "SB 1123: {address}
   Approved"; several at once, "SB 1123 Sweep: {n} New Filings, {n} Approvals".
   Body: one block per case (address, case number with its PDIS link, homes,
   lot SF, owner or entity, applicant's rep, filed or decided date) and the
   land.laaa.com link. A hold change alone gets no email.
8. A run that fails (city site down, script error) emails Filip once with the
   error instead of failing silently.

Last run's report is kept at `%USERPROFILE%\.claude\scheduled-tasks\laaa-land-sb1123-sweep\last_report.json`
(outside the repo).
