<?php

declare(strict_types=1);

// Fixture-only, privacy-safe reproduction of Friendica's JSON-LD compaction
// boundary. Never emit the actor document, verification key, or HTTP headers.

require '/var/www/html/vendor/autoload.php';

$actorUri = getenv('AP_INTEROP_ACTOR_URI') ?: '';
$expectedHost = strtolower(getenv('AP_INTEROP_EXPECTED_ACTOR_HOST') ?: '');
$parts = parse_url($actorUri);
if (
    !is_array($parts)
    || ($parts['scheme'] ?? '') !== 'https'
    || empty($parts['host'])
    || $expectedHost === ''
    || !hash_equals($expectedHost, strtolower((string) $parts['host']))
) {
    fwrite(STDERR, "friendica_actor_diagnostic=invalid_actor_uri\n");
    exit(1);
}

$body = '';
$tooLarge = false;
$curl = curl_init($actorUri);
curl_setopt_array($curl, [
    CURLOPT_HTTPHEADER => ['Accept: application/activity+json'],
    CURLOPT_FOLLOWLOCATION => false,
    CURLOPT_CONNECTTIMEOUT => 5,
    CURLOPT_TIMEOUT => 30,
    CURLOPT_CAINFO => '/interop/runtime/certs/rootCA.crt',
    CURLOPT_WRITEFUNCTION => static function ($handle, string $chunk) use (&$body, &$tooLarge): int {
        if (strlen($body) + strlen($chunk) > 2 * 1024 * 1024) {
            $tooLarge = true;
            return 0;
        }
        $body .= $chunk;
        return strlen($chunk);
    },
]);
curl_exec($curl);
$status = (int) curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
$contentType = strtolower(trim((string) curl_getinfo($curl, CURLINFO_CONTENT_TYPE)));
$curlError = curl_errno($curl);
curl_close($curl);

printf("actor_fetch_status=%d\n", $status);
printf("actor_fetch_content_type_valid=%d\n", preg_match('/^application\/(activity\+json|ld\+json)(?:;|$)/', $contentType) === 1 ? 1 : 0);
printf("actor_fetch_body_bytes=%d\n", strlen($body));
printf("actor_fetch_too_large=%d\n", $tooLarge ? 1 : 0);
printf("actor_fetch_transport_error=%d\n", $curlError === 0 ? 0 : 1);

if ($status < 200 || $status >= 300 || $curlError !== 0 || $tooLarge) {
    exit(1);
}

$document = json_decode($body);
if (!is_object($document)) {
    fwrite(STDERR, "actor_json_valid=0\n");
    exit(1);
}
fwrite(STDERR, "actor_json_valid=1\n");

$contexts = [
    'https://www.w3.org/ns/activitystreams' => '/var/www/html/static/activitystreams.jsonld',
    'https://w3id.org/security/v1' => '/var/www/html/static/security-v1.jsonld',
];
jsonld_set_document_loader(static function (string $url) use ($contexts) {
    if (!isset($contexts[$url])) {
        throw new RuntimeException('unsupported_context');
    }
    return jsonld_default_document_loader($contexts[$url]);
});

$context = (object) [
    'as' => 'https://www.w3.org/ns/activitystreams#',
    'w3id' => 'https://w3id.org/security#',
    'ldp' => (object) ['@id' => 'http://www.w3.org/ns/ldp#', '@type' => '@id'],
];

try {
    $compactedObject = jsonld_compact($document, $context);
    $compacted = json_decode(json_encode($compactedObject, JSON_UNESCAPED_SLASHES), true, 512, JSON_THROW_ON_ERROR);
} catch (Throwable $error) {
    fwrite(STDERR, 'actor_jsonld_compaction_ok=0 error_class=' . get_class($error) . "\n");
    exit(1);
}

$id = is_string($compacted['@id'] ?? null) ? $compacted['@id'] : '';
$types = $compacted['@type'] ?? [];
$types = is_array($types) ? $types : [$types];
$accountTypes = ['as:Application', 'as:Group', 'as:Organization', 'as:Person', 'as:Service'];
$accountTypeCount = count(array_intersect($types, $accountTypes));
$fetchElement = static function (array $source, string $element, string $key): mixed {
    if (!array_key_exists($element, $source)) {
        return null;
    }
    $value = $source[$element];
    if (!is_array($value)) {
        return $value;
    }
    $entries = array_is_list($value) ? $value : [$value];
    foreach ($entries as $entry) {
        if (!is_array($entry)) {
            return $entry;
        }
        if (array_key_exists($key, $entry)) {
            return $entry[$key];
        }
    }
    return null;
};

$inbox = $fetchElement($compacted, 'ldp:inbox', '@id');
$nickname = $fetchElement($compacted, 'as:preferredUsername', '@value');
$name = $fetchElement($compacted, 'as:name', '@value');
$publicKey = $compacted['w3id:publicKey'] ?? null;
$publicKey = is_array($publicKey) && array_is_list($publicKey) ? ($publicKey[0] ?? null) : $publicKey;
$pem = is_array($publicKey) ? $fetchElement($publicKey, 'w3id:publicKeyPem', '@value') : null;
$owner = is_array($publicKey) ? $fetchElement($publicKey, 'w3id:owner', '@id') : null;
$controller = is_array($publicKey) ? $fetchElement($publicKey, 'w3id:controller', '@id') : null;

fwrite(STDERR, "actor_jsonld_compaction_ok=1\n");
printf("actor_compact_id_exact=%d\n", hash_equals($actorUri, $id) ? 1 : 0);
printf("actor_compact_account_type_count=%d\n", $accountTypeCount);
printf("actor_compact_inbox_present=%d\n", is_string($inbox) && $inbox !== '' ? 1 : 0);
printf("actor_compact_preferred_username_present=%d\n", is_string($nickname) && $nickname !== '' ? 1 : 0);
printf("actor_compact_name_present=%d\n", is_string($name) && $name !== '' ? 1 : 0);
printf("actor_compact_public_key_present=%d\n", is_array($publicKey) ? 1 : 0);
printf("actor_compact_public_key_pem_present=%d\n", is_string($pem) && $pem !== '' ? 1 : 0);
printf("actor_compact_public_key_owner_exact=%d\n", is_string($owner) && hash_equals($actorUri, $owner) ? 1 : 0);
printf("actor_compact_public_key_controller_exact=%d\n", is_string($controller) && hash_equals($actorUri, $controller) ? 1 : 0);
