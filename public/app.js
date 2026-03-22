/*
 * GasSenseIQ — Frontend Application
 * ===================================
 * WebSocket real-time updates + Chart.js + REST API
 */

// ─── State ───
let allData = [];
let chartRange = 50;
let selectedDevice = 'all';
let chart = null;
let ws = null;

// ─── DOM Elements ───
const $ = id => document.getElementById(id);

const ppmValue = $('ppmValue');
const ppmBar = $('ppmBar');
const ppmBadge = $('ppmBadge');
const ppmCard = $('ppmCard');
const alertBanner = $('alertBanner');
const alertText = $('alertText');
const connStatus = $('connStatus');
const deviceSelect = $('deviceSelect');
const tableBody = $('tableBody');
const readingCount = $('readingCount');

const statCurrent = $('statCurrent');
const statMin = $('statMin');
const statMax = $('statMax');
const statAvg = $('statAvg');

const rssiValue = $('rssiValue');
const signalBars = $('signalBars');
const infoDevice = $('infoDevice');
const infoADC = $('infoADC');
const infoTime = $('infoTime');
const footerTime = $('footerTime');

// ─── Initialize ───
let refreshCountdown = 30;
let refreshTimer = null;

document.addEventListener('DOMContentLoaded', () => {
  initChart();
  connectWebSocket();
  loadInitialData();
  setupEventListeners();
  updateClock();
  setInterval(updateClock, 1000);

  // Auto-refresh data every 30 seconds via REST (reliable, works even if WebSocket fails)
  refreshTimer = setInterval(() => {
    loadFreshData();
    refreshCountdown = 30;
  }, 30000);

  // Countdown display updates every second
  setInterval(() => {
    refreshCountdown = Math.max(0, refreshCountdown - 1);
    const countEl = document.getElementById('footerTime');
    if (countEl) {
      const now = new Date().toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'medium' });
      countEl.textContent = `${now}  •  Next refresh: ${refreshCountdown}s`;
    }
  }, 1000);
});

// ─── WebSocket ───
function connectWebSocket() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}`);

  ws.onopen = () => {
    connStatus.classList.remove('disconnected');
    connStatus.querySelector('.status-text').textContent = 'Live';
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'data' && msg.items) {
      msg.items.forEach(item => addDataPoint(item));
      updateDashboard();
    }
  };

  ws.onclose = () => {
    connStatus.classList.add('disconnected');
    connStatus.querySelector('.status-text').textContent = 'Reconnecting...';
    setTimeout(connectWebSocket, 3000);
  };

  ws.onerror = () => ws.close();
}

// ─── Load Initial Data ───
async function loadInitialData() {
  try {
    const devRes = await fetch('/api/devices');
    const devData = await devRes.json();

    // Update device dropdown
    const current = deviceSelect.value;
    deviceSelect.innerHTML = '<option value="all">All Devices</option>';
    (devData.devices || []).forEach(d => {
      const opt = document.createElement('option');
      opt.value = d;
      opt.textContent = d;
      deviceSelect.appendChild(opt);
    });
    deviceSelect.value = current;

    // Load data for all devices
    const devices = devData.devices || [];
    for (const d of devices) {
      const res = await fetch(`/api/data/${d}?limit=100`);
      const data = await res.json();
      (data.items || []).forEach(item => {
        if (!allData.find(x => x.device_id === item.device_id && x.timestamp === item.timestamp)) {
          allData.push(item);
        }
      });
    }

    allData.sort((a, b) => (a.aws_timestamp || 0) - (b.aws_timestamp || 0));
    updateDashboard();
  } catch (err) {
    console.error('Load error:', err);
  }
}

// ─── Refresh data (called every 60s) ───
async function loadFreshData() {
  try {
    const devRes = await fetch('/api/devices');
    const devData = await devRes.json();
    const devices = devData.devices || [];

    for (const d of devices) {
      const res = await fetch(`/api/data/${d}?limit=10`);
      const data = await res.json();
      (data.items || []).forEach(item => {
        if (!allData.find(x => x.device_id === item.device_id && x.timestamp === item.timestamp)) {
          allData.push(item);
        }
      });
    }

    // Keep only last 500 records
    allData.sort((a, b) => (a.aws_timestamp || 0) - (b.aws_timestamp || 0));
    if (allData.length > 500) allData = allData.slice(-500);

    updateDashboard();
    console.log(`[Live] Refreshed: ${allData.length} total readings`);
  } catch (err) {
    console.error('Refresh error:', err);
  }
}

// ─── Add Data Point ───
function addDataPoint(item) {
  if (!allData.find(x => x.device_id === item.device_id && x.timestamp === item.timestamp)) {
    allData.push(item);
    allData.sort((a, b) => (a.aws_timestamp || 0) - (b.aws_timestamp || 0));
    if (allData.length > 500) allData = allData.slice(-500);
  }
}

// ─── Update Dashboard ───
function updateDashboard() {
  const filtered = selectedDevice === 'all'
    ? allData
    : allData.filter(d => d.device_id === selectedDevice);

  if (filtered.length === 0) return;

  // Get unique devices in filtered data
  const devices = [...new Set(filtered.map(d => d.device_id))];

  // Find the most critical (highest PPM) latest reading across all devices
  const latestPerDevice = {};
  for (const d of filtered) {
    if (!latestPerDevice[d.device_id] || (d.timestamp || 0) > (latestPerDevice[d.device_id].timestamp || 0)) {
      latestPerDevice[d.device_id] = d;
    }
  }

  // Show the highest PPM device on the gauge
  const latestReadings = Object.values(latestPerDevice);
  const mostCritical = latestReadings.reduce((a, b) =>
    (parseFloat(a.gas_ppm) || 0) >= (parseFloat(b.gas_ppm) || 0) ? a : b
  );

  const ppm = parseFloat(mostCritical.gas_ppm) || 0;
  const rssi = parseInt(mostCritical.wifi_rssi) || 0;

  // PPM Display
  ppmValue.textContent = ppm.toFixed(1);
  const ppmPercent = Math.min((ppm / 1000) * 100, 100);
  ppmBar.style.width = ppmPercent + '%';
  ppmValue.className = 'ppm-value ' + getPPMClass(ppm);

  // Badge
  if (ppm > 300) {
    ppmBadge.textContent = 'DANGER';
    ppmBadge.className = 'card-badge danger';
  } else if (ppm > 200) {
    ppmBadge.textContent = 'WARNING';
    ppmBadge.className = 'card-badge warning';
  } else {
    ppmBadge.textContent = 'SAFE';
    ppmBadge.className = 'card-badge safe';
  }

  // Alert banner — triggers if ANY device is in alert
  const anyAlert = latestReadings.some(d => d.alert === true || d.alert === 'true');
  const alertDevices = latestReadings.filter(d => d.alert === true || d.alert === 'true').map(d => d.device_id);
  if (anyAlert) {
    alertBanner.classList.add('active');
    alertText.textContent = `GAS LEVEL CRITICAL — ${alertDevices.join(', ')} EXCEEDS SAFETY THRESHOLD`;
  } else {
    alertBanner.classList.remove('active');
  }

  // Stats (across all filtered data)
  const ppmValues = filtered.map(d => parseFloat(d.gas_ppm) || 0);
  statCurrent.textContent = ppm.toFixed(1);
  statMin.textContent = Math.min(...ppmValues).toFixed(1);
  statMax.textContent = Math.max(...ppmValues).toFixed(1);
  statAvg.textContent = (ppmValues.reduce((a, b) => a + b, 0) / ppmValues.length).toFixed(1);

  // Signal (from most critical device)
  rssiValue.textContent = rssi;
  signalBars.className = 'signal-bars ' + getSignalClass(rssi);

  // Device info
  infoDevice.textContent = devices.length > 1 ? `${devices.length} devices` : (mostCritical.device_id || '--');
  infoADC.textContent = mostCritical.raw_adc || '--';
  infoTime.textContent = formatTime(mostCritical.aws_timestamp || Date.now());

  // Chart — separate lines per device
  updateChart(filtered, devices);

  // Table — shows all devices
  updateTable(filtered);

  // Reading count
  readingCount.textContent = `${filtered.length} readings (${devices.length} device${devices.length > 1 ? 's' : ''})`;
}

// ─── Chart ───
function initChart() {
  const ctx = $('ppmChart').getContext('2d');

  const gradient = ctx.createLinearGradient(0, 0, 0, 280);
  gradient.addColorStop(0, 'rgba(59, 130, 246, 0.3)');
  gradient.addColorStop(1, 'rgba(59, 130, 246, 0.0)');

  chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [{
        label: 'Gas PPM',
        data: [],
        borderColor: '#3b82f6',
        backgroundColor: gradient,
        borderWidth: 2,
        fill: true,
        tension: 0.3,
        pointRadius: 3,
        pointBackgroundColor: '#3b82f6',
        pointBorderColor: '#0a0f1a',
        pointBorderWidth: 2,
        pointHoverRadius: 6,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 500 },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(10, 15, 26, 0.95)',
          borderColor: 'rgba(59, 130, 246, 0.3)',
          borderWidth: 1,
          titleFont: { family: 'Inter' },
          bodyFont: { family: 'JetBrains Mono', size: 12 },
          padding: 12,
          callbacks: {
            label: ctx => `${ctx.parsed.y.toFixed(2)} PPM`
          }
        }
      },
      scales: {
        x: {
          grid: { color: 'rgba(255,255,255,0.03)' },
          ticks: { color: '#64748b', font: { size: 10 }, maxRotation: 0, maxTicksLimit: 8 }
        },
        y: {
          grid: { color: 'rgba(255,255,255,0.03)' },
          ticks: { color: '#64748b', font: { size: 10 } },
          beginAtZero: true,
        }
      }
    }
  });

  // Danger threshold annotation line
  const thresholdPlugin = {
    id: 'thresholdLine',
    afterDraw(chart) {
      const yScale = chart.scales.y;
      const y = yScale.getPixelForValue(300);
      if (y >= chart.chartArea.top && y <= chart.chartArea.bottom) {
        const ctx = chart.ctx;
        ctx.save();
        ctx.strokeStyle = 'rgba(239, 68, 68, 0.4)';
        ctx.lineWidth = 1;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(chart.chartArea.left, y);
        ctx.lineTo(chart.chartArea.right, y);
        ctx.stroke();
        ctx.fillStyle = 'rgba(239, 68, 68, 0.6)';
        ctx.font = '10px Inter';
        ctx.fillText('Danger: 300 PPM', chart.chartArea.right - 95, y - 5);
        ctx.restore();
      }
    }
  };
  Chart.register(thresholdPlugin);
}

function updateChart(data, devices) {
  // Device color palette
  const colors = [
    { line: '#3b82f6', fill: 'rgba(59, 130, 246, 0.15)' },   // blue
    { line: '#22c55e', fill: 'rgba(34, 197, 94, 0.15)' },    // green
    { line: '#f97316', fill: 'rgba(249, 115, 22, 0.15)' },   // orange
    { line: '#a855f7', fill: 'rgba(168, 85, 247, 0.15)' },   // purple
    { line: '#ec4899', fill: 'rgba(236, 72, 153, 0.15)' },   // pink
    { line: '#eab308', fill: 'rgba(234, 179, 8, 0.15)' },    // yellow
  ];

  if (!devices || devices.length <= 1) {
    // Single device — one line
    const sliced = data.slice(-chartRange);
    const color = colors[0];

    chart.data.labels = sliced.map(d => {
      if (d.aws_timestamp) return new Date(d.aws_timestamp).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
      return '';
    });

    chart.data.datasets = [{
      label: devices?.[0] || 'Gas PPM',
      data: sliced.map(d => parseFloat(d.gas_ppm) || 0),
      borderColor: color.line,
      backgroundColor: color.fill,
      borderWidth: 2,
      fill: true,
      tension: 0.3,
      pointRadius: 3,
      pointBackgroundColor: color.line,
      pointBorderColor: '#0a0f1a',
      pointBorderWidth: 2,
      pointHoverRadius: 6,
    }];
    chart.options.plugins.legend.display = false;
  } else {
    // Multiple devices — separate line per device
    // Collect all unique timestamps for the x-axis
    const allTimestamps = [...new Set(data.map(d => d.aws_timestamp))].sort().slice(-chartRange);

    chart.data.labels = allTimestamps.map(ts =>
      new Date(ts).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })
    );

    chart.data.datasets = devices.map((deviceId, i) => {
      const color = colors[i % colors.length];
      const deviceData = data.filter(d => d.device_id === deviceId);

      // Map timestamps to PPM values (null if no data at that timestamp)
      const values = allTimestamps.map(ts => {
        const match = deviceData.find(d => d.aws_timestamp === ts);
        return match ? (parseFloat(match.gas_ppm) || 0) : null;
      });

      return {
        label: deviceId,
        data: values,
        borderColor: color.line,
        backgroundColor: color.fill,
        borderWidth: 2,
        fill: false,
        tension: 0.3,
        pointRadius: 3,
        pointBackgroundColor: color.line,
        pointBorderColor: '#0a0f1a',
        pointBorderWidth: 2,
        pointHoverRadius: 6,
        spanGaps: true,
      };
    });
    chart.options.plugins.legend.display = true;
    chart.options.plugins.legend.labels = {
      color: '#94a3b8',
      font: { family: 'Inter', size: 11 },
      boxWidth: 12,
      padding: 16,
    };
  }

  chart.update('none');
}

// ─── Table ───
function updateTable(data) {
  const recent = data.slice(-20).reverse();
  if (recent.length === 0) return;

  tableBody.innerHTML = recent.map(d => {
    const ppm = parseFloat(d.gas_ppm) || 0;
    const isAlert = d.alert === true || d.alert === 'true';
    const time = d.aws_timestamp ? new Date(d.aws_timestamp).toLocaleString('en-IN', {
      hour: '2-digit', minute: '2-digit', second: '2-digit', day: '2-digit', month: 'short'
    }) : '--';

    return `<tr>
      <td>${time}</td>
      <td>${d.device_id || '--'}</td>
      <td style="color: ${ppm > 300 ? '#ef4444' : ppm > 200 ? '#eab308' : '#22c55e'}">${ppm.toFixed(2)}</td>
      <td>${d.raw_adc || '--'}</td>
      <td>${d.wifi_rssi || '--'}</td>
      <td><span class="alert-tag ${isAlert ? 'danger' : 'safe'}">${isAlert ? 'DANGER' : 'SAFE'}</span></td>
    </tr>`;
  }).join('');
}

// ─── Helpers ───
function getPPMClass(ppm) {
  if (ppm > 300) return 'danger';
  if (ppm > 200) return 'warning';
  return 'safe';
}

function getSignalClass(rssi) {
  if (rssi >= -50) return 's4';
  if (rssi >= -60) return 's3';
  if (rssi >= -70) return 's2';
  return 's1';
}

function formatTime(ts) {
  if (!ts) return '--';
  return new Date(ts).toLocaleTimeString('en-IN', {
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
}

function updateClock() {
  footerTime.textContent = new Date().toLocaleString('en-IN', {
    dateStyle: 'medium', timeStyle: 'medium'
  });
}

// ─── Event Listeners ───
function setupEventListeners() {
  deviceSelect.addEventListener('change', (e) => {
    selectedDevice = e.target.value;
    updateDashboard();
  });

  document.querySelectorAll('.chart-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.chart-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      chartRange = parseInt(btn.dataset.range);
      updateDashboard();
    });
  });
}
