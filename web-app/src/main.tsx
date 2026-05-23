/// <reference types="vite/client" />
import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './index.css';
import './i18n';
import { assertSharedDomainInvariants } from '@platform/domain';

const basename = '/api/web-app';

// Shared Domain 0C — single explicit invariant entrypoint.
//
// Replaces the per-module try/catch boilerplate that was here in 0B.
// The aggregator hand-references each `assert*` function: when a new
// shared/domain module ships, it MUST be added there or this surface
// won't catch its drift. That's the gate; do not re-introduce a
// runtime registry or a "discovers asserts automatically" pattern.
if (import.meta.env.DEV) {
  try {
    assertSharedDomainInvariants();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[shared/domain] invariants failed:', err);
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter basename={basename}>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);
