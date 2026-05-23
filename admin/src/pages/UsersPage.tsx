import { useEffect, useState } from 'react';
import { adminAPI } from '../services/api';
import { Search, UserX, UserCheck, Mail, Phone, Calendar } from 'lucide-react';
import { format } from 'date-fns';

interface User {
  _id: string;
  email: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  role: string;
  isBlocked?: boolean;
  isActive?: boolean;
  createdAt: string;
}

const ROLES = [
  { value: '', label: 'Все роли' },
  { value: 'customer', label: 'Клиенты' },
  { value: 'provider_owner', label: 'Владельцы СТО' },
  { value: 'admin', label: 'Админы' },
];

const ROLE_LABELS: Record<string, string> = {
  customer: 'Клиент',
  provider_owner: 'Владелец СТО',
  provider_manager: 'Менеджер',
  admin: 'Админ',
  support: 'Поддержка',
};

const ROLE_COLORS: Record<string, string> = {
  customer: 'bg-blue-500/20 text-blue-400',
  provider_owner: 'bg-green-500/20 text-green-400',
  provider_manager: 'bg-emerald-500/20 text-emerald-400',
  admin: 'bg-red-500/20 text-red-400',
  support: 'bg-purple-500/20 text-purple-400',
};

export default function UsersPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [role, setRole] = useState('');
  const [page, setPage] = useState(0);
  const limit = 20;

  const fetchUsers = async () => {
    setLoading(true);
    try {
      const res = await adminAPI.getUsers({
        role: role || undefined,
        search: search || undefined,
        limit,
        skip: page * limit,
      });
      setUsers(res.data.users);
      setTotal(res.data.total);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchUsers();
  }, [role, page]);

  const handleSearch = () => {
    setPage(0);
    fetchUsers();
  };

  const toggleBlock = async (user: User) => {
    try {
      if (user.isBlocked) {
        await adminAPI.unblockUser(user._id);
      } else {
        await adminAPI.blockUser(user._id);
      }
      fetchUsers();
    } catch (err) {
      console.error(err);
    }
  };

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-white">Пользователи</h1>
        <span className="text-slate-400">Всего: {total}</span>
      </div>

      {/* Filters */}
      <div className="flex gap-4 mb-6">
        <div className="flex-1 relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={20} />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            placeholder="Поиск по email, имени..."
            className="w-full bg-slate-800 border border-slate-700 rounded-lg pl-10 pr-4 py-2 text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-primary"
          />
        </div>
        <select
          value={role}
          onChange={(e) => { setRole(e.target.value); setPage(0); }}
          className="bg-slate-800 border border-slate-700 rounded-lg px-4 py-2 text-white focus:outline-none focus:ring-2 focus:ring-primary"
        >
          {ROLES.map((r) => (
            <option key={r.value} value={r.value}>{r.label}</option>
          ))}
        </select>
        <button
          onClick={handleSearch}
          className="bg-primary hover:bg-primary/90 text-white px-4 py-2 rounded-lg transition-colors"
        >
          Поиск
        </button>
      </div>

      {/* Table */}
      <div className="bg-slate-800 rounded-xl border border-slate-700 overflow-hidden">
        <table className="w-full">
          <thead className="bg-slate-700/50">
            <tr>
              <th className="text-left px-4 py-3 text-sm font-medium text-slate-300">Пользователь</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-slate-300">Контакты</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-slate-300">Роль</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-slate-300">Дата регистрации</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-slate-300">Статус</th>
              <th className="text-right px-4 py-3 text-sm font-medium text-slate-300">Действия</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700">
            {loading ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-slate-400">
                  Загрузка...
                </td>
              </tr>
            ) : users.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-slate-400">
                  Пользователи не найдены
                </td>
              </tr>
            ) : (
              users.map((user) => (
                <tr key={user._id} className="hover:bg-slate-700/30">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 bg-slate-600 rounded-full flex items-center justify-center">
                        <span className="text-white font-medium">
                          {user.firstName?.[0] || user.email[0].toUpperCase()}
                        </span>
                      </div>
                      <div>
                        <p className="text-white font-medium">
                          {user.firstName && user.lastName 
                            ? `${user.firstName} ${user.lastName}`
                            : user.email}
                        </p>
                        <p className="text-sm text-slate-400">{user._id}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-col gap-1">
                      <span className="text-slate-300 flex items-center gap-1">
                        <Mail size={14} /> {user.email}
                      </span>
                      {user.phone && (
                        <span className="text-slate-400 flex items-center gap-1">
                          <Phone size={14} /> {user.phone}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-1 rounded text-xs font-medium ${ROLE_COLORS[user.role] || 'bg-slate-600 text-slate-300'}`}>
                      {ROLE_LABELS[user.role] || user.role}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-slate-300 flex items-center gap-1">
                      <Calendar size={14} />
                      {format(new Date(user.createdAt), 'dd.MM.yyyy')}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {user.isBlocked ? (
                      <span className="px-2 py-1 rounded text-xs font-medium bg-red-500/20 text-red-400">
                        Заблокирован
                      </span>
                    ) : (
                      <span className="px-2 py-1 rounded text-xs font-medium bg-green-500/20 text-green-400">
                        Активен
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => toggleBlock(user)}
                      className={`p-2 rounded-lg transition-colors ${
                        user.isBlocked 
                          ? 'bg-green-500/20 hover:bg-green-500/30 text-green-400' 
                          : 'bg-red-500/20 hover:bg-red-500/30 text-red-400'
                      }`}
                      title={user.isBlocked ? 'Разблокировать' : 'Заблокировать'}
                    >
                      {user.isBlocked ? <UserCheck size={18} /> : <UserX size={18} />}
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {total > limit && (
        <div className="flex items-center justify-between mt-4">
          <span className="text-slate-400 text-sm">
            Страница {page + 1} из {Math.ceil(total / limit)}
          </span>
          <div className="flex gap-2">
            <button
              onClick={() => setPage(p => Math.max(0, p - 1))}
              disabled={page === 0}
              className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded-lg disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Назад
            </button>
            <button
              onClick={() => setPage(p => p + 1)}
              disabled={(page + 1) * limit >= total}
              className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded-lg disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Вперёд
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
