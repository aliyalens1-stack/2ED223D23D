/**
 * Thin API client for admin partner-verification queue.
 * Imported by admin screens — keeps fetch logic out of the UI.
 */
import { api } from '../api';

export interface PartnerApplication {
  id: string;
  organizationId: string;
  userId: string;
  kind: 'workshop' | 'inspector' | 'dealer' | 'carwash';
  city: string;
  status: 'pending' | 'approved' | 'rejected';
  submittedAt: string;
  location: { type: 'Point'; coordinates: [number, number] };
  note?: string;
  decidedAt?: string;
  decidedBy?: string;
  organization?: {
    name?: string;
    city?: string;
    address?: string;
    status?: string;
    kind?: string;
    location?: { type: 'Point'; coordinates: [number, number] };
  } | null;
}

export interface ListResponse {
  applications: PartnerApplication[];
  total: number;
  limit: number;
  skip: number;
}

const BASE = '/admin/partner-verifications';

export const partnerVerificationsApi = {
  async list(params: { status?: 'pending' | 'approved' | 'rejected' | 'all'; kind?: string; limit?: number; skip?: number } = {}): Promise<ListResponse> {
    const r = await api.get(`${BASE}/`, { params });
    return r.data;
  },
  async get(queueId: string): Promise<{ application: PartnerApplication; organization: any; user: any }> {
    const r = await api.get(`${BASE}/${queueId}`);
    return r.data;
  },
  async approve(queueId: string, note?: string): Promise<{ ok: boolean; status: string }> {
    const r = await api.post(`${BASE}/${queueId}/approve`, { note: note || null });
    return r.data;
  },
  async reject(queueId: string, note: string): Promise<{ ok: boolean; status: string }> {
    const r = await api.post(`${BASE}/${queueId}/reject`, { note });
    return r.data;
  },
};
