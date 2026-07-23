(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const METRICS_WINDOW_SEC = 3600;

  let moduleAbort = null;
  let lastPayload = null;
  let loading = false;
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
            maxTicksLimit: 12,
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
      valueKey: 'cpu_percent',
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
    loading = show;
    $('infraMetricsLoading')?.classList.toggle('hidden', !show);
    $('btnInfraRefresh')?.toggleAttribute('disabled', show);
  }

  function updateMeta(payload) {
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
    if (payload.from_cache) parts.push('em cache');
    if (payload.window_seconds) parts.push(`última ${Math.round(payload.window_seconds / 60)} min`);
    el.textContent = parts.join(' · ') || '—';
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

  function renderKpiHead(item) {
    const status = item.status || '—';
    return `
      <div class="infra-kpi-head__info">
        <h2 class="infra-kpi-head__title">${escapeHtml(item.label || item.name || item.id)}</h2>
        <p class="infra-kpi-head__sub">${escapeHtml(item.name || item.id)} · ID ${escapeHtml(item.id)}</p>
        <div class="infra-kpi-head__specs">${renderSpecBadges(item)}</div>
      </div>
      <span class="pill pill--${status === 'active' ? 'ok' : 'partial'}">${escapeHtml(status)}</span>`;
  }

  function renderKpiSection(item) {
    const section = $('infraKpiSection');
    const head = $('infraKpiHead');
    const grid = $('infraKpiGrid');
    const metrics = item?.metrics;
    if (!section || !head || !grid) return;

    if (!item || !metrics || item.metrics_error) {
      section.classList.add('hidden');
      head.innerHTML = '';
      grid.innerHTML = '';
      return;
    }

    const cpu = metrics.cpu || {};
    section.classList.remove('hidden');
    head.innerHTML = renderKpiHead(item);

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
          <h2 class="infra-charts-head__title">Histórico (última hora)</h2>
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

  async function loadMetrics({ force = false } = {}) {
    if (loading) return;
    setLoading(true);
    showBanner('');

    try {
      const query = new URLSearchParams({
        window: String(METRICS_WINDOW_SEC),
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
      lastPayload = data;
      renderLists(data);
      updateMeta(data);
      const vpsName = data.vps?.[0]?.name || data.vps?.[0]?.id || 'SOAP';
      $('infraMetricsSubtitle').textContent = `VPS ${vpsName} · DigitalOcean`;
    } catch (err) {
      if (err.name === 'AbortError') return;
      showBanner(err.message || 'Falha ao carregar métricas', false);
    } finally {
      setLoading(false);
    }
  }

  function bindEvents() {
    $('btnInfraRefresh')?.addEventListener('click', () => {
      void loadMetrics({ force: true });
    }, { signal: moduleAbort.signal });
  }

  async function init() {
    destroy();
    moduleAbort = new AbortController();
    bindEvents();
    await loadMetrics({ force: false });
  }

  function destroy() {
    moduleAbort?.abort();
    moduleAbort = null;
    loading = false;
    lastPayload = null;
    destroyCharts();
    $('infraKpiSection')?.classList.add('hidden');
    $('infraKpiGrid') && ($('infraKpiGrid').innerHTML = '');
    $('infraKpiHead') && ($('infraKpiHead').innerHTML = '');
  }

  window.Lav60InfraMetricsPage = { init, destroy };
})();
