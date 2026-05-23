import { useEffect, useState } from 'react';
import { adminAPI } from '../services/api';
import { Star, EyeOff, User, Building2 } from 'lucide-react';
import { format } from 'date-fns';

interface Review {
  _id: string;
  rating: number;
  comment?: string;
  isHidden?: boolean;
  customerId?: { firstName?: string; email?: string };
  organizationId?: { name?: string };
  createdAt: string;
}

export default function ReviewsPage() {
  const [reviews, setReviews] = useState<Review[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const limit = 20;

  const fetchReviews = async () => {
    setLoading(true);
    try {
      const res = await adminAPI.getReviews({ limit, skip: page * limit });
      setReviews(res.data.reviews);
      setTotal(res.data.total);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchReviews();
  }, [page]);

  const hideReview = async (id: string) => {
    try {
      await adminAPI.hideReview(id);
      fetchReviews();
    } catch (err) {
      console.error(err);
    }
  };

  const renderStars = (rating: number) => {
    return Array.from({ length: 5 }, (_, i) => (
      <Star
        key={i}
        size={14}
        className={i < rating ? 'text-yellow-400 fill-yellow-400' : 'text-slate-600'}
      />
    ));
  };

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-white">Отзывы</h1>
        <span className="text-slate-400">Всего: {total}</span>
      </div>

      <div className="space-y-4">
        {loading ? (
          <div className="bg-slate-800 rounded-xl border border-slate-700 p-8 text-center text-slate-400">
            Загрузка...
          </div>
        ) : reviews.length === 0 ? (
          <div className="bg-slate-800 rounded-xl border border-slate-700 p-8 text-center text-slate-400">
            Нет отзывов
          </div>
        ) : (
          reviews.map((r) => (
            <div key={r._id} className={`bg-slate-800 rounded-xl border border-slate-700 p-4 ${r.isHidden ? 'opacity-50' : ''}`}>
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-4 mb-2">
                    <div className="flex items-center gap-1">
                      {renderStars(r.rating)}
                    </div>
                    <span className="text-slate-400 text-sm">
                      {format(new Date(r.createdAt), 'dd.MM.yyyy')}
                    </span>
                    {r.isHidden && (
                      <span className="px-2 py-0.5 bg-red-500/20 text-red-400 text-xs rounded">
                        Скрыт
                      </span>
                    )}
                  </div>
                  <p className="text-white mb-3">{r.comment || '—'}</p>
                  <div className="flex items-center gap-6 text-sm">
                    <span className="flex items-center gap-1 text-slate-400">
                      <User size={14} />
                      {r.customerId?.firstName || r.customerId?.email || '—'}
                    </span>
                    <span className="flex items-center gap-1 text-slate-400">
                      <Building2 size={14} />
                      {r.organizationId?.name || '—'}
                    </span>
                  </div>
                </div>
                {!r.isHidden && (
                  <button
                    onClick={() => hideReview(r._id)}
                    className="p-2 bg-red-500/20 hover:bg-red-500/30 text-red-400 rounded-lg"
                    title="Скрыть отзыв"
                  >
                    <EyeOff size={18} />
                  </button>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      {total > limit && (
        <div className="flex items-center justify-between mt-4">
          <span className="text-slate-400 text-sm">Страница {page + 1} из {Math.ceil(total / limit)}</span>
          <div className="flex gap-2">
            <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0} className="px-4 py-2 bg-slate-700 text-white rounded-lg disabled:opacity-50">Назад</button>
            <button onClick={() => setPage(p => p + 1)} disabled={(page + 1) * limit >= total} className="px-4 py-2 bg-slate-700 text-white rounded-lg disabled:opacity-50">Вперёд</button>
          </div>
        </div>
      )}
    </div>
  );
}
