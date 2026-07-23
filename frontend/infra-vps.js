(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const METRICS_INTERVAL_SEC = window.Lav60InfraPeriod?.INTERVAL_SEC || 300;
  const SELECTED_VPS_KEY = 'lav60:infra:selected-vps';
  const VPS_CATALOG_STORAGE_KEY = 'lav60:infra:vps-catalog';
  const VPS_METRICS_STORAGE_PREFIX = 'lav60:infra:vps-metrics:';
  const CLIENT_METRICS_CACHE_MS = 120000;

  let metricsWindowSec = window.Lav60InfraPeriod?.getSelectedSeconds?.() || 3600;

  let moduleAbort = null;
  let lastPayload = null;
  let vpsCatalog = [];
  let selectedHostId = '';
  let fetchInFlight = false;
  const metricsCache = new Map();
  let cpuChart = null;
  let memoryChart = null;
  let diskChart = null;
  let loadChart = null;

  const CHART_GRID = 'rgba(148, 163, 184, 0.12)';
  const CHART_TICK = '#94a3b8';
  const CHART_CPU_LINE = '#6cb6ff';
  const CHART_CPU_FILL = 'rgba(108, 182, 255, 0.22)';
  const CHART_MEMORY_LINE = '#9b8afb';
  const CHART_MEMORY_FILL = 'rgba(155, 138, 251, 0.22)';
  const CHART_DISK_LINE = '#f59e0b';
  const CHART_DISK_FILL = 'rgba(245, 158, 11, 0.2)';

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatPercent(value) {
    if (value == null || Number.isNaN(Number(value))) return '—';
    return `${Number(value).toFixed(1)}%`;
  }

  function formatGb(value) {
    if (value == null || Number.isNaN(Number(value))) return '—';
    return `${Number(value).toFixed(1)} GB`;
  }

  function formatTs(epoch) {
    if (!epoch) return '—';
    const date = new Date(Number(epoch) * 1000);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleString('pt-BR');
  }

  function formatChartTime(epoch) {
    const date = new Date(Number(epoch) * 1000);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }

  function formatTooltipTime(epoch) {
    const date = new Date(Number(epoch) * 1000);
    if (Number.isNaN(date.getTime())) return '';
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    const h = String(date.getHours()).padStart(2, '0');
    const min = String(date.getMinutes()).padStart(2, '0');
    const s = String(date.getSeconds()).padStart(2, '0');
    return `${y}-${m}-${d} ${h}:${min}:${s}`;
  }

  function kpiTone(percent) {
    const n = Number(percent);
    if (!Number.isFinite(n)) return 'neutral';
    if (n >= 85) return 'danger';
    if (n >= 70) return 'warn';
    return 'ok';
  }

  function chartAvailable() {
    return typeof window.Chart !== 'undefined';
  }

  function destroyCharts() {
    [cpuChart, memoryChart, diskChart, loadChart].forEach((chart) => {
      if (chart) chart.destroy();
    });
    cpuChart = null;
    memoryChart = null;
    diskChart = null;
    loadChart = null;
  }

  function baseChartOptions({ yMax = null, ySuffix = '', tooltipLabel = null } = {}) {
    return {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          display: false,
          labels: { color: CHART_TICK, boxWidth: 10, usePointStyle: true },
        },
        tooltip: {
          backgroundColor: 'rgba(15, 23, 42, 0.96)',
          borderColor: 'rgba(148, 163, 184, 0.25)',
          borderWidth: 1,
          titleColor: '#f8fafc',
          bodyColor: '#e2e8f0',
          padding: 10,
          displayColors: true,
          callbacks: {
            title(items) {
              const idx = items?.[0]?.dataIndex;
              const ts = items?.[0]?.chart?.data?.timestamps?.[idx];
              return ts ? formatTooltipTime(ts) : items?.[0]?.label || '';
            },
            label(context) {
              const value = context.parsed.y;
              if (typeof tooltipLabel === 'function') return tooltipLabel(context);
              const suffix = ySuffix || '';
              return `${context.dataset.label}: ${Number(value).toFixed(1)}${suffix}`;
            },
          },
        },
      },
      scales: {
        x: {
          grid: { color: CHART_GRID, drawBorder: false },
          ticks: {
            color: CHART_TICK,
            maxTicksLimit: window.Lav60InfraPeriod?.chartTickLimit?.(metricsWindowSec)
              || Math.ceil(metricsWindowSec / METRICS_INTERVAL_SEC / 6),
            maxRotation: 0,
            autoSkip: true,
          },
        },
        y: {
          min: 0,
          max: yMax || undefined,
          grid: { color: CHART_GRID, drawBorder: false },
          ticks: {
            color: CHART_TICK,
            callback(value) {
              return `${value}${ySuffix}`;
            },
          },
        },
      },
    };
  }

  function buildPercentAreaChart(canvas, timeseries, {
    label,
    lineColor,
    fillColor,
    valueKey = 'percent',
    chartRef = 'chart',
  } = {}) {
    if (!canvas || !chartAvailable() || !Array.isArray(timeseries) || !timeseries.length) return null;

    const labels = timeseries.map((p) => formatChartTime(p.timestamp));
    const values = timeseries.map((p) => Number(p[valueKey]));
    const timestamps = timeseries.map((p) => p.timestamp);

    return new Chart(canvas, {
      type: 'line',
      data: {
        labels,
        timestamps,
        datasets: [{
          label,
          data: values,
          borderColor: lineColor,
          backgroundColor: fillColor,
          fill: true,
          tension: 0.15,
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 5,
          pointHoverBackgroundColor: lineColor,
          pointHoverBorderColor: '#fff',
          pointHoverBorderWidth: 2,
        }],
      },
      options: baseChartOptions({
        yMax: 100,
        ySuffix: '%',
        tooltipLabel(context) {
          const idx = context.dataIndex;
          const row = timeseries[idx] || {};
          const parts = [`${label}: ${Number(context.parsed.y).toFixed(1)}%`];
          if (row.used_gb != null && row.total_gb != null) {
            parts.push(`${Number(row.used_gb).toFixed(1)} / ${Number(row.total_gb).toFixed(1)} GB`);
          }
          return parts;
        },
      }),
    });
  }

  function buildCpuChart(canvas, timeseries) {
    cpuChart = buildPercentAreaChart(canvas, timeseries, {
      label: 'CPU',
      lineColor: CHART_CPU_LINE,
      fillColor: CHART_CPU_FILL,
      valueKey: 'percent',
    });
  }

  function buildMemoryChart(canvas, timeseries) {
    memoryChart = buildPercentAreaChart(canvas, timeseries, {
      label: 'Memória',
      lineColor: CHART_MEMORY_LINE,
      fillColor: CHART_MEMORY_FILL,
      valueKey: 'percent',
    });
  }

  function buildDiskChart(canvas, timeseries) {
    diskChart = buildPercentAreaChart(canvas, timeseries, {
      label: 'Disco',
      lineColor: CHART_DISK_LINE,
      fillColor: CHART_DISK_FILL,
      valueKey: 'percent',
    });
  }

  function alignLoadSeries(loadSeries) {
    const keys = ['load_1', 'load_5', 'load_15'];
    const maps = {};
    keys.forEach((key) => {
      maps[key] = new Map((loadSeries?.[key] || []).map((p) => [Number(p.timestamp), Number(p.value)]));
    });
    const timestamps = Array.from(
      new Set(keys.flatMap((key) => (loadSeries?.[key] || []).map((p) => Number(p.timestamp))))
    ).sort((a, b) => a - b);
    return { timestamps, maps, keys };
  }

  function buildLoadChart(canvas, loadSeries) {
    if (!canvas || !chartAvailable()) return;

    const { timestamps, maps, keys } = alignLoadSeries(loadSeries);
    if (!timestamps.length) return;

    const colors = {
      load_1: '#6cb6ff',
      load_5: '#fbbf24',
      load_15: '#fb7185',
    };
    const labelsMap = {
      load_1: 'Load 1',
      load_5: 'Load 5',
      load_15: 'Load 15',
    };

    loadChart = new Chart(canvas, {
      type: 'line',
      data: {
        labels: timestamps.map(formatChartTime),
        timestamps,
        datasets: keys.map((key) => ({
          label: labelsMap[key],
          data: timestamps.map((ts) => maps[key].get(ts) ?? null),
          borderColor: colors[key],
          backgroundColor: 'transparent',
          fill: false,
          tension: 0.15,
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 4,
          spanGaps: true,
        })),
      },
      options: {
        ...baseChartOptions({ ySuffix: '' }),
        plugins: {
          ...baseChartOptions().plugins,
          legend: {
            display: true,
            position: 'top',
            align: 'end',
            labels: { color: CHART_TICK, boxWidth: 10, usePointStyle: true, font: { size: 11 } },
          },
        },
      },
    });
  }

  function initCharts(metrics) {
    destroyCharts();
    if (!metrics || !chartAvailable()) return;
    buildCpuChart($('infraCpuChart'), metrics.cpu?.timeseries || []);
    buildMemoryChart($('infraMemoryChart'), metrics.memory_timeseries || []);
    buildDiskChart($('infraDiskChart'), metrics.disk_timeseries || []);
    buildLoadChart($('infraLoadChart'), metrics.load_timeseries || {});
  }

  function showBanner(message, ok = false) {
    const el = $('infraMetricsBanner');
    if (!el) return;
    if (!message) {
      el.classList.add('hidden');
      el.textContent = '';
      return;
    }
    el.textContent = message;
    el.classList.toggle('records-audit-banner--ok', ok);
    el.classList.remove('hidden');
  }

  function setLoading(show) {
    $('infraMetricsLoading')?.classList.toggle('hidden', !show);
    $('btnInfraRefresh')?.toggleAttribute('disabled', show);
  }

  function updateMeta(payload, { refreshing = false } = {}) {
    const el = $('infraMetricsMeta');
    if (!el) return;
    if (!payload) {
      el.textContent = 'Sem dados';
      return;
    }
    const parts = [];
    if (payload.checked_at) {
      parts.push(`Atualizado ${new Date(payload.checked_at).toLocaleString('pt-BR')}`);
    }
    if (payload.from_store || payload.vps?.[0]?.from_store) parts.push('dados salvos');
    else if (payload.from_cache) parts.push('em cache');
    if (payload.window_seconds) {
      parts.push(window.Lav60InfraPeriod?.formatPeriodLabel?.(payload.window_seconds)
        || `última ${Math.round(payload.window_seconds / 60)} min`);
    }
    const intervalSec = Number(payload.interval_seconds) || METRICS_INTERVAL_SEC;
    parts.push(`intervalo ${Math.round(intervalSec / 60)} min`);
    if (refreshing) parts.push('atualizando…');
    el.textContent = parts.join(' · ') || '—';
  }

  function readCatalogFromStorage() {
    try {
      const raw = sessionStorage.getItem(VPS_CATALOG_STORAGE_KEY);
      if (!raw) return null;
      const hit = JSON.parse(raw);
      return Array.isArray(hit?.items) ? hit.items : null;
    } catch {
      return null;
    }
  }

  function writeCatalogToStorage(items) {
    try {
      sessionStorage.setItem(VPS_CATALOG_STORAGE_KEY, JSON.stringify({ items, cachedAt: Date.now() }));
    } catch {
      /* ignore */
    }
  }

  function metricsStorageKey(hostId) {
    return `${VPS_METRICS_STORAGE_PREFIX}${hostId}:${metricsWindowSec}`;
  }

  function readMetricsFromStorage(hostId) {
    if (!hostId) return null;
    try {
      const raw = sessionStorage.getItem(metricsStorageKey(hostId));
      if (!raw) return null;
      const hit = JSON.parse(raw);
      return hit?.data || null;
    } catch {
      return null;
    }
  }

  function writeMetricsToStorage(hostId, data) {
    if (!hostId || !data) return;
    try {
      sessionStorage.setItem(metricsStorageKey(hostId), JSON.stringify({ data, cachedAt: Date.now() }));
    } catch {
      /* ignore */
    }
  }

  function vpsTabLabel(item) {
    const name = String(item?.name || item?.id || '');
    const short = name.split('.')[0];
    return short || name || 'VPS';
  }

  function persistSelectedHostId(hostId) {
    selectedHostId = String(hostId || '');
    try {
      if (selectedHostId) localStorage.setItem(SELECTED_VPS_KEY, selectedHostId);
    } catch {
      /* ignore */
    }
  }

  function renderVpsTabs(items) {
    const tabs = $('infraVpsTabs');
    if (!tabs) return;
    if (!items.length) {
      tabs.innerHTML = '<span class="infra-vps-tabs__empty">Nenhuma VPS cadastrada</span>';
      return;
    }
    tabs.innerHTML = items.map((item) => {
      const active = String(item.id) === String(selectedHostId);
      const removable = items.length > 1;
      return `
        <button type="button" class="infra-vps-tab${active ? ' infra-vps-tab--active' : ''}" data-vps-id="${escapeHtml(item.id)}" role="tab" aria-selected="${active ? 'true' : 'false'}" title="ID ${escapeHtml(item.id)}">
          <span class="infra-vps-tab__label">${escapeHtml(vpsTabLabel(item))}</span>
          <span class="infra-vps-tab__id">${escapeHtml(item.id)}</span>
          ${removable ? `<span class="infra-vps-tab__remove" data-vps-remove="${escapeHtml(item.id)}" title="Remover VPS" aria-label="Remover VPS">×</span>` : ''}
        </button>`;
    }).join('');
  }

  async function loadVpsCatalog() {
    const res = await fetch('/api/infra/vps', {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      signal: moduleAbort?.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
    vpsCatalog = Array.isArray(data.items) ? data.items : [];
    if (!vpsCatalog.length) {
      selectedHostId = '';
      renderVpsTabs([]);
      return;
    }
    const stillExists = vpsCatalog.some((item) => String(item.id) === String(selectedHostId));
    if (!stillExists) {
      let stored = '';
      try { stored = localStorage.getItem(SELECTED_VPS_KEY) || ''; } catch { /* ignore */ }
      const fromStore = vpsCatalog.find((item) => String(item.id) === stored);
      persistSelectedHostId(fromStore?.id || vpsCatalog[0].id);
    }
    renderVpsTabs(vpsCatalog);
  }

  async function addVps(hostId) {
    const res = await fetch('/api/infra/vps', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ host_id: hostId }),
      signal: moduleAbort?.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
    persistSelectedHostId(data.item?.id || hostId);
    await loadVpsCatalog();
    showBanner('VPS adicionada com sucesso.', true);
  }

  async function removeVps(hostId) {
    const item = vpsCatalog.find((row) => String(row.id) === String(hostId));
    const label = item ? vpsTabLabel(item) : hostId;
    if (!window.confirm(`Remover a VPS ${label} (${hostId}) do painel?`)) return;

    const res = await fetch(`/api/infra/vps/${encodeURIComponent(hostId)}`, {
      method: 'DELETE',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      signal: moduleAbort?.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
    if (String(selectedHostId) === String(hostId)) {
      persistSelectedHostId(data.host_ids?.[0] || '');
    }
    await loadVpsCatalog();
    showBanner('VPS removida.', true);
  }

  function renderSpecBadges(item) {
    const specs = [];
    if (item.vcpus) specs.push(`${item.vcpus} vCPU`);
    if (item.memory_mb) specs.push(`${Math.round(item.memory_mb / 1024)} GB RAM`);
    if (item.disk_gb) specs.push(`${item.disk_gb} GB disco`);
    if (item.region) specs.push(item.region);
    return specs.map((s) => `<span class="infra-server-card__spec">${escapeHtml(s)}</span>`).join('');
  }

  function renderKpiBar(percent) {
    if (percent == null || Number.isNaN(Number(percent))) return '';
    const width = Math.max(0, Math.min(100, Number(percent)));
    return `
      <div class="infra-kpi-card__bar" aria-hidden="true">
        <div class="infra-kpi-card__bar-fill" style="width:${width}%"></div>
      </div>`;
  }

  function renderKpiCard({ accent, label, value, meta, percent = null, tone = 'neutral' }) {
    return `
      <article class="infra-kpi-card infra-kpi-card--${accent} infra-kpi-card--${tone}">
        <span class="infra-kpi-card__label">${escapeHtml(label)}</span>
        <strong class="infra-kpi-card__value">${escapeHtml(value)}</strong>
        ${renderKpiBar(percent)}
        ${meta ? `<span class="infra-kpi-card__meta">${escapeHtml(meta)}</span>` : ''}
      </article>`;
  }

  function renderToolbarInfo(item, toolbarInfoId, statusOkValues = ['active']) {
    const el = $(toolbarInfoId);
    if (!el) return;
    if (!item || item.metrics_error) {
      el.innerHTML = '';
      el.classList.add('hidden');
      return;
    }
    const status = item.status || '—';
    const pillClass = statusOkValues.includes(status) ? 'ok' : 'partial';
    el.classList.remove('hidden');
    el.innerHTML = `
      <div class="infra-toolbar-info__specs">${renderSpecBadges(item)}</div>
      <span class="pill pill--${pillClass} pill--sm">${escapeHtml(status)}</span>`;
  }

  function renderKpiSection(item) {
    const section = $('infraKpiSection');
    const grid = $('infraKpiGrid');
    const metrics = item?.metrics;
    if (!section || !grid) return;

    if (!item || !metrics || item.metrics_error) {
      section.classList.add('hidden');
      grid.innerHTML = '';
      renderToolbarInfo(null, 'infraVpsToolbarInfo');
      return;
    }

    const cpu = metrics.cpu || {};
    section.classList.remove('hidden');
    renderToolbarInfo(item, 'infraVpsToolbarInfo', ['active']);

    const memoryMeta = metrics.memory_used_gb != null && metrics.memory_total_gb != null
      ? `${formatGb(metrics.memory_used_gb)} de ${formatGb(metrics.memory_total_gb)}`
      : '—';
    const diskMeta = metrics.disk_free_gb != null && metrics.disk_total_gb != null
      ? `${formatGb(metrics.disk_free_gb)} livres de ${formatGb(metrics.disk_total_gb)}`
      : '—';
    const loadMeta = [
      metrics.load_5 != null ? `5m: ${metrics.load_5}` : null,
      metrics.load_15 != null ? `15m: ${metrics.load_15}` : null,
    ].filter(Boolean).join(' · ') || '—';

    grid.innerHTML = [
      renderKpiCard({
        accent: 'cpu',
        label: 'CPU',
        value: formatPercent(cpu.latest_percent),
        meta: cpu.average_percent != null ? `Média ${formatPercent(cpu.average_percent)}` : '—',
        percent: cpu.latest_percent,
        tone: kpiTone(cpu.latest_percent),
      }),
      renderKpiCard({
        accent: 'memory',
        label: 'Memória',
        value: formatPercent(metrics.memory_percent),
        meta: memoryMeta,
        percent: metrics.memory_percent,
        tone: kpiTone(metrics.memory_percent),
      }),
      renderKpiCard({
        accent: 'disk',
        label: 'Disco',
        value: formatPercent(metrics.disk_percent),
        meta: diskMeta,
        percent: metrics.disk_percent,
        tone: kpiTone(metrics.disk_percent),
      }),
      renderKpiCard({
        accent: 'load',
        label: 'Load average',
        value: metrics.load_1 != null ? String(metrics.load_1) : '—',
        meta: loadMeta,
        tone: 'neutral',
      }),
    ].join('');
  }

  function renderVpsCard(item) {
    const metrics = item.metrics || {};
    const cpu = metrics.cpu || {};
    const error = item.metrics_error;

    if (error) {
      return `
        <article class="infra-server-card panel">
          <p class="infra-server-card__error">${escapeHtml(error)}</p>
        </article>`;
    }

    return `
      <article class="infra-server-card panel">
        <header class="infra-charts-head">
          <h2 class="infra-charts-head__title">Histórico (${escapeHtml(window.Lav60InfraPeriod?.formatPeriodLabel?.(metricsWindowSec) || '1 hora')} · 5 min)</h2>
          <p class="infra-charts-head__meta">Amostra CPU: ${escapeHtml(formatTs(cpu.period_end))}</p>
        </header>
        <div class="infra-charts">
          <section class="infra-chart-panel panel">
            <h3 class="infra-chart-panel__title">CPU %</h3>
            <div class="infra-chart-wrap">
              <canvas id="infraCpuChart" aria-label="Gráfico de CPU"></canvas>
            </div>
          </section>
          <section class="infra-chart-panel panel">
            <h3 class="infra-chart-panel__title">Memória %</h3>
            <div class="infra-chart-wrap">
              <canvas id="infraMemoryChart" aria-label="Gráfico de memória"></canvas>
            </div>
          </section>
          <section class="infra-chart-panel panel">
            <h3 class="infra-chart-panel__title">Disco %</h3>
            <div class="infra-chart-wrap">
              <canvas id="infraDiskChart" aria-label="Gráfico de disco"></canvas>
            </div>
          </section>
          <section class="infra-chart-panel panel">
            <h3 class="infra-chart-panel__title">Load (1/5/15)</h3>
            <div class="infra-chart-wrap">
              <canvas id="infraLoadChart" aria-label="Gráfico de load average"></canvas>
            </div>
          </section>
        </div>
      </article>`;
  }

  function renderLists(payload) {
    const vps = Array.isArray(payload?.vps) ? payload.vps : [];
    renderKpiSection(vps[0] || null);
    const vpsGrid = $('infraVpsGrid');
    if (vpsGrid) vpsGrid.innerHTML = vps.map(renderVpsCard).join('');
    $('infraVpsEmpty')?.classList.toggle('hidden', vps.length > 0);
    if (vps[0]?.metrics && !vps[0].metrics_error) {
      initCharts(vps[0].metrics);
    } else {
      destroyCharts();
    }
  }

  function renderMetricsPayload(data, { refreshing = false } = {}) {
    lastPayload = data;
    renderLists(data);
    updateMeta(data, { refreshing });
  }

  function metricsCacheKey(hostId) {
    return `${String(hostId || '')}:${metricsWindowSec}`;
  }

  function getCachedMetrics(hostId) {
    const hit = metricsCache.get(metricsCacheKey(hostId));
    if (!hit) return null;
    if (Date.now() - hit.ts > CLIENT_METRICS_CACHE_MS) return null;
    return hit.data;
  }

  async function loadMetrics({ force = false } = {}) {
    if (fetchInFlight && !force) return;
    if (!selectedHostId) {
      $('infraVpsEmpty')?.classList.remove('hidden');
      renderKpiSection(null);
      destroyCharts();
      return;
    }

    const cached = !force ? getCachedMetrics(selectedHostId) : null;
    if (cached) {
      renderMetricsPayload(cached);
      $('infraPanelVps')?.classList.remove('hidden');
      return;
    }

    const stale = !force ? metricsCache.get(metricsCacheKey(selectedHostId))?.data : null;
    const stored = !force ? readMetricsFromStorage(selectedHostId) : null;
    const preview = stale || stored;
    if (preview) {
      renderMetricsPayload(preview, { refreshing: true });
      $('infraPanelVps')?.classList.remove('hidden');
    }

    if (force) setLoading(true);
    showBanner('');
    fetchInFlight = true;

    try {
      const query = new URLSearchParams({
        window: String(metricsWindowSec),
        host_id: selectedHostId,
        ...(force ? { force: '1' } : {}),
      });
      const res = await fetch(`/api/infra/metrics?${query.toString()}`, {
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
        signal: moduleAbort?.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.detail || `HTTP ${res.status}`);
      }
      if (!data.configured) {
        showBanner('DigitalOcean não configurado no servidor (DIGITALOCEAN_TOKEN).', false);
      }
      if (!chartAvailable()) {
        showBanner('Biblioteca de gráficos indisponível. Recarregue a página.', false);
      }
      metricsCache.set(metricsCacheKey(selectedHostId), { ts: Date.now(), data });
      writeMetricsToStorage(selectedHostId, data);
      renderMetricsPayload(data);
      $('infraPanelVps')?.classList.remove('hidden');
    } catch (err) {
      if (err.name === 'AbortError') return;
      if (!preview) showBanner(err.message || 'Falha ao carregar métricas', false);
    } finally {
      fetchInFlight = false;
      if (force) setLoading(false);
    }
  }

  function bindPeriodSelect() {
    const select = $('infraMetricsPeriod');
    if (!select || !window.Lav60InfraPeriod) return;
    metricsWindowSec = window.Lav60InfraPeriod.bindSelect(select, (seconds) => {
      metricsWindowSec = seconds;
      metricsCache.clear();
      destroyCharts();
      void loadMetrics({ force: true });
    }, { signal: moduleAbort.signal });
  }

  function bindEvents() {
    bindPeriodSelect();
    $('btnInfraRefresh')?.addEventListener('click', () => {
      void loadMetrics({ force: true });
    }, { signal: moduleAbort.signal });

    $('infraVpsTabs')?.addEventListener('click', (event) => {
      const removeBtn = event.target.closest('[data-vps-remove]');
      if (removeBtn) {
        event.stopPropagation();
        void removeVps(removeBtn.dataset.vpsRemove).then(() => loadMetrics({ force: true })).catch((err) => {
          if (err.name !== 'AbortError') showBanner(err.message, false);
        });
        return;
      }
      const tab = event.target.closest('[data-vps-id]');
      if (!tab || tab.disabled) return;
      persistSelectedHostId(tab.dataset.vpsId);
      renderVpsTabs(vpsCatalog);
      void loadMetrics({ force: false });
    }, { signal: moduleAbort.signal });

    $('infraVpsAddForm')?.addEventListener('submit', (event) => {
      event.preventDefault();
      const input = $('infraVpsAddId');
      const hostId = String(input?.value || '').trim();
      if (!hostId) return;
      void addVps(hostId)
        .then(() => loadMetrics({ force: true }))
        .catch((err) => {
          if (err.name !== 'AbortError') showBanner(err.message, false);
        })
        .finally(() => {
          if (input) input.value = '';
        });
    }, { signal: moduleAbort.signal });
  }

  async function init() {
    destroy();
    moduleAbort = new AbortController();
    bindEvents();
    const cachedCatalog = readCatalogFromStorage();
    if (cachedCatalog?.length) {
      vpsCatalog = cachedCatalog;
      const stored = localStorage.getItem(SELECTED_VPS_KEY) || '';
      const fromStore = vpsCatalog.find((item) => String(item.id) === stored);
      if (fromStore) persistSelectedHostId(fromStore.id);
      else if (vpsCatalog[0]) persistSelectedHostId(vpsCatalog[0].id);
      renderVpsTabs(vpsCatalog);
    }
    const saved = selectedHostId ? readMetricsFromStorage(selectedHostId) : null;
    if (saved) renderMetricsPayload(saved);
    try {
      await loadVpsCatalog();
      writeCatalogToStorage(vpsCatalog);
    } catch (err) {
      if (err?.name !== 'AbortError') showBanner(err.message || 'Falha ao carregar', false);
    }
    void loadMetrics({ force: false });
  }

  function destroy() {
    moduleAbort?.abort();
    moduleAbort = null;
    fetchInFlight = false;
    lastPayload = null;
    destroyCharts();
    vpsCatalog = [];
    selectedHostId = '';
    metricsWindowSec = window.Lav60InfraPeriod?.getSelectedSeconds?.() || 3600;
    $('infraMetricsLoading')?.classList.add('hidden');
    $('infraPanelVps')?.classList.remove('hidden');
    $('infraKpiSection')?.classList.add('hidden');
    if ($('infraKpiGrid')) $('infraKpiGrid').innerHTML = '';
    if ($('infraVpsToolbarInfo')) {
      $('infraVpsToolbarInfo').innerHTML = '';
      $('infraVpsToolbarInfo').classList.add('hidden');
    }
    if ($('infraVpsTabs')) $('infraVpsTabs').innerHTML = '';
  }

  window.Lav60InfraVpsPage = { init, destroy };
})();
