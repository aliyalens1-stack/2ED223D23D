import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Heart, Star, MapPin, Clock, ArrowRight } from 'lucide-react';
import { favoritesAPI } from '../../services/api';

export default function CustomerFavorites() {
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    favoritesAPI.getMy().then(r => setItems(r.data?.favorites || r.data?.items || [])).catch(() => setItems([])).finally(() => setLoading(false));
  }, []);

  const remove = async (orgId: string) => {
    try { await favoritesAPI.remove(orgId); setItems(p => p.filter((i: any) => i.organizationId !== orgId && i.id !== orgId)); }
    catch (e) { console.error(e); }
  };

  return (
    <div className="max-w-[1200px] mx-auto px-4 lg:px-8 py-8">
      <div className="slash-label mb-2">КАБИНЕТ КЛИЕНТА</div>
      <h1 className="font-display tracking-bebas text-4xl md:text-5xl mb-6">ИЗБРАННОЕ</h1>

      {loading ? (
        <p className="text-sm" style={{ color: 'var(--text-soft)' }}>Загрузка…</p>
      ) : items.length === 0 ? (
        <div className="card text-center py-16">
          <Heart size={32} className="text-amber mx-auto mb-3" />
          <p className="mb-4" style={{ color: 'var(--text-soft)' }}>В избранном пока пусто</p>
          <Link to="/search" className="btn-primary">Найти мастера</Link>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {items.map((p: any) => (
            <div key={p.id || p.organizationId} className="provider-card p-5 flex flex-col gap-3" data-testid={`fav-${p.id}`}>
              <div className="flex items-start justify-between">
                <Link to={`/provider/${p.slug || p.id}`}>
                  <h3 className="font-display tracking-bebas text-xl hover:text-amber transition-colors">{p.name}</h3>
                </Link>
                <button onClick={() => remove(p.organizationId || p.id)} className="text-amber" title="Убрать"><Heart size={16} fill="currentColor" /></button>
              </div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs" style={{ color: 'var(--text-soft)' }}>
                <span className="flex items-center gap-1"><Star size={12} className="text-amber" fill="currentColor" />{p.ratingAvg ?? '—'}</span>
                <span className="flex items-center gap-1"><MapPin size={12} className="text-amber" />{p.distanceKm ?? '—'} км</span>
                <span className="flex items-center gap-1"><Clock size={12} className="text-amber" />{p.etaMinutes ?? '—'} мин</span>
              </div>
              <div className="hairline-t pt-3 mt-auto flex items-center justify-between">
                <span className="font-display tracking-bebas text-2xl text-amber">{p.priceFrom ?? 500} ₴</span>
                <Link to={`/provider/${p.slug || p.id}`} className="btn-primary btn-sm">Открыть <ArrowRight size={12} /></Link>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
