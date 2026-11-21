<?php
/**
 * MewsCenter — API data sensor (SQLite)
 *
 * Endpoint:
 *   GET  api/sensor.php?action=latest                 -> generate data simulasi s/d sekarang, kembalikan data terbaru
 *   GET  api/sensor.php?action=history&limit=100      -> riwayat data (default source=dummy)
 *        &source=dummy|mqtt
 *   POST api/sensor.php?action=store  (body JSON)     -> simpan data asli dari MQTT (source=mqtt)
 *
 * Simulasi disesuaikan dengan kondisi Lampahan Timur, Bener Meriah (±1.200 mdpl),
 * musim kemarau: suhu sejuk 16–28 °C, tekanan stasiun ±880 hPa, hujan jarang.
 */

declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
date_default_timezone_set('Asia/Jakarta');

const SIM_INTERVAL = 15;     // detik antar data simulasi
const MAX_BACKFILL = 100;    // titik maksimum yang diisi ketika ada jeda (halaman lama tidak dibuka)
const RETENTION_DAYS = 30;     // data lebih lama dari ini dihapus
const DB_FILE = __DIR__ . '/../data/mews.sqlite';
const FIELDS = [
    'soil_moisture',
    'pergeseran_tanah',
    'water_level_cm',
    'water_pressure_bar',
    'water_voltage_v',
    'mpu1_tebing_deg',
    'mpu1_kika_deg',
    'mpu1_total_deg',
    'mpu2_tebing_deg',
    'mpu2_kika_deg',
    'mpu2_total_deg',
    'voltage_dc',
    'voltage_solar',
    'voltage_battery',
    'current_dc',
    'current_solar',
    'power_dc',
    'voltage_hardware',
    'gsm_signal',
    'gps_latitude',
    'gps_longitude',
];

// ===== DATABASE =====
function db(): PDO
{
    $dir = dirname(DB_FILE);
    if (!is_dir($dir)) {
        mkdir($dir, 0775, true);
        file_put_contents($dir . '/.htaccess', "Require all denied\n");
    }
    $pdo = new PDO('sqlite:' . DB_FILE);
    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $pdo->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
    $pdo->setAttribute(PDO::ATTR_TIMEOUT, 5);
    $pdo->exec('PRAGMA journal_mode = WAL');

    $cols = implode(', ', array_map(fn($f) => "$f REAL", FIELDS));
    $pdo->exec("CREATE TABLE IF NOT EXISTS sensor_readings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        source TEXT NOT NULL DEFAULT 'dummy',
        $cols
    )");
    $pdo->exec('CREATE INDEX IF NOT EXISTS idx_sensor_readings_source_ts ON sensor_readings(source, ts)');
    $pdo->exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)');
    return $pdo;
}

function metaGet(PDO $pdo, string $key): ?array
{
    $st = $pdo->prepare('SELECT v FROM meta WHERE k = ?');
    $st->execute([$key]);
    $v = $st->fetchColumn();
    return $v === false ? null : json_decode($v, true);
}

function metaSet(PDO $pdo, string $key, array $value): void
{
    $pdo->prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
        ->execute([$key, json_encode($value)]);
}

function insertReading(PDO $pdo, int $ts, string $source, array $vals): void
{
    $cols = implode(', ', FIELDS);
    $ph = implode(', ', array_fill(0, count(FIELDS), '?'));
    $args = [$ts, $source];
    foreach (FIELDS as $f) {
        $args[] = isset($vals[$f]) && is_numeric($vals[$f]) ? (float) $vals[$f] : null;
    }
    $pdo->prepare("INSERT INTO sensor_readings (ts, source, $cols) VALUES (?, ?, $ph)")->execute($args);
}

function formatRow(array $row): array
{
    $out = [
        'ts' => date('c', (int) $row['ts']),
        'source' => $row['source'],
        'sid' => $row['source'] === 'dummy' ? 'Local' : 'ESP32-S3',
    ];
    foreach (FIELDS as $f) {
        $out[$f] = $row[$f] === null ? null : (float) $row[$f];
    }
    return $out;
}

// ===== SIMULATOR =====
function gauss(float $sigma = 1.0): float
{
    $u = max(mt_rand() / mt_getrandmax(), 1e-9);
    $v = mt_rand() / mt_getrandmax();
    return sqrt(-2 * log($u)) * cos(2 * M_PI * $v) * $sigma;
}

function rnd(float $min, float $max): float
{
    return $min + (mt_rand() / mt_getrandmax()) * ($max - $min);
}

function clamp(float $v, float $min, float $max): float
{
    return max($min, min($max, $v));
}

/** Kurva harian 0..1 — minimum sekitar 06:00, maksimum sekitar 14:30. */
function diurnal(float $h, float $minH = 6.0, float $maxH = 14.5): float
{
    if ($h >= $minH && $h < $maxH) {
        return (1 - cos(M_PI * ($h - $minH) / ($maxH - $minH))) / 2;
    }
    $span = 24 - ($maxH - $minH);
    $d = fmod($h - $maxH + 24, 24);
    // pangkat < 1 -> pendinginan lebih cepat di sore/awal malam
    return (1 + cos(M_PI * ($d / $span) ** 0.6)) / 2;
}

/** Faktor matahari 0..1 — terbit ±06:35, terbenam ±18:40 WIB (Aceh). */
function sunFactor(float $h): float
{
    $rise = 6.6;
    $set = 18.65;
    if ($h <= $rise || $h >= $set)
        return 0.0;
    return sin(M_PI * ($h - $rise) / ($set - $rise));
}

function initialState(): array
{
    return [
        'soil' => 80.5,
        'batteryV' => 12.95,
        'hwV' => 3.82,
        'waterCm' => 0.0,
        'mpu1Teb' => 0.12,
        'mpu1Kik' => -0.10,
        'mpu2Teb' => 0.03,
        'mpu2Kik' => 0.02,
    ];
}

function simulate(array &$s, int $ts, int $dt): array
{
    $h = (int) date('G', $ts) + (int) date('i', $ts) / 60 + (int) date('s', $ts) / 3600;
    $sun = sunFactor($h);
    $k = $dt / 3600;

    $s['soil'] = clamp($s['soil'] + gauss(0.15) + (80.0 - $s['soil']) * 0.02, 55, 95);
    $s['mpu1Teb'] = clamp($s['mpu1Teb'] + gauss(0.03) + (0.12 - $s['mpu1Teb']) * 0.1, -2, 2);
    $s['mpu1Kik'] = clamp($s['mpu1Kik'] + gauss(0.03) + (-0.10 - $s['mpu1Kik']) * 0.1, -2, 2);
    $mpu1Total = hypot($s['mpu1Teb'], $s['mpu1Kik']);

    $s['mpu2Teb'] = clamp($s['mpu2Teb'] + gauss(0.02) + (0.03 - $s['mpu2Teb']) * 0.1, -2, 2);
    $s['mpu2Kik'] = clamp($s['mpu2Kik'] + gauss(0.02) + (0.02 - $s['mpu2Kik']) * 0.1, -2, 2);
    $mpu2Total = hypot($s['mpu2Teb'], $s['mpu2Kik']);

    $waterCm = max(0.0, $s['waterCm'] + gauss(0.1));
    $waterBar = $waterCm * 0.00098;
    $waterV = 0.495 + $waterCm * 0.001;

    $solarV = $sun > 0.05 ? round(14.5 * $sun + gauss(0.2), 2) : 0.0;
    $solarI = $sun > 0.05 ? max(0.0, round(450 * $sun + gauss(15), 2)) : round(rnd(15, 30), 2);

    $s['batteryV'] = clamp($s['batteryV'] + ($sun > 0.05 ? 0.08 * $sun * $k : -0.02 * $k) + gauss(0.01), 11.8, 13.8);
    $dcV = round(4.85 + gauss(0.03), 2);
    $dcI = round(clamp(700 + gauss(60), 500, 950), 2);
    $dcP = round($dcV * $dcI, 2);

    return [
        'soil_moisture' => round($s['soil'], 2),
        'pergeseran_tanah' => round($mpu1Total, 2),
        'water_level_cm' => round($waterCm, 1),
        'water_pressure_bar' => round($waterBar, 3),
        'water_voltage_v' => round($waterV, 4),
        'mpu1_tebing_deg' => round($s['mpu1Teb'], 2),
        'mpu1_kika_deg' => round($s['mpu1Kik'], 2),
        'mpu1_total_deg' => round($mpu1Total, 2),
        'mpu2_tebing_deg' => round($s['mpu2Teb'], 2),
        'mpu2_kika_deg' => round($s['mpu2Kik'], 2),
        'mpu2_total_deg' => round($mpu2Total, 2),
        'voltage_dc' => $dcV,
        'voltage_solar' => $solarV,
        'voltage_battery' => round($s['batteryV'], 2),
        'current_dc' => $dcI,
        'current_solar' => $solarI,
        'power_dc' => $dcP,
        'voltage_hardware' => round($s['hwV'] + gauss(0.005), 2),
        'gsm_signal' => (int) round(clamp(25 + gauss(1.5), 15, 31)),
        'gps_latitude' => 4.756871,
        'gps_longitude' => 96.768135,
    ];
}

/** Isi data simulasi dari data terakhir hingga sekarang. */
function generateUntilNow(PDO $pdo): void
{
    $pdo->exec('BEGIN IMMEDIATE');
    try {
        $now = time();
        $last = $pdo->query("SELECT MAX(ts) FROM sensor_readings WHERE source = 'dummy'")->fetchColumn();
        $last = $last === null ? null : (int) $last;
        $earliest = $now - (MAX_BACKFILL - 1) * SIM_INTERVAL;
        $start = $last === null ? $earliest : max($last + SIM_INTERVAL, $earliest);

        if ($start <= $now) {
            $state = metaGet($pdo, 'sim_state_v2') ?? initialState();
            for ($t = $start; $t <= $now; $t += SIM_INTERVAL) {
                insertReading($pdo, $t, 'dummy', simulate($state, $t, SIM_INTERVAL));
            }
            metaSet($pdo, 'sim_state_v2', $state);

            if (mt_rand(1, 50) === 1) {
                $pdo->prepare('DELETE FROM sensor_readings WHERE ts < ?')->execute([$now - RETENTION_DAYS * 86400]);
            }
        }
        $pdo->exec('COMMIT');
    } catch (Throwable $e) {
        $pdo->exec('ROLLBACK');
        throw $e;
    }
}

function respond(array $data, int $code = 200): never
{
    http_response_code($code);
    echo json_encode($data, JSON_UNESCAPED_UNICODE);
    exit;
}

// ===== ROUTER =====
try {
    $pdo = db();
    $action = $_GET['action'] ?? 'latest';

    switch ($action) {
        case 'latest':
            generateUntilNow($pdo);
            $row = $pdo->query("SELECT * FROM sensor_readings WHERE source = 'dummy' ORDER BY ts DESC LIMIT 1")->fetch();
            respond(['ok' => true, 'interval' => SIM_INTERVAL, 'data' => formatRow($row)]);

        case 'history':
            $source = ($_GET['source'] ?? 'dummy') === 'mqtt' ? 'mqtt' : 'dummy';
            $limit = max(1, min(1000, (int) ($_GET['limit'] ?? 100)));
            if ($source === 'dummy')
                generateUntilNow($pdo);
            $st = $pdo->prepare('SELECT * FROM (SELECT * FROM sensor_readings WHERE source = ? ORDER BY ts DESC LIMIT ?) ORDER BY ts ASC');
            $st->bindValue(1, $source);
            $st->bindValue(2, $limit, PDO::PARAM_INT);
            $st->execute();
            respond(['ok' => true, 'interval' => SIM_INTERVAL, 'data' => array_map('formatRow', $st->fetchAll())]);

        case 'store':
            if ($_SERVER['REQUEST_METHOD'] !== 'POST')
                respond(['ok' => false, 'error' => 'Gunakan POST'], 405);
            $body = json_decode(file_get_contents('php://input') ?: '', true);
            if (!is_array($body))
                respond(['ok' => false, 'error' => 'Body JSON tidak valid'], 400);
            insertReading($pdo, time(), 'mqtt', $body);
            respond(['ok' => true]);

        default:
            respond(['ok' => false, 'error' => 'Action tidak dikenal'], 404);
    }
} catch (Throwable $e) {
    respond(['ok' => false, 'error' => $e->getMessage()], 500);
}
