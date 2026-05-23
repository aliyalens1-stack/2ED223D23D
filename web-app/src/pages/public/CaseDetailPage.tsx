// CaseDetailPage — /case/:id
// Premium inspection case page. Cinematic hierarchy: vehicle hero,
// verdict banner, gallery, findings, timeline, specialist, PDF preview, CTA.
import { useParams, Link, Navigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import {
  ArrowRight, ArrowLeft, Calendar, MapPin, Gauge, FileText, Download,
  ShieldCheck, Camera, Clock, CheckCircle2, AlertTriangle, AlertOctagon, Info,
  Star, Award, ChevronRight,
} from 'lucide-react';
import { findCase, VERDICT_META, SEVERITY_META, type Severity } from '../../data/cases';

const SEV_ICON: Record<Severity, typeof CheckCircle2> = {
  critical: AlertOctagon,
  warning:  AlertTriangle,
  info:     Info,
  ok:       CheckCircle2,
};

function fmt(n: number) { return n.toLocaleString('ru-RU'); }
function fmtDate(iso: string) {
  try { return new Date(iso).toLocaleDateString('ru-RU', { day: '2-digit', month: 'long', year: 'numeric' }); }
  catch { return iso; }
}

export default function CaseDetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  const c = findCase(id);
  const [activePhoto, setActivePhoto] = useState(0);

  useEffect(() => { window.scrollTo(0, 0); }, [id]);

  if (!c) return <Navigate to="/reports" replace />;

  const v = VERDICT_META[c.verdict];
  const findingsByCategory = c.findings.reduce<Record<string, typeof c.findings>>((acc, f) => {
    (acc[f.category] = acc[f.category] || []).push(f); return acc;
  }, {});

  return (
    <div className="bg-white" data-testid="case-page">
      {/* ── BREADCRUMB ─── */}
      <div className="border-b border-[var(--border)]">
        <div className="mx-auto max-w-7xl px-4 md:px-6 h-14 flex items-center text-sm">
          <Link to="/reports" className="inline-flex items-center gap-1.5 text-[var(--text-soft)] hover:text-[var(--text)]" data-testid="case-back">
            <ArrowLeft size={14} /> Все кейсы
          </Link>
          <ChevronRight size={14} className="mx-2 text-[var(--text-soft)]" />
          <span className="font-semibold truncate">{c.title}</span>
        </div>
      </div>

      {/* ══════════════════════════════════════════════════════════════
          VEHICLE HERO — full-width image left, big metadata right
          ══════════════════════════════════════════════════════════════ */}
      <section className="relative">
        <div className="mx-auto max-w-7xl px-4 md:px-6 pt-10 md:pt-16 pb-12">
          <div className="grid lg:grid-cols-12 gap-10 items-start">
            <div className="lg:col-span-7">
              <div className="aspect-[16/10] rounded-3xl overflow-hidden bg-[#0b0b0d] relative">
                <img src={c.gallery[activePhoto] || c.heroImage} alt={c.title} className="w-full h-full object-cover" />
                <div className={`absolute top-5 left-5 inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-black uppercase tracking-wider`} style={{ background: v.accent, color: '#fff' }}>
                  <ShieldCheck size={13} /> {v.short}
                </div>
              </div>
              {c.gallery.length > 1 && (
                <div className="mt-3 grid grid-cols-4 gap-3">
                  {c.gallery.slice(0, 4).map((src, i) => (
                    <button
                      key={src}
                      onClick={() => setActivePhoto(i)}
                      className={`aspect-[4/3] rounded-xl overflow-hidden bg-[#0b0b0d] transition ring-2 ${i === activePhoto ? 'ring-[var(--text)]' : 'ring-transparent hover:ring-[var(--border)]'}`}
                      data-testid={`case-thumb-${i}`}
                    >
                      <img src={src} alt={`${c.title} – ${i+1}`} className="w-full h-full object-cover" />
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="lg:col-span-5">
              <div className="text-xs font-black uppercase tracking-[0.18em] text-[var(--text-soft)]">{c.country} · {c.city}</div>
              <h1 className="mt-3 text-4xl md:text-5xl lg:text-6xl font-black tracking-tight leading-[1.05]" data-testid="case-title">{c.title}</h1>

              <dl className="mt-8 grid grid-cols-3 gap-3">
                <Spec icon={<Calendar size={14} />} label="Год" value={String(c.year)} />
                <Spec icon={<Gauge size={14} />}    label="Пробег" value={`${fmt(c.km)} km`} />
                <Spec icon={<MapPin size={14} />}   label="Город" value={c.city} />
              </dl>

              {c.vin && (
                <div className="mt-3 inline-flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface-soft)] px-3 py-2 text-xs font-mono text-[var(--text-2)]">
                  VIN · {c.vin}
                </div>
              )}

              <div className="mt-8 grid grid-cols-2 gap-3">
                <PriceCell label="Цена продавца" value={`€${fmt(c.askingPrice)}`} />
                <PriceCell label="Рыночная" value={`€${fmt(c.marketPrice)}`} />
              </div>

              {c.saved > 0 && (
                <div className="mt-3 rounded-2xl bg-[var(--primary)] text-black p-5">
                  <div className="text-xs font-black uppercase tracking-wider opacity-70">Сэкономлено покупателю</div>
                  <div className="mt-1 text-4xl font-black tracking-tight">€{fmt(c.saved)}</div>
                </div>
              )}

              <Link to="/inspect" className="mt-8 inline-flex items-center justify-center gap-2 w-full rounded-xl bg-black hover:bg-[#1f2937] text-white h-14 text-base font-bold transition-colors" data-testid="case-cta-inspect">
                Проверить мою машину <ArrowRight size={18} />
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* ══════════════════════════════════════════════════════════════
          VERDICT BANNER — full-width tinted block
          ══════════════════════════════════════════════════════════════ */}
      <section className="border-y border-[var(--border)]" style={{ background: v.bg }} data-testid="case-verdict">
        <div className="mx-auto max-w-7xl px-4 md:px-6 py-12 md:py-16 grid lg:grid-cols-12 gap-8 items-center">
          <div className="lg:col-span-2">
            <div className="inline-flex items-center justify-center h-20 w-20 rounded-2xl" style={{ background: v.accent }}>
              <ShieldCheck size={36} className="text-white" />
            </div>
            <div className="mt-4 text-xs font-black uppercase tracking-wider" style={{ color: v.text }}>Вердикт</div>
            <div className="mt-1 text-3xl font-black tracking-tight" style={{ color: v.text }}>{v.short}</div>
          </div>
          <div className="lg:col-span-10">
            <h2 className="text-2xl md:text-4xl font-black tracking-tight" style={{ color: v.text }}>{c.verdictHeadline}</h2>
            <p className="mt-4 text-base md:text-lg max-w-3xl" style={{ color: v.text, opacity: 0.85 }}>{c.verdictSummary}</p>
            <div className="mt-6 flex flex-wrap gap-2">
              <Stat color={v.text} label="Найдено" value={`${c.findings.length} пунктов`} />
              <Stat color={v.text} label="Критичных" value={`${c.findings.filter(f => f.severity === 'critical').length}`} />
              <Stat color={v.text} label="Внимание" value={`${c.findings.filter(f => f.severity === 'warning').length}`} />
              <Stat color={v.text} label="Дата осмотра" value={fmtDate(c.inspectionDate)} />
            </div>
          </div>
        </div>
      </section>

      {/* ══════════════════════════════════════════════════════════════
          FINDINGS — sectioned by category
          ══════════════════════════════════════════════════════════════ */}
      <section className="bg-white">
        <div className="mx-auto max-w-7xl px-4 md:px-6 py-20">
          <div className="max-w-3xl mb-12">
            <span className="text-xs font-black uppercase tracking-[0.18em] text-[var(--text-soft)]">Что нашёл инспектор</span>
            <h2 className="mt-3 text-3xl md:text-5xl font-black tracking-tight">Все находки по категориям</h2>
            <p className="mt-4 text-base text-[var(--text-2)]">Каждый пункт — со степенью важности и комментарием инспектора. Полный отчёт с фото и видео — в PDF.</p>
          </div>

          <div className="space-y-12">
            {Object.entries(findingsByCategory).map(([cat, items]) => (
              <div key={cat} data-testid={`findings-${cat}`}>
                <div className="flex items-baseline justify-between border-b border-[var(--border)] pb-3 mb-6">
                  <h3 className="text-xl md:text-2xl font-black tracking-tight">{cat}</h3>
                  <span className="text-sm text-[var(--text-soft)]">{items.length} {items.length === 1 ? 'пункт' : items.length < 5 ? 'пункта' : 'пунктов'}</span>
                </div>
                <div className="space-y-3">
                  {items.map((f, idx) => {
                    const sm = SEVERITY_META[f.severity];
                    const Icon = SEV_ICON[f.severity];
                    return (
                      <div key={`${cat}-${idx}`} className="rounded-2xl border border-[var(--border)] bg-white p-5 md:p-6 flex gap-5" data-testid={`finding-${cat}-${idx}`}>
                        <div className={`shrink-0 h-11 w-11 rounded-xl ${sm.bg} ${sm.text} flex items-center justify-center ring-1 ${sm.ring}`}>
                          <Icon size={20} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className={`inline-flex items-center rounded-full ${sm.bg} ${sm.text} px-2.5 py-0.5 text-[10px] font-black uppercase tracking-wider ring-1 ${sm.ring}`}>{sm.label}</span>
                            <h4 className="text-base md:text-lg font-extrabold">{f.title}</h4>
                          </div>
                          <p className="mt-2 text-sm md:text-base text-[var(--text-2)] leading-relaxed">{f.description}</p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ══════════════════════════════════════════════════════════════
          TIMELINE + PDF preview (sticky panel)
          ══════════════════════════════════════════════════════════════ */}
      <section className="border-t border-[var(--border)] bg-[var(--surface-soft)]">
        <div className="mx-auto max-w-7xl px-4 md:px-6 py-20 grid lg:grid-cols-12 gap-12">
          <div className="lg:col-span-7">
            <span className="text-xs font-black uppercase tracking-[0.18em] text-[var(--text-soft)]">Хронология</span>
            <h2 className="mt-3 text-3xl md:text-5xl font-black tracking-tight">От заявки до отчёта</h2>
            <p className="mt-4 text-base text-[var(--text-2)] max-w-xl">Каждый шаг фиксируется в платформе. Никаких «потом расскажу».</p>

            <ol className="mt-10 relative" data-testid="case-timeline">
              <span aria-hidden className="absolute left-[15px] top-2 bottom-2 w-px bg-[var(--border)]" />
              {c.timeline.map((step, i) => (
                <li key={i} className="relative pl-12 pb-8 last:pb-0">
                  <span className={`absolute left-0 top-0.5 h-8 w-8 rounded-full flex items-center justify-center ${step.done ? 'bg-[var(--primary)]' : 'bg-white border border-[var(--border)]'}`}>
                    {step.done ? <CheckCircle2 size={16} className="text-black" /> : <Clock size={14} className="text-[var(--text-soft)]" />}
                  </span>
                  <div className="text-xs font-bold uppercase tracking-wider text-[var(--text-soft)]">{step.ts}</div>
                  <div className="mt-1 text-lg font-extrabold">{step.label}</div>
                  {step.detail && <div className="mt-1 text-sm text-[var(--text-2)]">{step.detail}</div>}
                </li>
              ))}
            </ol>
          </div>

          {/* PDF preview */}
          <div className="lg:col-span-5">
            <div className="lg:sticky lg:top-24 rounded-3xl border border-[var(--border)] bg-white p-6 shadow-sm" data-testid="case-pdf">
              <div className="aspect-[3/4] rounded-2xl bg-gradient-to-br from-[#fafafa] to-[#f1f1f3] border border-[var(--border)] relative overflow-hidden">
                {/* Mock PDF header */}
                <div className="absolute inset-x-6 top-6 space-y-2">
                  <div className="h-2 w-20 rounded-full bg-[var(--primary)]" />
                  <div className="h-3 w-3/4 rounded bg-[var(--text)]/85" />
                  <div className="h-2 w-1/2 rounded bg-[var(--text-soft)]/30" />
                </div>
                {/* Mock car image block */}
                <div className="absolute left-6 right-6 top-24 aspect-[16/9] rounded-xl overflow-hidden">
                  <img src={c.heroImage} alt="" className="w-full h-full object-cover" />
                </div>
                {/* Mock content lines */}
                <div className="absolute left-6 right-6 bottom-6 space-y-2">
                  <div className="h-2 w-full rounded bg-[var(--text-soft)]/25" />
                  <div className="h-2 w-5/6 rounded bg-[var(--text-soft)]/25" />
                  <div className="h-2 w-4/6 rounded bg-[var(--text-soft)]/25" />
                  <div className="mt-3 flex items-center gap-2">
                    <div className="h-6 w-16 rounded-full" style={{ background: v.accent }} />
                    <div className="h-2 w-1/2 rounded bg-[var(--text-soft)]/25" />
                  </div>
                </div>
                {/* Verdict ribbon */}
                <div className="absolute right-4 top-4 rounded-md px-2 py-1 text-[10px] font-black uppercase tracking-wider text-white" style={{ background: v.accent }}>{v.short}</div>
              </div>

              <div className="mt-5">
                <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-[var(--text-soft)]"><FileText size={14} /> Полный отчёт</div>
                <div className="mt-1.5 text-xl font-extrabold">PDF · {c.reportPages} страниц</div>
                <div className="mt-1 text-sm text-[var(--text-2)]">Чек-лист, фото, видео, рекомендации, расчёт цены.</div>
              </div>
              <button
                disabled
                className="mt-5 w-full inline-flex items-center justify-center gap-2 rounded-xl bg-[var(--primary)] hover:bg-[#facc15] disabled:opacity-70 disabled:cursor-not-allowed h-12 text-sm font-bold text-black"
                data-testid="case-pdf-download"
                title="Доступно после заказа собственной проверки"
              >
                <Download size={16} /> Скачать PDF
              </button>
              <div className="mt-2 text-xs text-center text-[var(--text-soft)]">Доступно после оформления своей проверки</div>
            </div>
          </div>
        </div>
      </section>

      {/* ══════════════════════════════════════════════════════════════
          SPECIALIST CARD
          ══════════════════════════════════════════════════════════════ */}
      <section className="bg-white border-t border-[var(--border)]">
        <div className="mx-auto max-w-7xl px-4 md:px-6 py-20">
          <span className="text-xs font-black uppercase tracking-[0.18em] text-[var(--text-soft)]">Кто проверял</span>
          <h2 className="mt-3 text-3xl md:text-5xl font-black tracking-tight">Инспектор</h2>

          <div className="mt-10 rounded-3xl border border-[var(--border)] bg-white overflow-hidden" data-testid="case-specialist">
            <div className="grid lg:grid-cols-12">
              <div className="lg:col-span-4 bg-[var(--surface-soft)] p-8 md:p-10 flex flex-col items-start">
                <div className="h-24 w-24 rounded-2xl bg-[var(--primary)] text-black flex items-center justify-center font-black text-3xl">
                  {c.specialist.initials}
                </div>
                <div className="mt-5 inline-flex items-center gap-1.5 rounded-full bg-white border border-[var(--border)] px-2.5 py-1 text-[10px] font-black uppercase tracking-wider"><Award size={11} /> TÜV-сертифицирован</div>
                <h3 className="mt-4 text-2xl md:text-3xl font-black tracking-tight">{c.specialist.name}</h3>
                <div className="mt-1 inline-flex items-center gap-1.5 text-sm text-[var(--text-soft)]"><MapPin size={13} /> {c.specialist.city}</div>
              </div>
              <div className="lg:col-span-8 p-8 md:p-10">
                <div className="grid grid-cols-3 gap-4">
                  <SpecMetric icon={<Star size={16} className="text-[var(--primary)]" fill="currentColor" />} value={c.specialist.ratingAvg.toFixed(1)} label="Рейтинг" />
                  <SpecMetric icon={<Camera size={16} className="text-[var(--text-soft)]" />} value={String(c.specialist.inspectionsCount)} label="Проверок" />
                  <SpecMetric icon={<Clock size={16} className="text-[var(--text-soft)]" />} value={`${c.specialist.yearsExperience} лет`} label="Опыт" />
                </div>
                <p className="mt-6 text-base text-[var(--text-2)] leading-relaxed">{c.specialist.bio}</p>
                <div className="mt-7 flex flex-col sm:flex-row gap-3">
                  <Link to={`/operator/${c.specialist.slug}`} className="inline-flex items-center justify-center gap-2 rounded-xl border border-[var(--border)] hover:bg-[var(--surface-soft)] h-12 px-6 text-sm font-bold" data-testid="case-specialist-profile">
                    Профиль инспектора <ChevronRight size={16} />
                  </Link>
                  <Link to="/inspect" className="inline-flex items-center justify-center gap-2 rounded-xl bg-black hover:bg-[#1f2937] text-white h-12 px-6 text-sm font-bold">
                    Заказать проверку <ArrowRight size={16} />
                  </Link>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ══════════════════════════════════════════════════════════════
          FINAL CTA — black slab
          ══════════════════════════════════════════════════════════════ */}
      <section className="bg-[#0b0b0d] text-white">
        <div className="mx-auto max-w-7xl px-4 md:px-6 py-20 grid lg:grid-cols-12 gap-8 items-center">
          <div className="lg:col-span-8">
            <h2 className="text-3xl md:text-5xl font-black tracking-tight">Хотите такой же отчёт по своей машине?</h2>
            <p className="mt-4 text-lg text-white/70 max-w-2xl">Вставьте ссылку на объявление с mobile.de или autoscout24 — инспектор выезжает на место за 24 часа. Фикс-цена. Платите только после подтверждения.</p>
          </div>
          <div className="lg:col-span-4 flex flex-col sm:flex-row lg:justify-end gap-3">
            <Link to="/inspect" className="inline-flex items-center justify-center gap-2 rounded-xl bg-[var(--primary)] hover:bg-[#facc15] px-7 h-14 text-base font-bold text-black">
              Проверить авто <ArrowRight size={18} />
            </Link>
            <Link to="/reports" className="inline-flex items-center justify-center gap-2 rounded-xl border border-white/30 hover:bg-white/10 px-7 h-14 text-base font-bold text-white">
              Ещё кейсы
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}

function Spec({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-white p-3.5">
      <div className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-[var(--text-soft)]">{icon}{label}</div>
      <div className="mt-1.5 font-extrabold text-base">{value}</div>
    </div>
  );
}

function PriceCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-white p-4">
      <div className="text-[10px] font-black uppercase tracking-wider text-[var(--text-soft)]">{label}</div>
      <div className="mt-1 font-black text-xl">{value}</div>
    </div>
  );
}

function Stat({ color, label, value }: { color: string; label: string; value: string }) {
  return (
    <div className="rounded-xl bg-white/60 px-4 py-2.5 backdrop-blur-sm">
      <div className="text-[10px] font-black uppercase tracking-wider opacity-70" style={{ color }}>{label}</div>
      <div className="mt-0.5 font-extrabold text-base" style={{ color }}>{value}</div>
    </div>
  );
}

function SpecMetric({ icon, value, label }: { icon: React.ReactNode; value: string; label: string }) {
  return (
    <div className="rounded-xl bg-[var(--surface-soft)] p-4">
      <div className="inline-flex items-center gap-1.5">{icon}<span className="text-2xl font-black tracking-tight">{value}</span></div>
      <div className="mt-1 text-[11px] font-bold uppercase tracking-wider text-[var(--text-soft)]">{label}</div>
    </div>
  );
}
