/**
 * Circuit Breaker & Dynamic API Health Manager
 * Otomatis mendeteksi API pihak ketiga yang rusak, menandainya UNHEALTHY,
 * dan beralih ke provider cadangan lain tanpa mempengaruhi pengguna.
 */

const apiHealthMap = new Map();
// Structure: providerName -> { failures: number, lastFailure: number, status: 'HEALTHY' | 'UNHEALTHY' }

const FAILURE_THRESHOLD = 3; // Jika 3 kali berturut-turut gagal, isolasi API
const COOLDOWN_PERIOD = 15 * 60 * 1000; // Isolasi selama 15 menit, lalu coba probe ulang

/**
 * Cek apakah API Provider sedang Sehat (HEALTHY)
 */
export function isApiHealthy(providerName) {
  const health = apiHealthMap.get(providerName);
  if (!health) return true;

  if (health.status === 'UNHEALTHY') {
    // Cek apakah masa isolasi (cooldown) sudah selesai
    if (Date.now() - health.lastFailure > COOLDOWN_PERIOD) {
      console.log(`[CIRCUIT_BREAKER] 🔄 Cooldown selesai untuk API '${providerName}'. Mencoba probe ulang...`);
      health.status = 'HEALTHY';
      health.failures = 0;
      return true;
    }
    return false;
  }
  return true;
}

/**
 * Laporkan bahwa API Provider sukses merespon
 */
export function reportApiSuccess(providerName) {
  const health = apiHealthMap.get(providerName);
  if (health) {
    if (health.failures > 0 || health.status === 'UNHEALTHY') {
      console.log(`[CIRCUIT_BREAKER] 🟢 API '${providerName}' pulih kembali (HEALTHY).`);
    }
    health.failures = 0;
    health.status = 'HEALTHY';
  }
}

/**
 * Laporkan bahwa API Provider eror/gagal
 */
export function reportApiFailure(providerName, errorMessage = '') {
  let health = apiHealthMap.get(providerName);
  if (!health) {
    health = { failures: 0, lastFailure: 0, status: 'HEALTHY' };
    apiHealthMap.set(providerName, health);
  }

  health.failures += 1;
  health.lastFailure = Date.now();

  if (health.failures >= FAILURE_THRESHOLD && health.status !== 'UNHEALTHY') {
    health.status = 'UNHEALTHY';
    console.warn(`[CIRCUIT_BREAKER] ⚠️ API '${providerName}' diisolasi (UNHEALTHY) setelah ${health.failures}x eror berturut-turut. Mengalihkan lalu lintas ke provider cadangan selama 15 menit. (Reason: ${errorMessage})`);
  }
}

/**
 * Eksekusi deretan API Providers secara otomatis dengan failover cerdas
 */
export async function executeWithSelfHealing(providers, fetchFn) {
  // Sort providers: HEALTHY diprioritaskan di depan
  const sortedProviders = [...providers].sort((a, b) => {
    const aHealthy = isApiHealthy(a.name);
    const bHealthy = isApiHealthy(b.name);
    if (aHealthy && !bHealthy) return -1;
    if (!aHealthy && bHealthy) return 1;
    return 0;
  });

  for (const provider of sortedProviders) {
    try {
      const result = await fetchFn(provider);
      if (result && result.success && (result.buffer || result.videoUrl || result.audioUrl)) {
        reportApiSuccess(provider.name);
        return result;
      } else {
        reportApiFailure(provider.name, result?.message || 'Empty payload');
      }
    } catch (err) {
      reportApiFailure(provider.name, err.message);
    }
  }

  return { success: false, message: 'Semua API provider downloader sedang tidak dapat dijangkau. Silakan coba beberapa saat lagi.' };
}
