/**
 * WatchToggle — anonymous "watch this vehicle" button for /vehicle/:id.
 *
 * Subscribed watchers get notifications fanned out from refresh.py:
 *   price_drop / price_increase / mileage_update / listing_disappeared / relisted / inspection
 *
 * The retention loop is: temporal event → fanout → /feed → user returns.
 */
import { useEffect, useState } from 'react';
import { Bell, BellRing, Check, Loader2 } from 'lucide-react';
import { api } from '../services/api';
import { getWatcherId } from '../lib/watcher';

interface Status {
  watching: boolean;
  totalWatchers: number;
  since?: string | null;
}

export default function WatchToggle({ vehicleId }: { vehicleId: string }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [justSubscribed, setJustSubscribed] = useState(false);

  useEffect(() => {
    const wid = getWatcherId();
    api.get<Status>(`/vehicles/${vehicleId}/watch?watcherId=${wid}`)
      .then(r => setStatus(r.data))
      .catch(() => setStatus({ watching: false, totalWatchers: 0 }));
  }, [vehicleId]);

  async function toggle() {
    if (busy) return;
    const wid = getWatcherId();
    setBusy(true);
    try {
      if (status?.watching) {
        await api.delete(`/vehicles/${vehicleId}/watch?watcherId=${wid}`);
        setStatus(s => ({ watching: false, totalWatchers: Math.max(0, (s?.totalWatchers ?? 1) - 1) }));
        setJustSubscribed(false);
      } else {
        await api.post(`/vehicles/${vehicleId}/watch`, { watcherId: wid, kinds: [] });
        setStatus(s => ({ watching: true, totalWatchers: (s?.totalWatchers ?? 0) + 1, since: new Date().toISOString() }));
        setJustSubscribed(true);
        setTimeout(() => setJustSubscribed(false), 2200);
      }
    } finally {
      setBusy(false);
    }
  }

  if (!status) {
    return (
      <button disabled className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-white/5 text-white/50 text-sm">
        <Loader2 size={14} className="animate-spin" /> …
      </button>
    );
  }

  const isOn = status.watching;
  return (
    <button
      type="button"
      onClick={toggle}
      disabled={busy}
      className="group inline-flex items-center gap-2 h-11 px-4 rounded-xl text-sm font-semibold transition disabled:opacity-60"
      style={{
        background: isOn ? 'rgba(255,176,32,0.14)' : 'rgba(255,255,255,0.07)',
        border: `1px solid ${isOn ? 'rgba(255,176,32,0.5)' : 'rgba(255,255,255,0.12)'}`,
        color: isOn ? '#FFB020' : '#fff',
      }}
      data-testid="watch-toggle"
    >
      {busy ? (
        <Loader2 size={15} className="animate-spin" />
      ) : justSubscribed ? (
        <Check size={15} />
      ) : isOn ? (
        <BellRing size={15} className="group-hover:animate-[wiggle_400ms_ease-in-out]" />
      ) : (
        <Bell size={15} />
      )}
      <span>
        {isOn ? (justSubscribed ? 'Подписан' : 'Слежу') : 'Следить'}
      </span>
      {status.totalWatchers > 0 && (
        <span className="text-2xs opacity-70 ml-1">· {status.totalWatchers}</span>
      )}
    </button>
  );
}
