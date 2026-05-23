import { useState, useEffect, useCallback } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Clock, MapPin, Star, CheckCircle, XCircle, Warning, Car, Wrench, Phone, ChatText, ArrowsClockwise, SealCheck, Spinner, Prohibit, Trophy, Headset, Copy, Check } from '@phosphor-icons/react';
import { marketplaceAPI } from '../../services/api';
import { useRealtimeEvents } from '../../hooks/useRealtimeSocket';
// Phase 0A — booking lifecycle now reads from shared behavioral truth.
// Surface owns presentation (icons/colors); shared owns capabilities.
import type { BookingStatus } from '@platform/domain/contracts/booking';
import { bookingViewModel, isTerminal, statusFromEvent } from '@platform/domain/state-machines/booking';

type StatusKey = BookingStatus;

const STATUS_VISUALS: Record<StatusKey, { color: string; bg: string; icon: any }> = {
  pending:     { color: 'text-amber-700',   bg: 'bg-gradient-to-r from-amber-50 to-orange-50 border-amber-200',     icon: Clock },
  confirmed:   { color: 'text-blue-700',    bg: 'bg-gradient-to-r from-blue-50 to-indigo-50 border-blue-200',       icon: CheckCircle },
  on_route:    { color: 'text-violet-700',  bg: 'bg-gradient-to-r from-violet-50 to-purple-50 border-violet-200',    icon: Car },
  arrived:     { color: 'text-emerald-700', bg: 'bg-gradient-to-r from-emerald-50 to-green-50 border-emerald-200',  icon: MapPin },
  in_progress: { color: 'text-blue-700',    bg: 'bg-gradient-to-r from-blue-50 to-cyan-50 border-blue-200',         icon: Wrench },
  completed:   { color: 'text-emerald-700', bg: 'bg-gradient-to-r from-emerald-50 to-green-50 border-emerald-200',  icon: Trophy },
  cancelled:   { color: 'text-gray-400',    bg: 'bg-ink-200 border-ink-300',                                         icon: XCircle },
};

export default function BookingDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();
  const [booking, setBooking] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [cancelling, setCancelling] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [showCancelModal, setShowCancelModal] = useState(false);
  const [showReviewModal, setShowReviewModal] = useState(false);
  const [reviewRating, setReviewRating] = useState(5);
  const [reviewComment, setReviewComment] = useState('');
  const [submittingReview, setSubmittingReview] = useState(false);
  const [copied, setCopied] = useState(false);

  const dateLocale = i18n.language === 'de' ? 'de-DE' : i18n.language === 'ru' ? 'ru-RU' : 'en-US';

  const fetchBooking = useCallback(async () => {
    if (!id) return;
    try {
      const { data } = await marketplaceAPI.getBooking(id);
      setBooking(data);
      setError('');
    } catch (err: any) {
      setError(err.response?.status === 404 ? t('booking.page.not_found') : t('booking.page.loading_error'));
    } finally {
      setLoading(false);
    }
  }, [id, t]);

  useEffect(() => { fetchBooking(); }, [fetchBooking]);

  useEffect(() => {
    if (!id || (booking?.status && isTerminal(booking.status as BookingStatus))) return;
    const interval = setInterval(fetchBooking, 30000);
    return () => clearInterval(interval);
  }, [id, booking?.status, fetchBooking]);

  useRealtimeEvents({
    'booking:status_changed':    (p: any) => { if (p?.data?.id === id || p?.data?.bookingId === id) fetchBooking(); },
    'booking:provider_location': (p: any) => { if (p?.data?.id === id || p?.data?.bookingId === id) fetchBooking(); },
    'booking.confirmed':         (p: any) => { if (p?.data?.id === id) fetchBooking(); },
    'booking.started':           (p: any) => { if (p?.data?.id === id) fetchBooking(); },
    'booking.completed':         (p: any) => { if (p?.data?.id === id) fetchBooking(); },
    'booking.cancelled':         (p: any) => { if (p?.data?.id === id) fetchBooking(); },
  }, [id]);

  const handleCancel = async () => {
    if (!id) return;
    setCancelling(true);
    try {
      await marketplaceAPI.cancelBooking(id, cancelReason);
      setShowCancelModal(false);
      fetchBooking();
    } catch { /* noop */ }
    finally { setCancelling(false); }
  };

  const handleReview = async () => {
    if (!id) return;
    setSubmittingReview(true);
    try {
      await marketplaceAPI.reviewBooking(id, reviewRating, reviewComment);
      setShowReviewModal(false);
      fetchBooking();
    } catch { /* noop */ }
    finally { setSubmittingReview(false); }
  };

  const handleSimulate = async () => {
    if (!id) return;
    await marketplaceAPI.simulateProgress(id);
    fetchBooking();
  };

  const copyId = () => {
    navigator.clipboard.writeText(id || '');
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const badgeLabel = (key: string): string => {
    const known = ['verified', 'top', 'mobile', 'fast_response'];
    return known.includes(key) ? t(`booking.badge.${key}`) : key;
  };

  if (loading) return (
    <div className="min-h-screen bg-black flex items-center justify-center" data-testid="booking-loading">
      <Spinner size={32} className="animate-spin text-amber" />
    </div>
  );

  if (error) return (
    <div className="min-h-screen bg-black flex items-center justify-center" data-testid="booking-error">
      <div className="text-center">
        <Warning size={48} className="text-slate-300 mx-auto mb-4" />
        <h2 className="font-heading font-bold text-xl text-white mb-2">{error}</h2>
        <button onClick={fetchBooking} className="text-amber font-medium text-sm hover:underline">{t('booking.page.try_again')}</button>
        <div className="mt-3"><Link to="/" className="text-gray-500 text-sm hover:text-gray-300">{t('booking.page.back_home')}</Link></div>
      </div>
    </div>
  );

  if (!booking) return null;

  const status = (booking.status || 'pending') as StatusKey;
  const visuals = STATUS_VISUALS[status] || STATUS_VISUALS.pending;
  const StatusIcon = visuals.icon;
  const provider = booking.provider;
  const timeline = booking.timeline || [];
  // Phase 0A — capability flags read from shared behavioral truth.
  // Backend may override with server-side flags (e.g. policy reasons
  // beyond status, like already-cancelled-once); when the flag is
  // present we honor it (backend wins), otherwise we fall back to
  // shared rules.
  const vm = bookingViewModel({ status, isPaid: booking.isPaid });
  const showCancel = booking.isCancellable ?? vm.canCancel;
  const showReview = (booking.isReviewable ?? vm.canReview) && !booking.hasReview;

  const liveTitle = t(`booking.live.${status}_title`);
  const liveSubtitle = t(`booking.live.${status}_subtitle`);
  const serviceLabel = booking.serviceKey ? t(`booking.services.${booking.serviceKey}`, { defaultValue: booking.serviceName }) : booking.serviceName;

  return (
    <div className="min-h-screen bg-black" data-testid="booking-detail-page">
      {/* Header */}
      <header className="sticky top-0 z-50 bg-white/95 backdrop-blur-xl border-b border-ink-300">
        <div className="max-w-[1200px] mx-auto px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button onClick={() => navigate(-1)} className="p-1.5 hover:bg-ink-200 rounded transition" data-testid="back-btn" aria-label={t('common.back')}>
              <ArrowLeft size={20} weight="bold" className="text-gray-300" />
            </button>
            <div>
              <h1 className="font-heading font-bold text-sm text-white">{t('booking.page.order_number')} #{id?.slice(0, 8)}</h1>
              <p className="text-[10px] text-gray-500">{booking.createdAt ? new Date(booking.createdAt).toLocaleString(dateLocale) : ''}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={copyId} className="text-xs text-gray-500 hover:text-gray-300 flex items-center gap-1 px-2 py-1 rounded hover:bg-ink-200 transition" data-testid="copy-id-btn">
              {copied ? <Check size={14} className="text-emerald-500" /> : <Copy size={14} />}
              {copied ? t('booking.page.copied') : t('booking.page.copy_id')}
            </button>
            {!vm.isTerminal && (
              <button onClick={handleSimulate} className="text-[10px] font-bold text-violet-600 bg-violet-50 px-2.5 py-1 rounded-full border border-violet-200 hover:bg-violet-100 transition" data-testid="simulate-btn">
                ⚡ {t('booking.page.simulate')}
              </button>
            )}
          </div>
        </div>
      </header>

      <div className="max-w-[1200px] mx-auto px-6 py-8">
        {/* STATUS BLOCK */}
        <div className={`rounded-modal p-6 border-2 mb-8 ${visuals.bg}`} data-testid="status-block">
          <div className="flex items-center gap-4">
            <div className={`w-14 h-14 rounded-modal flex items-center justify-center ${status === 'completed' ? 'bg-emerald-100' : status === 'cancelled' ? 'bg-slate-200' : 'bg-white/80'}`}>
              <StatusIcon size={28} weight="fill" className={visuals.color} />
            </div>
            <div className="flex-1">
              <h2 className={`font-heading font-extrabold text-xl ${visuals.color}`} data-testid="status-title">{liveTitle}</h2>
              <p className="text-sm text-gray-300 mt-0.5">{liveSubtitle}</p>
            </div>
            {booking.eta && status === 'on_route' && (
              <div className="bg-ink-100 rounded px-4 py-2 text-center">
                <p className="font-extrabold text-2xl text-white">{booking.eta}</p>
                <p className="text-[10px] text-gray-400 font-medium">{t('booking.live.minutes_short')}</p>
              </div>
            )}
          </div>
        </div>

        {/* MAIN GRID */}
        <div className="grid lg:grid-cols-12 gap-8">
          <div className="lg:col-span-7 space-y-6">
            {/* TIMELINE */}
            <div className="bg-ink-100 rounded-modal p-6 shadow-card" data-testid="timeline-block">
              <h3 className="font-heading font-bold text-base mb-5 flex items-center gap-2">
                <ArrowsClockwise size={18} className="text-amber" />{t('booking.page.timeline')}
              </h3>
              <div className="relative pl-8">
                <div className="absolute left-[11px] top-1 bottom-1 w-0.5 bg-slate-200" />
                {timeline.map((step: any) => (
                  <div key={step.key} className={`relative pb-6 last:pb-0 ${step.completed || step.active ? '' : 'opacity-40'}`} data-testid={`timeline-step-${step.key}`}>
                    <div className={`absolute -left-8 w-6 h-6 rounded-full border-2 flex items-center justify-center ${step.active ? 'bg-amber border-blue-600 ring-4 ring-blue-100' : step.completed ? 'bg-emerald-500 border-emerald-500' : 'bg-white border-slate-300'}`}>
                      {step.completed && <Check size={12} weight="bold" className="text-white" />}
                      {step.active && <div className="w-2 h-2 bg-ink-100 rounded-full" />}
                    </div>
                    <div className="ml-1">
                      <p className={`font-semibold text-sm ${step.active ? 'text-blue-700' : step.completed ? 'text-white' : 'text-gray-500'}`}>{step.label}</p>
                      {step.at && <p className="text-[10px] text-gray-500 mt-0.5">{new Date(step.at).toLocaleTimeString(dateLocale, { hour: '2-digit', minute: '2-digit' })}</p>}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* DETAILS */}
            <div className="bg-ink-100 rounded-modal p-6 shadow-card" data-testid="details-block">
              <h3 className="font-heading font-bold text-base mb-4">{t('booking.page.details_title')}</h3>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-gray-500 font-bold mb-1">{t('booking.page.service_label')}</p>
                  <p className="text-sm font-semibold text-white">{serviceLabel}</p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-gray-500 font-bold mb-1">{t('booking.page.datetime_label')}</p>
                  <p className="text-sm font-semibold text-white">{booking.slotDate} {t('booking.page.datetime_at')} {booking.slotTime}</p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-gray-500 font-bold mb-1">{t('booking.page.address_label')}</p>
                  <p className="text-sm font-semibold text-white">{booking.address || provider?.address || '—'}</p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-gray-500 font-bold mb-1">{t('booking.page.cost_label')}</p>
                  <p className="text-sm font-extrabold text-white">{t('booking.page.cost_from')} {booking.priceEstimate || 500} €</p>
                </div>
              </div>
              {booking.comment && (
                <div className="mt-4 bg-ink-100 rounded p-3">
                  <p className="text-[10px] uppercase tracking-wider text-gray-500 font-bold mb-1">{t('booking.page.comment_label')}</p>
                  <p className="text-sm text-gray-200">{booking.comment}</p>
                </div>
              )}
            </div>

            {/* ACTIONS */}
            <div className="bg-ink-100 rounded-modal p-6 shadow-card" data-testid="actions-block">
              <h3 className="font-heading font-bold text-base mb-4">{t('booking.page.actions_title')}</h3>
              <div className="flex flex-wrap gap-3">
                {showCancel && (
                  <button onClick={() => setShowCancelModal(true)} className="flex items-center gap-2 px-5 py-3 bg-red-50 hover:bg-red-100 text-red-700 rounded text-sm font-bold border border-red-200 transition" data-testid="cancel-btn">
                    <Prohibit size={16} weight="bold" /> {t('booking.page.cancel_btn')}
                  </button>
                )}
                {showReview && (
                  <button onClick={() => setShowReviewModal(true)} className="flex items-center gap-2 px-5 py-3 bg-amber-50 hover:bg-amber-100 text-amber-700 rounded text-sm font-bold border border-amber-200 transition" data-testid="review-btn">
                    <Star size={16} weight="fill" /> {t('booking.page.review_btn')}
                  </button>
                )}
                {status === 'completed' && (
                  <Link to="/" className="flex items-center gap-2 px-5 py-3 bg-amber hover:bg-amber-600 text-white rounded text-sm font-bold transition" data-testid="repeat-btn">
                    <ArrowsClockwise size={16} weight="bold" /> {t('booking.page.repeat_btn')}
                  </Link>
                )}
                <button className="flex items-center gap-2 px-5 py-3 bg-ink-200 hover:bg-slate-200 text-gray-200 rounded text-sm font-medium transition" data-testid="support-btn">
                  <Headset size={16} /> {t('booking.page.support_btn')}
                </button>
              </div>
            </div>
          </div>

          {/* RIGHT */}
          <div className="lg:col-span-5 space-y-4 lg:sticky lg:top-20">
            {/* PROVIDER CARD */}
            {provider && (
              <div className="bg-ink-100 rounded-modal p-6 shadow-card" data-testid="provider-card">
                <div className="flex items-center gap-4 mb-4">
                  <div className="w-16 h-16 bg-gradient-to-br from-blue-100 to-blue-200 rounded-modal flex items-center justify-center">
                    <span className="font-bold text-2xl text-amber">{provider.name?.[0]}</span>
                  </div>
                  <div className="flex-1">
                    <Link to={`/provider/${provider.slug}`} className="block">
                      <h3 className="font-heading font-extrabold text-lg text-white hover:text-amber transition">{provider.name}</h3>
                    </Link>
                    <div className="flex items-center gap-2 mt-1">
                      <div className="flex items-center gap-1 bg-amber-50 px-2 py-0.5 rounded border border-amber-100">
                        <Star size={14} weight="fill" className="text-amber-400" />
                        <span className="font-bold text-sm text-amber-700">{provider.rating}</span>
                      </div>
                      <span className="text-xs text-gray-500">{t('booking.page.reviews_count', { count: provider.reviewsCount ?? 0 })}</span>
                    </div>
                  </div>
                  {provider.isOnline && (
                    <span className="flex items-center gap-1 text-[10px] font-bold text-emerald-700 bg-emerald-50 px-2 py-1 rounded-full border border-emerald-200">
                      <span className="w-1.5 h-1.5 bg-emerald-500 rounded-full" /> {t('booking.page.online')}
                    </span>
                  )}
                </div>
                <div className="flex flex-wrap gap-1.5 mb-3">
                  {(provider.badges || []).map((b: string, i: number) => (
                    <span key={i} className="text-[10px] font-bold text-gray-300 bg-ink-200 px-2.5 py-1 rounded-full flex items-center gap-1">
                      {b === 'verified' && <SealCheck size={12} weight="fill" className="text-blue-500" />}
                      {badgeLabel(b)}
                    </span>
                  ))}
                </div>
                {provider.whyReasons?.length > 0 && (
                  <div className="space-y-1.5">
                    {provider.whyReasons.map((w: string, i: number) => (
                      <div key={i} className="flex items-center gap-2 text-xs text-emerald-700">
                        <CheckCircle size={14} weight="fill" className="text-emerald-500 flex-shrink-0" />{w}
                      </div>
                    ))}
                  </div>
                )}
                {provider.workHours && (
                  <div className="mt-3 pt-3 border-t border-ink-300 flex items-center gap-2 text-xs text-gray-400">
                    <Clock size={14} /> {provider.workHours}
                  </div>
                )}
              </div>
            )}

            {/* SUMMARY */}
            <div className="bg-ink-100 rounded-modal p-6 shadow-card" data-testid="summary-card">
              <h3 className="font-heading font-bold text-sm mb-3">{t('booking.page.summary_title')}</h3>
              <div className="space-y-2.5">
                <div className="flex justify-between"><span className="text-xs text-gray-400">{t('booking.page.summary_order')}</span><span className="text-xs font-mono text-gray-200">{id?.slice(0, 8)}</span></div>
                <div className="flex justify-between"><span className="text-xs text-gray-400">{t('booking.page.summary_source')}</span><span className="text-xs font-medium text-gray-200">{booking.source === 'quick_request' ? t('booking.page.source_quick') : t('booking.page.source_marketplace')}</span></div>
                <div className="flex justify-between"><span className="text-xs text-gray-400">{t('booking.page.summary_payment')}</span><span className="text-xs font-medium text-amber-600">{t('booking.page.payment_on_meeting')}</span></div>
                <div className="border-t border-ink-300 pt-2 flex justify-between"><span className="text-xs font-semibold text-gray-200">{t('booking.page.summary_cost')}</span><span className="font-extrabold text-lg text-white">{t('booking.page.cost_from')} {booking.priceEstimate || 500} €</span></div>
              </div>
            </div>

            {/* SUPPORT */}
            <div className="bg-gradient-to-br from-slate-900 to-slate-800 rounded-modal p-5 text-white" data-testid="support-card">
              <h3 className="font-heading font-bold text-sm mb-1.5 flex items-center gap-2"><Headset size={16} /> {t('booking.page.support_title')}</h3>
              <p className="text-xs text-gray-500 mb-3">{t('booking.page.support_subtitle')}</p>
              <div className="flex gap-2">
                <button className="flex-1 flex items-center justify-center gap-1.5 bg-white/10 hover:bg-white/20 py-2.5 rounded text-xs font-bold transition">
                  <ChatText size={14} /> {t('booking.page.support_chat')}
                </button>
                <button className="flex-1 flex items-center justify-center gap-1.5 bg-white/10 hover:bg-white/20 py-2.5 rounded text-xs font-bold transition">
                  <Phone size={14} /> {t('booking.page.support_call')}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* CANCEL MODAL */}
      {showCancelModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 modal-backdrop" onClick={() => setShowCancelModal(false)} data-testid="cancel-modal">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
          <div className="relative bg-ink-100 rounded-modal shadow-2xl w-full max-w-sm p-6 modal-content" onClick={e => e.stopPropagation()}>
            <h3 className="font-heading font-bold text-lg text-white mb-2">{t('booking.cancel_modal.title')}</h3>
            <p className="text-sm text-gray-400 mb-4">{t('booking.cancel_modal.subtitle')}</p>
            <textarea value={cancelReason} onChange={e => setCancelReason(e.target.value)} placeholder={t('booking.cancel_modal.placeholder')} className="w-full h-20 p-3 rounded text-sm outline-none focus:border-red-400 resize-none mb-4" data-testid="cancel-reason" />
            <div className="flex gap-2">
              <button onClick={() => setShowCancelModal(false)} className="flex-1 py-3 bg-ink-200 text-gray-200 rounded font-bold text-sm">{t('booking.cancel_modal.keep')}</button>
              <button onClick={handleCancel} disabled={cancelling} className="flex-1 py-3 bg-red-600 hover:bg-red-700 text-white rounded font-bold text-sm transition disabled:opacity-50" data-testid="confirm-cancel-btn">
                {cancelling ? t('booking.cancel_modal.cancelling') : t('booking.cancel_modal.confirm')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* REVIEW MODAL */}
      {showReviewModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 modal-backdrop" onClick={() => setShowReviewModal(false)} data-testid="review-modal">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
          <div className="relative bg-ink-100 rounded-modal shadow-2xl w-full max-w-sm p-6 modal-content" onClick={e => e.stopPropagation()}>
            <h3 className="font-heading font-bold text-lg text-white mb-4">{t('booking.review_modal.title')}</h3>
            <div className="flex items-center justify-center gap-2 mb-4">
              {[1,2,3,4,5].map(n => (
                <button key={n} onClick={() => setReviewRating(n)} className="transition hover:scale-110" data-testid={`star-${n}`}>
                  <Star size={36} weight={n <= reviewRating ? 'fill' : 'regular'} className={n <= reviewRating ? 'text-amber-400' : 'text-slate-300'} />
                </button>
              ))}
            </div>
            <textarea value={reviewComment} onChange={e => setReviewComment(e.target.value)} placeholder={t('booking.review_modal.placeholder')} className="w-full h-24 p-3 rounded text-sm outline-none focus:border-blue-400 resize-none mb-4" data-testid="review-comment" />
            <button onClick={handleReview} disabled={submittingReview} className="w-full py-3.5 bg-amber hover:bg-amber-600 text-white rounded font-bold text-sm transition disabled:opacity-50" data-testid="submit-review-btn">
              {submittingReview ? t('booking.review_modal.submitting') : t('booking.review_modal.submit')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
