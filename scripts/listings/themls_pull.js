// Pull every Active SFR and Land listing in the City of LA's ZIPs (plus City = "Los Angeles")
// from TheMLS and download them as one JSON file for city_of_la_csvs.py. Paste into the Chrome
// tool's javascript_exec on a signed-in themls.com page (/MemberDashboard/ loads, not /explore/),
// or the browser console. Read-only: saves no search and touches no cart. PropertyType 0 = SFR,
// 3 = Land, both under searchType SFR. The grid report fails on fields outside the list below.
(async () => {
  const cookie = Object.fromEntries(document.cookie.split(';').map(c => c.trim().split('=')));
  const post = async (url, body) => {
    for (let t = 0; t < 3; t++) {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (r.ok) return r.json();
      await new Promise(s => setTimeout(s, 800));
    }
    throw new Error('Failed: ' + url + ' (signed out?)');
  };
  const zips = [];
  for (let z = 90001; z <= 90099; z++) zips.push(z);
  zips.push(90210, 90230, 90232, 90245, 90247, 90248, 90272, 90290, 90291, 90292, 90293, 90402, 90501, 90502, 90710, 90717, 90731, 90732, 90744,
    91040, 91042, 91303, 91304, 91306, 91307, 91311, 91316, 91324, 91325, 91326, 91330, 91331, 91335, 91340, 91342, 91343, 91344, 91345, 91352,
    91356, 91364, 91367, 91401, 91402, 91403, 91405, 91406, 91411, 91423, 91436, 91504, 91601, 91602, 91604, 91605, 91606, 91607, 91608);
  const search = async (pt, place) => (await post('/MLSListingAPI/api/Search/ListingSearchElastic', {
    mlsID: 'CLAW', searchTemplateID: null, searchType: 'SFR', zoomLevel: 20, criteriaTitle: 'laaa', criteriaSummary: 'laaa', savedSearchID: null,
    criterias: [{ field: 'Status', value1: 5 }, { field: 'PropertyType', value1: pt, subcriteria: [] }, place], searchRequestID: Date.now(),
  })).ReportMlsnums.split(',').filter(Boolean);
  const GRID = ['MLSNum', 'Status', 'FullAddress', 'City', 'Zip', 'NumberOfUnit', 'squareFeet', 'PricePerSQFt', 'lotSize', 'ListPrice', 'CalcDOM'];
  const jobs = [];
  for (const [sheet, pt] of [['SFR', 0], ['Land', 3]]) {
    const ids = [...new Set([...await search(pt, { field: 'Zip', value1: zips.join(',') }), ...await search(pt, { field: 'City', value1: 'Los Angeles' })])];
    for (let i = 0; i < ids.length; i += 100) jobs.push([sheet, ids.slice(i, i + 100)]);
  }
  const rows = [];
  let next = 0;
  await Promise.all([1, 2, 3, 4].map(async () => {
    while (next < jobs.length) {
      const [sheet, chunk] = jobs[next++];
      const data = await post('/ReportsAPI/api/ReportData/GetReportData', {
        Mlsnums: chunk, Fields: GRID, source: 'report', HotsheetFilter: null, SearchType: 'SFR', SelectedItems: [], SavedSearchID: null,
        NewSinceBeginDate: null, IsCommercialPublic: false, AgentId: cookie.Id, IsPublic: false,
        SortBy: " ORDER BY CHARINDEX(a.MLSNUM,'" + chunk.join(',') + "')",
      });
      for (const r of data) rows.push({ sheet, mls: r.MLSNum, status: r.Status, addr: r.FullAddress, city: r.City, zip: r.Zip, sqft: r.squareFeet,
        lot: r.lotSize, price: r.ListPrice, dom: r.CalcDOM, apn: r.APN, lat: r.Latitude, lng: r.Longitude });
    }
  }));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(rows)], { type: 'application/json' }));
  a.download = 'themls_la_onmarket_raw_' + new Date().toISOString().slice(0, 10) + '.json';
  document.body.appendChild(a); a.click(); a.remove();
  console.log('TheMLS pull saved: ' + rows.length + ' rows');
  window.__pullCount = rows.length;
})();
