import { useState, useEffect } from 'react';
import { Flag, Plus, Edit, Trash2, Play, Pause, FlaskConical, Target, Users, Percent, ChevronRight, Check, X, Zap } from 'lucide-react';
import { adminAPI } from '../services/api';

interface FeatureFlag {
  id: string;
  key: string;
  name: string;
  description?: string;
  enabled: boolean;
  rollout: number;
  conditions?: {
    cities?: string[];
    tiers?: string[];
    minScore?: number;
  };
  type: string;
}

interface Experiment {
  id: string;
  name: string;
  description?: string;
  featureFlagKey: string;
  variants: { id: string; name: string; config: any; weight: number }[];
  metric: string;
  status: string;
  results?: any[];
  startDate?: string;
  endDate?: string;
}

export default function FeatureFlagsPage() {
  const [activeTab, setActiveTab] = useState<'flags' | 'experiments'>('flags');
  const [flags, setFlags] = useState<FeatureFlag[]>([]);
  const [experiments, setExperiments] = useState<Experiment[]>([]);
  const [loading, setLoading] = useState(true);
  const [showFlagForm, setShowFlagForm] = useState(false);
  const [showExpForm, setShowExpForm] = useState(false);
  const [editingFlag, setEditingFlag] = useState<FeatureFlag | null>(null);

  // Flag form state
  const [flagForm, setFlagForm] = useState({
    key: '',
    name: '',
    description: '',
    enabled: false,
    rollout: 100,
    type: 'release',
    conditions: { cities: [], tiers: [] },
  });

  // Experiment form state
  const [expForm, setExpForm] = useState({
    name: '',
    description: '',
    featureFlagKey: '',
    metric: 'conversion_rate',
    variants: [
      { id: 'control', name: 'Control', config: {}, weight: 50 },
      { id: 'variant_a', name: 'Variant A', config: {}, weight: 50 },
    ],
  });

  const loadData = async () => {
    setLoading(true);
    try {
      const [flagsRes, expRes] = await Promise.all([
        adminAPI.getFeatureFlags(),
        adminAPI.getExperiments(),
      ]);
      setFlags(flagsRes.data.flags || []);
      setExperiments(expRes.data.experiments || []);
    } catch (err) {
      console.error('Failed to load data:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleToggleFlag = async (key: string, enabled: boolean) => {
    try {
      await adminAPI.toggleFeatureFlag(key, enabled);
      setFlags(flags.map(f => f.key === key ? { ...f, enabled } : f));
    } catch (err) {
      console.error('Failed to toggle flag:', err);
    }
  };

  const handleCreateFlag = async () => {
    try {
      await adminAPI.createFeatureFlag(flagForm);
      setShowFlagForm(false);
      setFlagForm({ key: '', name: '', description: '', enabled: false, rollout: 100, type: 'release', conditions: { cities: [], tiers: [] } });
      loadData();
    } catch (err) {
      console.error('Failed to create flag:', err);
    }
  };

  const handleUpdateFlag = async () => {
    if (!editingFlag) return;
    try {
      await adminAPI.updateFeatureFlag(editingFlag.id, flagForm);
      setEditingFlag(null);
      setShowFlagForm(false);
      loadData();
    } catch (err) {
      console.error('Failed to update flag:', err);
    }
  };

  const handleCreateExperiment = async () => {
    try {
      await adminAPI.createExperiment(expForm);
      setShowExpForm(false);
      setExpForm({
        name: '',
        description: '',
        featureFlagKey: '',
        metric: 'conversion_rate',
        variants: [
          { id: 'control', name: 'Control', config: {}, weight: 50 },
          { id: 'variant_a', name: 'Variant A', config: {}, weight: 50 },
        ],
      });
      loadData();
    } catch (err) {
      console.error('Failed to create experiment:', err);
    }
  };

  const handleExperimentStatus = async (id: string, status: string) => {
    try {
      await adminAPI.updateExperimentStatus(id, status);
      loadData();
    } catch (err) {
      console.error('Failed to update experiment:', err);
    }
  };

  const typeColors: Record<string, string> = {
    release: 'bg-blue-500/20 text-blue-400',
    experiment: 'bg-purple-500/20 text-purple-400',
    ops: 'bg-orange-500/20 text-orange-400',
  };

  const statusColors: Record<string, string> = {
    draft: 'bg-slate-500/20 text-slate-400',
    active: 'bg-green-500/20 text-green-400',
    paused: 'bg-yellow-500/20 text-yellow-400',
    completed: 'bg-blue-500/20 text-blue-400',
  };

  return (
    <div className="p-6 bg-slate-900 min-h-screen">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-purple-500/20 rounded-lg">
            <Flag className="w-6 h-6 text-purple-400" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-white">Feature Flags & Experiments</h1>
            <p className="text-sm text-slate-400">Управление поведением системы и A/B тестирование</p>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 mb-6">
        <button
          onClick={() => setActiveTab('flags')}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-colors ${
            activeTab === 'flags' ? 'bg-purple-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
          }`}
        >
          <Flag className="w-4 h-4" />
          Feature Flags ({flags.length})
        </button>
        <button
          onClick={() => setActiveTab('experiments')}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-colors ${
            activeTab === 'experiments' ? 'bg-purple-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
          }`}
        >
          <FlaskConical className="w-4 h-4" />
          Experiments ({experiments.length})
        </button>
      </div>

      {/* Feature Flags Tab */}
      {activeTab === 'flags' && (
        <div>
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-lg font-semibold text-white">Feature Flags</h2>
            <button
              onClick={() => {
                setEditingFlag(null);
                setFlagForm({ key: '', name: '', description: '', enabled: false, rollout: 100, type: 'release', conditions: { cities: [], tiers: [] } });
                setShowFlagForm(true);
              }}
              className="flex items-center gap-2 px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-lg"
            >
              <Plus className="w-4 h-4" />
              Create Flag
            </button>
          </div>

          {/* Flag Form Modal */}
          {showFlagForm && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
              <div className="bg-slate-800 border border-slate-700 rounded-xl p-6 w-full max-w-lg">
                <h3 className="text-lg font-semibold text-white mb-4">
                  {editingFlag ? 'Edit Feature Flag' : 'New Feature Flag'}
                </h3>
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm text-slate-400 mb-1">Key</label>
                    <input
                      type="text"
                      value={flagForm.key}
                      onChange={(e) => setFlagForm({ ...flagForm, key: e.target.value })}
                      placeholder="auto_distribution"
                      disabled={!!editingFlag}
                      className="w-full bg-slate-700 border border-slate-600 rounded-lg px-4 py-2 text-white disabled:opacity-50"
                    />
                  </div>
                  <div>
                    <label className="block text-sm text-slate-400 mb-1">Name</label>
                    <input
                      type="text"
                      value={flagForm.name}
                      onChange={(e) => setFlagForm({ ...flagForm, name: e.target.value })}
                      className="w-full bg-slate-700 border border-slate-600 rounded-lg px-4 py-2 text-white"
                    />
                  </div>
                  <div>
                    <label className="block text-sm text-slate-400 mb-1">Description</label>
                    <textarea
                      value={flagForm.description}
                      onChange={(e) => setFlagForm({ ...flagForm, description: e.target.value })}
                      rows={2}
                      className="w-full bg-slate-700 border border-slate-600 rounded-lg px-4 py-2 text-white resize-none"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm text-slate-400 mb-1">Type</label>
                      <select
                        value={flagForm.type}
                        onChange={(e) => setFlagForm({ ...flagForm, type: e.target.value })}
                        className="w-full bg-slate-700 border border-slate-600 rounded-lg px-4 py-2 text-white"
                      >
                        <option value="release">Release</option>
                        <option value="experiment">Experiment</option>
                        <option value="ops">Operations</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-sm text-slate-400 mb-1">Rollout %</label>
                      <input
                        type="number"
                        min={0}
                        max={100}
                        value={flagForm.rollout}
                        onChange={(e) => setFlagForm({ ...flagForm, rollout: parseInt(e.target.value) })}
                        className="w-full bg-slate-700 border border-slate-600 rounded-lg px-4 py-2 text-white"
                      />
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <label className="text-sm text-slate-400">Enabled</label>
                    <button
                      onClick={() => setFlagForm({ ...flagForm, enabled: !flagForm.enabled })}
                      className={`relative w-12 h-6 rounded-full transition-colors ${flagForm.enabled ? 'bg-green-500' : 'bg-slate-600'}`}
                    >
                      <div className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-transform ${flagForm.enabled ? 'left-7' : 'left-1'}`} />
                    </button>
                  </div>
                </div>
                <div className="flex justify-end gap-2 mt-6">
                  <button
                    onClick={() => { setShowFlagForm(false); setEditingFlag(null); }}
                    className="px-4 py-2 bg-slate-700 text-white rounded-lg hover:bg-slate-600"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={editingFlag ? handleUpdateFlag : handleCreateFlag}
                    className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700"
                  >
                    {editingFlag ? 'Update' : 'Create'}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Flags List */}
          <div className="space-y-3">
            {flags.map((flag) => (
              <div
                key={flag.id}
                className="bg-slate-800 border border-slate-700 rounded-xl p-4 hover:border-slate-600 transition-colors"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <button
                      onClick={() => handleToggleFlag(flag.key, !flag.enabled)}
                      className={`relative w-12 h-6 rounded-full transition-colors ${flag.enabled ? 'bg-green-500' : 'bg-slate-600'}`}
                    >
                      <div className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-transform ${flag.enabled ? 'left-7' : 'left-1'}`} />
                    </button>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-white font-medium">{flag.name}</span>
                        <span className="font-mono text-xs text-slate-500">{flag.key}</span>
                        <span className={`px-2 py-0.5 rounded text-xs ${typeColors[flag.type]}`}>{flag.type}</span>
                      </div>
                      {flag.description && (
                        <p className="text-slate-400 text-sm mt-1">{flag.description}</p>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-4">
                    <div className="flex items-center gap-2 text-slate-400 text-sm">
                      <Percent className="w-4 h-4" />
                      {flag.rollout}%
                    </div>
                    {flag.conditions?.tiers && flag.conditions.tiers.length > 0 && (
                      <div className="flex items-center gap-1 text-slate-400 text-sm">
                        <Users className="w-4 h-4" />
                        {flag.conditions.tiers.join(', ')}
                      </div>
                    )}
                    <button
                      onClick={() => {
                        setEditingFlag(flag);
                        setFlagForm({
                          key: flag.key,
                          name: flag.name,
                          description: flag.description || '',
                          enabled: flag.enabled,
                          rollout: flag.rollout,
                          type: flag.type,
                          conditions: flag.conditions || { cities: [], tiers: [] },
                        });
                        setShowFlagForm(true);
                      }}
                      className="p-2 hover:bg-slate-700 rounded-lg text-slate-400"
                    >
                      <Edit className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </div>
            ))}
            {flags.length === 0 && !loading && (
              <div className="bg-slate-800 border border-slate-700 rounded-xl p-8 text-center">
                <Flag className="w-12 h-12 text-slate-600 mx-auto mb-2" />
                <p className="text-slate-400">No feature flags yet</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Experiments Tab */}
      {activeTab === 'experiments' && (
        <div>
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-lg font-semibold text-white">A/B Experiments</h2>
            <button
              onClick={() => setShowExpForm(true)}
              className="flex items-center gap-2 px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-lg"
            >
              <Plus className="w-4 h-4" />
              New Experiment
            </button>
          </div>

          {/* Experiment Form Modal */}
          {showExpForm && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
              <div className="bg-slate-800 border border-slate-700 rounded-xl p-6 w-full max-w-lg">
                <h3 className="text-lg font-semibold text-white mb-4">New Experiment</h3>
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm text-slate-400 mb-1">Name</label>
                    <input
                      type="text"
                      value={expForm.name}
                      onChange={(e) => setExpForm({ ...expForm, name: e.target.value })}
                      placeholder="Distribution radius test"
                      className="w-full bg-slate-700 border border-slate-600 rounded-lg px-4 py-2 text-white"
                    />
                  </div>
                  <div>
                    <label className="block text-sm text-slate-400 mb-1">Feature Flag Key</label>
                    <select
                      value={expForm.featureFlagKey}
                      onChange={(e) => setExpForm({ ...expForm, featureFlagKey: e.target.value })}
                      className="w-full bg-slate-700 border border-slate-600 rounded-lg px-4 py-2 text-white"
                    >
                      <option value="">Select flag...</option>
                      {flags.filter(f => f.type === 'experiment').map(f => (
                        <option key={f.key} value={f.key}>{f.name}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm text-slate-400 mb-1">Success Metric</label>
                    <select
                      value={expForm.metric}
                      onChange={(e) => setExpForm({ ...expForm, metric: e.target.value })}
                      className="w-full bg-slate-700 border border-slate-600 rounded-lg px-4 py-2 text-white"
                    >
                      <option value="conversion_rate">Conversion Rate</option>
                      <option value="gmv">GMV</option>
                      <option value="response_time">Response Time</option>
                      <option value="completion_rate">Completion Rate</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm text-slate-400 mb-2">Variants</label>
                    {expForm.variants.map((v, i) => (
                      <div key={i} className="flex gap-2 mb-2">
                        <input
                          type="text"
                          value={v.name}
                          onChange={(e) => {
                            const variants = [...expForm.variants];
                            variants[i].name = e.target.value;
                            setExpForm({ ...expForm, variants });
                          }}
                          className="flex-1 bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm"
                        />
                        <input
                          type="number"
                          value={v.weight}
                          onChange={(e) => {
                            const variants = [...expForm.variants];
                            variants[i].weight = parseInt(e.target.value);
                            setExpForm({ ...expForm, variants });
                          }}
                          className="w-20 bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm"
                          placeholder="%"
                        />
                      </div>
                    ))}
                  </div>
                </div>
                <div className="flex justify-end gap-2 mt-6">
                  <button
                    onClick={() => setShowExpForm(false)}
                    className="px-4 py-2 bg-slate-700 text-white rounded-lg hover:bg-slate-600"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleCreateExperiment}
                    className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700"
                  >
                    Create
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Experiments List */}
          <div className="space-y-3">
            {experiments.map((exp) => (
              <div
                key={exp.id}
                className="bg-slate-800 border border-slate-700 rounded-xl p-4"
              >
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <FlaskConical className="w-5 h-5 text-purple-400" />
                      <span className="text-white font-medium">{exp.name}</span>
                      <span className={`px-2 py-0.5 rounded text-xs ${statusColors[exp.status]}`}>
                        {exp.status}
                      </span>
                    </div>
                    <p className="text-slate-500 text-sm mt-1">
                      Metric: {exp.metric} • Flag: {exp.featureFlagKey}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {exp.status === 'draft' && (
                      <button
                        onClick={() => handleExperimentStatus(exp.id, 'active')}
                        className="flex items-center gap-1 px-3 py-1.5 bg-green-500/20 text-green-400 rounded-lg text-sm hover:bg-green-500/30"
                      >
                        <Play className="w-4 h-4" />
                        Start
                      </button>
                    )}
                    {exp.status === 'active' && (
                      <>
                        <button
                          onClick={() => handleExperimentStatus(exp.id, 'paused')}
                          className="flex items-center gap-1 px-3 py-1.5 bg-yellow-500/20 text-yellow-400 rounded-lg text-sm hover:bg-yellow-500/30"
                        >
                          <Pause className="w-4 h-4" />
                          Pause
                        </button>
                        <button
                          onClick={() => handleExperimentStatus(exp.id, 'completed')}
                          className="flex items-center gap-1 px-3 py-1.5 bg-blue-500/20 text-blue-400 rounded-lg text-sm hover:bg-blue-500/30"
                        >
                          <Check className="w-4 h-4" />
                          Complete
                        </button>
                      </>
                    )}
                  </div>
                </div>
                
                {/* Variants */}
                <div className="grid grid-cols-2 gap-3">
                  {exp.variants.map((v) => (
                    <div key={v.id} className="bg-slate-700/50 rounded-lg p-3">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-white text-sm font-medium">{v.name}</span>
                        <span className="text-slate-400 text-sm">{v.weight}%</span>
                      </div>
                      <div className="h-2 bg-slate-600 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-purple-500 rounded-full"
                          style={{ width: `${v.weight}%` }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
            {experiments.length === 0 && !loading && (
              <div className="bg-slate-800 border border-slate-700 rounded-xl p-8 text-center">
                <FlaskConical className="w-12 h-12 text-slate-600 mx-auto mb-2" />
                <p className="text-slate-400">No experiments yet</p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
