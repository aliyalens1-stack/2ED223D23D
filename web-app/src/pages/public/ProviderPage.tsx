import { useState, useEffect } from 'react';
import { useParams, useNavigate, useSearchParams, Link } from 'react-router-dom';
import {
  Star, MapPin, Clock, ShieldCheck, Heart, ChevronRight, Calendar, Award,
  CheckCircle2, FileText, Sparkles, Phone, ArrowLeft, Zap, AlertTriangle, Wrench,
} from 'lucide-react';
import { marketplaceAPI, favoritesAPI } from '../../services/api';
import BookingModal from '../../components/BookingModal';
import QuickRequestModal from '../../components/QuickRequestModal';

/**
 * Sprint 14.5 — Light ProviderPage
 *
 * Layout: light hero with KPI grid · sticky right CTA · tabbed content.
 * Yellow only on primary action (Book), Quick request as dark secondary.
 */

const TABS = [
  { id: 'services', label: 'Services'   },
  { id: 'slots',    label: 'Time slots' },
  { id: 'reviews',  label: 'Reviews'    },
  { id: 'why',      label: 'Why us'     },
  { id: 'zone',     label: 'Service area' },
];

export default function ProviderPage() {
  const { slug } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [p, setP]                   = useState<any>(null);
  const [loading, setLoading]       = useState(true);
  const [tab, setTab]               = useState('services');
  const [bookingOpen, setBookingOpen] = useState(false);
  const [quickOpen, setQuickOpen]   = useState(false);
  const [favorited, setFavorited]   = useState(false);
  const [slots, setSlots]           = useState<any[]>([]);
  const [slotDate, setSlotDate]     = useState(() => new Date().toISOString().split('T')[0]);

  useEffect(() => {
    if (!slug) return;
    setLoading(true);
    marketplaceAPI.getProviderDetail(slug)
      .then((r: any) => setP(r.data))
      .catch(() => setP(null))
      .finally(() => setLoading(false));
  }, [slug]);

  // Auto-open booking when ?action=book in URL
  useEffect(() => {
    if (!loading && p && searchParams.get('action') === 'book') {
      setBookingOpen(true);
    }
  }, [loading, p, searchParams]);

  useEffect(() => {
    if (tab === 'slots' && p?.slug) {
      marketplaceAPI.getProviderSlots(p.slug, slotDate)
        .then(r => setSlots(r.data?.slots || []))
        .catch(() => {
          const fb = [];
          for (let h = 9; h < 19; h++) for (const m of [0, 30]) fb.push({ time: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`, available: Math.random() > 0.3 });
          setSlots(fb);
        });
    }
  }, [tab, p, slotDate]);

  const toggleFav = async () => {
    setFavorited(!favorited);
    try { favorited ? await favoritesAPI.remove(p.id) : await favoritesAPI.add(p.id); } catch {}
  };

  if (loading) {
    return (
      <div className="mx-auto max-w-7xl px-4 py-12">
        <div className="h-12 w-72 bg-[var(--surface-2)] rounded-xl mb-4 animate-pulse" />
        <div className="grid lg:grid-cols-[1fr_360px] gap-8">
          <div className="space-y-3">
            {[1,2,3,4].map(i => <div key={i} className="h-20 bg-[var(--surface-2)] rounded-2xl animate-pulse" />)}
          </div>
          <div className="h-72 bg-[var(--surface-2)] rounded-2xl animate-pulse" />
        </div>
      </div>
    );
  }

  if (!p) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-16 text-center" data-testid="provider-not-found">
        <AlertTriangle size={32} className="mx-auto text-[var(--warning)] mb-3" />
        <div className="text-2xl font-extrabold mb-2">Provider not found</div>
        <p className="text-[var(--text-2)] mb-6">The mechanic you're looking for is not available right now.</p>
        <Link to="/search" className="btn-primary inline-flex"><ArrowLeft size={14} /> Back to search</Link>
      </div>
    );
  }

  const rating = Number(p.ratingAvg ?? p.rating ?? 0).toFixed(1);
  const cityArea = `${p.city || 'Berlin'}${p.address ? ' · ' + p.address.split(',')[0] : ''}`;
  const reviewsCount = p.reviewsCount ?? 0;
  const orderCount = p.completedOrdersCount ?? p.totalBookings ?? 0;
  const eta = p.avgEtaMinutes ?? p.eta ?? '—';
  const distance = p.distanceKm ? Number(p.distanceKm).toFixed(1) : '—';

  return (
    <div data-testid="provider-page">
      {/* ─── HERO (light) ───────────────────────────────────────── */}
      <section className="relative overflow-hidden border-b border-[var(--border)] bg-[var(--surface-soft)]">
        <div className="mx-auto max-w-7xl px-4 md:px-6 py-10">
          <div className="mb-5">
            <Link to="/search" className="inline-flex items-center gap-1 text-sm font-semibold text-[var(--text-2)] hover:text-[var(--text)]" data-testid="provider-back">
              <ArrowLeft size={14} /> Back to results
            </Link>
          </div>

          <div className="grid lg:grid-cols-[1fr_360px] gap-8">
            {/* LEFT */}
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.18em] text-[var(--primary-h)]" data-testid="provider-area">
                {cityArea}
              </p>
              <h1 className="text-4xl md:text-5xl font-extrabold tracking-tight text-[var(--text)] mt-2" data-testid="provider-name">
                {p.name}
              </h1>
              {p.specialization && (
                <p className="mt-3 text-[var(--text-2)] max-w-2xl" data-testid="provider-specialization">
                  {p.specialization}
                </p>
              )}

              {/* KPI grid */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-6" data-testid="provider-kpi">
                <KPI label="Rating" value={`${rating} ★`} sub={`${reviewsCount} reviews`} />
                <KPI label="Orders" value={orderCount > 0 ? `${orderCount}+` : '—'} sub="completed" />
                <KPI label="ETA" value={typeof eta === 'number' ? `${eta} min` : '—'} sub="response" />
                <KPI label="Distance" value={distance !== '—' ? `${distance} km` : '—'} sub="from you" />
              </div>

              {/* Trust badges */}
              <div className="flex flex-wrap gap-2 mt-5" data-testid="provider-badges">
                {(p.badges?.length ? p.badges : ['verified', 'mobile', 'warranty', 'fast-response']).slice(0, 6).map((b: string) => (
                  <span
                    key={b}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-full border border-[var(--border)] bg-white"
                  >
                    {b === 'verified' && <ShieldCheck size={12} className="text-[var(--success)]" />}
                    {b === 'fast-response' && <Zap size={12} className="text-[var(--primary-p)]" />}
                    {b === 'warranty' && <Award size={12} className="text-[var(--primary-p)]" />}
                    {b === 'mobile' && <MapPin size={12} className="text-[var(--text-2)]" />}
                    {b.charAt(0).toUpperCase() + b.slice(1).replace('-', ' ')}
                  </span>
                ))}
              </div>

              {/* Trust strip */}
              <div className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-[var(--text-2)]">
                <span className="inline-flex items-center gap-1.5"><FileText size={14} /> Invoice ready</span>
                <span className="inline-flex items-center gap-1.5"><CheckCircle2 size={14} /> VAT included</span>
                <span className="inline-flex items-center gap-1.5"><Award size={14} /> {p.warranty || '1 year'} warranty</span>
                <span className="inline-flex items-center gap-1.5"><ShieldCheck size={14} /> Verified license</span>
              </div>
            </div>

            {/* RIGHT — sticky CTA card */}
            <aside className="lg:sticky lg:top-24 h-fit rounded-2xl border border-[var(--border)] bg-white p-5 shadow-[var(--shadow-card)]" data-testid="provider-cta-card">
              <div className="flex items-center justify-between mb-4">
                <span className={`text-sm font-bold inline-flex items-center gap-1.5 ${p.isOnline ? 'text-[var(--success)]' : 'text-[var(--text-soft)]'}`}>
                  <span className={`h-2 w-2 rounded-full ${p.isOnline ? 'bg-[var(--success)]' : 'bg-[var(--text-soft)]'}`} />
                  {p.isOnline ? 'Open now' : 'Closed'}
                </span>
                <span className="text-xs text-[var(--text-soft)]">Replies in {p.avgResponseTimeMinutes || 5} min</span>
              </div>

              <div className="border-t border-[var(--border)] pt-4 mb-4">
                <div className="text-[11px] uppercase tracking-wider font-semibold text-[var(--text-soft)]">from</div>
                <div className="text-3xl font-extrabold">{p.priceFrom || 350} €</div>
                <div className="text-[11px] text-[var(--text-soft)] mt-0.5">VAT incl. · Invoice on request</div>
              </div>

              <button
                onClick={() => setBookingOpen(true)}
                className="btn-primary btn-lg w-full"
                data-testid="provider-cta-book"
              >
                <Calendar size={16} /> Book a slot
              </button>
              <button
                onClick={() => setQuickOpen(true)}
                className="btn-dark w-full mt-2"
                data-testid="provider-cta-quick"
              >
                <Zap size={16} /> Quick request
              </button>
              <div className="grid grid-cols-2 gap-2 mt-3">
                <button onClick={toggleFav} className="btn-secondary btn-sm" data-testid="provider-cta-fav">
                  <Heart size={14} className={favorited ? 'fill-[var(--danger)] text-[var(--danger)]' : ''} />
                  {favorited ? 'Saved' : 'Save'}
                </button>
                {p.phone && (
                  <a href={`tel:${p.phone}`} className="btn-secondary btn-sm" data-testid="provider-cta-call">
                    <Phone size={14} /> Call
                  </a>
                )}
              </div>
            </aside>
          </div>
        </div>
      </section>

      {/* ─── TABS NAV ───────────────────────────────────────────── */}
      <div className="sticky top-16 z-30 bg-white/95 backdrop-blur border-b border-[var(--border)]">
        <div className="mx-auto max-w-7xl px-4 md:px-6 overflow-x-auto no-scrollbar">
          <div className="flex gap-1 py-2">
            {TABS.map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={[
                  'px-4 py-2 rounded-xl text-sm font-bold whitespace-nowrap transition',
                  tab === t.id ? 'bg-[var(--primary-soft)] text-[var(--text)]' : 'text-[var(--text-2)] hover:bg-[var(--surface-soft)]',
                ].join(' ')}
                data-testid={`provider-tab-${t.id}`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ─── TAB CONTENT ────────────────────────────────────────── */}
      <section className="mx-auto max-w-7xl px-4 md:px-6 py-8">
        <div className="grid lg:grid-cols-[1fr_360px] gap-8">
          <div className="min-w-0">
            {tab === 'services' && <ServicesTab services={p.services || []} onBook={() => setBookingOpen(true)} />}
            {tab === 'slots' && (
              <SlotsTab
                slots={slots}
                date={slotDate}
                onDate={setSlotDate}
                onPick={() => setBookingOpen(true)}
              />
            )}
            {tab === 'reviews' && <ReviewsTab reviews={p.recentReviews || []} rating={rating} count={reviewsCount} />}
            {tab === 'why' && <WhyTab provider={p} />}
            {tab === 'zone' && <ZoneTab provider={p} />}
          </div>

          <aside className="hidden lg:block">
            <SimilarProviders currentSlug={slug || ''} />
          </aside>
        </div>
      </section>

      {bookingOpen && (
        <BookingModal
          provider={p}
          isOpen={bookingOpen}
          onClose={() => setBookingOpen(false)}
          onSuccess={(bookingId: string) => {
            setBookingOpen(false);
            navigate(`/booking/${bookingId}/track`);
          }}
        />
      )}
      <QuickRequestModal isOpen={quickOpen} onClose={() => setQuickOpen(false)} />
    </div>
  );
}

/* ─── helpers ─────────────────────────────────────────────────── */

function KPI({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-white border border-[var(--border)] rounded-xl p-3.5">
      <div className="text-lg font-extrabold text-[var(--text)]">{value}</div>
      <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-soft)] mt-0.5">{label}</div>
      {sub && <div className="text-[10px] text-[var(--text-soft)] mt-0.5">{sub}</div>}
    </div>
  );
}

function ServicesTab({ services, onBook }: { services: any[]; onBook: () => void }) {
  if (!services.length) return <Empty icon={<Wrench size={26} />} title="No services listed" hint="The provider hasn't listed individual services yet — use Quick request or Book a slot." />;
  return (
    <div className="space-y-3" data-testid="provider-services-list">
      <h2 className="text-lg font-extrabold mb-2">Services</h2>
      {services.map((s: any) => (
        <div key={s.id || s._id} className="flex items-center justify-between gap-4 rounded-xl border border-[var(--border)] bg-white p-4 hover:border-[var(--border-strong)] transition">
          <div className="min-w-0">
            <div className="font-bold truncate">{s.name || s.title}</div>
            <div className="text-xs text-[var(--text-2)] mt-0.5">{s.duration ? `${s.duration} min` : 'Time on request'}{s.warranty ? ` · ${s.warranty}` : ''}</div>
          </div>
          <div className="text-right shrink-0">
            <div className="text-lg font-extrabold">{s.priceFrom || s.price || s.basePrice || '—'} €</div>
            <button onClick={onBook} className="text-xs font-bold text-[var(--primary-h)] hover:underline">Book →</button>
          </div>
        </div>
      ))}
    </div>
  );
}

function SlotsTab({ slots, date, onDate, onPick }: { slots: any[]; date: string; onDate: (d: string) => void; onPick: () => void }) {
  return (
    <div data-testid="provider-slots">
      <h2 className="text-lg font-extrabold mb-3">Available time slots</h2>
      <div className="mb-4 flex items-center gap-2">
        <Calendar size={14} className="text-[var(--text-soft)]" />
        <input
          type="date"
          value={date}
          onChange={(e) => onDate(e.target.value)}
          min={new Date().toISOString().split('T')[0]}
          className="input-light h-10 max-w-xs"
        />
      </div>
      {slots.length === 0 ? (
        <Empty icon={<Calendar size={26} />} title="No slots for that day" hint="Try a different date or use Quick request." />
      ) : (
        <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-2">
          {slots.map((s, i) => (
            <button
              key={i}
              disabled={!s.available}
              onClick={onPick}
              className={[
                'h-12 rounded-xl border text-sm font-bold transition',
                s.available
                  ? 'bg-white border-[var(--border)] hover:border-[var(--primary)] hover:bg-[var(--primary-soft)]'
                  : 'bg-[var(--surface-2)] border-[var(--border)] text-[var(--text-soft)] cursor-not-allowed line-through',
              ].join(' ')}
            >
              {s.time}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ReviewsTab({ reviews, rating, count }: { reviews: any[]; rating: string; count: number }) {
  return (
    <div data-testid="provider-reviews">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-extrabold">Reviews</h2>
        <div className="inline-flex items-center gap-2 text-sm">
          <Star size={16} className="text-[var(--primary)] fill-[var(--primary)]" />
          <span className="font-extrabold">{rating}</span>
          <span className="text-[var(--text-soft)]">· {count} reviews</span>
        </div>
      </div>
      {reviews.length === 0 ? (
        <Empty icon={<Star size={26} />} title="No reviews yet" hint="Be the first to book and leave feedback." />
      ) : (
        <div className="space-y-3">
          {reviews.map((r: any, i: number) => (
            <div key={r.id || i} className="rounded-xl border border-[var(--border)] bg-white p-4">
              <div className="flex items-center justify-between mb-1">
                <div className="font-bold">{r.author || 'Customer'}</div>
                <div className="inline-flex items-center gap-1 text-sm font-bold">
                  <Star size={13} className="text-[var(--primary)] fill-[var(--primary)]" /> {r.rating}
                </div>
              </div>
              <p className="text-sm text-[var(--text-2)]">{r.comment || r.text}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function WhyTab({ provider }: { provider: any }) {
  const advantages = [
    { icon: <ShieldCheck size={18} />, title: 'Verified license',  text: 'Identity, business and license verified by AutoSearch.' },
    { icon: <Award size={18} />,        title: `${provider.warranty || '1 year'} warranty`, text: 'Workmanship covered. Free re-fix if the issue returns.' },
    { icon: <FileText size={18} />,     title: 'Invoice ready',   text: 'VAT included on every job. Insurance compatible.' },
    { icon: <Sparkles size={18} />,     title: 'Fast response',   text: `Replies within ${provider.avgResponseTimeMinutes || 5} minutes on average.` },
    { icon: <CheckCircle2 size={18} />, title: 'Top rated',       text: `${Number(provider.ratingAvg ?? 4.5).toFixed(1)} ★ across ${provider.reviewsCount ?? 0} reviews.` },
    { icon: <MapPin size={18} />,       title: 'Local & mobile',  text: 'Workshop visits and on-site mobile service.' },
  ];
  return (
    <div data-testid="provider-why">
      <h2 className="text-lg font-extrabold mb-4">Why choose us</h2>
      <div className="grid sm:grid-cols-2 gap-3">
        {advantages.map((a, i) => (
          <div key={i} className="rounded-xl border border-[var(--border)] bg-white p-4">
            <div className="h-9 w-9 rounded-lg bg-[var(--primary-soft)] text-[var(--primary-p)] inline-flex items-center justify-center mb-2">{a.icon}</div>
            <div className="font-bold">{a.title}</div>
            <div className="text-sm text-[var(--text-2)] mt-1">{a.text}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ZoneTab({ provider }: { provider: any }) {
  return (
    <div data-testid="provider-zone">
      <h2 className="text-lg font-extrabold mb-3">Service area</h2>
      <div className="rounded-2xl border border-[var(--border)] bg-white p-5">
        <div className="flex items-start gap-3 mb-3">
          <MapPin size={20} className="text-[var(--text-soft)] mt-0.5" />
          <div>
            <div className="font-bold">{provider.city || 'Berlin'}</div>
            {provider.address && <div className="text-sm text-[var(--text-2)]">{provider.address}</div>}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3 text-sm mt-4">
          <Info label="Service radius" value={`${provider.serviceRadiusKm || 15} km`} />
          <Info label="Mobile service"  value={provider.mobileService ? 'Yes' : 'On request'} />
          <Info label="Min order"       value={`${provider.minOrderAmount || 50} €`} />
          <Info label="Open hours"      value={provider.openHours || 'Mon-Sat 8:00-19:00'} />
        </div>
      </div>
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-[var(--surface-soft)] border border-[var(--border)] p-3">
      <div className="text-[11px] uppercase tracking-wider font-semibold text-[var(--text-soft)]">{label}</div>
      <div className="font-bold mt-0.5">{value}</div>
    </div>
  );
}

function Empty({ icon, title, hint }: { icon: React.ReactNode; title: string; hint: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-[var(--border-strong)] bg-white p-10 text-center">
      <div className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-[var(--surface-soft)] text-[var(--text-soft)] mb-3">{icon}</div>
      <div className="font-bold mb-1">{title}</div>
      <p className="text-sm text-[var(--text-2)] max-w-md mx-auto">{hint}</p>
    </div>
  );
}

function SimilarProviders({ currentSlug }: { currentSlug: string }) {
  const [list, setList] = useState<any[]>([]);
  useEffect(() => {
    marketplaceAPI.getProviders().then(r => {
      const all = r.data?.providers ?? r.data ?? [];
      setList((Array.isArray(all) ? all : []).filter((x: any) => x.slug !== currentSlug).slice(0, 4));
    }).catch(() => {});
  }, [currentSlug]);
  if (list.length === 0) return null;
  return (
    <div className="rounded-2xl border border-[var(--border)] bg-white p-5">
      <div className="text-xs font-bold uppercase tracking-[0.18em] text-[var(--primary-h)] mb-3">Similar nearby</div>
      <div className="space-y-3">
        {list.map((p) => (
          <Link
            key={p.slug}
            to={`/provider/${p.slug}`}
            className="flex items-center gap-3 rounded-xl p-2 -mx-2 hover:bg-[var(--surface-soft)] transition"
          >
            <div className="h-12 w-12 rounded-xl bg-[var(--surface-2)] flex items-center justify-center shrink-0 overflow-hidden">
              {p.logo ? <img src={p.logo} className="h-full w-full object-cover" alt="" /> : <Wrench size={18} className="text-[var(--text-soft)]" />}
            </div>
            <div className="min-w-0 flex-1">
              <div className="font-bold truncate text-sm">{p.name}</div>
              <div className="text-xs text-[var(--text-2)] flex items-center gap-1">
                <Star size={11} className="text-[var(--primary)] fill-[var(--primary)]" />
                {Number(p.ratingAvg ?? p.rating ?? 4.5).toFixed(1)}
                <span className="text-[var(--text-soft)]">· from {p.priceFrom || 300} €</span>
              </div>
            </div>
            <ChevronRight size={14} className="text-[var(--text-soft)] shrink-0" />
          </Link>
        ))}
      </div>
    </div>
  );
}
