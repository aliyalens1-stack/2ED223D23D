// P4.3 — Vehicle Memory cache (mobile)
//
// Mirror of `web-app/src/stores/vehicleMemoryStore.ts`. Identical
// shape, identical reconciliation logic, identical scope rules. The
// only thing that differs from the web mirror is the import target
// (Zustand v5 here, v4 in web-app — both expose `create`).
//
// Strict scope (per P4.3 spec, do not expand without an architectural
// review):
//   ✅ Hold latest VehicleMemory per vehicleId.
//   ✅ Use shared `mergeVehicleMemory` for ALL writes (server snapshot
//      AND optimistic patches). Stale refetch never regresses below
//      locally-known-better state.
//   ✅ Optimistic patch returns a rollback closure.
//   ✅ Invalidate drops a single id.
//
//   ❌ NO generic entity store / cache framework.
//   ❌ NO universal projection registry.
//   ❌ NO offline queue.
//   ❌ NO AsyncStorage persistence (will revisit per spec).
//   ❌ NO event sourcing / log.
//   ❌ NO new backend endpoints.
//   ❌ NO mutation orchestration — surfaces own fetch/mutate.
//
// The store is a CACHE LAYER. The shared semantic kernel
// (@platform/domain/state-machines/vehicle) remains the single
// source of truth on perception/stage derivation.

import { create } from 'zustand';
import {
  mergeVehicleMemory,
} from '@platform/domain/state-machines/vehicle';
import type { VehicleMemory } from '@platform/domain/contracts/vehicle';

type State = {
  byId: Record<string, VehicleMemory>;
};

type Actions = {
  setSnapshot: (vehicleId: string, memory: VehicleMemory) => void;
  optimisticPatch: (
    vehicleId: string,
    patcher: (prev: VehicleMemory | null) => VehicleMemory | null,
  ) => () => void;
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

export const useVehicleMemory = (vehicleId: string): VehicleMemory | null =>
  useVehicleMemoryStore((s) => s.byId[vehicleId] ?? null);
