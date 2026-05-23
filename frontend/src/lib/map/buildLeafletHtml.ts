/**
 * Pure function that builds the Leaflet HTML payload rendered inside the
 * map iframe (web) or react-native-webview (native). No React, no I/O —
 * keeps `app/map.tsx` thin and easy to test.
 */
import { PARTNER_KIND_MAP, REGION_BOUNDS_LATLNG, REGION_COUNTRIES, NAME_TO_ISO3 } from './kinds';
import type { PartnerKind } from './kinds';

export interface BuildOpts {
  centerLat?: number;
  centerLng?: number;
  hasCity: boolean;
  providers: Array<any>;
  myRequests?: Array<any>;
  drawCountries?: boolean;
}

export function buildLeafletHtml({ centerLat = 54.0, centerLng = 19.5, hasCity, providers, myRequests = [], drawCountries = true }: BuildOpts): string {
  const iconJs = (Object.keys(PARTNER_KIND_MAP) as PartnerKind[]).map((k) => {
    const m = PARTNER_KIND_MAP[k];
    return `'${k}': L.divIcon({ html: '<div style="background:${m.color};color:#000;width:30px;height:30px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:bold;box-shadow:0 2px 6px rgba(0,0,0,0.25);border:2px solid #fff">${m.emoji}</div>', className: '', iconSize: [30, 30] })`;
  }).join(',\n  ');

  const markerJs = providers
    .filter((p) => p.location?.coordinates || (p.lat && p.lng))
    .map((p) => {
      const c = p.location?.coordinates;
      const plat = c ? c[1] : p.lat;
      const plng = c ? c[0] : p.lng;
      const k: PartnerKind = (PARTNER_KIND_MAP[p.kind as PartnerKind] ? p.kind : 'workshop');
      const m = PARTNER_KIND_MAP[k];
      const name = String(p.name || p.displayName || '').replace(/'/g, "\\'");
      const city = String(p.city || '').replace(/'/g, "\\'");
      return `L.marker([${plat}, ${plng}], { icon: icons['${k}'] }).bindPopup('<b>${name}</b><br>${m.emoji} ${m.label}<br>⭐ ${p.ratingAvg || '—'}<br>${city}').addTo(map);`;
    }).join('\n');

  const reqJs = myRequests.map((r) => {
    const lat = r.location?.lat;
    const lng = r.location?.lng;
    if (!lat || !lng) return '';
    return `L.marker([${lat}, ${lng}], { icon: icons.request }).bindPopup('<b>${String(r.title || '').replace(/'/g, "\\'")}</b><br>${r.category}<br>${r.status}').addTo(map);`;
  }).join('\n');

  const initJs = hasCity
    ? `map.setView([${centerLat}, ${centerLng}], 12);`
    : `map.fitBounds([[${REGION_BOUNDS_LATLNG[0][0]}, ${REGION_BOUNDS_LATLNG[0][1]}], [${REGION_BOUNDS_LATLNG[1][0]}, ${REGION_BOUNDS_LATLNG[1][1]}]], { padding: [10, 10] });`;

  const countryJs = drawCountries ? `
fetch('https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-110m.json').then(r=>r.json()).then(topo=>{
  var s=document.createElement('script'); s.src='https://unpkg.com/topojson-client@3/dist/topojson-client.min.js';
  s.onload=function(){
    var geo=topojson.feature(topo, topo.objects.countries);
    var name2iso=${JSON.stringify(NAME_TO_ISO3)};
    var feats=geo.features.filter(function(f){ return name2iso[f.properties.name]; });
    L.geoJSON(feats,{ style:{ color:'#f5c518', weight:2, fillColor:'#f5c518', fillOpacity:0.06, opacity:0.85 } }).addTo(map);
    var labels=${JSON.stringify(REGION_COUNTRIES)};
    labels.forEach(function(c){ L.marker(c.center, { icon: L.divIcon({ className:'country-label', html:c.label, iconSize:[80,16] }), interactive:false }).addTo(map); });
  };
  document.head.appendChild(s);
}).catch(function(){});` : '';

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<style>html,body,#m{margin:0;height:100%;width:100%;background:#f5f7fb}.leaflet-popup-content{font-family:sans-serif;font-size:13px}.country-label{background:transparent;border:0;color:#0f172a;font-weight:700;font-size:11px;text-shadow:0 0 4px #fff,0 0 4px #fff;letter-spacing:0.5px}</style>
</head><body><div id="m"></div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
var map = L.map('m', { zoomControl: true });
L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png', { attribution: '© OSM, © CARTO', maxZoom: 19 }).addTo(map);
${initJs}
var icons = { ${iconJs}, request: L.divIcon({ html:'<div style="background:#ef4444;color:#fff;width:30px;height:30px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:14px;box-shadow:0 2px 6px rgba(0,0,0,0.25);border:2px solid #fff">📋</div>', className:'', iconSize:[30,30] }) };
${countryJs}
${markerJs}
${reqJs}
</script></body></html>`;
}
