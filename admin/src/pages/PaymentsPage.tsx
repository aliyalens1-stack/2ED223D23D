import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { adminAPI } from '../services/api';
import { CreditCard, ArrowUpRight, ArrowDownLeft, Clock, Activity } from 'lucide-react';
import { format } from 'date-fns';

interface Payment {
  _id: string;
  type: string;
  status: string;
  amount: number;
  platformFee?: number;
  userId?: { firstName?: string; email?: string };
  organizationId?: { name?: string };
  createdAt: string;
}

const STATUS_COLORS: Record<string, string> = {
  pending: 'bg-yellow-500/20 text-yellow-400',
  completed: 'bg-green-500/20 text-green-400',
  failed: 'bg-red-500/20 text-red-400',
  refunded: 'bg-purple-500/20 text-purple-400',
};

export default function PaymentsPage() {
  const [payments, setPayments] = useState<Payment[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(0);
  const limit = 20;

  const fetchPayments = async () => {
    setLoading(true);
    try {
      const res = await adminAPI.getPayments({
        status: status || undefined,
        limit,
        skip: page * limit,
      });
      setPayments(res.data.payments);
      setTotal(res.data.total);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchPayments();
  }, [status, page]);

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-white">Платежи</h1>
        <span className="text-slate-400">Всего: {total}</span>
      </div>

      <div className="flex gap-4 mb-6">
        <select
          value={status}
          onChange={(e) => { setStatus(e.target.value); setPage(0); }}
          className="bg-slate-800 border border-slate-700 rounded-lg px-4 py-2 text-white"
        >
          <option value="">Все статусы</option>
          <option value="pending">Ожидают</option>
          <option value="completed">Завершены</option>
          <option value="failed">Неуспешные</option>
          <option value="refunded">Возвраты</option>
        </select>
      </div>

      <div className="bg-slate-800 rounded-xl border border-slate-700 overflow-hidden">
        <table className="w-full">
          <thead className="bg-slate-700/50">
            <tr>
              <th className="text-left px-4 py-3 text-sm font-medium text-slate-300">Тип</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-slate-300">Пользователь</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-slate-300">Организация</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-slate-300">Сумма</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-slate-300">Комиссия</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-slate-300">Дата</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-slate-300">Статус</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700">
            {loading ? (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-slate-400">Загрузка...</td></tr>
            ) : payments.length === 0 ? (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-slate-400">Нет платежей</td></tr>
            ) : (
              payments.map((p) => (
                <tr key={p._id} className="hover:bg-slate-700/30">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      {p.type === 'payout' ? (
                        <ArrowUpRight size={16} className="text-red-400" />
                      ) : (
                        <ArrowDownLeft size={16} className="text-green-400" />
                      )}
                      <span className="text-white capitalize">{p.type}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-slate-300">
                    {p.userId?.firstName || p.userId?.email || '—'}
                  </td>
                  <td className="px-4 py-3 text-slate-300">
                    {p.organizationId?.name || '—'}
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-white font-medium">₴{p.amount?.toLocaleString() || 0}</span>
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-green-400">₴{p.platformFee || 0}</span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1 text-slate-400">
                      <Clock size={14} />
                      <span className="text-sm">{format(new Date(p.createdAt), 'dd.MM.yy HH:mm')}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className={`px-2 py-1 rounded text-xs font-medium ${STATUS_COLORS[p.status] || 'bg-slate-600 text-slate-300'}`}>
                        {p.status}
                      </span>
                      <Link
                        to={`/forensic/payment/${p._id}`}
                        className="p-1.5 hover:bg-slate-700 rounded text-slate-400 hover:text-blue-300"
                        title="Forensic graph"
                        data-testid={`payment-forensic-link-${p._id}`}
                      >
                        <Activity size={14} />
                      </Link>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
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
