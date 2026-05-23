import { useEffect, useMemo } from 'react';
import { MapContainer, TileLayer, CircleMarker, Tooltip, Circle, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

// Fix default icon paths (we use CircleMarker mostly so it's defensive)
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl:       'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl:     'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
});

const KYIV_CENTER: [number, number] = [50.4501, 30.5234];

export type MapPoint = {
  id: string;
  lat: number;
  lng: number;
  label?: string;
  status?: 'open' | 'busy' | 'closed';
  selected?: boolean;
  onClick?: () => void;
};

export type MapZone = {
  id: string;
  lat: number;
  lng: number;
  radiusKm: number;
  level: 'high' | 'medium' | 'balanced' | 'low';
  label?: string;
  multiplier?: number;
};

interface Props {
  points?: MapPoint[];
  zones?: MapZone[];
  center?: [number, number];
  zoom?: number;
  height?: string | number;
  selectedId?: string | null;
}

const LEVEL_COLORS: Record<MapZone['level'], string> = {
  high:     '#ef4444',
  medium:   '#FFB020',
  balanced: '#22c55e',
  low:      '#6b7280',
};

function FlyToSelected({ id, points }: { id: string | null | undefined; points: MapPoint[] }) {
  const map = useMap();
  useEffect(() => {
    if (!id) return;
    const p = points.find(pp => pp.id === id);
    if (p) map.flyTo([p.lat, p.lng], 14, { duration: 0.5 });
  }, [id, points, map]);
  return null;
}

export default function LiveMap({ points = [], zones = [], center = KYIV_CENTER, zoom = 12, height = 480, selectedId }: Props) {
  const allPoints = useMemo(() => points, [points]);

  return (
    <div style={{ height, width: '100%', borderRadius: 12, overflow: 'hidden', border: '1px solid #2E2E2E' }}>
      <MapContainer
        center={center}
        zoom={zoom}
        scrollWheelZoom
        style={{ height: '100%', width: '100%', background: '#111' }}
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> · <a href="https://carto.com/attributions">CARTO</a>'
          url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
          subdomains="abcd"
          maxZoom={19}
        />

        {zones.map(z => (
          <Circle
            key={z.id}
            center={[z.lat, z.lng]}
            radius={z.radiusKm * 1000}
            pathOptions={{
              color: LEVEL_COLORS[z.level],
              fillColor: LEVEL_COLORS[z.level],
              fillOpacity: 0.15,
              weight: 1.5,
              dashArray: '4 6',
            }}
          >
            {z.label && (
              <Tooltip direction="center" permanent className="zone-tooltip">
                {z.label}{z.multiplier && z.multiplier > 1 ? ` ×${z.multiplier}` : ''}
              </Tooltip>
            )}
          </Circle>
        ))}

        {allPoints.map(p => {
          const isSelected = selectedId === p.id;
          const status = p.status || 'open';
          const fill = isSelected ? '#FFB020' : status === 'closed' ? '#6b7280' : status === 'busy' ? '#FFC233' : '#22c55e';
          return (
            <CircleMarker
              key={p.id}
              center={[p.lat, p.lng]}
              radius={isSelected ? 12 : 8}
              pathOptions={{
                color: '#000',
                weight: 2,
                fillColor: fill,
                fillOpacity: 1,
              }}
              eventHandlers={{ click: () => p.onClick?.() }}
            >
              {p.label && (
                <Tooltip direction="top" offset={[0, -6]} opacity={1}>
                  <span style={{ fontSize: 11, fontWeight: 600 }}>{p.label}</span>
                </Tooltip>
              )}
            </CircleMarker>
          );
        })}

        <FlyToSelected id={selectedId || null} points={allPoints} />
      </MapContainer>
    </div>
  );
}

export { KYIV_CENTER };
