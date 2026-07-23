(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const METRICS_INTERVAL_SEC = window.Lav60InfraPeriod?.INTERVAL_SEC || 300;
  const SELECTED_DB_KEY = 'lav60:infra:selected-db';
  const DB_CATALOG_STORAGE_KEY = 'lav60:infra:db-catalog';
  const DB_METRICS_STORAGE_PREFIX = 'lav60:infra:db-metrics:';
  const CLIENT_METRICS_CACHE_MS = 300000;

  let metricsWindowSec = window.Lav60InfraPeriod?.getSelectedSeconds?.() || 3600;

  let moduleAbort = null;
  let dbCatalog = [];
  let selectedDbId = '';
  let fetchInFlight = false;
  const metricsCache = new Map();
  let cpuChart = null;
  let memoryChart = null;
  let diskChart = null;

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
    if (metricsWindowSec > 86400) {
      return date.toLocaleString('pt-BR', {
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });
    }
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

  function avgFromTimeseries(timeseries) {
    const values = (timeseries || [])
      .map((point) => Number(point.percent ?? point.value))
      .filter((value) => Number.isFinite(value));
    if (!values.length) return null;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }

  function prepareTimeseriesForChart(timeseries) {
    return (timeseries || [])
      .map((point) => ({
        ...point,
        timestamp: Number(point.timestamp),
        percent: Number(point.percent ?? point.value),
      }))
      .filter((point) => Number.isFinite(point.timestamp) && Number.isFinite(point.percent));
  }

  function chartAvailable() {
    return typeof window.Chart !== 'undefined';
  }

  function destroyCharts() {
    [cpuChart, memoryChart, diskChart].forEach((chart) => {
      if (chart) chart.destroy();
    });
    cpuChart = null;
    memoryChart = null;
    diskChart = null;
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
              return `${context.dataset.label}: ${Number(value).toFixed(1)}${ySuffix}`;
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
            callback(value) { return `${value}${ySuffix}`; },
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
  } = {}) {
    const series = prepareTimeseriesForChart(timeseries);
    if (!canvas || !chartAvailable() || !series.length) return null;

    const labels = series.map((p) => formatChartTime(p.timestamp));
    const values = series.map((p) => Number(p[valueKey] ?? p.percent));
    const timestamps = series.map((p) => p.timestamp);

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
          const row = series[idx] || {};
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

  function initCharts(metrics) {
    destroyCharts();
    if (!metrics || !chartAvailable()) return;
    requestAnimationFrame(() => {
      buildCpuChart($('infraDbCpuChart'), metrics.cpu_percent_timeseries || []);
      buildMemoryChart($('infraDbMemoryChart'), metrics.memory_percent_timeseries || []);
      buildDiskChart($('infraDbDiskChart'), metrics.disk_percent_timeseries || []);
    });
  }

  function showBanner(message, ok = false) {
    const el = $('infraDbBanner');
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
    $('infraDbLoading')?.classList.toggle('hidden', !show);
    $('btnInfraDbRefresh')?.toggleAttribute('disabled', show);
  }

  function updateMeta(payload, { refreshing = false } = {}) {
    const el = $('infraDbMeta');
    if (!el) return;
    if (!payload) {
      el.textContent = 'Sem dados';
      return;
    }
    const parts = [];
    if (payload.checked_at) {
      parts.push(`Atualizado ${new Date(payload.checked_at).toLocaleString('pt-BR')}`);
    }
    if (payload.from_cache) parts.push('em cache');
    if (payload.from_store || payload.databases?.[0]?.from_store) parts.push('dados salvos');
    const windowSec = payload.window_seconds || metricsWindowSec;
    parts.push(window.Lav60InfraPeriod?.formatPeriodLabel?.(windowSec)
      || `última ${Math.round(windowSec / 60)} min`);
    const intervalSec = Number(payload.interval_seconds) || METRICS_INTERVAL_SEC;
    parts.push(`intervalo ${Math.round(intervalSec / 60)} min`);
    const collected = payload.history_samples_collected;
    const chartPts = payload.history_samples;
    if (Number.isFinite(collected) && collected > 0) {
      if (Number.isFinite(chartPts) && chartPts > collected) {
        parts.push(`${collected} coletada(s) · ${chartPts} pontos no gráfico`);
      } else {
        parts.push(`${collected} amostra(s) no período`);
      }
    } else if (Number.isFinite(chartPts) && chartPts > 0) {
      parts.push(`${chartPts} amostra(s) no período`);
    }
    if (refreshing) parts.push('atualizando…');
    el.textContent = parts.join(' · ') || '—';
  }

  function readCatalogFromStorage() {
    try {
      const raw = sessionStorage.getItem(DB_CATALOG_STORAGE_KEY);
      if (!raw) return null;
      const hit = JSON.parse(raw);
      return Array.isArray(hit?.items) ? hit.items : null;
    } catch {
      return null;
    }
  }

  function writeCatalogToStorage(items) {
    try {
      sessionStorage.setItem(DB_CATALOG_STORAGE_KEY, JSON.stringify({ items, cachedAt: Date.now() }));
    } catch {
      /* ignore */
    }
  }

  function metricsStorageKey(dbId) {
    return `${DB_METRICS_STORAGE_PREFIX}${dbId}:${metricsWindowSec}`;
  }

  function readMetricsFromStorage(dbId) {
    if (!dbId) return null;
    try {
      const raw = sessionStorage.getItem(metricsStorageKey(dbId));
      if (!raw) return null;
      const hit = JSON.parse(raw);
      return hit?.data || null;
    } catch {
      return null;
    }
  }

  function writeMetricsToStorage(dbId, data) {
    if (!dbId || !data) return;
    try {
      sessionStorage.setItem(metricsStorageKey(dbId), JSON.stringify({ data, cachedAt: Date.now() }));
    } catch {
      /* ignore */
    }
  }

  function findAnyCachedMetrics(dbId) {
    const prefix = `${String(dbId || '')}:`;
    let best = null;
    metricsCache.forEach((hit, key) => {
      if (!key.startsWith(prefix)) return;
      if (!best || hit.ts > best.ts) best = hit;
    });
    return best?.data || null;
  }

  function dbTabLabel(item) {
    const name = String(item?.name || '').trim();
    if (name) {
      const short = name.split('.')[0];
      return short || name;
    }
    const id = String(item?.id || 'DB');
    return id.length > 14 ? `${id.slice(0, 8)}…` : id;
  }

  function persistSelectedDbId(dbId) {
    selectedDbId = String(dbId || '');
    try {
      if (selectedDbId) localStorage.setItem(SELECTED_DB_KEY, selectedDbId);
    } catch {
      /* ignore */
    }
  }

  function renderDbTabs(items) {
    const tabs = $('infraDbTabs');
    if (!tabs) return;
    if (!items.length) {
      tabs.innerHTML = '<span class="infra-vps-tabs__empty">Nenhum database cadastrado</span>';
      return;
    }
    tabs.innerHTML = items.map((item) => {
      const active = String(item.id) === String(selectedDbId);
      const removable = items.length > 1;
      return `
        <button type="button" class="infra-vps-tab${active ? ' infra-vps-tab--active' : ''}" data-db-id="${escapeHtml(item.id)}" role="tab" aria-selected="${active ? 'true' : 'false'}" title="${escapeHtml(item.id)}">
          <span class="infra-vps-tab__label">${escapeHtml(dbTabLabel(item))}</span>
          <span class="infra-vps-tab__id">${escapeHtml(item.id)}</span>
          ${removable ? `<span class="infra-vps-tab__remove" data-db-remove="${escapeHtml(item.id)}" title="Remover database" aria-label="Remover database">×</span>` : ''}
        </button>`;
    }).join('');
  }

  async function loadDbCatalog() {
    const res = await fetch('/api/infra/databases', {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      signal: moduleAbort?.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
    dbCatalog = Array.isArray(data.items) ? data.items : [];
    if (!dbCatalog.length) {
      selectedDbId = '';
      renderDbTabs([]);
      return;
    }
    const stillExists = dbCatalog.some((item) => String(item.id) === String(selectedDbId));
    if (!stillExists) {
      let stored = '';
      try { stored = localStorage.getItem(SELECTED_DB_KEY) || ''; } catch { /* ignore */ }
      const fromStore = dbCatalog.find((item) => String(item.id) === stored);
      persistSelectedDbId(fromStore?.id || dbCatalog[0].id);
    }
    renderDbTabs(dbCatalog);
  }

  async function addDatabase(dbId) {
    const res = await fetch('/api/infra/databases', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ db_id: dbId }),
      signal: moduleAbort?.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
    persistSelectedDbId(data.item?.id || dbId);
    await loadDbCatalog();
    if (data.item?.trusted_source_added) {
      showBanner(
        `Database adicionado. IP ${data.item.trusted_source_ip || 'do painel'} incluído em Trusted Sources.`,
        true,
      );
      return;
    }
    if (data.item?.trusted_source_warning) {
      showBanner(
        `Database adicionado, mas Trusted Sources não foi atualizado: ${data.item.trusted_source_warning}`,
        false,
      );
      return;
    }
    showBanner('Database adicionado com sucesso.', true);
  }

  async function removeDatabase(dbId) {
    const item = dbCatalog.find((row) => String(row.id) === String(dbId));
    const label = item ? dbTabLabel(item) : dbId;
    if (!window.confirm(`Remover o database ${label} (${dbId}) do painel?`)) return;

    const res = await fetch(`/api/infra/databases/${encodeURIComponent(dbId)}`, {
      method: 'DELETE',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      signal: moduleAbort?.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
    if (String(selectedDbId) === String(dbId)) {
      persistSelectedDbId(data.db_ids?.[0] || '');
    }
    await loadDbCatalog();
    showBanner('Database removido.', true);
  }

  function renderSpecBadges(item) {
    const specs = [];
    if (item.engine) specs.push(String(item.engine).toUpperCase());
    if (item.version) specs.push(`v${item.version}`);
    if (item.num_nodes) specs.push(`${item.num_nodes} nó(s)`);
    if (item.size) specs.push(String(item.size));
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

  function renderKpiCard({ accent, label, value, meta = '', percent = null, tone = 'neutral' }) {
    return `
      <article class="infra-kpi-card infra-kpi-card--${accent} infra-kpi-card--${tone}">
        <span class="infra-kpi-card__label">${escapeHtml(label)}</span>
        <strong class="infra-kpi-card__value">${escapeHtml(value)}</strong>
        ${renderKpiBar(percent)}
        ${meta ? `<span class="infra-kpi-card__meta">${escapeHtml(meta)}</span>` : ''}
      </article>`;
  }

  function renderToolbarInfo(item) {
    const el = $('infraDbToolbarInfo');
    if (!el) return;
    if (!item || item.metrics_error) {
      el.innerHTML = '';
      el.classList.add('hidden');
      return;
    }
    const status = item.status || '—';
    const pillClass = status === 'online' ? 'ok' : 'partial';
    el.classList.remove('hidden');
    el.innerHTML = `
      <div class="infra-toolbar-info__specs">${renderSpecBadges(item)}</div>
      <span class="pill pill--${pillClass} pill--sm">${escapeHtml(status)}</span>`;
  }

  function renderKpiSection(item) {
    const section = $('infraDbKpiSection');
    const grid = $('infraDbKpiGrid');
    const metrics = item?.metrics;
    if (!section || !grid) return;

    if (!item || !metrics || item.metrics_error) {
      section.classList.add('hidden');
      grid.innerHTML = '';
      renderToolbarInfo(null);
      return;
    }

    section.classList.remove('hidden');
    renderToolbarInfo(item);

    const cpuSeries = metrics.cpu_percent_timeseries || [];
    const memorySeries = metrics.memory_percent_timeseries || [];
    const diskSeries = metrics.disk_percent_timeseries || [];
    const cpuAvg = metrics.cpu_percent_avg ?? avgFromTimeseries(cpuSeries);
    const memoryAvg = metrics.memory_percent_avg ?? avgFromTimeseries(memorySeries);
    const diskAvg = metrics.disk_percent_avg ?? avgFromTimeseries(diskSeries);

    let cpuMeta = cpuAvg != null ? `Média ${formatPercent(cpuAvg)}` : '—';
    if (metrics.cpu_percent_pending) {
      cpuMeta = 'Atualize em ~5 s para calcular';
    }

    const memoryMeta = metrics.memory_used_gb != null && metrics.memory_total_gb != null
      ? `${formatGb(metrics.memory_used_gb)} de ${formatGb(metrics.memory_total_gb)}`
      : (memoryAvg != null ? `Média ${formatPercent(memoryAvg)}` : '—');
    const diskMeta = metrics.disk_free_gb != null && metrics.disk_total_gb != null
      ? `${formatGb(metrics.disk_free_gb)} livres de ${formatGb(metrics.disk_total_gb)}`
      : (diskAvg != null ? `Média ${formatPercent(diskAvg)}` : '—');

    grid.innerHTML = [
      renderKpiCard({
        accent: 'cpu',
        label: 'CPU',
        value: formatPercent(metrics.cpu_percent),
        meta: cpuMeta,
        percent: metrics.cpu_percent,
        tone: kpiTone(metrics.cpu_percent),
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
    ].join('');
  }

  function renderDbCard(item) {
    const metrics = item.metrics || {};
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
          <p class="infra-charts-head__meta">Amostra CPU: ${escapeHtml(formatTs(metrics.sampled_at))}</p>
        </header>
        <div class="infra-charts">
          <section class="infra-chart-panel panel">
            <h3 class="infra-chart-panel__title">CPU %</h3>
            <div class="infra-chart-wrap">
              <canvas id="infraDbCpuChart" aria-label="Gráfico de CPU"></canvas>
            </div>
          </section>
          <section class="infra-chart-panel panel">
            <h3 class="infra-chart-panel__title">Memória %</h3>
            <div class="infra-chart-wrap">
              <canvas id="infraDbMemoryChart" aria-label="Gráfico de memória"></canvas>
            </div>
          </section>
          <section class="infra-chart-panel panel">
            <h3 class="infra-chart-panel__title">Disco %</h3>
            <div class="infra-chart-wrap">
              <canvas id="infraDbDiskChart" aria-label="Gráfico de disco"></canvas>
            </div>
          </section>
        </div>
      </article>`;
  }

  function renderLists(payload) {
    const databases = Array.isArray(payload?.databases) ? payload.databases : [];
    renderKpiSection(databases[0] || null);
    const grid = $('infraDbGrid');
    if (grid) grid.innerHTML = databases.map(renderDbCard).join('');
    $('infraDbEmpty')?.classList.toggle('hidden', databases.length > 0);
    if (databases[0]?.metrics && !databases[0].metrics_error) {
      initCharts(databases[0].metrics);
    } else {
      destroyCharts();
    }
  }

  function renderMetricsPayload(data, { refreshing = false } = {}) {
    if (data?.window_seconds) {
      metricsWindowSec = Number(data.window_seconds) || metricsWindowSec;
    }
    const db = data.databases?.[0];
    const metrics = db?.metrics;
    if (metrics?.cpu_percent_timeseries) {
      data.history_samples = metrics.cpu_percent_timeseries.length;
      if (metrics.history_samples_collected != null) {
        data.history_samples_collected = metrics.history_samples_collected;
      }
    }
    renderLists(data);
    updateMeta(data, { refreshing });
    if (db?.metrics_error) {
      showBanner(db.metrics_error, false);
    } else if (metrics && metrics.memory_percent == null && metrics.disk_percent == null) {
      showBanner(
        'Memória e disco indisponíveis. Clique Atualizar ou confira Trusted Sources do cluster na DigitalOcean.',
        false,
      );
    } else if (metrics?.cpu_percent_pending) {
      showBanner('CPU será calculada na próxima atualização (aguarde ~5 s e clique Atualizar).', false);
    }
  }

  function metricsCacheKey(dbId) {
    return `${String(dbId || '')}:${metricsWindowSec}`;
  }

  function getCachedMetrics(dbId) {
    const hit = metricsCache.get(metricsCacheKey(dbId));
    if (!hit) return null;
    if (Date.now() - hit.ts > CLIENT_METRICS_CACHE_MS) return null;
    return hit.data;
  }

  async function loadMetrics({ force = false, backendForce = false } = {}) {
    if (fetchInFlight && !force && !backendForce) return;
    if (!selectedDbId) {
      $('infraDbEmpty')?.classList.remove('hidden');
      renderKpiSection(null);
      destroyCharts();
      return;
    }

    const cacheKey = metricsCacheKey(selectedDbId);
    const cached = !force && !backendForce ? getCachedMetrics(selectedDbId) : null;
    if (cached) {
      renderMetricsPayload(cached);
      $('infraPanelDb')?.classList.remove('hidden');
      return;
    }

    const stale = !force && !backendForce
      ? (metricsCache.get(cacheKey)?.data || findAnyCachedMetrics(selectedDbId))
      : null;
    const stored = !force && !backendForce ? readMetricsFromStorage(selectedDbId) : null;
    const previewSource = stale || stored;
    if (previewSource) {
      const preview = {
        ...previewSource,
        window_seconds: metricsWindowSec,
        from_cache: true,
      };
      renderMetricsPayload(preview, { refreshing: true });
      $('infraPanelDb')?.classList.remove('hidden');
    }

    if (force || backendForce) setLoading(true);
    showBanner('');
    fetchInFlight = true;

    try {
      const query = new URLSearchParams({
        window: String(metricsWindowSec),
        include_databases: '1',
        db_id: selectedDbId,
        ...(backendForce ? { force: '1' } : {}),
      });
      const res = await fetch(`/api/infra/metrics?${query.toString()}`, {
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
        signal: moduleAbort?.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
      if (!data.configured) {
        showBanner('Token de database não configurado no servidor (DIGITALOCEAN_DB_TOKEN).', false);
      }
      if (!chartAvailable()) {
        showBanner('Biblioteca de gráficos indisponível. Recarregue a página.', false);
      }
      data.window_seconds = data.window_seconds || metricsWindowSec;
      metricsCache.set(cacheKey, { ts: Date.now(), data });
      writeMetricsToStorage(selectedDbId, data);
      renderMetricsPayload(data);
      $('infraPanelDb')?.classList.remove('hidden');
    } catch (err) {
      if (err.name === 'AbortError') return;
      if (!previewSource) showBanner(err.message || 'Falha ao carregar métricas', false);
    } finally {
      fetchInFlight = false;
      if (force || backendForce) setLoading(false);
    }
  }

  function bindPeriodSelect() {
    const select = $('infraMetricsPeriod');
    if (!select || !window.Lav60InfraPeriod) return;
    metricsWindowSec = window.Lav60InfraPeriod.bindSelect(select, (seconds) => {
      metricsWindowSec = seconds;
      destroyCharts();
      void loadMetrics({ force: true, backendForce: false });
    }, { signal: moduleAbort.signal });
  }

  function bindEvents() {
    bindPeriodSelect();
    $('btnInfraDbRefresh')?.addEventListener('click', () => {
      metricsCache.delete(metricsCacheKey(selectedDbId));
      void loadMetrics({ force: true, backendForce: true });
    }, { signal: moduleAbort.signal });

    $('infraDbTabs')?.addEventListener('click', (event) => {
      const removeBtn = event.target.closest('[data-db-remove]');
      if (removeBtn) {
        event.stopPropagation();
        void removeDatabase(removeBtn.dataset.dbRemove)
          .then(() => loadMetrics({ force: true }))
          .catch((err) => {
            if (err.name !== 'AbortError') showBanner(err.message, false);
          });
        return;
      }
      const tab = event.target.closest('[data-db-id]');
      if (!tab) return;
      persistSelectedDbId(tab.dataset.dbId);
      renderDbTabs(dbCatalog);
      void loadMetrics({ force: false });
    }, { signal: moduleAbort.signal });

    $('infraDbAddForm')?.addEventListener('submit', (event) => {
      event.preventDefault();
      const input = $('infraDbAddId');
      const dbId = String(input?.value || '').trim();
      if (!dbId) return;
      void addDatabase(dbId)
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
      dbCatalog = cachedCatalog;
      let stored = '';
      try { stored = localStorage.getItem(SELECTED_DB_KEY) || ''; } catch { /* ignore */ }
      const fromStore = dbCatalog.find((item) => String(item.id) === stored);
      if (fromStore) persistSelectedDbId(fromStore.id);
      else if (dbCatalog[0]) persistSelectedDbId(dbCatalog[0].id);
      renderDbTabs(dbCatalog);
    }
    const saved = selectedDbId ? readMetricsFromStorage(selectedDbId) : null;
    if (saved) renderMetricsPayload(saved);
    try {
      await loadDbCatalog();
      writeCatalogToStorage(dbCatalog);
    } catch (err) {
      if (err?.name !== 'AbortError') showBanner(err.message || 'Falha ao carregar', false);
    }
    void loadMetrics({ force: false });
  }

  function destroy() {
    if (moduleAbort) {
      moduleAbort.abort();
      moduleAbort = null;
    }
    fetchInFlight = false;
    destroyCharts();
    dbCatalog = [];
    selectedDbId = '';
    metricsWindowSec = window.Lav60InfraPeriod?.getSelectedSeconds?.() || 3600;
    $('infraDbLoading')?.classList.add('hidden');
    $('infraPanelDb')?.classList.remove('hidden');
    $('infraDbKpiSection')?.classList.add('hidden');
    if ($('infraDbKpiGrid')) $('infraDbKpiGrid').innerHTML = '';
    if ($('infraDbToolbarInfo')) {
      $('infraDbToolbarInfo').innerHTML = '';
      $('infraDbToolbarInfo').classList.add('hidden');
    }
    if ($('infraDbTabs')) $('infraDbTabs').innerHTML = '';
  }

  window.Lav60InfraDatabasePage = { init, destroy };
})();
