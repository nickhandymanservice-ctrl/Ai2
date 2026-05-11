/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { bridge, logger } from '@office-ai/platform';
import type { ElectronBridgeAPI } from '@/types/electron';

interface CustomWindow extends Window {
  electronAPI?: ElectronBridgeAPI;
  __bridgeEmitter?: { emit: (name: string, data: unknown) => void };
  __emitBridgeCallback?: (name: string, data: unknown) => void;
  __websocketReconnect?: () => void;
}

const win = window as CustomWindow;

/**
 * Adapt the platform bridge to the current runtime environment.
 * - Electron desktop: communicates via contextBridge IPC (preload injects electronAPI).
 * - WebUI / browser:  communicates via WebSocket with automatic reconnection.
 *   If the configured hostname cannot be resolved (e.g. DNS was changed), the
 *   adapter retries up to FALLBACK_AFTER_CLOSES times then switches to the
 *   explicit loopback address 127.0.0.1 which always works for local servers.
 */
if (win.electronAPI) {
  // ── Electron IPC path ──────────────────────────────────────────────
  bridge.adapter({
    emit(name, data) {
      return win.electronAPI.emit(name, data);
    },
    on(emitter) {
      win.electronAPI?.on((event) => {
        try {
          const { value } = event;
          const { name, data } = JSON.parse(value);
          emitter.emit(name, data);
        } catch (e) {
          console.warn('JSON parsing error:', e);
        }
      });
    },
  });
} else {
  // ── WebSocket path ────────────────────────────────────────────────────────
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const port = window.location.port || '25808';

  // Primary URL uses whatever host the browser navigated to.
  // Fallback URL uses the explicit loopback IP so DNS misconfigurations
  // (e.g. a hardwired /etc/hosts or resolv.conf entry) cannot break it.
  const primarySocketUrl = `${protocol}//${window.location.host || `localhost:${port}`}`;
  const fallbackSocketUrl = `${protocol}//127.0.0.1:${port}`;

  type QueuedMessage = { name: string; data: unknown };

  let socket: WebSocket | null = null;
  let emitterRef: { emit: (name: string, data: unknown) => void } | null = null;
  let reconnectTimer: number | null = null;
  let reconnectDelay = 500;
  let shouldReconnect = true;

  // Track consecutive failures so we can switch to the fallback URL.
  let consecutiveCloses = 0;
  const FALLBACK_AFTER_CLOSES = 3;
  let currentSocketUrl = primarySocketUrl;

  const messageQueue: QueuedMessage[] = [];

  const flushQueue = () => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    while (messageQueue.length > 0) {
      const queued = messageQueue.shift();
      if (queued) socket.send(JSON.stringify(queued));
    }
  };

  const scheduleReconnect = () => {
    if (reconnectTimer !== null || !shouldReconnect) return;
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      reconnectDelay = Math.min(reconnectDelay * 2, 8000);
      connect();
    }, reconnectDelay);
  };

  const connect = () => {
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
      return;
    }

    // After enough consecutive failures on the primary hostname, switch to
    // the explicit loopback address so broken DNS cannot keep us stuck.
    if (consecutiveCloses >= FALLBACK_AFTER_CLOSES && currentSocketUrl === primarySocketUrl && primarySocketUrl !== fallbackSocketUrl) {
      currentSocketUrl = fallbackSocketUrl;
    }

    try {
      socket = new WebSocket(currentSocketUrl);
    } catch (error) {
      consecutiveCloses++;
      scheduleReconnect();
      return;
    }

    socket.addEventListener('open', () => {
      // Successful connection — reset backoff and failure counter.
      reconnectDelay = 500;
      consecutiveCloses = 0;
      // If we recovered via fallback, keep using it for the session.
      flushQueue();
    });

    socket.addEventListener('message', (event: MessageEvent) => {
      if (!emitterRef) return;
      try {
        const payload = JSON.parse(event.data as string) as { name: string; data: unknown };

        if (payload.name === 'ping') {
          if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ name: 'pong', data: { timestamp: Date.now() } }));
          }
          return;
        }

        if (payload.name === 'auth-expired') {
          console.warn('[WebSocket] Authentication expired, stopping reconnection');
          shouldReconnect = false;
          if (reconnectTimer !== null) {
            window.clearTimeout(reconnectTimer);
            reconnectTimer = null;
          }
          socket?.close();
          setTimeout(() => {
            window.location.href = '/login';
          }, 1000);
          return;
        }

        emitterRef.emit(payload.name, payload.data);
      } catch (error) {
        // Ignore malformed payloads.
      }
    });

    socket.addEventListener('close', () => {
      consecutiveCloses++;
      socket = null;
      scheduleReconnect();
    });

    socket.addEventListener('error', () => {
      socket?.close();
    });
  };

  const ensureSocket = () => {
    if (!socket || socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) {
      connect();
    }
  };

  bridge.adapter({
    emit(name, data) {
      const message: QueuedMessage = { name, data };
      ensureSocket();
      if (socket && socket.readyState === WebSocket.OPEN) {
        try {
          socket.send(JSON.stringify(message));
          return;
        } catch (error) {
          scheduleReconnect();
        }
      }
      messageQueue.push(message);
    },
    on(emitter) {
      emitterRef = emitter;
      win.__bridgeEmitter = emitter;
      win.__emitBridgeCallback = (name: string, data: unknown) => {
        emitter.emit(name, data);
      };
      ensureSocket();
    },
  });

  connect();

  // Expose reconnection control for login flow.
  // Also resets the failure counter so the primary URL gets a fresh try.
  win.__websocketReconnect = () => {
    shouldReconnect = true;
    reconnectDelay = 500;
    consecutiveCloses = 0;
    currentSocketUrl = primarySocketUrl;
    connect();
  };
}

logger.provider({
  log(log) {
    console.log('process.log', log.type, ...log.logs);
  },
  path() {
    return Promise.resolve('');
  },
});
