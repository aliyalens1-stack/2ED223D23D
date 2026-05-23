// Polling-based real-time service (fallback when WebSocket is not available)
// This works reliably through any proxy/ingress configuration

interface RealtimeEvent {
  id: string;
  type: string;
  data: any;
  timestamp: string;
}

class RealtimeService {
  private listeners: Map<string, Set<(data: any) => void>> = new Map();
  private connected = false;
  private pollInterval: NodeJS.Timeout | null = null;
  private lastTimestamp: string | null = null;
  private pollIntervalMs = 2000; // Poll every 2 seconds

  connect(token?: string) {
    if (this.connected) {
      return;
    }

    console.log('🚀 Starting polling-based real-time connection...');
    
    // Start polling immediately
    this.startPolling();
  }

  private async startPolling() {
    // Initial status check
    try {
      const response = await fetch('/api/realtime/status');
      if (response.ok) {
        const data = await response.json();
        console.log('✅ Real-time status:', data);
        
        // Set connected BEFORE emitting events
        this.connected = true;
        this.emit('connection_status', { connected: true });
        this.emit('connected', {
          clientId: 'polling-client',
          mode: 'polling',
          timestamp: data.timestamp,
        });
      }
    } catch (error) {
      console.error('Real-time status check failed:', error);
      this.emit('connection_status', { connected: false, reason: 'Status check failed' });
    }

    // Start event polling loop
    this.pollInterval = setInterval(() => this.pollEvents(), this.pollIntervalMs);
    
    // First poll immediately
    this.pollEvents();
  }

  private async pollEvents() {
    try {
      const url = this.lastTimestamp 
        ? `/api/realtime/events?since=${encodeURIComponent(this.lastTimestamp)}&limit=20`
        : '/api/realtime/events?limit=20';
      
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      
      if (!this.connected) {
        this.connected = true;
        this.emit('connection_status', { connected: true });
      }

      // Update last timestamp
      if (data.timestamp) {
        this.lastTimestamp = data.timestamp;
      }

      // Process new events
      if (data.events && data.events.length > 0) {
        for (const event of data.events.reverse()) {
          this.processEvent(event);
        }
      }
    } catch (error) {
      console.error('Poll failed:', error);
      if (this.connected) {
        this.connected = false;
        this.emit('connection_status', { connected: false, reason: 'Poll failed' });
      }
    }
  }

  private processEvent(event: RealtimeEvent) {
    // Emit to specific event listeners
    this.emit(event.type, {
      type: event.type,
      data: event.data,
      timestamp: event.timestamp,
    });

    // Also emit to 'all' for global listeners
    this.emit('all', {
      type: event.type,
      data: event.data,
      timestamp: event.timestamp,
    });
  }

  disconnect() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    this.connected = false;
    this.lastTimestamp = null;
    this.emit('connection_status', { connected: false });
  }

  isConnected(): boolean {
    return this.connected;
  }

  // Subscribe to events
  on(event: string, callback: (data: any) => void): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(callback);

    // Return unsubscribe function
    return () => {
      this.listeners.get(event)?.delete(callback);
    };
  }

  // Emit to local listeners
  private emit(event: string, data: any) {
    const callbacks = this.listeners.get(event);
    if (callbacks) {
      callbacks.forEach((callback) => {
        try {
          callback(data);
        } catch (error) {
          console.error(`Error in event listener for ${event}:`, error);
        }
      });
    }
  }

  // Utility methods
  joinRoom(room: string) {
    // Rooms not supported in polling mode, but keep API compatible
    console.log('Room join requested (polling mode):', room);
  }

  leaveRoom(room: string) {
    console.log('Room leave requested (polling mode):', room);
  }

  async ping(): Promise<any> {
    try {
      const response = await fetch('/api/realtime/status');
      return response.json();
    } catch {
      return { error: 'Ping failed' };
    }
  }

  // Emit a test event (for debugging)
  async emitTestEvent(type: string, data: any = {}): Promise<any> {
    try {
      const response = await fetch(`/api/realtime/emit?event_type=${encodeURIComponent(type)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      return response.json();
    } catch (error) {
      console.error('Failed to emit test event:', error);
      return { error: 'Failed' };
    }
  }
}

// Singleton instance
export const realtimeService = new RealtimeService();
