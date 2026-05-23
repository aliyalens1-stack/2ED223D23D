import React from 'react';
import ClusterRequestForm from '../../src/components/ClusterRequestForm';

// UX-2A — Repair (Ремонт / диагностика / эвакуатор / помощь после поломки).
// Backend SERVICES['repair'] catalogue keys live in app/marketplace/requests.py.
export default function RepairRequestScreen() {
  return (
    <ClusterRequestForm
      cluster="repair"
      defaultServiceKey="diagnostics"
    />
  );
}
