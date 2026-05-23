import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { X, Clock, MapPin, Star, CheckCircle2, Zap, ArrowLeft, ChevronRight } from 'lucide-react';
import { marketplaceAPI } from '../services/api';

type Step = 'service' | 'slot' | 'comment' | 'confirm' | 'creating' | 'success';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  provider: any;
  onSuccess?: (booking: any) => void;
}

const SERVICE_KEYS = [
  'diagnostics',
  'oil_change',
  'brake_pads',
  'suspension',
  'electrical',
  'inspection',
  'other',
] as const;

export default function BookingModal({ isOpen, onClose, provider, onSuccess }: Props) {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [step, setStep] = useState<Step>('service');
  const [selectedServiceKey, setSelectedServiceKey] = useState<string>('');
  const [slots, setSlots] = useState<any[]>([]);
  const [selectedSlot, setSelectedSlot] = useState<any>(null);
  const [selectedDate, setSelectedDate] = useState(() => new Date().toISOString().split('T')[0]);
  const [comment, setComment] = useState('');
  const [loading, setLoading] = useState(false);
  const [booking, setBooking] = useState<any>(null);

  useEffect(() => {
    if (isOpen) { setStep('service'); setSelectedServiceKey(''); setSelectedSlot(null); setComment(''); setBooking(null); }
  }, [isOpen]);

  useEffect(() => {
    if (step === 'slot' && provider?.slug) {
      setLoading(true);
      marketplaceAPI.getProviderSlots(provider.slug, selectedDate)
        .then(r => setSlots(r.data.slots || []))
        .catch(() => {
          const fb = [];
          for (let h = 9; h < 19; h++) for (const m of [0, 30]) fb.push({ time: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`, available: Math.random() > 0.3 });
          setSlots(fb);
        })
        .finally(() => setLoading(false));
    }
  }, [step, provider, selectedDate]);

  const submitBooking = async () => {
    setStep('creating');
    setLoading(true);
    try {
      const { data } = await marketplaceAPI.createBooking({
        providerId: provider.id,
        slug: provider.slug,
        service: t(`booking.services.${selectedServiceKey}`),
        serviceKey: selectedServiceKey,
        slot: selectedSlot,
        date: selectedDate,
        comment,
      });
      setBooking(data);
      setStep('success');
      onSuccess?.(data);
    } catch (e) {
      console.error(e);
      setStep('confirm');
    } finally { setLoading(false); }
  };

  if (!isOpen || !provider) return null;

  const selectedServiceLabel = selectedServiceKey ? t(`booking.services.${selectedServiceKey}`) : '';

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 modal-backdrop" onClick={onClose} data-testid="booking-modal">
      <div
        className="modal-content relative w-full max-w-lg p-6"
        onClick={e => e.stopPropagation()}
        data-testid="booking-content"
      >
        <button
          onClick={onClose}
          className="absolute top-4 right-4 w-9 h-9 surface-chip flex items-center justify-center hover:border-amber transition-colors"
          style={{ borderRadius: 999 }}
          data-testid="booking-close"
          aria-label={t('booking.close')}
        >
          <X size={16} className="text-amber" />
        </button>

        <div className="mb-6">
          <div className="slash-label mb-2">{t('booking.title').toUpperCase()}</div>
          <h3 className="font-display tracking-bebas text-3xl">{provider.name}</h3>
          <div className="flex items-center gap-3 text-xs mt-1" style={{ color: '#8A8A8A' }}>
            <span className="flex items-center gap-1"><Star size={11} className="text-amber" fill="currentColor" /> {provider.ratingAvg ?? '4.7'}</span>
            <span>·</span>
            <span className="flex items-center gap-1"><MapPin size={11} className="text-amber" /> {provider.distanceKm ?? '—'} km</span>
            <span>·</span>
            <span className="flex items-center gap-1"><Clock size={11} className="text-amber" /> {provider.etaMinutes ?? '—'} {t('common.minutes_short')}</span>
          </div>
        </div>

        {/* Steps indicator */}
        <div className="flex items-center gap-1 mb-6">
          {['service', 'slot', 'comment', 'confirm'].map((s, i) => {
            const idx = ['service', 'slot', 'comment', 'confirm', 'creating', 'success'].indexOf(step);
            return <div key={s} className={`h-1 flex-1 transition-colors ${idx >= i ? 'bg-amber' : 'bg-ink-300'}`} style={{ borderRadius: 999 }} />;
          })}
        </div>

        {step === 'service' && (
          <div className="space-y-2" data-testid="step-service">
            <label className="slash-label">{t('booking.service').toUpperCase()}</label>
            <div className="grid grid-cols-1 gap-2 mt-3">
              {SERVICE_KEYS.map(key => (
                <button
                  key={key}
                  onClick={() => { setSelectedServiceKey(key); setStep('slot'); }}
                  className="card-interactive flex items-center justify-between !p-4"
                  data-testid={`service-${key}`}
                >
                  <span className="text-sm font-semibold">{t(`booking.services.${key}`)}</span>
                  <ChevronRight size={16} className="text-amber" />
                </button>
              ))}
            </div>
          </div>
        )}

        {step === 'slot' && (
          <div className="space-y-3" data-testid="step-slot">
            <div className="flex items-center justify-between">
              <label className="slash-label">{t('booking.time').toUpperCase()}</label>
              <input
                type="date"
                value={selectedDate}
                onChange={e => setSelectedDate(e.target.value)}
                className="input-dark !w-auto !h-9 text-xs"
                data-testid="slot-date"
              />
            </div>
            {loading ? <div className="py-8 text-center text-sm" style={{ color: '#8A8A8A' }}>{t('booking.loading_slots')}</div> : (
              <div className="grid grid-cols-3 gap-2">
                {slots.map((sl, i) => (
                  <button
                    key={i}
                    disabled={!sl.available}
                    onClick={() => { setSelectedSlot(sl); setStep('comment'); }}
                    className={`px-2 h-10 text-sm font-semibold transition-colors ${
                      sl.available ? 'surface-chip hover:border-amber cursor-pointer' : 'bg-ink-300 opacity-30 cursor-not-allowed'
                    }`}
                    style={{ borderRadius: 8 }}
                    data-testid={`slot-${sl.time}`}
                  >
                    {sl.time}
                  </button>
                ))}
              </div>
            )}
            <button onClick={() => setStep('service')} className="btn-ghost w-full mt-3" data-testid="slot-back">
              <ArrowLeft size={14} /> {t('booking.back')}
            </button>
          </div>
        )}

        {step === 'comment' && (
          <div className="space-y-3" data-testid="step-comment">
            <label className="slash-label">{t('booking.comment_optional').toUpperCase()}</label>
            <textarea
              value={comment}
              onChange={e => setComment(e.target.value)}
              rows={4}
              placeholder={t('booking.comment_placeholder')}
              className="input-dark !h-auto !py-3"
              style={{ resize: 'vertical' }}
              data-testid="comment-input"
            />
            <div className="flex gap-2 mt-3">
              <button onClick={() => setStep('slot')} className="btn-secondary flex-1" data-testid="comment-back">
                <ArrowLeft size={14} /> {t('booking.back')}
              </button>
              <button onClick={() => setStep('confirm')} className="btn-primary flex-1" data-testid="comment-next">
                {t('booking.next')} <ChevronRight size={14} />
              </button>
            </div>
          </div>
        )}

        {step === 'confirm' && (
          <div className="space-y-3" data-testid="step-confirm">
            <div className="card !p-4 space-y-2">
              <Row label={t('booking.service')} value={selectedServiceLabel} />
              <Row label={t('booking.date')} value={selectedDate} />
              <Row label={t('booking.time')} value={selectedSlot?.time || '—'} />
              {comment && <Row label={t('booking.comment')} value={comment} />}
              <div className="hairline-t pt-2 flex justify-between">
                <span className="text-xs uppercase tracking-widest" style={{ color: '#8A8A8A' }}>{t('booking.total')}</span>
                <span className="font-display tracking-bebas text-xl text-amber">{provider.priceFrom ?? 500} €</span>
              </div>
            </div>
            <div className="flex gap-2">
              <button onClick={() => setStep('comment')} className="btn-secondary flex-1" data-testid="confirm-back">
                <ArrowLeft size={14} /> {t('booking.back')}
              </button>
              <button onClick={submitBooking} className="btn-primary flex-1" data-testid="confirm-submit">
                <Zap size={14} fill="currentColor" /> {t('booking.confirm')}
              </button>
            </div>
          </div>
        )}

        {step === 'creating' && (
          <div className="py-10 text-center">
            <div className="w-12 h-12 border-2 border-amber border-t-transparent rounded-full animate-spin mx-auto mb-4" />
            <p className="text-sm" style={{ color: '#B8B8B8' }}>{t('booking.creating')}</p>
          </div>
        )}

        {step === 'success' && booking && (
          <div className="py-6 text-center" data-testid="step-success">
            <div className="icon-badge-soft !w-16 !h-16 mx-auto mb-4">
              <CheckCircle2 size={28} className="text-amber" />
            </div>
            <h4 className="font-display tracking-bebas text-2xl mb-2">{t('booking.success_title').toUpperCase()}</h4>
            <p className="text-sm mb-6" style={{ color: '#B8B8B8' }}>
              {t('booking.success_id')}: <span className="text-amber font-semibold">{booking.id}</span>
            </p>
            <div className="flex gap-2">
              <button onClick={onClose} className="btn-secondary flex-1">{t('booking.close')}</button>
              <button onClick={() => { onClose(); navigate(`/booking/${booking.id}`); }} className="btn-primary flex-1" data-testid="success-track">
                {t('booking.track')} <ChevronRight size={14} />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between text-sm">
      <span style={{ color: '#8A8A8A' }} className="uppercase tracking-widest text-2xs">{label}</span>
      <span className="text-white font-semibold">{value}</span>
    </div>
  );
}
