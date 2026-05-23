import { useEffect, useState } from 'react';
import { adminAPI } from '../services/api';
import { 
  Users, Search, Mail, Phone, Calendar, Car, MapPin, 
  ShoppingCart, Star, AlertCircle, DollarSign, Clock,
  ChevronRight, X, CreditCard, History, Heart, Shield
} from 'lucide-react';
import { format } from 'date-fns';
import { ru } from 'date-fns/locale';

interface Customer {
  _id: string;
  email: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  role: string;
  isBlocked?: boolean;
  createdAt: string;
  // Extended fields
  cityId?: string;
  district?: string;
  avatar?: string;
  totalBookings?: number;
  completedBookings?: number;
  cancellations?: number;
  disputesOpened?: number;
  averageSpend?: number;
  lastBookingAt?: string;
  vehicles?: Vehicle[];
  savedAddresses?: SavedAddress[];
  favoriteProviders?: string[];
}

interface Vehicle {
  _id: string;
  make: string;
  model: string;
  year: number;
  plate?: string;
  vin?: string;
  engine?: string;
  mileage?: number;
  isPrimary?: boolean;
}

interface SavedAddress {
  _id: string;
  label: string;
  address: string;
  lat: number;
  lng: number;
}

interface CustomerDetailProps {
  customer: Customer;
  onClose: () => void;
  onUpdate: () => void;
}

const CustomerDetail = ({ customer, onClose, onUpdate }: CustomerDetailProps) => {
  const [activeTab, setActiveTab] = useState<'overview' | 'vehicles' | 'history' | 'settings'>('overview');
  const [bookings, setBookings] = useState<any[]>([]);
  const [loadingBookings, setLoadingBookings] = useState(false);

  useEffect(() => {
    if (activeTab === 'history') {
      loadBookings();
    }
  }, [activeTab]);

  const loadBookings = async () => {
    setLoadingBookings(true);
    try {
      const res = await adminAPI.getBookings({ customerId: customer._id, limit: 20 });
      setBookings(res.data.bookings || []);
    } catch (err) {
      console.error(err);
    } finally {
      setLoadingBookings(false);
    }
  };

  const handleBlock = async () => {
    try {
      if (customer.isBlocked) {
        await adminAPI.unblockUser(customer._id);
      } else {
        await adminAPI.blockUser(customer._id);
      }
      onUpdate();
    } catch (err) {
      console.error(err);
    }
  };

  const trustScore = Math.min(100, Math.max(0, 
    100 - (customer.cancellations || 0) * 5 - (customer.disputesOpened || 0) * 10
  ));

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-slate-800 rounded-xl border border-slate-700 w-full max-w-4xl max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="p-4 border-b border-slate-700">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div className="w-16 h-16 bg-gradient-to-br from-blue-500 to-purple-600 rounded-full flex items-center justify-center">
                {customer.avatar ? (
                  <img src={customer.avatar} alt="" className="w-full h-full rounded-full object-cover" />
                ) : (
                  <span className="text-2xl font-bold text-white">
                    {customer.firstName?.[0] || customer.email[0].toUpperCase()}
                  </span>
                )}
              </div>
              <div>
                <h2 className="text-xl font-bold text-white">
                  {customer.firstName && customer.lastName 
                    ? `${customer.firstName} ${customer.lastName}`
                    : customer.email}
                </h2>
                <div className="flex items-center gap-3 mt-1 text-sm">
                  <span className="text-slate-400 flex items-center gap-1">
                    <Mail size={14} /> {customer.email}
                  </span>
                  {customer.phone && (
                    <span className="text-slate-400 flex items-center gap-1">
                      <Phone size={14} /> {customer.phone}
                    </span>
                  )}
                </div>
              </div>
            </div>
            <button onClick={onClose} className="p-2 hover:bg-slate-700 rounded-lg text-slate-400">
              <X size={20} />
            </button>
          </div>
        </div>

        {/* Quick Stats */}
        <div className="grid grid-cols-5 gap-4 p-4 bg-slate-700/30">
          <div className="text-center">
            <p className="text-2xl font-bold text-white">{customer.totalBookings || 0}</p>
            <p className="text-xs text-slate-400">Заказов</p>
          </div>
          <div className="text-center">
            <p className="text-2xl font-bold text-green-400">{customer.completedBookings || 0}</p>
            <p className="text-xs text-slate-400">Завершено</p>
          </div>
          <div className="text-center">
            <p className="text-2xl font-bold text-red-400">{customer.cancellations || 0}</p>
            <p className="text-xs text-slate-400">Отмен</p>
          </div>
          <div className="text-center">
            <p className="text-2xl font-bold text-white">₴{(customer.averageSpend || 0).toLocaleString()}</p>
            <p className="text-xs text-slate-400">Ср. чек</p>
          </div>
          <div className="text-center">
            <p className={`text-2xl font-bold ${trustScore >= 80 ? 'text-green-400' : trustScore >= 50 ? 'text-yellow-400' : 'text-red-400'}`}>
              {trustScore}
            </p>
            <p className="text-xs text-slate-400">Trust Score</p>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-slate-700">
          {[
            { id: 'overview', label: 'Обзор', icon: Users },
            { id: 'vehicles', label: 'Гараж', icon: Car },
            { id: 'history', label: 'История', icon: History },
            { id: 'settings', label: 'Управление', icon: Shield },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id as any)}
              className={`flex items-center gap-2 px-4 py-3 text-sm font-medium transition-colors ${
                activeTab === tab.id ? 'text-primary border-b-2 border-primary' : 'text-slate-400 hover:text-white'
              }`}
            >
              <tab.icon size={16} />
              {tab.label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-4">
          {activeTab === 'overview' && (
            <div className="grid grid-cols-2 gap-6">
              {/* Info */}
              <div className="space-y-4">
                <div className="bg-slate-700/50 rounded-lg p-4">
                  <h3 className="text-white font-medium mb-3">Информация</h3>
                  <div className="space-y-3 text-sm">
                    <div className="flex justify-between">
                      <span className="text-slate-400">Регистрация</span>
                      <span className="text-white">
                        {format(new Date(customer.createdAt), 'dd.MM.yyyy', { locale: ru })}
                      </span>
                    </div>
                    {customer.lastBookingAt && (
                      <div className="flex justify-between">
                        <span className="text-slate-400">Последний заказ</span>
                        <span className="text-white">
                          {format(new Date(customer.lastBookingAt), 'dd.MM.yyyy', { locale: ru })}
                        </span>
                      </div>
                    )}
                    <div className="flex justify-between">
                      <span className="text-slate-400">Город</span>
                      <span className="text-white">{customer.cityId || 'Не указан'}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-400">Район</span>
                      <span className="text-white">{customer.district || 'Не указан'}</span>
                    </div>
                  </div>
                </div>

                {/* Saved Addresses */}
                <div className="bg-slate-700/50 rounded-lg p-4">
                  <h3 className="text-white font-medium mb-3 flex items-center gap-2">
                    <MapPin size={16} /> Сохранённые адреса
                  </h3>
                  {customer.savedAddresses?.length ? (
                    <div className="space-y-2">
                      {customer.savedAddresses.map((addr) => (
                        <div key={addr._id} className="flex items-center justify-between p-2 bg-slate-600/50 rounded">
                          <div>
                            <p className="text-white text-sm font-medium">{addr.label}</p>
                            <p className="text-slate-400 text-xs">{addr.address}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-slate-500 text-sm">Нет сохранённых адресов</p>
                  )}
                </div>
              </div>

              {/* Activity & Preferences */}
              <div className="space-y-4">
                <div className="bg-slate-700/50 rounded-lg p-4">
                  <h3 className="text-white font-medium mb-3 flex items-center gap-2">
                    <Heart size={16} /> Любимые мастера
                  </h3>
                  {customer.favoriteProviders?.length ? (
                    <div className="space-y-2">
                      {customer.favoriteProviders.map((provId) => (
                        <div key={provId} className="p-2 bg-slate-600/50 rounded text-slate-300 text-sm">
                          ID: {provId}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-slate-500 text-sm">Нет избранных мастеров</p>
                  )}
                </div>

                {/* Disputes */}
                {(customer.disputesOpened || 0) > 0 && (
                  <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4">
                    <h3 className="text-red-400 font-medium mb-2 flex items-center gap-2">
                      <AlertCircle size={16} /> Споры
                    </h3>
                    <p className="text-slate-300 text-sm">
                      Открыто споров: {customer.disputesOpened}
                    </p>
                  </div>
                )}
              </div>
            </div>
          )}

          {activeTab === 'vehicles' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-white font-medium">Автомобили клиента</h3>
                <span className="text-slate-400 text-sm">{customer.vehicles?.length || 0} авто</span>
              </div>
              
              {customer.vehicles?.length ? (
                <div className="grid grid-cols-2 gap-4">
                  {customer.vehicles.map((vehicle) => (
                    <div 
                      key={vehicle._id} 
                      className={`bg-slate-700/50 rounded-lg p-4 border ${vehicle.isPrimary ? 'border-primary' : 'border-transparent'}`}
                    >
                      <div className="flex items-start justify-between">
                        <div className="flex items-center gap-3">
                          <div className="w-12 h-12 bg-slate-600 rounded-lg flex items-center justify-center">
                            <Car size={24} className="text-slate-300" />
                          </div>
                          <div>
                            <p className="text-white font-medium">
                              {vehicle.make} {vehicle.model}
                            </p>
                            <p className="text-slate-400 text-sm">{vehicle.year}</p>
                          </div>
                        </div>
                        {vehicle.isPrimary && (
                          <span className="px-2 py-1 bg-primary/20 text-primary text-xs rounded">
                            Основной
                          </span>
                        )}
                      </div>
                      <div className="mt-4 grid grid-cols-2 gap-2 text-sm">
                        {vehicle.plate && (
                          <div>
                            <span className="text-slate-500">Номер:</span>
                            <span className="text-white ml-2">{vehicle.plate}</span>
                          </div>
                        )}
                        {vehicle.vin && (
                          <div>
                            <span className="text-slate-500">VIN:</span>
                            <span className="text-white ml-2 text-xs">{vehicle.vin}</span>
                          </div>
                        )}
                        {vehicle.engine && (
                          <div>
                            <span className="text-slate-500">Двигатель:</span>
                            <span className="text-white ml-2">{vehicle.engine}</span>
                          </div>
                        )}
                        {vehicle.mileage && (
                          <div>
                            <span className="text-slate-500">Пробег:</span>
                            <span className="text-white ml-2">{vehicle.mileage.toLocaleString()} км</span>
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-12 bg-slate-700/30 rounded-lg">
                  <Car size={48} className="text-slate-600 mx-auto mb-4" />
                  <p className="text-slate-400">У клиента нет добавленных автомобилей</p>
                </div>
              )}
            </div>
          )}

          {activeTab === 'history' && (
            <div className="space-y-4">
              {loadingBookings ? (
                <div className="text-center py-8 text-slate-400">Загрузка...</div>
              ) : bookings.length > 0 ? (
                <div className="space-y-3">
                  {bookings.map((booking) => (
                    <div key={booking._id} className="bg-slate-700/50 rounded-lg p-4">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-white font-medium">{booking.service?.name || 'Услуга'}</p>
                          <p className="text-slate-400 text-sm">
                            {format(new Date(booking.createdAt), 'dd.MM.yyyy HH:mm', { locale: ru })}
                          </p>
                        </div>
                        <div className="text-right">
                          <p className="text-white font-medium">₴{booking.totalPrice || 0}</p>
                          <span className={`text-xs px-2 py-1 rounded ${
                            booking.status === 'completed' ? 'bg-green-500/20 text-green-400' :
                            booking.status === 'cancelled' ? 'bg-red-500/20 text-red-400' :
                            'bg-blue-500/20 text-blue-400'
                          }`}>
                            {booking.status}
                          </span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-12 bg-slate-700/30 rounded-lg">
                  <History size={48} className="text-slate-600 mx-auto mb-4" />
                  <p className="text-slate-400">История заказов пуста</p>
                </div>
              )}
            </div>
          )}

          {activeTab === 'settings' && (
            <div className="space-y-6">
              <div className="bg-slate-700/50 rounded-lg p-4">
                <h3 className="text-white font-medium mb-4">Статус аккаунта</h3>
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-slate-300">
                      {customer.isBlocked ? 'Аккаунт заблокирован' : 'Аккаунт активен'}
                    </p>
                    <p className="text-slate-500 text-sm">
                      {customer.isBlocked 
                        ? 'Клиент не может делать заказы' 
                        : 'Клиент может пользоваться платформой'}
                    </p>
                  </div>
                  <button
                    onClick={handleBlock}
                    className={`px-4 py-2 rounded-lg font-medium ${
                      customer.isBlocked
                        ? 'bg-green-500/20 text-green-400 hover:bg-green-500/30'
                        : 'bg-red-500/20 text-red-400 hover:bg-red-500/30'
                    }`}
                  >
                    {customer.isBlocked ? 'Разблокировать' : 'Заблокировать'}
                  </button>
                </div>
              </div>

              <div className="bg-slate-700/50 rounded-lg p-4">
                <h3 className="text-white font-medium mb-4">Действия</h3>
                <div className="space-y-2">
                  <button className="w-full flex items-center justify-between p-3 bg-slate-600/50 hover:bg-slate-600 rounded-lg text-left">
                    <div className="flex items-center gap-3">
                      <CreditCard size={18} className="text-slate-400" />
                      <span className="text-slate-300">Добавить бонус/промокод</span>
                    </div>
                    <ChevronRight size={18} className="text-slate-500" />
                  </button>
                  <button className="w-full flex items-center justify-between p-3 bg-slate-600/50 hover:bg-slate-600 rounded-lg text-left">
                    <div className="flex items-center gap-3">
                      <AlertCircle size={18} className="text-slate-400" />
                      <span className="text-slate-300">Просмотреть споры</span>
                    </div>
                    <ChevronRight size={18} className="text-slate-500" />
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-slate-700 flex justify-end">
          <button onClick={onClose} className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded-lg">
            Закрыть
          </button>
        </div>
      </div>
    </div>
  );
};

export default function CustomersPage() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const limit = 20;

  const fetchCustomers = async () => {
    setLoading(true);
    try {
      const res = await adminAPI.getUsers({
        role: 'customer',
        search: search || undefined,
        limit,
        skip: page * limit,
      });
      setCustomers(res.data.users || []);
      setTotal(res.data.total || 0);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchCustomers();
  }, [page]);

  const handleSearch = () => {
    setPage(0);
    fetchCustomers();
  };

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-blue-500/20 rounded-lg">
            <Users size={24} className="text-blue-400" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-white">Customer Profiles</h1>
            <p className="text-slate-400 text-sm">Управление профилями клиентов</p>
          </div>
        </div>
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
            placeholder="Поиск по email, имени, телефону..."
            className="w-full bg-slate-800 border border-slate-700 rounded-lg pl-10 pr-4 py-2 text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-primary"
          />
        </div>
        <button
          onClick={handleSearch}
          className="bg-primary hover:bg-primary/90 text-white px-4 py-2 rounded-lg"
        >
          Поиск
        </button>
      </div>

      {/* Table */}
      <div className="bg-slate-800 rounded-xl border border-slate-700 overflow-hidden">
        <table className="w-full">
          <thead className="bg-slate-700/50">
            <tr>
              <th className="text-left px-4 py-3 text-sm font-medium text-slate-300">Клиент</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-slate-300">Контакты</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-slate-300">Заказы</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-slate-300">Ср. чек</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-slate-300">Trust</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-slate-300">Статус</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700">
            {loading ? (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-slate-400">Загрузка...</td></tr>
            ) : customers.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-12 text-center">
                  <Users size={48} className="text-slate-600 mx-auto mb-4" />
                  <p className="text-slate-400">Клиенты не найдены</p>
                </td>
              </tr>
            ) : (
              customers.map((customer) => {
                const trustScore = Math.min(100, Math.max(0, 
                  100 - (customer.cancellations || 0) * 5 - (customer.disputesOpened || 0) * 10
                ));
                return (
                  <tr 
                    key={customer._id} 
                    className="hover:bg-slate-700/30 cursor-pointer"
                    onClick={() => setSelectedCustomer(customer)}
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 bg-gradient-to-br from-blue-500 to-purple-600 rounded-full flex items-center justify-center">
                          <span className="text-white font-medium">
                            {customer.firstName?.[0] || customer.email[0].toUpperCase()}
                          </span>
                        </div>
                        <div>
                          <p className="text-white font-medium">
                            {customer.firstName && customer.lastName 
                              ? `${customer.firstName} ${customer.lastName}`
                              : customer.email.split('@')[0]}
                          </p>
                          <p className="text-slate-500 text-xs">
                            С {format(new Date(customer.createdAt), 'dd.MM.yyyy')}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="space-y-1 text-sm">
                        <p className="text-slate-300">{customer.email}</p>
                        {customer.phone && (
                          <p className="text-slate-500">{customer.phone}</p>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className="text-white font-medium">{customer.completedBookings || 0}</span>
                        <span className="text-slate-500">/</span>
                        <span className="text-slate-400">{customer.totalBookings || 0}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-white">₴{(customer.averageSpend || 0).toLocaleString()}</span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <div className="w-16 h-2 bg-slate-600 rounded-full overflow-hidden">
                          <div 
                            className={`h-full rounded-full ${
                              trustScore >= 80 ? 'bg-green-500' : trustScore >= 50 ? 'bg-yellow-500' : 'bg-red-500'
                            }`}
                            style={{ width: `${trustScore}%` }}
                          />
                        </div>
                        <span className="text-slate-400 text-sm">{trustScore}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      {customer.isBlocked ? (
                        <span className="px-2 py-1 rounded text-xs bg-red-500/20 text-red-400">
                          Заблокирован
                        </span>
                      ) : (
                        <span className="px-2 py-1 rounded text-xs bg-green-500/20 text-green-400">
                          Активен
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {total > limit && (
        <div className="flex items-center justify-between mt-4">
          <span className="text-slate-400 text-sm">
            Показано {page * limit + 1}-{Math.min((page + 1) * limit, total)} из {total}
          </span>
          <div className="flex gap-2">
            <button
              onClick={() => setPage(p => Math.max(0, p - 1))}
              disabled={page === 0}
              className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded-lg disabled:opacity-50"
            >
              Назад
            </button>
            <button
              onClick={() => setPage(p => p + 1)}
              disabled={(page + 1) * limit >= total}
              className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded-lg disabled:opacity-50"
            >
              Вперёд
            </button>
          </div>
        </div>
      )}

      {/* Customer Detail Modal */}
      {selectedCustomer && (
        <CustomerDetail
          customer={selectedCustomer}
          onClose={() => setSelectedCustomer(null)}
          onUpdate={fetchCustomers}
        />
      )}
    </div>
  );
}
