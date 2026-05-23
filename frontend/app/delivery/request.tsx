import React from 'react';
import ClusterRequestForm from '../../src/components/ClusterRequestForm';

// UX-2A — Delivery (Пригон / Доставка / EU import). Logistics across borders.
// Backend SERVICES['delivery'] catalogue keys live in app/marketplace/requests.py.
export default function DeliveryRequestScreen() {
  return (
    <ClusterRequestForm
      cluster="delivery"
      defaultServiceKey="eu_import"
    />
  );
}
