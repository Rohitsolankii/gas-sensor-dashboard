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
document.addEventListener('DOMContentLoaded', () => {
  initChart();
  connectWebSocket();
  loadInitialData();
  setupEventListeners();
  updateClock();
  setInterval(updateClock, 1000);
  // Poll for new data via REST as backup
  setInterval(loadInitialData, 30000);
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

    // Load data for selected device or all
    const devices = selectedDevice === 'all' ? (devData.devices || []) : [selectedDevice];
    for (const d of devices) {
      const res = await fetch(`/api/data/${d}?limit=100`);
      const data = await res.json();
      (data.items || []).forEach(item => {
        if (!allData.find(x => x.device_id === item.device_id && x.timestamp === item.timestamp)) {
          allData.push(item);
        }
      });
    }

    allData.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    updateDashboard();
  } catch (err) {
    console.error('Load error:', err);
  }
}

// ─── Add Data Point ───
function addDataPoint(item) {
  if (!allData.find(x => x.device_id === item.device_id && x.timestamp === item.timestamp)) {
    allData.push(item);
    allData.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    if (allData.length > 500) allData = allData.slice(-500);
  }
}

// ─── Update Dashboard ───
function updateDashboard() {
  const filtered = selectedDevice === 'all'
    ? allData
    : allData.filter(d => d.device_id === selectedDevice);

  if (filtered.length === 0) return;

  const latest = filtered[filtered.length - 1];
  const ppm = parseFloat(latest.gas_ppm) || 0;
  const rssi = parseInt(latest.wifi_rssi) || 0;
  const isAlert = latest.alert === true || latest.alert === 'true';

  // PPM Display
  ppmValue.textContent = ppm.toFixed(1);
  const ppmPercent = Math.min((ppm / 1000) * 100, 100);
  ppmBar.style.width = ppmPercent + '%';

  // PPM color class
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

  // Alert banner
  if (isAlert) {
    alertBanner.classList.add('active');
    alertText.textContent = `GAS LEVEL CRITICAL — ${ppm.toFixed(1)} PPM EXCEEDS SAFETY THRESHOLD (${latest.device_id})`;
  } else {
    alertBanner.classList.remove('active');
  }

  // Stats
  const ppmValues = filtered.map(d => parseFloat(d.gas_ppm) || 0);
  statCurrent.textContent = ppm.toFixed(1);
  statMin.textContent = Math.min(...ppmValues).toFixed(1);
  statMax.textContent = Math.max(...ppmValues).toFixed(1);
  statAvg.textContent = (ppmValues.reduce((a, b) => a + b, 0) / ppmValues.length).toFixed(1);

  // Signal
  rssiValue.textContent = rssi;
  signalBars.className = 'signal-bars ' + getSignalClass(rssi);

  // Device info
  infoDevice.textContent = latest.device_id || '--';
  infoADC.textContent = latest.raw_adc || '--';
  infoTime.textContent = formatTime(latest.aws_timestamp || Date.now());

  // Chart
  updateChart(filtered);

  // Table
  updateTable(filtered);

  // Reading count
  readingCount.textContent = `${filtered.length} readings`;
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

function updateChart(data) {
  const sliced = data.slice(-chartRange);
  chart.data.labels = sliced.map(d => {
    if (d.aws_timestamp) {
      const date = new Date(d.aws_timestamp);
      return date.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
    }
    return '';
  });
  chart.data.datasets[0].data = sliced.map(d => parseFloat(d.gas_ppm) || 0);
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
