import { useEffect, useState } from 'react';
import { adminAPI } from '../services/api';
import { 
  Package, Search, Plus, Edit, Trash2, X,
  DollarSign, Clock, Zap, AlertCircle, CheckCircle, Save
} from 'lucide-react';

interface ServiceCategory {
  _id: string;
  name: string;
  slug: string;
  description?: string;
  icon?: string;
  status: string;
  sortOrder?: number;
}

interface Service {
  _id: string;
  categoryId?: string;
  name: string;
  slug: string;
  description?: string;
  priceMin?: number;
  priceMax?: number;
  durationMin?: number;
  durationMax?: number;
  requiresDiagnostics?: boolean;
  status: string;
}

interface PricingConfig {
  key: string;
  value: any;
  description?: string;
}

export default function ServicesPage() {
  const [categories, setCategories] = useState<ServiceCategory[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'categories' | 'services' | 'pricing'>('categories');
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [showModal, setShowModal] = useState<'category' | 'service' | null>(null);
  const [editingItem, setEditingItem] = useState<any>(null);
  const [saving, setSaving] = useState(false);

  // Form states
  const [catForm, setCatForm] = useState({ name: '', description: '', icon: '', sortOrder: 0 });
  const [svcForm, setSvcForm] = useState({ name: '', description: '', categoryId: '', priceMin: 0, priceMax: 0, durationMin: 30, durationMax: 60, requiresDiagnostics: false });
  
  // Pricing config
  const [configItems, setConfigItems] = useState<PricingConfig[]>([]);
  const [configLoading, setConfigLoading] = useState(false);

  const fetchData = async () => {
    setLoading(true);
    try {
      const [catRes, svcRes] = await Promise.all([
        adminAPI.getAllServiceCategories().catch(() => ({ data: [] })),
        adminAPI.getAllServicesList().catch(() => adminAPI.getServicesList()),
      ]);
      setCategories(catRes.data || []);
      setServices(svcRes.data || []);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const fetchConfig = async () => {
    setConfigLoading(true);
    try {
      const res = await adminAPI.getConfig();
      setConfigItems(res.data || []);
    } catch (err) {
      console.error(err);
    } finally {
      setConfigLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  useEffect(() => {
    if (activeTab === 'pricing') fetchConfig();
  }, [activeTab]);

  // Category CRUD
  const handleSaveCategory = async () => {
    setSaving(true);
    try {
      if (editingItem) {
        await adminAPI.updateServiceCategory(editingItem._id, catForm);
      } else {
        await adminAPI.createServiceCategory(catForm);
      }
      setShowModal(null);
      setEditingItem(null);
      setCatForm({ name: '', description: '', icon: '', sortOrder: 0 });
      fetchData();
    } catch (err) {
      console.error(err);
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteCategory = async (id: string) => {
    if (!confirm('Деактивировать категорию?')) return;
    try {
      await adminAPI.deleteServiceCategory(id);
      fetchData();
    } catch (err) {
      console.error(err);
    }
  };

  // Service CRUD
  const handleSaveService = async () => {
    setSaving(true);
    try {
      if (editingItem) {
        await adminAPI.updateService(editingItem._id, svcForm);
      } else {
        await adminAPI.createService(svcForm);
      }
      setShowModal(null);
      setEditingItem(null);
      setSvcForm({ name: '', description: '', categoryId: '', priceMin: 0, priceMax: 0, durationMin: 30, durationMax: 60, requiresDiagnostics: false });
      fetchData();
    } catch (err) {
      console.error(err);
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteService = async (id: string) => {
    if (!confirm('Деактивировать услугу?')) return;
    try {
      await adminAPI.deleteService(id);
      fetchData();
    } catch (err) {
      console.error(err);
    }
  };

  // Config save
  const handleSaveConfig = async (key: string, value: any) => {
    try {
      await adminAPI.setConfig(key, value);
      fetchConfig();
    } catch (err) {
      console.error(err);
    }
  };

  const openEditCategory = (cat: ServiceCategory) => {
    setCatForm({ name: cat.name, description: cat.description || '', icon: cat.icon || '', sortOrder: cat.sortOrder || 0 });
    setEditingItem(cat);
    setShowModal('category');
  };

  const openEditService = (svc: Service) => {
    setSvcForm({
      name: svc.name,
      description: svc.description || '',
      categoryId: svc.categoryId || '',
      priceMin: svc.priceMin || 0,
      priceMax: svc.priceMax || 0,
      durationMin: svc.durationMin || 30,
      durationMax: svc.durationMax || 60,
      requiresDiagnostics: svc.requiresDiagnostics || false,
    });
    setEditingItem(svc);
    setShowModal('service');
  };

  const filteredServices = selectedCategory
    ? services.filter(s => s.categoryId === selectedCategory)
    : services;

  const activeCategories = categories.filter(c => c.status === 'active');
  const activeServices = filteredServices.filter(s => s.status === 'active');

  return (
    <div className="p-6" data-testid="services-page">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-purple-500/20 rounded-lg">
            <Package size={24} className="text-purple-400" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-white">Services & Pricing</h1>
            <p className="text-slate-400 text-sm">Управление услугами и ценообразованием</p>
          </div>
        </div>
        <div className="flex items-center gap-2 text-slate-400 text-sm">
          <span>{activeCategories.length} категорий</span>
          <span>•</span>
          <span>{services.filter(s => s.status === 'active').length} услуг</span>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 mb-6 bg-slate-800 p-1 rounded-lg w-fit">
        {[
          { id: 'categories', label: 'Категории' },
          { id: 'services', label: 'Услуги' },
          { id: 'pricing', label: 'Ценообразование' },
        ].map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id as any)}
            data-testid={`tab-${tab.id}`}
            className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
              activeTab === tab.id ? 'bg-primary text-white' : 'text-slate-400 hover:text-white'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="bg-slate-800 rounded-xl border border-slate-700 p-12 text-center text-slate-400">Загрузка...</div>
      ) : (
        <>
          {/* Categories Tab */}
          {activeTab === 'categories' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-medium text-white">Категории услуг ({activeCategories.length})</h2>
                <button
                  onClick={() => { setCatForm({ name: '', description: '', icon: '', sortOrder: 0 }); setEditingItem(null); setShowModal('category'); }}
                  data-testid="add-category-btn"
                  className="flex items-center gap-2 px-4 py-2 bg-primary hover:bg-primary/90 text-white rounded-lg"
                >
                  <Plus size={18} /> Добавить
                </button>
              </div>

              {activeCategories.length === 0 ? (
                <div className="bg-slate-800 rounded-xl border border-slate-700 p-12 text-center">
                  <Package size={48} className="text-slate-600 mx-auto mb-4" />
                  <p className="text-slate-400">Нет категорий. Создайте первую!</p>
                </div>
              ) : (
                <div className="grid grid-cols-3 gap-4">
                  {activeCategories.map((cat) => {
                    const svcCount = services.filter(s => s.categoryId === cat._id && s.status === 'active').length;
                    return (
                      <div
                        key={cat._id}
                        data-testid={`category-card-${cat._id}`}
                        className={`bg-slate-800 rounded-xl border p-4 cursor-pointer transition-all ${
                          selectedCategory === cat._id ? 'border-primary' : 'border-slate-700 hover:border-slate-600'
                        }`}
                        onClick={() => { setSelectedCategory(selectedCategory === cat._id ? null : cat._id); setActiveTab('services'); }}
                      >
                        <div className="flex items-start justify-between">
                          <div className="flex items-center gap-3">
                            <span className="text-2xl">{cat.icon || '📦'}</span>
                            <div>
                              <h3 className="text-white font-medium">{cat.name}</h3>
                              <p className="text-slate-500 text-sm">{svcCount} услуг</p>
                            </div>
                          </div>
                          <div className="flex items-center gap-1">
                            <button onClick={(e) => { e.stopPropagation(); openEditCategory(cat); }} className="p-1 hover:bg-slate-700 rounded text-slate-400" data-testid={`edit-cat-${cat._id}`}>
                              <Edit size={14} />
                            </button>
                            <button onClick={(e) => { e.stopPropagation(); handleDeleteCategory(cat._id); }} className="p-1 hover:bg-red-500/20 rounded text-slate-400 hover:text-red-400" data-testid={`delete-cat-${cat._id}`}>
                              <Trash2 size={14} />
                            </button>
                          </div>
                        </div>
                        {cat.description && <p className="text-slate-500 text-xs mt-2">{cat.description}</p>}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Services Tab */}
          {activeTab === 'services' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <h2 className="text-lg font-medium text-white">Услуги ({activeServices.length})</h2>
                  {selectedCategory && (
                    <button onClick={() => setSelectedCategory(null)} className="text-sm text-primary hover:underline">
                      Показать все
                    </button>
                  )}
                </div>
                <button
                  onClick={() => { setSvcForm({ name: '', description: '', categoryId: selectedCategory || '', priceMin: 0, priceMax: 0, durationMin: 30, durationMax: 60, requiresDiagnostics: false }); setEditingItem(null); setShowModal('service'); }}
                  data-testid="add-service-btn"
                  className="flex items-center gap-2 px-4 py-2 bg-primary hover:bg-primary/90 text-white rounded-lg"
                >
                  <Plus size={18} /> Добавить услугу
                </button>
              </div>

              {/* Category filter chips */}
              {activeCategories.length > 0 && (
                <div className="flex gap-2 flex-wrap">
                  <button
                    onClick={() => setSelectedCategory(null)}
                    className={`px-3 py-1.5 rounded-lg text-sm ${!selectedCategory ? 'bg-primary text-white' : 'bg-slate-700 text-slate-300 hover:bg-slate-600'}`}
                  >
                    Все
                  </button>
                  {activeCategories.map((cat) => (
                    <button
                      key={cat._id}
                      onClick={() => setSelectedCategory(cat._id)}
                      className={`px-3 py-1.5 rounded-lg text-sm flex items-center gap-1 ${
                        selectedCategory === cat._id ? 'bg-primary text-white' : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                      }`}
                    >
                      <span>{cat.icon || '📦'}</span> {cat.name}
                    </button>
                  ))}
                </div>
              )}

              {/* Services Table */}
              <div className="bg-slate-800 rounded-xl border border-slate-700 overflow-hidden">
                <table className="w-full">
                  <thead className="bg-slate-700/50">
                    <tr>
                      <th className="text-left px-4 py-3 text-sm font-medium text-slate-300">Услуга</th>
                      <th className="text-left px-4 py-3 text-sm font-medium text-slate-300">Цена (мин–макс)</th>
                      <th className="text-left px-4 py-3 text-sm font-medium text-slate-300">Время (мин–макс)</th>
                      <th className="text-left px-4 py-3 text-sm font-medium text-slate-300">Доп.</th>
                      <th className="text-left px-4 py-3 text-sm font-medium text-slate-300">Статус</th>
                      <th className="text-right px-4 py-3 text-sm font-medium text-slate-300">Действия</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-700">
                    {activeServices.length === 0 ? (
                      <tr><td colSpan={6} className="px-4 py-12 text-center text-slate-400">
                        <Package size={48} className="text-slate-600 mx-auto mb-4" />
                        <p>Нет услуг{selectedCategory ? ' в этой категории' : ''}</p>
                      </td></tr>
                    ) : (
                      activeServices.map((service) => {
                        const category = categories.find(c => c._id === service.categoryId);
                        return (
                          <tr key={service._id} className="hover:bg-slate-700/30" data-testid={`service-row-${service._id}`}>
                            <td className="px-4 py-3">
                              <div>
                                <p className="text-white font-medium">{service.name}</p>
                                <p className="text-slate-500 text-xs">{category?.name || 'Без категории'}</p>
                              </div>
                            </td>
                            <td className="px-4 py-3">
                              <span className="text-white font-medium flex items-center gap-1">
                                <DollarSign size={14} className="text-green-400" />
                                ₴{service.priceMin || 0} — ₴{service.priceMax || 0}
                              </span>
                            </td>
                            <td className="px-4 py-3">
                              <span className="text-slate-300 flex items-center gap-1">
                                <Clock size={14} className="text-slate-500" />
                                {service.durationMin || 0}–{service.durationMax || 0} мин
                              </span>
                            </td>
                            <td className="px-4 py-3">
                              <div className="flex items-center gap-2">
                                {service.requiresDiagnostics && (
                                  <span className="px-2 py-0.5 bg-orange-500/20 text-orange-400 text-xs rounded flex items-center gap-1">
                                    <Zap size={12} /> Диагностика
                                  </span>
                                )}
                              </div>
                            </td>
                            <td className="px-4 py-3">
                              <span className="px-2 py-1 bg-green-500/20 text-green-400 text-xs rounded flex items-center gap-1 w-fit">
                                <CheckCircle size={12} /> Активна
                              </span>
                            </td>
                            <td className="px-4 py-3 text-right">
                              <div className="flex items-center justify-end gap-1">
                                <button onClick={() => openEditService(service)} className="p-2 hover:bg-slate-700 rounded text-slate-400 hover:text-white" data-testid={`edit-svc-${service._id}`}>
                                  <Edit size={16} />
                                </button>
                                <button onClick={() => handleDeleteService(service._id)} className="p-2 hover:bg-red-500/20 rounded text-slate-400 hover:text-red-400" data-testid={`delete-svc-${service._id}`}>
                                  <Trash2 size={16} />
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Pricing Tab */}
          {activeTab === 'pricing' && (
            <div className="space-y-6">
              <h2 className="text-lg font-medium text-white">Platform Configuration</h2>
              {configLoading ? (
                <div className="bg-slate-800 rounded-xl border border-slate-700 p-8 text-center text-slate-400">Загрузка...</div>
              ) : (
                <div className="grid grid-cols-2 gap-4">
                  {configItems.filter(c => !c.key.startsWith('stripe.')).map((item: any) => (
                    <ConfigCard key={item.key} item={item} onSave={handleSaveConfig} />
                  ))}
                </div>
              )}

              {/* Stripe Config */}
              <div className="mt-6">
                <h3 className="text-lg font-medium text-white mb-4">Stripe (Платежи)</h3>
                <div className="grid grid-cols-2 gap-4">
                  {configItems.filter(c => c.key.startsWith('stripe.')).map((item: any) => (
                    <ConfigCard key={item.key} item={item} onSave={handleSaveConfig} />
                  ))}
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {/* Category Modal */}
      {showModal === 'category' && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-slate-800 rounded-xl border border-slate-700 w-full max-w-md" data-testid="category-modal">
            <div className="p-4 border-b border-slate-700 flex items-center justify-between">
              <h2 className="text-white font-semibold">{editingItem ? 'Редактировать категорию' : 'Новая категория'}</h2>
              <button onClick={() => { setShowModal(null); setEditingItem(null); }} className="text-slate-400 hover:text-white"><X size={20} /></button>
            </div>
            <div className="p-4 space-y-4">
              <div>
                <label className="text-slate-400 text-sm mb-1 block">Название *</label>
                <input type="text" value={catForm.name} onChange={e => setCatForm(f => ({ ...f, name: e.target.value }))} className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white" data-testid="cat-name-input" />
              </div>
              <div>
                <label className="text-slate-400 text-sm mb-1 block">Описание</label>
                <input type="text" value={catForm.description} onChange={e => setCatForm(f => ({ ...f, description: e.target.value }))} className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white" />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-slate-400 text-sm mb-1 block">Иконка (emoji)</label>
                  <input type="text" value={catForm.icon} onChange={e => setCatForm(f => ({ ...f, icon: e.target.value }))} className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white" placeholder="🔧" />
                </div>
                <div>
                  <label className="text-slate-400 text-sm mb-1 block">Порядок</label>
                  <input type="number" value={catForm.sortOrder} onChange={e => setCatForm(f => ({ ...f, sortOrder: parseInt(e.target.value) || 0 }))} className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white" />
                </div>
              </div>
            </div>
            <div className="p-4 border-t border-slate-700 flex justify-end gap-2">
              <button onClick={() => { setShowModal(null); setEditingItem(null); }} className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded-lg">Отмена</button>
              <button onClick={handleSaveCategory} disabled={!catForm.name || saving} className="px-4 py-2 bg-primary hover:bg-primary/90 text-white rounded-lg disabled:opacity-50 flex items-center gap-2" data-testid="save-category-btn">
                <Save size={16} /> {saving ? 'Сохранение...' : 'Сохранить'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Service Modal */}
      {showModal === 'service' && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-slate-800 rounded-xl border border-slate-700 w-full max-w-lg" data-testid="service-modal">
            <div className="p-4 border-b border-slate-700 flex items-center justify-between">
              <h2 className="text-white font-semibold">{editingItem ? 'Редактировать услугу' : 'Новая услуга'}</h2>
              <button onClick={() => { setShowModal(null); setEditingItem(null); }} className="text-slate-400 hover:text-white"><X size={20} /></button>
            </div>
            <div className="p-4 space-y-4">
              <div>
                <label className="text-slate-400 text-sm mb-1 block">Название *</label>
                <input type="text" value={svcForm.name} onChange={e => setSvcForm(f => ({ ...f, name: e.target.value }))} className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white" data-testid="svc-name-input" />
              </div>
              <div>
                <label className="text-slate-400 text-sm mb-1 block">Описание</label>
                <textarea value={svcForm.description} onChange={e => setSvcForm(f => ({ ...f, description: e.target.value }))} rows={2} className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white" />
              </div>
              <div>
                <label className="text-slate-400 text-sm mb-1 block">Категория</label>
                <select value={svcForm.categoryId} onChange={e => setSvcForm(f => ({ ...f, categoryId: e.target.value }))} className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white">
                  <option value="">Без категории</option>
                  {activeCategories.map(c => <option key={c._id} value={c._id}>{c.icon} {c.name}</option>)}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-slate-400 text-sm mb-1 block">Цена мин (₴)</label>
                  <input type="number" value={svcForm.priceMin} onChange={e => setSvcForm(f => ({ ...f, priceMin: parseInt(e.target.value) || 0 }))} className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white" data-testid="svc-price-input" />
                </div>
                <div>
                  <label className="text-slate-400 text-sm mb-1 block">Цена макс (₴)</label>
                  <input type="number" value={svcForm.priceMax} onChange={e => setSvcForm(f => ({ ...f, priceMax: parseInt(e.target.value) || 0 }))} className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-slate-400 text-sm mb-1 block">Время мин (мин)</label>
                  <input type="number" value={svcForm.durationMin} onChange={e => setSvcForm(f => ({ ...f, durationMin: parseInt(e.target.value) || 0 }))} className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white" />
                </div>
                <div>
                  <label className="text-slate-400 text-sm mb-1 block">Время макс (мин)</label>
                  <input type="number" value={svcForm.durationMax} onChange={e => setSvcForm(f => ({ ...f, durationMax: parseInt(e.target.value) || 0 }))} className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white" />
                </div>
              </div>
              <div className="flex gap-4">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={svcForm.requiresDiagnostics} onChange={e => setSvcForm(f => ({ ...f, requiresDiagnostics: e.target.checked }))} className="rounded bg-slate-700 border-slate-600 text-primary" />
                  <Zap size={16} className="text-orange-400" />
                  <span className="text-slate-300 text-sm">Требует диагностики</span>
                </label>
              </div>
            </div>
            <div className="p-4 border-t border-slate-700 flex justify-end gap-2">
              <button onClick={() => { setShowModal(null); setEditingItem(null); }} className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded-lg">Отмена</button>
              <button onClick={handleSaveService} disabled={!svcForm.name || saving} className="px-4 py-2 bg-primary hover:bg-primary/90 text-white rounded-lg disabled:opacity-50 flex items-center gap-2" data-testid="save-service-btn">
                <Save size={16} /> {saving ? 'Сохранение...' : 'Сохранить'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Config Card Component
function ConfigCard({ item, onSave }: { item: any; onSave: (key: string, value: any) => void }) {
  const [value, setValue] = useState(item.value);
  const [changed, setChanged] = useState(false);

  const isSecret = item.isSecret;
  const label = item.description || item.key;

  const handleChange = (newVal: any) => {
    setValue(newVal);
    setChanged(true);
  };

  const handleSave = () => {
    onSave(item.key, value);
    setChanged(false);
  };

  return (
    <div className="bg-slate-800 rounded-xl border border-slate-700 p-4" data-testid={`config-${item.key}`}>
      <div className="flex items-start justify-between mb-2">
        <div>
          <p className="text-white font-medium text-sm">{label}</p>
          <p className="text-slate-500 text-xs font-mono">{item.key}</p>
        </div>
        {changed && (
          <button onClick={handleSave} className="flex items-center gap-1 px-3 py-1 bg-primary hover:bg-primary/90 text-white text-sm rounded" data-testid={`save-config-${item.key}`}>
            <Save size={12} /> Сохранить
          </button>
        )}
      </div>
      {isSecret ? (
        <input
          type="password"
          value={value}
          onChange={e => handleChange(e.target.value)}
          placeholder="***"
          className="w-full bg-slate-700 border border-slate-600 rounded px-3 py-2 text-white text-sm"
        />
      ) : typeof item.value === 'number' ? (
        <input
          type="number"
          value={value}
          onChange={e => handleChange(parseFloat(e.target.value) || 0)}
          className="w-full bg-slate-700 border border-slate-600 rounded px-3 py-2 text-white text-sm"
        />
      ) : (
        <input
          type="text"
          value={value}
          onChange={e => handleChange(e.target.value)}
          className="w-full bg-slate-700 border border-slate-600 rounded px-3 py-2 text-white text-sm"
        />
      )}
    </div>
  );
}
