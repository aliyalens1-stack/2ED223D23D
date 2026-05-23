// P4.3 — Vehicle Memory cache (web-app)
//
// Tiny Zustand store keyed by `vehicleId`. The ONLY responsibility here
// is optimistic reconciliation of `VehicleMemory` snapshots produced by
// the shared projection (`@platform/domain/state-machines/vehicle`).
//
// Strict scope (per P4.3 spec, do not expand without an architectural
// review):
//   ✅ Hold latest VehicleMemory per vehicleId.
//   ✅ Use shared `mergeVehicleMemory` for ALL writes (including the
//      "canonical" server snapshot — protects against stale refetch
//      clobbering known-better local state).
//   ✅ Optimistic patch returns a rollback closure. Surface owns when
//      to call it.
//   ✅ Invalidate drops a single id (used by surfaces after server
//      mutation success → triggers a fresh `setSnapshot` from server).
//
//   ❌ NO generic entity store / cache framework.
//   ❌ NO universal projection registry.
//   ❌ NO offline queue.
//   ❌ NO localStorage persistence (will revisit per spec).
//   ❌ NO event sourcing / log.
//   ❌ NO new backend endpoints.
//   ❌ NO mutation orchestration — surfaces still own fetch/mutate.
//
// The store is a CACHE LAYER. The single source of truth on the wire is
// the P4.1 `/api/customer/vehicles/:id/timeline` aggregator + shared
// projection. The store only lets us avoid empty-screen flicker between
// re-mounts and lets a `note` or `status` mutation feel instant on the
// surface.

import { create } from 'zustand';
import {
  mergeVehicleMemory,
} from '@platform/domain/state-machines/vehicle';
import type { VehicleMemory } from '@platform/domain/contracts/vehicle';

type State = {
  /** Latest known memory per vehicleId. Absence = never observed. */
  byId: Record<string, VehicleMemory>;
};

type Actions = {
  /**
   * Apply a fresh server-derived projection. Goes through
   * `mergeVehicleMemory` so a stale refetch (e.g. brief offline →
   * online round-trip) cannot regress operational status / counts /
   * flags below the locally-known-better state.
   */
  setSnapshot: (vehicleId: string, memory: VehicleMemory) => void;

  /**
   * Optimistic update. `patcher` receives the current memory (or
   * `null` if none cached yet) and returns the next memory it expects
   * the server to confirm. The store reconciles via
   * `mergeVehicleMemory`. Returns a rollback closure the surface
   * should call on mutation failure.
   *
   * Surfaces typically follow:
   *   const rollback = store.optimisticPatch(id, prev => ({...prev, ...}));
   *   try { await api.mutate(); store.invalidate(id); refetch(); }
   *   catch { rollback(); }
   */
  optimisticPatch: (
    vehicleId: string,
    patcher: (prev: VehicleMemory | null) => VehicleMemory | null,
  ) => () => void;

  /** Drop a single id (forces next read to wait for server snapshot). */
  invalidate: (vehicleId: string) => void;
};

export const useVehicleMemoryStore = create<State & Actions>((set, get) => ({
  byId: {},

  setSnapshot: (vehicleId, memory) => {
    if (!vehicleId || !memory) return;
    const prev = get().byId[vehicleId] ?? null;
    const merged = mergeVehicleMemory(prev, memory);
    if (!merged) return;
    set((s) => ({ byId: { ...s.byId, [vehicleId]: merged } }));
  },

  optimisticPatch: (vehicleId, patcher) => {
    const prev = get().byId[vehicleId] ?? null;
    const candidate = patcher(prev);
    const merged = mergeVehicleMemory(prev, candidate);
    if (merged) {
      set((s) => ({ byId: { ...s.byId, [vehicleId]: merged } }));
    }
    return () => {
      // Rollback: restore the exact prior reference (or remove the id
      // entirely if it was never observed before this patch).
      set((s) => {
        const next = { ...s.byId };
        if (prev === null) {
          delete next[vehicleId];
        } else {
          next[vehicleId] = prev;
        }
        return { byId: next };
      });
    };
  },

  invalidate: (vehicleId) => {
    set((s) => {
      if (!(vehicleId in s.byId)) return s;
      const next = { ...s.byId };
      delete next[vehicleId];
      return { byId: next };
    });
  },
}));

/** Selector hook — single id lookup. */
export const useVehicleMemory = (vehicleId: string): VehicleMemory | null =>
  useVehicleMemoryStore((s) => s.byId[vehicleId] ?? null);
