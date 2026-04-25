#!/usr/bin/env tsx
/**
 * CI-friendly smoke test runner
 * 
 * Strategy:
 * 1. Always runs local smoke (mocked fixture server)
 * 2. Attempts to detect public internet connectivity
 * 3. If connected, runs public SSRF-validated smoke
 * 4. If disconnected, logs a warning and exits 0 (CI passes)
 * 5. Provides structured exit codes for CI systems
 * 
 * Exit codes:
 * - 0: All requested smoke tests passed
 * - 1: Local or public smoke failed
 * - 2: Public smoke skipped due to connectivity issue (still exit 0 for CI)
 */

import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CONNECTIVITY_CHECK_URLS = [
  'https://www.google.com/images/branding/googlelogo/1x/googlelogo_color_272x92dp.png',
  'https://www.github.com/assets/images/modules/logos_page/GitHub-Mark.png',
];

const CONNECTIVITY_TIMEOUT_MS = 5000;

/**
 * Check if outbound HTTPS connectivity is available by attempting HEAD requests
 */
async function isPublicConnected(): Promise<boolean> {
  for (const url of CONNECTIVITY_CHECK_URLS) {
    try {
      const controller = new AbortController();
      const timeoutHandle = setTimeout(() => controller.abort(), CONNECTIVITY_TIMEOUT_MS);
      
      try {
        const response = await fetch(url, {
          method: 'HEAD',
          signal: controller.signal,
          redirect: 'follow',
        });
        clearTimeout(timeoutHandle);
        
        if (response.ok || response.status === 405) {
          // 405 means HEAD not supported, but we got a response = connected
          return true;
        }
      } finally {
        clearTimeout(timeoutHandle);
      }
    } catch {
      // Continue to next URL
    }
  }
  return false;
}

/**
 * Run local smoke test (always succeeds if media-pipeline-sidecar is built)
 */
function runLocalSmoke(): void {
  console.log('📦 Running local smoke test (mocked fixture)...');
  try {
    execSync('npm run -s smoke:runtime', {
      cwd: path.dirname(__dirname),
      stdio: 'inherit',
    });
    console.log('✅ Local smoke: PASS\n');
  } catch (err) {
    console.error('❌ Local smoke: FAIL');
    throw err;
  }
}

/**
 * Run public SSRF-validated smoke test (requires connectivity)
 * Uses Google logo as reliable public fixture
 */
function runPublicSmoke(): void {
  console.log('🌐 Running public smoke test (Google logo fixture)...');
  const env = {
    ...process.env,
    SMOKE_PUBLIC_FIXTURE_URL: CONNECTIVITY_CHECK_URLS[0],
    SMOKE_PUBLIC_EXPECT_KIND: 'image',
    SMOKE_REQUEST_TIMEOUT_MS: '8000',
  };
  
  try {
    execSync('npm run -s smoke:runtime:public', {
      cwd: path.dirname(__dirname),
      env,
      stdio: 'inherit',
    });
    console.log('✅ Public smoke: PASS\n');
  } catch (err) {
    console.error('❌ Public smoke: FAIL');
    throw err;
  }
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  console.log('🚀 CI-Friendly Smoke Test Runner\n');
  
  // Always run local smoke
  try {
    runLocalSmoke();
  } catch (err) {
    console.error('\n❌ Smoke test failed: Local tests did not pass');
    process.exit(1);
  }
  
  // Check connectivity for public smoke
  console.log('🔍 Checking public internet connectivity...');
  const connected = await isPublicConnected();
  
  if (!connected) {
    console.warn('⚠️  Public connectivity unavailable');
    console.warn('   Skipping public SSRF-validated smoke test');
    console.log('\n✅ CI Smoke Suite: PASS (local only, connectivity skipped)');
    console.log('   In a connected environment, public smoke would also run.');
    process.exit(0);
  }
  
  console.log('✅ Connected to public internet');
  
  // Run public smoke if connected
  try {
    runPublicSmoke();
  } catch (err) {
    console.error('\n❌ Smoke test failed: Public tests did not pass');
    process.exit(1);
  }
  
  console.log('✅ CI Smoke Suite: PASS (local + public)');
  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
