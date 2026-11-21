<?php
$secret = 'CobaWebhookCoy';
$repoDir = __DIR__; // atau arahkan ke folder repo Anda

$signature = $_SERVER['HTTP_X_HUB_SIGNATURE_256'] ?? '';
$payload = file_get_contents('php://input');

if (!$payload || !$signature) {
    http_response_code(400);
    exit('Bad request');
}

$expected = 'sha256=' . hash_hmac('sha256', $payload, $secret);
if (!hash_equals($expected, $signature)) {
    http_response_code(403);
    exit('Invalid signature');
}

$data = json_decode($payload, true);
if (($data['ref'] ?? '') !== 'refs/heads/main') {
    exit('Ignored: bukan branch main');
}

$cmd = 'cd ' . escapeshellarg($repoDir) . ' && git pull origin main 2>&1';
$output = shell_exec($cmd);

header('Content-Type: text/plain');
echo $output ?? 'Selesai (tidak ada output)';