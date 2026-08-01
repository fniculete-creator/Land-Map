/* Land-Map — ideal land site targeting.
 * Plain-JS single page app: Leaflet map + weighted-criteria scoring,
 * persisted to localStorage. */

(function () {
  "use strict";

  var STORAGE_KEY = "land-map-state-v1";
  var SQM_PER_ACRE = 4046.8564224;

  var DEFAULT_CRITERIA = [
    { id: "price",     name: "Price value",            weight: 8 },
    { id: "access",    name: "Road access",            weight: 7 },
    { id: "utilities", name: "Utilities availability", weight: 6 },
    { id: "terrain",   name: "Terrain / buildability", weight: 6 },
    { id: "flood",     name: "Flood / drainage risk",  weight: 5 },
    { id: "zoning",    name: "Zoning / restrictions",  weight: 5 },
    { id: "proximity", name: "Proximity to town",      weight: 4 },
    { id: "views",     name: "Views / character",      weight: 3 }
  ];

  var state = {
    sites: [],      // {id, name, price, acreage, notes, ratings:{critId:1..5}, geometry:{type:'point'|'polygon', latlngs}}
    criteria: [],   // {id, name, weight}
    mapView: { center: [39.5, -98.35], zoom: 5 } // continental US default
  };

  var map, drawnLayers = {}, selectedSiteId = null;

  /* ---------------- persistence ---------------- */

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      console.warn("Could not save state:", e);
    }
  }

  function load() {
    var raw = null;
    try { raw = localStorage.getItem(STORAGE_KEY); } catch (e) { /* private mode */ }
    if (raw) {
      try {
        var parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.sites) && Array.isArray(parsed.criteria)) {
          state = parsed;
        }
      } catch (e) {
        console.warn("Corrupt saved state, starting fresh.");
      }
    }
    if (!state.criteria.length) {
      state.criteria = DEFAULT_CRITERIA.map(function (c) { return Object.assign({}, c); });
    }
    if (!state.mapView) state.mapView = { center: [39.5, -98.35], zoom: 5 };
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  /* ---------------- scoring ---------------- */

  // Weighted average of rated criteria, normalized to 0–100.
  // Unrated criteria are excluded so a new site isn't punished for blanks.
  function scoreSite(site) {
    var num = 0, den = 0;
    state.criteria.forEach(function (c) {
      var r = site.ratings && site.ratings[c.id];
      if (r >= 1 && c.weight > 0) {
        num += c.weight * r;
        den += c.weight * 5;
      }
    });
    if (!den) return null;
    return Math.round((num / den) * 100);
  }

  function ratedCount(site) {
    var n = 0;
    state.criteria.forEach(function (c) {
      if (site.ratings && site.ratings[c.id] >= 1) n++;
    });
    return n;
  }

  // Red (0) → amber (50) → green (100)
  function scoreColor(score) {
    if (score === null) return "#8a94a0";
    var h = Math.round((score / 100) * 120); // 0=red, 120=green
    return "hsl(" + h + ", 65%, 42%)";
  }

  function sortedSites() {
    return state.sites.slice().sort(function (a, b) {
      var sa = scoreSite(a), sb = scoreSite(b);
      if (sa === null && sb === null) return 0;
      if (sa === null) return 1;
      if (sb === null) return -1;
      return sb - sa;
    });
  }

  /* ---------------- map ---------------- */

  function initMap() {
    map = L.map("map").setView(state.mapView.center, state.mapView.zoom);

    var streets = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);

    var satellite = L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
        maxZoom: 19,
        attribution: "Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics"
      });

    var topo = L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
      maxZoom: 17,
      attribution: 'Map data &copy; OpenStreetMap contributors, SRTM | Style &copy; <a href="https://opentopomap.org">OpenTopoMap</a>'
    });

    L.control.layers(
      { "Streets": streets, "Satellite": satellite, "Topographic": topo },
      null, { position: "bottomright" }
    ).addTo(map);

    var drawControl = new L.Control.Draw({
      draw: {
        polyline: false,
        circle: false,
        circlemarker: false,
        rectangle: { shapeOptions: { color: "#2f7d4f" } },
        polygon: { allowIntersection: false, shapeOptions: { color: "#2f7d4f" } },
        marker: true
      }
    });
    map.addControl(drawControl);

    map.on(L.Draw.Event.CREATED, function (e) {
      var site = createSiteFromLayer(e.layer, e.layerType);
      state.sites.push(site);
      save();
      renderAll();
      selectSite(site.id);
    });

    map.on("moveend", function () {
      var c = map.getCenter();
      state.mapView = { center: [c.lat, c.lng], zoom: map.getZoom() };
      save();
    });
  }

  function createSiteFromLayer(layer, layerType) {
    var site = {
      id: uid(),
      name: "Site " + (state.sites.length + 1),
      price: null,
      acreage: null,
      notes: "",
      ratings: {},
      geometry: null
    };

    if (layerType === "marker") {
      var ll = layer.getLatLng();
      site.geometry = { type: "point", latlngs: [ll.lat, ll.lng] };
    } else {
      // polygon or rectangle
      var ring = layer.getLatLngs()[0].map(function (p) { return [p.lat, p.lng]; });
      site.geometry = { type: "polygon", latlngs: ring };
      if (L.GeometryUtil && L.GeometryUtil.geodesicArea) {
        var areaSqm = L.GeometryUtil.geodesicArea(layer.getLatLngs()[0]);
        site.acreage = Math.round((areaSqm / SQM_PER_ACRE) * 100) / 100;
      }
    }
    return site;
  }

  function siteLayer(site) {
    var score = scoreSite(site);
    var color = scoreColor(score);
    var layer;

    if (site.geometry.type === "point") {
      layer = L.circleMarker(site.geometry.latlngs, {
        radius: 10, color: "#fff", weight: 2, fillColor: color, fillOpacity: 0.95
      });
    } else {
      layer = L.polygon(site.geometry.latlngs, {
        color: color, weight: 2, fillColor: color, fillOpacity: 0.35
      });
    }

    var label = site.name + (score !== null ? " — " + score : "");
    layer.bindTooltip(label, { className: "site-tooltip", direction: "top" });
    layer.on("click", function () { selectSite(site.id); });
    return layer;
  }

  function renderMapLayers() {
    Object.keys(drawnLayers).forEach(function (id) {
      map.removeLayer(drawnLayers[id]);
    });
    drawnLayers = {};
    state.sites.forEach(function (site) {
      var layer = siteLayer(site).addTo(map);
      drawnLayers[site.id] = layer;
    });
  }

  function zoomToSite(site) {
    if (site.geometry.type === "point") {
      map.setView(site.geometry.latlngs, Math.max(map.getZoom(), 15));
    } else {
      map.fitBounds(L.polygon(site.geometry.latlngs).getBounds().pad(0.3));
    }
  }

  /* ---------------- geocoding ---------------- */

  function geocode(query) {
    var url = "https://nominatim.openstreetmap.org/search?format=json&limit=1&q=" +
      encodeURIComponent(query);
    return fetch(url, { headers: { "Accept": "application/json" } })
      .then(function (r) { return r.json(); })
      .then(function (results) {
        if (!results.length) throw new Error("No results");
        return results[0];
      });
  }

  /* ---------------- rendering: sites ---------------- */

  function formatMoney(n) {
    if (n === null || n === undefined || n === "" || isNaN(n)) return null;
    return "$" + Number(n).toLocaleString();
  }

  function renderSiteList() {
    var list = document.getElementById("site-list");
    var empty = document.getElementById("empty-sites");
    list.innerHTML = "";
    var sites = sortedSites();
    empty.style.display = sites.length ? "none" : "block";

    sites.forEach(function (site, i) {
      var score = scoreSite(site);
      var li = document.createElement("li");
      li.className = "site-item" + (site.id === selectedSiteId ? " selected" : "");

      var rank = document.createElement("span");
      rank.className = "site-rank";
      rank.textContent = (i + 1) + ".";

      var info = document.createElement("div");
      info.className = "site-info";
      var nameEl = document.createElement("div");
      nameEl.className = "site-name";
      nameEl.textContent = site.name;
      var meta = document.createElement("div");
      meta.className = "site-meta";
      var bits = [];
      if (site.acreage) bits.push(site.acreage + " ac");
      var money = formatMoney(site.price);
      if (money) bits.push(money);
      var rated = ratedCount(site);
      bits.push(rated + "/" + state.criteria.length + " rated");
      meta.textContent = bits.join(" · ");
      info.appendChild(nameEl);
      info.appendChild(meta);

      var badge = document.createElement("span");
      badge.className = "score-badge";
      badge.style.background = scoreColor(score);
      badge.textContent = score === null ? "–" : score;

      li.appendChild(rank);
      li.appendChild(info);
      li.appendChild(badge);
      li.addEventListener("click", function () {
        selectSite(site.id);
        zoomToSite(site);
      });
      list.appendChild(li);
    });
  }

  /* ---------------- rendering: criteria ---------------- */

  function renderCriteria() {
    var list = document.getElementById("criteria-list");
    list.innerHTML = "";

    state.criteria.forEach(function (c) {
      var li = document.createElement("li");
      li.className = "criterion-item";

      var top = document.createElement("div");
      top.className = "criterion-top";

      var name = document.createElement("span");
      name.className = "criterion-name";
      name.textContent = c.name;
      name.title = "Double-click to rename";
      name.addEventListener("dblclick", function () {
        var next = prompt("Rename criterion:", c.name);
        if (next && next.trim()) {
          c.name = next.trim().slice(0, 40);
          save();
          renderAll();
        }
      });

      var weightVal = document.createElement("span");
      weightVal.className = "criterion-weight-value";
      weightVal.textContent = c.weight;

      var remove = document.createElement("button");
      remove.className = "criterion-remove";
      remove.title = "Remove criterion";
      remove.textContent = "×";
      remove.addEventListener("click", function () {
        if (!confirm('Remove criterion "' + c.name + '"? Existing ratings for it will be discarded.')) return;
        state.criteria = state.criteria.filter(function (x) { return x.id !== c.id; });
        state.sites.forEach(function (s) { if (s.ratings) delete s.ratings[c.id]; });
        save();
        renderAll();
      });

      top.appendChild(name);
      top.appendChild(weightVal);
      top.appendChild(remove);

      var slider = document.createElement("input");
      slider.type = "range";
      slider.min = "0";
      slider.max = "10";
      slider.step = "1";
      slider.value = c.weight;
      slider.addEventListener("input", function () {
        c.weight = Number(slider.value);
        weightVal.textContent = c.weight;
      });
      slider.addEventListener("change", function () {
        save();
        renderAll();
      });

      li.appendChild(top);
      li.appendChild(slider);
      list.appendChild(li);
    });
  }

  /* ---------------- site detail drawer ---------------- */

  function currentSite() {
    return state.sites.find(function (s) { return s.id === selectedSiteId; }) || null;
  }

  function selectSite(id) {
    selectedSiteId = id;
    renderSiteList();
    renderDetail();
  }

  function closeDetail() {
    selectedSiteId = null;
    document.getElementById("site-detail").classList.add("hidden");
    renderSiteList();
  }

  function renderDetail() {
    var site = currentSite();
    var panel = document.getElementById("site-detail");
    if (!site) { panel.classList.add("hidden"); return; }
    panel.classList.remove("hidden");

    var score = scoreSite(site);
    var badge = document.getElementById("detail-score");
    badge.textContent = score === null ? "–" : score;
    badge.style.background = scoreColor(score);

    document.getElementById("detail-name").value = site.name;
    document.getElementById("detail-price").value = site.price === null ? "" : site.price;
    document.getElementById("detail-acreage").value = site.acreage === null ? "" : site.acreage;
    document.getElementById("detail-notes").value = site.notes || "";
    renderPricePerAcre(site);
    renderRatings(site);
  }

  function renderPricePerAcre(site) {
    var el = document.getElementById("detail-price-per-acre");
    if (site.price > 0 && site.acreage > 0) {
      el.textContent = "$" + Math.round(site.price / site.acreage).toLocaleString();
    } else {
      el.textContent = "–";
    }
  }

  function renderRatings(site) {
    var wrap = document.getElementById("detail-ratings");
    wrap.innerHTML = "";
    if (!site.ratings) site.ratings = {};

    state.criteria.forEach(function (c) {
      var row = document.createElement("div");
      row.className = "rating-row";

      var label = document.createElement("span");
      label.className = "rating-label";
      label.textContent = c.name;
      label.title = c.name + " (weight " + c.weight + ")";

      var stars = document.createElement("div");
      stars.className = "rating-stars";
      var current = site.ratings[c.id] || 0;

      for (var v = 1; v <= 5; v++) {
        (function (val) {
          var b = document.createElement("button");
          b.textContent = "★";
          b.title = val + " / 5";
          if (val <= current) b.classList.add("filled");
          b.addEventListener("click", function () {
            // Clicking the current rating clears it.
            site.ratings[c.id] = (site.ratings[c.id] === val) ? 0 : val;
            save();
            renderAll();
            renderDetail();
          });
          stars.appendChild(b);
        })(v);
      }

      row.appendChild(label);
      row.appendChild(stars);
      wrap.appendChild(row);
    });
  }

  function bindDetailEvents() {
    document.getElementById("detail-close").addEventListener("click", closeDetail);

    document.getElementById("detail-name").addEventListener("change", function (e) {
      var site = currentSite();
      if (!site) return;
      site.name = e.target.value.trim() || site.name;
      e.target.value = site.name;
      save();
      renderAll();
    });

    document.getElementById("detail-price").addEventListener("change", function (e) {
      var site = currentSite();
      if (!site) return;
      site.price = e.target.value === "" ? null : Number(e.target.value);
      save();
      renderPricePerAcre(site);
      renderSiteList();
    });

    document.getElementById("detail-acreage").addEventListener("change", function (e) {
      var site = currentSite();
      if (!site) return;
      site.acreage = e.target.value === "" ? null : Number(e.target.value);
      save();
      renderPricePerAcre(site);
      renderSiteList();
    });

    document.getElementById("detail-notes").addEventListener("change", function (e) {
      var site = currentSite();
      if (!site) return;
      site.notes = e.target.value;
      save();
    });

    document.getElementById("detail-zoom").addEventListener("click", function () {
      var site = currentSite();
      if (site) zoomToSite(site);
    });

    document.getElementById("detail-delete").addEventListener("click", function () {
      var site = currentSite();
      if (!site) return;
      if (!confirm('Delete "' + site.name + '"?')) return;
      state.sites = state.sites.filter(function (s) { return s.id !== site.id; });
      save();
      closeDetail();
      renderAll();
    });
  }

  /* ---------------- tabs / search / data ---------------- */

  function bindTabs() {
    var tabs = document.querySelectorAll(".tab");
    tabs.forEach(function (tab) {
      tab.addEventListener("click", function () {
        tabs.forEach(function (t) { t.classList.remove("active"); });
        document.querySelectorAll(".tab-panel").forEach(function (p) { p.classList.remove("active"); });
        tab.classList.add("active");
        document.getElementById("tab-" + tab.dataset.tab).classList.add("active");
      });
    });
  }

  function bindSearch() {
    var input = document.getElementById("search-input");
    var btn = document.getElementById("search-btn");

    function run() {
      var q = input.value.trim();
      if (!q) return;
      btn.disabled = true;
      btn.textContent = "…";
      geocode(q)
        .then(function (r) {
          var lat = parseFloat(r.lat), lon = parseFloat(r.lon);
          if (r.boundingbox) {
            var bb = r.boundingbox.map(Number); // [s, n, w, e]
            map.fitBounds([[bb[0], bb[2]], [bb[1], bb[3]]]);
          } else {
            map.setView([lat, lon], 12);
          }
        })
        .catch(function () { alert("No results found for \"" + q + "\"."); })
        .finally(function () {
          btn.disabled = false;
          btn.textContent = "Go";
        });
    }

    btn.addEventListener("click", run);
    input.addEventListener("keydown", function (e) { if (e.key === "Enter") run(); });
  }

  function bindCriteriaForm() {
    document.getElementById("add-criterion-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var input = document.getElementById("new-criterion-name");
      var name = input.value.trim();
      if (!name) return;
      state.criteria.push({ id: uid(), name: name.slice(0, 40), weight: 5 });
      input.value = "";
      save();
      renderAll();
    });
  }

  function bindDataActions() {
    document.getElementById("export-btn").addEventListener("click", function () {
      var blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "land-map-export.json";
      a.click();
      URL.revokeObjectURL(a.href);
    });

    document.getElementById("import-input").addEventListener("change", function (e) {
      var file = e.target.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        try {
          var parsed = JSON.parse(reader.result);
          if (!parsed || !Array.isArray(parsed.sites) || !Array.isArray(parsed.criteria)) {
            throw new Error("bad shape");
          }
          if (!confirm("Importing replaces your current sites and criteria. Continue?")) return;
          state = parsed;
          if (!state.mapView) state.mapView = { center: [39.5, -98.35], zoom: 5 };
          save();
          closeDetail();
          renderAll();
          map.setView(state.mapView.center, state.mapView.zoom);
        } catch (err) {
          alert("That file doesn't look like a Land-Map export.");
        }
        e.target.value = "";
      };
      reader.readAsText(file);
    });

    document.getElementById("clear-btn").addEventListener("click", function () {
      if (!confirm("Delete ALL sites and reset criteria to defaults? This cannot be undone.")) return;
      state.sites = [];
      state.criteria = DEFAULT_CRITERIA.map(function (c) { return Object.assign({}, c); });
      save();
      closeDetail();
      renderAll();
    });
  }

  /* ---------------- boot ---------------- */

  function renderAll() {
    renderSiteList();
    renderCriteria();
    renderMapLayers();
    var site = currentSite();
    if (site) renderDetail();
  }

  load();
  initMap();
  bindTabs();
  bindSearch();
  bindCriteriaForm();
  bindDataActions();
  bindDetailEvents();
  renderAll();
})();
