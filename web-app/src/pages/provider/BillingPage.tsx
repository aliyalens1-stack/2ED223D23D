import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Star, Zap, Crown, Shield, Clock, TrendingUp, CheckCircle, AlertTriangle, Package, ArrowRight } from 'lucide-react';
import { marketplaceAPI } from '../../services/api';

export default function ProviderBillingPage() {
  const [products, setProducts] = useState<any[]>([]);
  const [status, setStatus] = useState<any>(null);
  const [pressure, setPressure] = useState<any>(null);
  const [tier, setTier] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [buyingCode, setBuyingCode] = useState<string | null>(null);
  const slug = 'avtomaster-pro'; // Would come from auth context

  useEffect(() => { loadAll(); }, []);

  const loadAll = async () => {
    try {
      const [prodRes, statusRes, pressureRes, tierRes] = await Promise.all([
        marketplaceAPI.getBillingProducts(),
        marketplaceAPI.getBillingStatus(slug),
        marketplaceAPI.getProviderPressure(slug),
        marketplaceAPI.getProviderTier(slug),
      ]);
      setProducts(prodRes.data.products || []);
      setStatus(statusRes.data);
      setPressure(pressureRes.data);
      setTier(tierRes.data);
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  };

  const handleBuy = async (code: string) => {
    setBuyingCode(code);
    try {
      await marketplaceAPI.billingCheckout({ productCode: code, providerSlug: slug });
      await loadAll();
      alert('Подписка активирована!');
    } catch (e) { alert('Ошибка оплаты'); }
    finally { setBuyingCode(null); }
  };

  if (loading) return <div className="max-w-[1200px] mx-auto px-6 py-12 flex justify-center"><div className="animate-spin w-8 h-8 border-2 border-brand border-t-transparent rounded-full" /></div>;

  const ICONS: Record<string, any> = { '⭐': Star, '🔥': Zap, '🏆': Crown };

  return (
    <div className="max-w-[1200px] mx-auto px-4 sm:px-6 py-6" data-testid="billing-page">
      <Link to="/provider/dashboard" className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-300 mb-4"><ArrowLeft className="w-4 h-4" />Кабинет мастера</Link>

      <h1 className="text-3xl font-extrabold text-white mb-2">🚀 Увеличьте поток заказов</h1>
      <p className="text-gray-500 mb-8">Выберите план, который подходит именно вам</p>

      {/* ── PRESSURE BANNER ── */}
      {pressure && !pressure.hasPriority && pressure.missedRequests > 0 && (
        <div className="bg-red-50 border border-red-200 rounded-modal p-5 mb-6 flex items-center gap-4" data-testid="pressure-banner">
          <div className="w-14 h-14 bg-red-100 rounded-modal flex items-center justify-center"><AlertTriangle className="w-7 h-7 text-red-500" /></div>
          <div className="flex-1">
            <p className="font-bold text-red-800">Вы пропустили {pressure.missedRequests} заявок сегодня</p>
            <p className="text-sm text-red-600">Потенциально потеряно: ~{pressure.lostRevenueEstimate} ₴</p>
            <p className="text-xs text-red-500 mt-1">{pressure.comparison?.message}</p>
          </div>
          <button onClick={() => handleBuy('priority_7d')} className="bg-red-600 text-white px-5 py-2.5 rounded text-sm font-bold hover:bg-red-500 whitespace-nowrap" data-testid="pressure-cta">Включить Priority</button>
        </div>
      )}

      {/* ── TIER CARD ── */}
      {tier && (
        <div className="bg-white  rounded-modal p-5 mb-6 flex items-center gap-5" data-testid="tier-card">
          <div className="text-5xl">{tier.tier?.emoji}</div>
          <div className="flex-1">
            <p className="font-bold text-lg text-white">{tier.message}</p>
            <div className="flex items-center gap-2 mt-2">
              <div className="flex-1 bg-ink-200 rounded-full h-2"><div className="rounded-full h-2 transition-all" style={{ width: `${tier.progress}%`, backgroundColor: tier.tier?.color }} /></div>
              <span className="text-xs text-gray-500 font-mono">{tier.score} pts</span>
            </div>
            <div className="flex gap-2 mt-2 flex-wrap">{tier.benefits?.map((b: string, i: number) => <span key={i} className="text-xs bg-ink-200 text-gray-400 px-2 py-0.5 rounded-full">{b}</span>)}</div>
          </div>
        </div>
      )}

      {/* ── PRODUCTS GRID ── */}
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-8">
        {products.filter(p => p.durationDays === 7).map(product => {
          const IconComp = ICONS[product.icon] || Star;
          const isVip = product.featureFlags?.vip;
          const isActive = status?.activePlans?.some((ap: any) => ap.productCode === product.code);
          return (
            <div key={product.code} className={`bg-white border rounded-modal p-6 relative overflow-hidden ${isVip ? 'border-purple-300 ring-2 ring-purple-100' : 'border-ink-300'}`} data-testid={`product-${product.code}`}>
              {isVip && <div className="absolute top-0 right-0 bg-purple-500 text-white text-[10px] font-bold px-3 py-1 rounded-bl-lg">ЛУЧШИЙ</div>}
              <div className={`w-12 h-12 rounded-modal flex items-center justify-center mb-4 ${isVip ? 'bg-purple-100' : product.featureFlags?.priority ? 'bg-orange-100' : 'bg-amber-100'}`}>
                <IconComp className={`w-6 h-6 ${isVip ? 'text-purple-600' : product.featureFlags?.priority ? 'text-orange-600' : 'text-amber-600'}`} />
              </div>
              <h3 className="font-bold text-lg text-white">{product.name}</h3>
              <p className="text-sm text-gray-500 mt-1 mb-4">{product.benefit}</p>
              <div className="flex items-baseline gap-1 mb-4">
                <span className="text-3xl font-extrabold text-white">{product.price}</span>
                <span className="text-sm text-gray-500">₴ / {product.durationDays} дней</span>
              </div>
              <div className="space-y-2 mb-5">
                {product.featureFlags?.promoted && <div className="flex items-center gap-2 text-sm"><CheckCircle className="w-4 h-4 text-emerald-500" /><span className="text-gray-400">Boost в выдаче (+{(product.config?.promotionBoost || 0) * 100}%)</span></div>}
                {product.featureFlags?.priority && <div className="flex items-center gap-2 text-sm"><CheckCircle className="w-4 h-4 text-emerald-500" /><span className="text-gray-400">Priority заявки ({product.config?.priorityWindowSeconds}s окно)</span></div>}
                {product.featureFlags?.vip && <div className="flex items-center gap-2 text-sm"><CheckCircle className="w-4 h-4 text-emerald-500" /><span className="text-gray-400">VIP бейдж и поддержка</span></div>}
              </div>
              {isActive ? (
                <div className="w-full bg-emerald-50 border border-emerald-200 text-emerald-700 py-3 rounded text-sm font-bold text-center">✅ Активно</div>
              ) : (
                <button onClick={() => handleBuy(product.code)} disabled={buyingCode === product.code}
                  className={`w-full py-3 rounded text-sm font-bold transition flex items-center justify-center gap-2 ${isVip ? 'bg-purple-600 text-white hover:bg-purple-500' : product.featureFlags?.priority ? 'bg-orange-600 text-white hover:bg-orange-500' : 'bg-amber-500 text-white hover:bg-amber-400'} disabled:opacity-50`}
                  data-testid={`buy-${product.code}`}>
                  {buyingCode === product.code ? <div className="animate-spin w-4 h-4 border-2 border-white border-t-transparent rounded-full" /> : <>Купить<ArrowRight className="w-4 h-4" /></>}
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* ── 30-day plans ── */}
      <h2 className="text-xl font-bold text-white mb-4">📅 Месячные планы</h2>
      <div className="grid sm:grid-cols-2 gap-4 mb-8">
        {products.filter(p => p.durationDays === 30).map(product => (
          <div key={product.code} className="bg-white  rounded-modal p-5 flex items-center gap-4" data-testid={`product-${product.code}`}>
            <div className="text-3xl">{product.icon}</div>
            <div className="flex-1">
              <p className="font-bold text-white">{product.name}</p>
              <p className="text-sm text-gray-500">{product.benefit}</p>
            </div>
            <div className="text-right">
              <p className="text-2xl font-extrabold text-white">{product.price} ₴</p>
              <button onClick={() => handleBuy(product.code)} disabled={buyingCode === product.code} className="mt-1 text-sm text-amber font-bold hover:underline" data-testid={`buy-${product.code}`}>
                Купить
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* ── Purchase History ── */}
      {status?.purchases?.length > 0 && (
        <div className="bg-white  rounded-modal p-5" data-testid="purchase-history">
          <h2 className="font-bold text-white mb-4 flex items-center gap-2"><Package className="w-5 h-5" />История покупок</h2>
          <div className="space-y-2">
            {status.purchases.map((p: any) => (
              <div key={p.id} className="flex items-center justify-between py-3 px-3 bg-ink-100 rounded">
                <div>
                  <p className="font-medium text-sm text-white">{p.productName}</p>
                  <p className="text-xs text-gray-500">{new Date(p.createdAt).toLocaleDateString('ru-RU')} — {new Date(p.endsAt).toLocaleDateString('ru-RU')}</p>
                </div>
                <div className="text-right">
                  <p className="font-bold text-sm text-white">{p.amount} ₴</p>
                  <span className={`text-xs font-bold px-2 py-0.5 rounded ${p.status === 'paid' ? 'bg-emerald-100 text-emerald-700' : 'bg-ink-200 text-gray-500'}`}>{p.status === 'paid' ? 'Оплачено' : p.status}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
