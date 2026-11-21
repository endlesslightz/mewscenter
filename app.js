// ===== CONFIG =====
const CONFIG = {
    mqtt: {
        brokerUrl: 'wss://broker.emqx.io:8084/mqtt',
        deviceId: '2504d4e4-f883-4012-af05-ffcade7aa012',
        topicData: 'iot/devices/2504d4e4-f883-4012-af05-ffcade7aa012/data',
        topicStatus: 'iot/devices/2504d4e4-f883-4012-af05-ffcade7aa012/status',
        clientId: `mewscenter-${Math.random().toString(16).slice(2, 10)}`,
    },
    api: {
        url: 'api/sensor.php',
        pollInterval: 15000,   // ms, polling data simulasi
        mqttTimeout: 10000,    // ms, tunggu payload MQTT sebelum beralih ke simulasi
    },
    bmkg: {
        weatherUrl: 'https://api.bmkg.go.id/publik/prakiraan-cuaca?adm4=11.17.07.2028',
        earthquakeUrl: 'https://data.bmkg.go.id/DataMKG/TEWS/autogempa.json',
        shakemapBase: 'https://data.bmkg.go.id/DataMKG/TEWS/',
        weatherRefresh: 600000,
        earthquakeRefresh: 60000,
    },
    map: {
        lat: 4.7596528158,
        lon: 96.7751885943,
        zoom: 14,
    }
};

// ===== STATE =====
let sensorChart = null;
let currentChartType = 'soilMoisture';
let sensorHistory = { labels: [], soilMoisture: [], pergeseran: [], waterLevel: [], voltageBattery: [] };
let previousSensorData = null;
let map = null;
let sensorMarker = null;
let mqttClient = null;
let dataMode = 'waiting';      // 'waiting' | 'mqtt' | 'dummy'
let dummyTimer = null;
let mqttWaitTimer = null;
let lastDummyTs = null;

// ===== CLOCK =====
function updateClock() {
    const now = new Date();
    const opts = { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Jakarta' };
    document.getElementById('liveClock').textContent = now.toLocaleTimeString('id-ID', opts) + ' WIB';
}
setInterval(updateClock, 1000);
updateClock();

// ===== MQTT SENSOR DATA =====
function connectMqtt() {
    if (mqttClient) return;
    setConnectionStatus('connecting', 'Menghubungkan...');
    mqttClient = mqtt.connect(CONFIG.mqtt.brokerUrl, { clientId: CONFIG.mqtt.clientId, clean: true, reconnectPeriod: 5000 });
    const client = mqttClient;
    // Saat mode simulasi aktif, status MQTT tidak menimpa badge simulasi
    const mqttStatus = (status, text) => { if (dataMode !== 'dummy') setConnectionStatus(status, text); };
    client.on('connect', () => client.subscribe([CONFIG.mqtt.topicData, CONFIG.mqtt.topicStatus], err => {
        if (err) { console.error('MQTT subscribe error:', err); mqttStatus('error', 'Gagal subscribe'); return; }
        if (dataMode === 'waiting') {
            mqttStatus('online', 'MQTT Online · Menunggu data');
            document.getElementById('sensorLastUpdate').textContent = 'Menunggu payload sensor...';
        }
    }));
    client.on('reconnect', () => mqttStatus('connecting', 'Menghubungkan...'));
    client.on('offline', () => mqttStatus('error', 'MQTT Offline'));
    client.on('error', err => console.error('MQTT error:', err));
    client.on('message', (topic, message) => {
        try {
            const payload = JSON.parse(message.toString());
            if (topic === CONFIG.mqtt.topicStatus) {
                updateDeviceStatus(payload);
                return;
            }
            if (topic !== CONFIG.mqtt.topicData) return;
            switchToMqttMode();
            const dt = payload.timestamp ? new Date(payload.timestamp) : new Date();
            const vals = updateSensorCards(payload, Number.isNaN(dt.getTime()) ? new Date() : dt);
            updateMapSensorMarker(vals.gpsLatitude, vals.gpsLongitude);
            storeMqttReading(vals);
        } catch (err) { console.error('Payload MQTT tidak valid:', err); }
    });
}

// ===== SIMULATED DATA (SQLite via api/sensor.php) =====
async function startDummyMode() {
    if (dataMode !== 'waiting') return;
    dataMode = 'dummy';
    setConnectionStatus('dummy', 'ESP32 belum mengirim data');
    try {
        const res = await fetch(`${CONFIG.api.url}?action=history&limit=100`, { cache: 'no-store' });
        const json = await res.json();
        if (!json.ok) throw new Error(json.error);
        if (dataMode !== 'dummy') return;
        json.data.forEach(row => applyDummyRow(row));
    } catch (err) {
        console.error('Gagal memuat data:', err);
        setConnectionStatus('error', 'Simulasi gagal · cek XAMPP/PHP');
        document.getElementById('sensorLastUpdate').textContent = 'Buka via http://localhost/mews/ (bukan file://)';
    }
    if (dataMode === 'dummy') dummyTimer = setInterval(pollDummy, CONFIG.api.pollInterval);
}

async function pollDummy() {
    try {
        const res = await fetch(`${CONFIG.api.url}?action=latest`, { cache: 'no-store' });
        const json = await res.json();
        if (json.ok && dataMode === 'dummy') applyDummyRow(json.data);
    } catch (err) { console.error('Polling gagal:', err); }
}

function applyDummyRow(row) {
    const ts = new Date(row.ts);
    if (lastDummyTs && ts <= lastDummyTs) return;
    lastDummyTs = ts;
    updateSensorCards(row, ts);
}

function switchToMqttMode() {
    clearTimeout(mqttWaitTimer);
    if (dataMode === 'mqtt') return;
    if (dataMode === 'dummy') {
        clearInterval(dummyTimer);
        // bersihkan grafik agar data simulasi tidak tercampur data asli
        Object.values(sensorHistory).forEach(values => values.length = 0);
        previousSensorData = null;
    }
    dataMode = 'mqtt';
    setConnectionStatus('online', 'MQTT Live');
}

function storeMqttReading(v) {
    const body = {
        soil_moisture: v.soilMoisture,
        pergeseran_tanah: v.pergeseran,
        water_level_cm: v.waterLevel,
        water_pressure_bar: v.waterPressure,
        water_voltage_v: v.waterVoltage,
        mpu1_tebing_deg: v.mpu1Tebing,
        mpu1_kika_deg: v.mpu1Kika,
        mpu1_total_deg: v.mpu1Total,
        mpu2_tebing_deg: v.mpu2Tebing,
        mpu2_kika_deg: v.mpu2Kika,
        mpu2_total_deg: v.mpu2Total,
        voltage_dc: v.voltageDc,
        voltage_solar: v.voltageSolar,
        voltage_battery: v.voltageBattery,
        current_dc: v.currentDc,
        current_solar: v.currentSolar,
        power_dc: v.powerDc,
        voltage_hardware: v.voltageHardware,
        gsm_signal: v.gsmSignal,
        gps_latitude: v.gpsLatitude,
        gps_longitude: v.gpsLongitude,
    };
    Object.keys(body).forEach(k => { if (!Number.isFinite(body[k])) delete body[k]; });
    fetch(`${CONFIG.api.url}?action=store`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }).catch(err => console.warn('Gagal menyimpan data MQTT:', err));
}

function updateDeviceStatus(status) {
    const container = document.getElementById('devicePills');
    if (!container || !status) return;
    const pills = [];
    pills.push({ label: status.online ? 'ONLINE' : 'OFFLINE', cls: status.online ? 'ok' : 'err' });

    const devLabels = {
        sd_card: 'SD Card',
        rtc_ds3231: 'RTC',
        ina226_0x40: 'INA226',
        ads1115_top_0x49: 'ADS Top',
        ads1115_borehole_0x48: 'ADS Borehole',
        mpu6050_1_0x68: 'MPU1',
        mpu6050_2_0x69: 'MPU2',
        gps_fix: 'GPS',
    };
    if (status.devices && typeof status.devices === 'object') {
        Object.entries(status.devices).forEach(([key, val]) => {
            const name = devLabels[key] || key;
            const upper = String(val).toUpperCase();
            const cls = (upper === 'OK' || upper === 'FIX') ? 'ok' : 'err';
            pills.push({ label: `${name}: ${upper}`, cls });
        });
    }
    if (status.diagnostics) {
        const d = status.diagnostics;
        if (Number.isFinite(Number(d.gps_usat))) {
            const vsat = Number(d.gps_vsat) >= 0 ? d.gps_vsat : '--';
            pills.push({ label: `Sat: ${d.gps_usat}/${vsat}`, cls: 'info' });
        }
        if (Number.isFinite(Number(d.pending_sync_count))) {
            pills.push({ label: `Sync Queue: ${d.pending_sync_count}`, cls: 'info' });
        }
    }
    container.innerHTML = pills.map(p => `<span class="device-pill ${p.cls}">${p.label}</span>`).join('');
}

function updateMapSensorMarker(lat, lon) {
    if (!map || !Number.isFinite(lat) || !Number.isFinite(lon)) return;
    if (lat === 0 && lon === 0) return;
    if (!sensorMarker) {
        const gpsIcon = L.divIcon({
            className: 'sensor-gps-marker',
            html: `<div style="width:14px;height:14px;background:#10b981;border-radius:50%;border:2px solid #fff;box-shadow:0 0 12px rgba(16,185,129,0.8);"></div>`,
            iconSize: [14, 14], iconAnchor: [7, 7],
        });
        sensorMarker = L.marker([lat, lon], { icon: gpsIcon }).addTo(map);
    } else {
        sensorMarker.setLatLng([lat, lon]);
    }
    sensorMarker.bindPopup(`<b>📡 Node Sensor IoT</b><br>${lat.toFixed(6)}°N, ${lon.toFixed(6)}°E`);
}

function updateSensorCards(data, dt = new Date()) {
    const readNumber = (paths) => {
        for (const path of paths) {
            const value = path.split('.').reduce((current, key) => current?.[key], data);
            const number = Number(value);
            if (value !== undefined && value !== null && Number.isFinite(number)) return number;
        }
        return NaN;
    };

    const vals = {
        soilMoisture: readNumber(['soil_moisture']),
        pergeseran: readNumber(['pergeseran_tanah']),
        waterLevel: readNumber(['water_level_cm']),
        waterPressure: readNumber(['water_pressure_bar']),
        waterVoltage: readNumber(['water_voltage_v']),
        mpu1Tebing: readNumber(['mpu1_tebing_deg']),
        mpu1Kika: readNumber(['mpu1_kika_deg']),
        mpu1Total: readNumber(['mpu1_total_deg']),
        mpu2Tebing: readNumber(['mpu2_tebing_deg']),
        mpu2Kika: readNumber(['mpu2_kika_deg']),
        mpu2Total: readNumber(['mpu2_total_deg']),
        voltageDc: readNumber(['voltage_dc']),
        voltageSolar: readNumber(['voltage_solar']),
        voltageBattery: readNumber(['voltage_battery']),
        currentDc: readNumber(['current_dc']),
        currentSolar: readNumber(['current_solar']),
        powerDc: readNumber(['power_dc']),
        voltageHardware: readNumber(['voltage_hardware']),
        gsmSignal: readNumber(['gsm_signal']),
        gpsLatitude: readNumber(['gps_latitude']),
        gpsLongitude: readNumber(['gps_longitude']),
    };

    setVal('sensorSoilMoisture', vals.soilMoisture, 2);
    setVal('sensorPergeseran', vals.pergeseran, 2);
    setVal('sensorWaterLevel', vals.waterLevel, 1);
    setVal('sensorWaterPressure', vals.waterPressure, 3);
    setVal('sensorMpu1Total', vals.mpu1Total, 2);
    setVal('sensorMpu2Total', vals.mpu2Total, 2);
    setVal('sensorVoltageBattery', vals.voltageBattery, 2);
    setVal('sensorVoltageSolar', vals.voltageSolar, 2);
    setVal('sensorPowerDc', vals.powerDc, 1);
    setVal('sensorGsmSignal', vals.gsmSignal, 0);

    // sub-info
    const setSub = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
    if (Number.isFinite(vals.waterVoltage)) setSub('subWaterVoltage', `Volt: ${vals.waterVoltage.toFixed(4)} V`);
    if (Number.isFinite(vals.mpu1Tebing) && Number.isFinite(vals.mpu1Kika)) {
        setSub('subMpu1', `Tebing: ${vals.mpu1Tebing.toFixed(2)}° · Kika: ${vals.mpu1Kika.toFixed(2)}°`);
    }
    if (Number.isFinite(vals.mpu2Tebing) && Number.isFinite(vals.mpu2Kika)) {
        setSub('subMpu2', `Tebing: ${vals.mpu2Tebing.toFixed(2)}° · Kika: ${vals.mpu2Kika.toFixed(2)}°`);
    }
    if (Number.isFinite(vals.voltageHardware)) setSub('subVoltageHw', `HW: ${vals.voltageHardware.toFixed(2)} V`);
    if (Number.isFinite(vals.currentSolar)) setSub('subCurrentSolar', `Arus: ${vals.currentSolar.toFixed(2)} mA`);
    if (Number.isFinite(vals.voltageDc) && Number.isFinite(vals.currentDc)) {
        setSub('subDcDetail', `${vals.voltageDc.toFixed(2)} V · ${vals.currentDc.toFixed(1)} mA`);
    }
    if (Number.isFinite(vals.gpsLatitude) && Number.isFinite(vals.gpsLongitude)) {
        setSub('subGpsCoords', `GPS: ${vals.gpsLatitude.toFixed(5)}, ${vals.gpsLongitude.toFixed(5)}`);
    }

    // bars
    setBar('barSoilMoisture', vals.soilMoisture, 0, 100);
    setBar('barPergeseran', vals.pergeseran, 0, 10);
    setBar('barWaterLevel', vals.waterLevel, 0, 200);
    setBar('barWaterPressure', vals.waterPressure, 0, 1);
    setBar('barMpu1Total', vals.mpu1Total, 0, 15);
    setBar('barMpu2Total', vals.mpu2Total, 0, 15);
    setBar('barVoltageBattery', vals.voltageBattery, 10.5, 14.5);
    setBar('barVoltageSolar', vals.voltageSolar, 0, 22);
    setBar('barPowerDc', vals.powerDc, 0, 6000);
    setBar('barGsmSignal', vals.gsmSignal, 0, 31);

    // trends
    if (previousSensorData) {
        Object.keys(vals).forEach(key => {
            if (Number.isFinite(vals[key]) && Number.isFinite(previousSensorData[key])) {
                setTrend(`trend${key[0].toUpperCase()}${key.slice(1)}`, vals[key], previousSensorData[key]);
            }
        });
    }
    previousSensorData = vals;

    // last update
    const devLabel = data.device_id ? `Node ${String(data.device_id).slice(0, 8)}` : (data.sid || 'Sensor');
    document.getElementById('sensorLastUpdate').textContent =
        `${devLabel} · ${dt.toLocaleDateString('id-ID')} ${dt.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
    updateSensorChart(vals, dt);
    return vals;
}

function setVal(id, val, decimals) {
    const el = document.getElementById(id);
    if (el && !isNaN(val)) el.textContent = val.toFixed(decimals);
}
function setBar(id, val, min, max) {
    const pct = Math.min(100, Math.max(0, ((val - min) / (max - min)) * 100));
    const el = document.getElementById(id);
    if (el) el.style.width = pct + '%';
}
function setTrend(id, curr, prev) {
    const el = document.getElementById(id);
    if (!el) return;
    const diff = curr - prev;
    if (Math.abs(diff) < 0.01) {
        el.textContent = '—'; el.className = 'sensor-trend stable';
    } else if (diff > 0) {
        el.textContent = '▲ ' + diff.toFixed(2); el.className = 'sensor-trend up';
    } else {
        el.textContent = '▼ ' + Math.abs(diff).toFixed(2); el.className = 'sensor-trend down';
    }
}

function setConnectionStatus(status, text) {
    const el = document.getElementById('connectionStatus');
    el.className = 'status-badge ' + status;
    el.querySelector('.status-text').textContent = text;
}

// ===== CHART =====
function initChart() {
    const ctx = document.getElementById('sensorChart').getContext('2d');
    sensorChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: [],
            datasets: [{
                label: 'Kelembapan Tanah (%)',
                data: [],
                borderColor: '#22d3ee',
                backgroundColor: 'rgba(34, 211, 238, 0.1)',
                borderWidth: 2, tension: 0.4, fill: true,
                pointRadius: 0, pointHitRadius: 10,
            }]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: 'rgba(17, 24, 39, 0.95)',
                    titleColor: '#f1f5f9', bodyColor: '#94a3b8',
                    borderColor: 'rgba(99, 102, 241, 0.3)', borderWidth: 1,
                    padding: 12, cornerRadius: 8,
                    titleFont: { family: 'Inter', weight: '600' },
                    bodyFont: { family: 'JetBrains Mono' },
                }
            },
            scales: {
                x: {
                    type: 'time',
                    time: { tooltipFormat: 'dd MMM yyyy HH:mm', displayFormats: { minute: 'HH:mm', hour: 'HH:mm' } },
                    grid: { color: 'rgba(255,255,255,0.04)' },
                    ticks: { color: '#64748b', font: { size: 10, family: 'JetBrains Mono' }, maxTicksLimit: 8 },
                },
                y: {
                    grid: { color: 'rgba(255,255,255,0.04)' },
                    ticks: { color: '#64748b', font: { size: 10, family: 'JetBrains Mono' } },
                }
            },
            interaction: { intersect: false, mode: 'index' },
            animation: { duration: 800, easing: 'easeInOutQuart' },
        }
    });
}

function updateSensorChart(data, timestamp) {
    sensorHistory.labels.push(timestamp);
    sensorHistory.soilMoisture.push(data.soilMoisture);
    sensorHistory.pergeseran.push(data.pergeseran);
    sensorHistory.waterLevel.push(data.waterLevel);
    sensorHistory.voltageBattery.push(data.voltageBattery);
    if (sensorHistory.labels.length > 100) Object.values(sensorHistory).forEach(values => values.shift());

    applyChartData(currentChartType);
}

function applyChartData(type) {
    if (!sensorChart) return;
    const chartConfig = {
        soilMoisture: { label: 'Kelembapan Tanah (%)', color: '#22d3ee', data: sensorHistory.soilMoisture },
        pergeseran: { label: 'Pergeseran Tanah (°)', color: '#f59e0b', data: sensorHistory.pergeseran },
        waterLevel: { label: 'Tinggi Muka Air (cm)', color: '#8b5cf6', data: sensorHistory.waterLevel },
        voltageBattery: { label: 'Tegangan Baterai (V)', color: '#10b981', data: sensorHistory.voltageBattery },
    };
    const c = chartConfig[type] || chartConfig.soilMoisture;
    sensorChart.data.labels = sensorHistory.labels;
    sensorChart.data.datasets[0].label = c.label;
    sensorChart.data.datasets[0].data = c.data;
    sensorChart.data.datasets[0].borderColor = c.color;
    sensorChart.data.datasets[0].backgroundColor = c.color + '1a';
    sensorChart.update();
}

document.querySelectorAll('.chart-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.chart-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentChartType = btn.dataset.chart;
        applyChartData(currentChartType);
    });
});

// ===== MAP =====
function initMap() {
    map = L.map('map', { zoomControl: true, scrollWheelZoom: true }).setView([CONFIG.map.lat, CONFIG.map.lon], CONFIG.map.zoom);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap contributors',
        maxZoom: 19,
    }).addTo(map);

    // Main location marker
    const mainIcon = L.divIcon({
        className: 'main-marker',
        html: `<div style="position:relative;">
            <div style="width:20px;height:20px;background:linear-gradient(135deg,#22d3ee,#8b5cf6);border-radius:50%;border:3px solid #fff;box-shadow:0 0 20px rgba(34,211,238,0.5);"></div>
            <div style="position:absolute;top:-2px;left:-2px;width:24px;height:24px;border-radius:50%;border:2px solid rgba(34,211,238,0.4);animation:mapPulse 2s ease-out infinite;"></div>
        </div>`,
        iconSize: [20, 20], iconAnchor: [10, 10]
    });

    L.marker([CONFIG.map.lat, CONFIG.map.lon], { icon: mainIcon })
        .addTo(map)
        .bindPopup(`
            <div style="min-width:200px;">
                <div style="font-weight:700;font-size:1rem;margin-bottom:4px;">📍 Lampahan Timur</div>
                <div style="font-size:0.8rem;color:#94a3b8;line-height:1.4;">
                    Kec. Timang Gajah<br>
                    Kab. Bener Meriah, Aceh<br>
                    <span style="font-family:monospace;font-size:0.75rem;">
                        ${CONFIG.map.lat.toFixed(6)}°N, ${CONFIG.map.lon.toFixed(6)}°E
                    </span>
                </div>
            </div>
        `)
        .openPopup();

    // Add a translucent area circle (~1km radius)
    L.circle([CONFIG.map.lat, CONFIG.map.lon], {
        radius: 1000, color: '#8b5cf6', fillColor: '#8b5cf6',
        fillOpacity: 0.08, weight: 1.5, dashArray: '6, 4', opacity: 0.4,
    }).addTo(map);

    // Add pulse CSS
    const style = document.createElement('style');
    style.textContent = `@keyframes mapPulse { 0% { transform: scale(1); opacity: 1; } 100% { transform: scale(3); opacity: 0; } }`;
    document.head.appendChild(style);
}

// ===== BMKG WEATHER =====
async function fetchWeather() {
    try {
        const res = await fetch(CONFIG.bmkg.weatherUrl);
        if (!res.ok) throw new Error('Weather fetch failed');
        const data = await res.json();
        renderWeather(data);
    } catch (err) {
        console.error('BMKG Weather error:', err);
        document.getElementById('weatherGrid').innerHTML = '<p style="color:var(--accent-red);padding:1rem;">Gagal memuat data cuaca BMKG.</p>';
    }
}

function renderWeather(data) {
    const loc = data.lokasi;
    document.getElementById('weatherLocation').innerHTML =
        `📍 <strong>${loc.desa}</strong>, Kec. ${loc.kecamatan}, ${loc.kotkab}, ${loc.provinsi}`;

    const allForecasts = data.data[0].cuaca.flat();
    // Group by date
    const grouped = {};
    allForecasts.forEach(f => {
        const localDt = new Date(f.local_datetime.replace(' ', 'T'));
        const dateKey = localDt.toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
        if (!grouped[dateKey]) grouped[dateKey] = [];
        grouped[dateKey].push({ ...f, localDt });
    });

    let html = '';
    for (const [day, forecasts] of Object.entries(grouped)) {
        html += `<div class="weather-day-group">
            <div class="weather-day-label">${day}</div>
            <div class="weather-cards">`;
        forecasts.forEach(f => {
            const time = f.localDt.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', hour12: false });
            html += `
                <div class="weather-card">
                    <div class="weather-time">${time}</div>
                    <div class="weather-icon"><img src="${f.image}" alt="${f.weather_desc}" loading="lazy"></div>
                    <div class="weather-desc">${f.weather_desc}</div>
                    <div class="weather-temp">${f.t}<span>°C</span></div>
                    <div class="weather-details">
                        <span>💧${f.hu}%</span>
                        <span>💨${f.ws} km/j</span>
                    </div>
                </div>`;
        });
        html += `</div></div>`;
    }

    document.getElementById('weatherGrid').innerHTML = html;
}

// ===== BMKG EARTHQUAKE =====
async function fetchEarthquake() {
    try {
        const res = await fetch(CONFIG.bmkg.earthquakeUrl);
        if (!res.ok) throw new Error('Earthquake fetch failed');
        const data = await res.json();
        renderEarthquake(data);
    } catch (err) {
        console.error('BMKG Earthquake error:', err);
        document.getElementById('earthquakeContent').innerHTML = '<p style="color:var(--accent-red);padding:1rem;">Gagal memuat data gempa BMKG.</p>';
    }
}

function renderEarthquake(data) {
    const g = data.Infogempa.gempa;
    const mag = parseFloat(g.Magnitude);
    let magColor = 'var(--accent-green)';
    let magBg = 'rgba(16, 185, 129, 0.1)';
    let magBorder = 'rgba(16, 185, 129, 0.3)';
    if (mag >= 5) { magColor = 'var(--accent-red)'; magBg = 'rgba(239, 68, 68, 0.1)'; magBorder = 'rgba(239, 68, 68, 0.3)'; }
    else if (mag >= 3) { magColor = 'var(--accent-orange)'; magBg = 'rgba(245, 158, 11, 0.1)'; magBorder = 'rgba(245, 158, 11, 0.3)'; }

    const coords = g.Coordinates.split(',');
    const lat = parseFloat(coords[0]);
    const lon = parseFloat(coords[1]);

    // Add quake marker on map
    if (map) {
        const quakeIcon = L.divIcon({
            className: 'quake-marker',
            html: `<div style="width:16px;height:16px;background:${magColor};border-radius:50%;border:3px solid rgba(255,255,255,0.8);box-shadow:0 0 15px ${magColor};"></div>`,
            iconSize: [16, 16], iconAnchor: [8, 8]
        });
        L.marker([lat, lon], { icon: quakeIcon })
            .addTo(map)
            .bindPopup(`<b>🔴 Gempa M${g.Magnitude}</b><br>${g.Wilayah}<br>${g.Tanggal} ${g.Jam}`);
    }

    document.getElementById('earthquakeContent').innerHTML = `
        <div class="quake-main">
            <div class="quake-magnitude" style="background:${magBg};border-color:${magBorder};">
                <div class="quake-mag-value" style="color:${magColor};">${g.Magnitude}</div>
                <div class="quake-mag-label" style="color:${magColor};">Magnitudo</div>
            </div>
            <div class="quake-info">
                <div class="quake-info-row">
                    <span class="quake-info-icon">📍</span>
                    <div class="quake-info-text">
                        <div class="quake-info-label">Wilayah</div>
                        <div class="quake-info-value">${g.Wilayah}</div>
                    </div>
                </div>
                <div class="quake-info-row">
                    <span class="quake-info-icon">🕐</span>
                    <div class="quake-info-text">
                        <div class="quake-info-label">Waktu</div>
                        <div class="quake-info-value">${g.Tanggal} — ${g.Jam}</div>
                    </div>
                </div>
                <div class="quake-info-row">
                    <span class="quake-info-icon">📐</span>
                    <div class="quake-info-text">
                        <div class="quake-info-label">Koordinat & Kedalaman</div>
                        <div class="quake-info-value">${g.Lintang}, ${g.Bujur} — ${g.Kedalaman}</div>
                    </div>
                </div>
                <div class="quake-info-row">
                    <span class="quake-info-icon">⚠️</span>
                    <div class="quake-info-text">
                        <div class="quake-info-label">Potensi</div>
                        <div class="quake-info-value">${g.Potensi}</div>
                    </div>
                </div>
                ${g.Dirasakan ? `
                <div class="quake-felt">
                    <div class="quake-felt-title">🔔 Dirasakan</div>
                    ${g.Dirasakan}
                </div>` : ''}
            </div>
        </div>
        ${g.Shakemap ? `
        <div class="quake-shakemap">
            <img src="${CONFIG.bmkg.shakemapBase}${g.Shakemap}" alt="Shakemap" loading="lazy" onerror="this.parentElement.style.display='none'">
        </div>` : ''}
    `;
}

// ===== INIT =====
document.addEventListener('DOMContentLoaded', () => {
    initChart();
    initMap();
    connectMqtt();
    // ?mode=dummy -> langsung mode simulasi (untuk demo)
    const forceDummy = new URLSearchParams(location.search).get('mode') === 'dummy';
    mqttWaitTimer = setTimeout(startDummyMode, forceDummy ? 0 : CONFIG.api.mqttTimeout);
    fetchWeather();
    fetchEarthquake();

    setInterval(fetchWeather, CONFIG.bmkg.weatherRefresh);
    setInterval(fetchEarthquake, CONFIG.bmkg.earthquakeRefresh);
});
