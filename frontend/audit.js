(() => {
  'use strict';

  let auditEnabled = null;
  let auditStatusReason = null;

  async function refreshAuditStatus() {
    try {
      const res = await fetch('/api/audit/status', { credentials: 'same-origin' });
      if (!res.ok) {
        auditEnabled = false;
        auditStatusReason = `status_http_${res.status}`;
        return false;
      }
      const data = await res.json();
      auditEnabled = Boolean(data.available);
      auditStatusReason = data.reason || null;
      return auditEnabled;
    } catch {
      auditEnabled = false;
      auditStatusReason = 'status_unreachable';
      return false;
    }
  }

  function inferDeviceFromPath(path) {
    const text = String(path || '');
    const match = text.match(/\/(washer|dryer|doser|ac)(?:\/([^/?#]+))?/i);
    if (!match) return { device_type: null, device_id: null };
    const device_type = match[1].toLowerCase();
    let device_id = match[2] || null;
    if (device_type === 'ac') device_id = device_id || '110';
    return { device_type, device_id };
  }

  const DEFAULT_CHANNEL_BY_PAGE = {
    store: 'agente_local',
    gateway: 'redundancia',
  };

  function resolveChannel(entry = {}) {
    if (entry.meta?.channel) return entry.meta.channel;
    if (entry.channel) return entry.channel;
    const page = entry.page || 'store';
    return DEFAULT_CHANNEL_BY_PAGE[page] || page;
  }

  /**
   * Normaliza campos enviados ao painel antes de gravar no Firestore.
   */
  function buildAuditEntry(entry = {}) {
    const fromPath = inferDeviceFromPath(entry.path);
    const device_type = entry.device_type || entry.deviceType || fromPath.device_type;
    const device_id = entry.device_id || entry.deviceId || fromPath.device_id;
    const payload = entry.payload ?? null;
    const page = entry.page || 'store';
    const channel = resolveChannel(entry);

    return {
      store: entry.store || null,
      page,
      channel,
      action: entry.action || 'operation',
      label: entry.label || null,
      method: entry.method || null,
      path: entry.path || null,
      success: entry.success !== false,
      payload,
      response: entry.response ?? null,
      error: entry.error || null,
      device_type: device_type || null,
      device_id: device_id || null,
      meta: {
        ...(entry.meta || {}),
        channel,
        ...(device_type ? { device_type } : {}),
        ...(device_id ? { device_id } : {}),
      },
    };
  }

  /**
   * Grava operação no Firestore via painel.
   * Retorna true se gravou; false se auditoria indisponível ou falhou.
   */
  async function logPanelAudit(entry) {
    if (auditEnabled === null) {
      await refreshAuditStatus();
    }
    if (!auditEnabled) return false;

    try {
      const res = await fetch('/api/audit/log', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildAuditEntry(entry)),
      });
      if (res.ok) return true;
      if (res.status === 503) {
        auditEnabled = false;
        auditStatusReason = 'audit_unavailable';
      }
      return false;
    } catch {
      return false;
    }
  }

  window.Lav60Audit = {
    log: logPanelAudit,
    buildEntry: buildAuditEntry,
    refreshStatus: refreshAuditStatus,
    isEnabled: () => auditEnabled,
    lastReason: () => auditStatusReason,
  };
})();
