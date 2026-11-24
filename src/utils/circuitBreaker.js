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
/**
 * Eksekusi deretan API Providers secara otomatis dengan failover cerdas & auto-healing
 * @param {Array<{name: string, fn?: Function}>} providers
 * @param {Function} fetchFn - (provider) => Promise<any>
 * @param {number} timeoutMs - Timeout per provider (default 15 detik)
 */
export async function executeWithSelfHealing(providers, fetchFn, timeoutMs = 15000) {
  // Sort providers: HEALTHY diprioritaskan di depan, UNHEALTHY di belakang
  const sortedProviders = [...providers].sort((a, b) => {
    const aHealthy = isApiHealthy(a.name);
    const bHealthy = isApiHealthy(b.name);
    if (aHealthy && !bHealthy) return -1;
    if (!aHealthy && bHealthy) return 1;
    return 0;
  });

  const errors = [];
  let lastSpecificError = null;

  for (let i = 0; i < sortedProviders.length; i++) {
    const provider = sortedProviders[i];
    try {
      // Eksekusi fungsi dengan batas timeout per provider
      const result = await Promise.race([
        fetchFn(provider),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout ${timeoutMs / 1000}s`)), timeoutMs))
      ]);

      if (result?.terlaluBesar) {
        return result;
      }

      if (result?.privateOrRestricted || result?.unavailable) {
        lastSpecificError = result;
      }

      const isValidResult = result && result.success && (
        result.buffer ||
        result.videoUrl ||
        result.audioUrl ||
        result.imageUrl ||
        (Array.isArray(result.media) && result.media.length > 0)
      );

      if (isValidResult) {
        reportApiSuccess(provider.name);
        return result;
      } else {
        const errMsg = result?.message || 'Empty payload / media not found';
        errors.push(`${provider.name}: ${errMsg}`);
        const isUserContentError = /private|permission|login|restricted|unavailable|tidak ditemukan|author_secret|status_self_see|404|expired/i.test(errMsg);
        if (!isUserContentError) {
          reportApiFailure(provider.name, errMsg);
        }
        if (i < sortedProviders.length - 1) {
          console.warn(`[AUTO_HEAL] ⚠️ Engine '${provider.name}' gagal (${errMsg}). Mengalihkan otomatis ke engine '${sortedProviders[i + 1].name}'...`);
        }
      }
    } catch (err) {
      errors.push(`${provider.name}: ${err.message}`);
      const is404 = err.response?.status === 404 || /404|not found/i.test(err.message);
      if (!is404) {
        reportApiFailure(provider.name, err.message);
      }
      if (i < sortedProviders.length - 1) {
        console.warn(`[AUTO_HEAL] ⚠️ Engine '${provider.name}' eror (${err.message}). Mengalihkan otomatis ke engine '${sortedProviders[i + 1].name}'...`);
      }
    }
  }

  if (lastSpecificError) {
    return lastSpecificError;
  }

  return {
    success: false,
    message: 'Semua engine downloader cadangan sedang tidak dapat dijangkau. Silakan coba beberapa saat lagi.'
  };
}
