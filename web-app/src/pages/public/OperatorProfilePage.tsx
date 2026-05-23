// OperatorProfilePage — /operator/:slug
// Premium hybrid creator/host/expert profile.
// Trust graph terminus: case → specialist → "order from this expert".
import { useEffect } from 'react';
import { useParams, Link, Navigate } from 'react-router-dom';
import {
  ArrowRight, ArrowLeft, MapPin, Star, Camera, Clock, Award,
  ShieldCheck, Euro, ChevronRight, TrendingUp, Languages, Calendar, CheckCircle2, AlertTriangle, AlertOctagon,
} from 'lucide-react';
import { findOperator, operatorFeaturedCases } from '../../data/operators';
import { VERDICT_META } from '../../data/cases';

function fmt(n: number) { return n.toLocaleString('ru-RU'); }
function fmtDate(iso: string) {
  try { return new Date(iso).toLocaleDateString('ru-RU', { day: '2-digit', month: 'short', year: 'numeric' }); }
  catch { return iso; }
}

export default function OperatorProfilePage() {
  const { slug = '' } = useParams<{ slug: string }>();
  const op = findOperator(slug);
  useEffect(() => { window.scrollTo(0, 0); }, [slug]);

  if (!op) return <Navigate to="/specialists" replace />;

  const featured = operatorFeaturedCases(op);

  return (
    <div className="bg-white" data-testid="operator-page">
      {/* ── BREADCRUMB ─── */}
      <div className="border-b border-[var(--border)]">
        <div className="mx-auto max-w-7xl px-4 md:px-6 h-14 flex items-center text-sm">
          <Link to="/specialists" className="inline-flex items-center gap-1.5 text-[var(--text-soft)] hover:text-[var(--text)]" data-testid="op-back">
            <ArrowLeft size={14} /> Все специалисты
          </Link>
          <ChevronRight size={14} className="mx-2 text-[var(--text-soft)]" />
          <span className="font-semibold truncate">{op.name}</span>
        </div>
      </div>

      {/* ══════════════════════════════════════════════════════════════
          IDENTITY HERO
          ══════════════════════════════════════════════════════════════ */}
      <section>
        <div className="mx-auto max-w-7xl px-4 md:px-6 pt-10 md:pt-16 pb-12">
          <div className="grid lg:grid-cols-12 gap-10 items-start">
            {/* Portrait */}
            <div className="lg:col-span-5">
              <div className="aspect-[4/5] rounded-3xl overflow-hidden bg-[#0b0b0d] relative">
                <img src={op.portrait} alt={op.name} className="w-full h-full object-cover" />
                <div className="absolute top-5 left-5 inline-flex items-center gap-2 rounded-full bg-[var(--primary)] px-3 py-1.5 text-xs font-black uppercase tracking-wider text-black">
                  <Award size={13} /> TÜV-сертифицирован
                </div>
              </div>
            </div>

            {/* Identity */}
            <div className="lg:col-span-7">
              <div className="text-xs font-black uppercase tracking-[0.18em] text-[var(--text-soft)]">{op.title}</div>
              <h1 className="mt-3 text-5xl md:text-6xl lg:text-7xl font-black tracking-tight leading-[1.02]" data-testid="op-name">{op.name}</h1>

              <div className="mt-6 flex flex-wrap gap-x-5 gap-y-2 text-sm text-[var(--text-2)]">
                <span className="inline-flex items-center gap-1.5"><MapPin size={14} /> {op.cities.join(' · ')}</span>
                <span className="inline-flex items-center gap-1.5"><Calendar size={14} /> {op.yearsExperience} лет в профессии</span>
                <span className="inline-flex items-center gap-1.5"><Languages size={14} /> {op.languages.join(' · ')}</span>
              </div>

              <div className="mt-8 space-y-4 max-w-2xl">
                {op.bio.map((p, i) => <p key={i} className="text-base md:text-lg text-[var(--text-2)] leading-relaxed">{p}</p>)}
              </div>

              <div className="mt-9 flex flex-col sm:flex-row gap-3 max-w-xl">
                <Link to="/inspect" className="flex-1 inline-flex items-center justify-center gap-2 rounded-xl bg-black hover:bg-[#1f2937] text-white h-14 px-6 text-base font-bold transition-colors" data-testid="op-cta-book">
                  Заказать проверку у {op.name.split(' ')[0]} <ArrowRight size={18} />
                </Link>
                <a href={`mailto:hello@autosearch.de?subject=${encodeURIComponent('Question for ' + op.name)}`} className="inline-flex items-center justify-center gap-2 rounded-xl border border-[var(--border)] hover:bg-[var(--surface-soft)] h-14 px-6 text-base font-bold">
                  Задать вопрос
                </a>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ══════════════════════════════════════════════════════════════
          TRUST STRIP — 5 metrics, full width, dark slab
          ══════════════════════════════════════════════════════════════ */}
      <section className="bg-[#0b0b0d] text-white">
        <div className="mx-auto max-w-7xl px-4 md:px-6 py-12 md:py-16 grid grid-cols-2 md:grid-cols-5 gap-y-8 gap-x-4" data-testid="op-trust-strip">
          <TrustMetric icon={<Camera size={18} />}      value={String(op.inspectionsCount)}                    label="Inspections" />
          <TrustMetric icon={<Euro size={18} />}        value={`€${(op.savedTotalEur / 1000).toFixed(0)}k`}    label="Сэкономлено покупателям" highlight />
          <TrustMetric icon={<Star size={18} />}        value={op.ratingAvg.toFixed(1)}                         label={`${op.reviewsCount} отзывов`} />
          <TrustMetric icon={<TrendingUp size={18} />}  value={`${op.recommendPct}%`}                          label="Рекомендуют" />
          <TrustMetric icon={<Clock size={18} />}       value={`${op.responseMinutes} мин`}                    label="Ответ в среднем" />
        </div>
      </section>

      {/* ══════════════════════════════════════════════════════════════
          FEATURED CASES — huge image-first cards → /case/:id
          ══════════════════════════════════════════════════════════════ */}
      {featured.length > 0 && (
        <section className="bg-white border-b border-[var(--border)]">
          <div className="mx-auto max-w-7xl px-4 md:px-6 py-20">
            <div className="max-w-3xl mb-12">
              <span className="text-xs font-black uppercase tracking-[0.18em] text-[var(--text-soft)]">Featured cases</span>
              <h2 className="mt-3 text-3xl md:text-5xl font-black tracking-tight">Что находил в реальных проверках</h2>
              <p className="mt-4 text-base text-[var(--text-2)]">Каждый кейс — отчёт с фото, видео, чек-листом и вердиктом. Это работа {op.name.split(' ')[0]}, а не маркетинг.</p>
            </div>

            <div className="space-y-8">
              {featured.map(c => {
                const v = VERDICT_META[c.verdict];
                return (
                  <Link
                    key={c.id}
                    to={`/case/${c.slug}`}
                    className="group block rounded-3xl overflow-hidden border border-[var(--border)] bg-white hover:border-[var(--text)] transition"
                    data-testid={`op-featured-${c.slug}`}
                  >
                    <div className="grid lg:grid-cols-12">
                      <div className="lg:col-span-7 aspect-[16/9] lg:aspect-auto bg-[#0b0b0d] relative overflow-hidden">
                        <img src={c.heroImage} alt={c.title} className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-[1.03]" />
                        <div className="absolute top-5 left-5 inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-black uppercase tracking-wider text-white" style={{ background: v.accent }}>
                          <ShieldCheck size={13} /> {v.short}
                        </div>
                      </div>
                      <div className="lg:col-span-5 p-8 md:p-10 flex flex-col">
                        <div className="text-xs font-black uppercase tracking-[0.18em] text-[var(--text-soft)]">{c.country} · {c.city} · {c.year}</div>
                        <h3 className="mt-3 text-3xl md:text-4xl font-black tracking-tight leading-tight">{c.title}</h3>
                        <p className="mt-4 text-base text-[var(--text-2)] line-clamp-3">{c.verdictHeadline}. {c.verdictSummary}</p>
                        <div className="mt-auto pt-7 grid grid-cols-2 gap-3">
                          <div className="rounded-xl bg-[var(--surface-soft)] p-4">
                            <div className="text-[10px] font-black uppercase tracking-wider text-[var(--text-soft)]">Цена</div>
                            <div className="mt-1 font-black text-xl">€{fmt(c.askingPrice)}</div>
                          </div>
                          {c.saved > 0 ? (
                            <div className="rounded-xl bg-[var(--primary)] text-black p-4">
                              <div className="text-[10px] font-black uppercase tracking-wider opacity-70">Сэкономили</div>
                              <div className="mt-1 font-black text-xl">€{fmt(c.saved)}</div>
                            </div>
                          ) : (
                            <div className="rounded-xl bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200 p-4">
                              <div className="text-[10px] font-black uppercase tracking-wider opacity-70">Вердикт</div>
                              <div className="mt-1 font-black text-xl">PASS</div>
                            </div>
                          )}
                        </div>
                        <div className="mt-6 inline-flex items-center gap-2 text-sm font-bold">Открыть кейс <ArrowRight size={15} className="transition-transform group-hover:translate-x-0.5" /></div>
                      </div>
                    </div>
                  </Link>
                );
              })}
            </div>
          </div>
        </section>
      )}

      {/* ══════════════════════════════════════════════════════════════
          EXPERTISE — rich tag grid (not "services")
          ══════════════════════════════════════════════════════════════ */}
      <section className="bg-[var(--surface-soft)]">
        <div className="mx-auto max-w-7xl px-4 md:px-6 py-20">
          <div className="max-w-3xl mb-12">
            <span className="text-xs font-black uppercase tracking-[0.18em] text-[var(--text-soft)]">Expertise</span>
            <h2 className="mt-3 text-3xl md:text-5xl font-black tracking-tight">На чём специализируется</h2>
          </div>
          <div className="grid md:grid-cols-2 gap-4">
            {op.expertise.map(e => (
              <div key={e.key} className="rounded-3xl border border-[var(--border)] bg-white p-7 md:p-8" data-testid={`op-expertise-${e.key}`}>
                <h3 className="text-xl md:text-2xl font-black tracking-tight">{e.label}</h3>
                <p className="mt-3 text-base text-[var(--text-2)] leading-relaxed">{e.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ══════════════════════════════════════════════════════════════
          METHODOLOGY — numbered process. Makes them an expert, not a "master"
          ══════════════════════════════════════════════════════════════ */}
      <section className="bg-white border-y border-[var(--border)]">
        <div className="mx-auto max-w-7xl px-4 md:px-6 py-20">
          <div className="max-w-3xl mb-12">
            <span className="text-xs font-black uppercase tracking-[0.18em] text-[var(--text-soft)]">Методика осмотра</span>
            <h2 className="mt-3 text-3xl md:text-5xl font-black tracking-tight">Процесс, не «посмотрю».</h2>
            <p className="mt-4 text-base text-[var(--text-2)]">Каждая проверка идёт по протоколу из шести шагов. Это то, чем профессиональный осмотр отличается от «разговора с другом-механиком».</p>
          </div>
          <ol className="grid md:grid-cols-2 lg:grid-cols-3 gap-5">
            {op.methodology.map(s => (
              <li key={s.n} className="rounded-3xl border border-[var(--border)] bg-white p-7 md:p-8" data-testid={`op-method-${s.n}`}>
                <div className="text-3xl font-black tracking-tight text-[var(--text-soft)]">{s.n}</div>
                <h3 className="mt-3 text-xl font-black">{s.title}</h3>
                <p className="mt-2 text-sm text-[var(--text-2)] leading-relaxed">{s.desc}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* ══════════════════════════════════════════════════════════════
          ACTIVITY — recent timeline. Makes the platform feel live
          ══════════════════════════════════════════════════════════════ */}
      <section className="bg-[var(--surface-soft)]">
        <div className="mx-auto max-w-7xl px-4 md:px-6 py-20">
          <div className="flex items-end justify-between gap-4 mb-10">
            <div className="max-w-2xl">
              <span className="text-xs font-black uppercase tracking-[0.18em] text-[var(--text-soft)]">Recent activity</span>
              <h2 className="mt-3 text-3xl md:text-5xl font-black tracking-tight">Последние проверки</h2>
            </div>
            <span className="text-sm text-[var(--text-soft)] hidden md:inline">{op.activity.length} за последний месяц</span>
          </div>

          <div className="rounded-3xl border border-[var(--border)] bg-white overflow-hidden" data-testid="op-activity">
            <ul className="divide-y divide-[var(--border)]">
              {op.activity.map((a, i) => {
                const v = VERDICT_META[a.verdict];
                const VIcon = a.verdict === 'pass' ? CheckCircle2 : a.verdict === 'risk' ? AlertTriangle : AlertOctagon;
                const Row = (
                  <div className="flex items-center gap-4 p-5 md:p-6 hover:bg-[var(--surface-soft)] transition-colors">
                    <div className="hidden sm:flex shrink-0 h-11 w-11 rounded-xl items-center justify-center text-white" style={{ background: v.accent }}>
                      <VIcon size={20} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-bold uppercase tracking-wider text-[var(--text-soft)]">{fmtDate(a.ts)} · {a.city}</div>
                      <div className="mt-1 text-base md:text-lg font-extrabold truncate">{a.vehicle}</div>
                    </div>
                    <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-black uppercase tracking-wider text-white shrink-0" style={{ background: v.accent }}>
                      {v.short}
                    </span>
                    {a.caseSlug ? <ArrowRight size={16} className="text-[var(--text-soft)] shrink-0" /> : <span className="w-4 shrink-0" />}
                  </div>
                );
                return (
                  <li key={i}>
                    {a.caseSlug ? (
                      <Link to={`/case/${a.caseSlug}`} className="block">{Row}</Link>
                    ) : (
                      <div>{Row}</div>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      </section>

      {/* ══════════════════════════════════════════════════════════════
          FINAL CTA
          ══════════════════════════════════════════════════════════════ */}
      <section className="bg-[#0b0b0d] text-white">
        <div className="mx-auto max-w-7xl px-4 md:px-6 py-20 grid lg:grid-cols-12 gap-8 items-center">
          <div className="lg:col-span-8">
            <h2 className="text-3xl md:text-5xl font-black tracking-tight">Заказать проверку у&nbsp;{op.name}</h2>
            <p className="mt-4 text-lg text-white/70 max-w-2xl">Вставьте ссылку на объявление с mobile.de или autoscout24. Если {op.name.split(' ')[0]} доступен — назначим его. Если нет — подберём инспектора того же уровня в&nbsp;{op.homeCity}.</p>
          </div>
          <div className="lg:col-span-4 flex flex-col sm:flex-row lg:justify-end gap-3">
            <Link to="/inspect" className="inline-flex items-center justify-center gap-2 rounded-xl bg-[var(--primary)] hover:bg-[#facc15] px-7 h-14 text-base font-bold text-black">
              Проверить авто <ArrowRight size={18} />
            </Link>
            <Link to="/specialists" className="inline-flex items-center justify-center gap-2 rounded-xl border border-white/30 hover:bg-white/10 px-7 h-14 text-base font-bold text-white">
              Другие эксперты
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}

function TrustMetric({ icon, value, label, highlight }: { icon: React.ReactNode; value: string; label: string; highlight?: boolean }) {
  return (
    <div className="text-center md:text-left px-2">
      <div className={`inline-flex items-center gap-1.5 ${highlight ? 'text-[var(--primary)]' : 'text-white/60'}`}>{icon}</div>
      <div className={`mt-2 text-4xl md:text-5xl font-black tracking-tight leading-none ${highlight ? 'text-[var(--primary)]' : 'text-white'}`}>{value}</div>
      <div className="mt-2 text-xs uppercase tracking-wider text-white/50">{label}</div>
    </div>
  );
}
