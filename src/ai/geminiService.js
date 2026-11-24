/**
 * Gemini AI Assistant & Vision Service
 * Uses Google Gemini REST API with automatic multi-model fallback (gemini-3.6-flash, gemini-3.5-flash, gemini-flash-latest)
 * and strict system prompt guardrails for concise, accurate WhatsApp responses.
 */
import https from 'https';

const DEFAULT_SYSTEM_PROMPT = `Kamu adalah Asisten AI Pintar WhatsApp yang ramah, sopan, akurat, dan serba tahu.
Aturan Penting:
1. Jawablah pertanyaan pengguna dengan Bahasa Indonesia yang baik, ramah, dan tepat sasaran.
2. Format jawaban secara ringkas dan rapi khas WhatsApp (gunakan *bold*, _italic_, bullet points). Jangan memberikan jawaban yang terlalu panjang membosankan kecuali diminta detail.
3. Jangan mengarang atau memberikan informasi palsu. Jika tidak tahu, katakan sejujurnya.
4. Jangan menyertakan tag HTML atau format markdown aneh yang tidak didukung WhatsApp.`;

const CANDIDATE_MODELS = [
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-flash-lite-latest',
  'gemini-3.6-flash',
  'gemini-flash-latest'
];

function getApiKey() {
  return process.env.GEMINI_API_KEY || '';
}

const TIMEOUT_TEKS_MS = 30_000;
const TIMEOUT_MEDIA_MS = 60_000;

function pasangTimeout(req, ms, label) {
  req.setTimeout(ms, () => {
    req.destroy(new Error(`Gemini tidak merespons dalam ${Math.round(ms / 1000)} detik (${label}).`));
  });
}

/**
 * Eksekusi REST request ke model Gemini tertentu
 */
function sendGeminiRequest({ model, payload, apiKey, timeoutMs, label }) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/${model}:generateContent?key=${apiKey}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode !== 200) {
            const errDetails = parsed.error?.message || JSON.stringify(parsed);
            return reject(new Error(`Gemini API Error (${res.statusCode}): ${errDetails}`));
          }
          const replyText = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
          if (!replyText || !replyText.trim()) {
            if (label === 'dokumen') {
              return resolve('(Tidak ada teks yang terdeteksi pada gambar/dokumen ini)');
            }
            return reject(new Error('Gemini API mengembalikan respons kosong.'));
          }
          resolve(replyText.trim());
        } catch (e) {
          reject(new Error(`Gagal memproses JSON Gemini API: ${e.message}`));
        }
      });
    });

    pasangTimeout(req, timeoutMs, label);
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/**
 * Eksekusi dengan fallback berurutan ke model berikutnya jika model pertama 404 / gagal
 */
async function executeWithModelFallback(payload, timeoutMs, label) {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY belum dikonfigurasi di file .env');
  }

  let lastError = null;
  for (const model of CANDIDATE_MODELS) {
    try {
      const result = await sendGeminiRequest({ model, payload, apiKey, timeoutMs, label });
      return result;
    } catch (err) {
      lastError = err;
      console.warn(`[GEMINI_FALLBACK] Model ${model} gagal (${err.message}). Mencoba model cadangan...`);
    }
  }

  throw lastError || new Error('Semua model Gemini AI tidak dapat diakses.');
}

/**
 * Send text prompt to Gemini AI.
 * @param {string|Object} param1 - String prompt atau object { prompt, systemPrompt }
 * @param {string} [param2] - Optional system prompt jika param1 berupa string
 * @returns {Promise<string>}
 */
export async function askGeminiText(param1, param2) {
  let prompt = '';
  let systemPrompt = DEFAULT_SYSTEM_PROMPT;

  if (typeof param1 === 'string') {
    prompt = param1;
    if (typeof param2 === 'string') systemPrompt = param2;
  } else if (param1 && typeof param1 === 'object') {
    prompt = param1.prompt || '';
    if (param1.systemPrompt) systemPrompt = param1.systemPrompt;
  }

  if (!prompt || !prompt.trim()) {
    throw new Error('Prompt teks Gemini tidak boleh kosong.');
  }

  const requestBody = {
    contents: [
      {
        role: 'user',
        parts: [{ text: prompt.trim() }]
      }
    ],
    systemInstruction: {
      parts: [{ text: systemPrompt }]
    },
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 1000,
      topP: 0.85
    }
  };

  const payload = JSON.stringify(requestBody);
  return await executeWithModelFallback(payload, TIMEOUT_TEKS_MS, 'teks');
}

/**
 * Send image + text prompt to Gemini Vision AI.
 * @param {string|Object} param1 - Prompt teks atau object opsi
 * @param {Buffer} [param2] - Buffer gambar jika param1 berupa string
 * @param {string} [param3] - mimeType jika param1 berupa string
 * @param {string} [param4] - systemPrompt opsional
 * @returns {Promise<string>}
 */
export async function askGeminiVision(param1, param2, param3, param4) {
  let prompt = 'Jelaskan atau analisis gambar ini dengan jelas dan ringkas.';
  let imageBuffer = null;
  let mimeType = 'image/jpeg';
  let systemPrompt = DEFAULT_SYSTEM_PROMPT;

  if (param1 && typeof param1 === 'object' && !Buffer.isBuffer(param1)) {
    prompt = param1.prompt || prompt;
    imageBuffer = param1.imageBuffer;
    mimeType = param1.mimeType || mimeType;
    systemPrompt = param1.systemPrompt || systemPrompt;
  } else {
    prompt = typeof param1 === 'string' && param1.trim() ? param1.trim() : prompt;
    imageBuffer = param2;
    mimeType = param3 || mimeType;
    systemPrompt = param4 || systemPrompt;
  }

  if (!imageBuffer || !Buffer.isBuffer(imageBuffer)) {
    throw new Error('Buffer gambar untuk Gemini Vision tidak valid.');
  }

  const base64Data = imageBuffer.toString('base64');

  const requestBody = {
    contents: [
      {
        role: 'user',
        parts: [
          {
            inlineData: {
              mimeType,
              data: base64Data
            }
          },
          { text: prompt }
        ]
      }
    ],
    systemInstruction: {
      parts: [{ text: systemPrompt }]
    },
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 1000
    }
  };

  const payload = JSON.stringify(requestBody);
  return await executeWithModelFallback(payload, TIMEOUT_MEDIA_MS, 'gambar');
}

/**
 * Ekstrak teks dari gambar/dokumen dengan Gemini OCR
 */
export async function askGeminiOCR(param1, param2) {
  let imageBuffer = null;
  let mimeType = 'image/jpeg';

  if (param1 && typeof param1 === 'object' && !Buffer.isBuffer(param1)) {
    imageBuffer = param1.imageBuffer;
    mimeType = param1.mimeType || mimeType;
  } else {
    imageBuffer = param1;
    mimeType = param2 || mimeType;
  }

  if (!imageBuffer || !Buffer.isBuffer(imageBuffer)) {
    throw new Error('Buffer dokumen/gambar untuk Gemini OCR tidak valid.');
  }

  const base64Data = imageBuffer.toString('base64');
  const systemPrompt = 'Kamu adalah bot OCR murni. Tugasmu hanya menyalin semua teks persis seperti yang tertulis di dalam dokumen atau gambar yang diberikan. JANGAN memberikan kata pembuka, penutup, atau komentar apa pun. HANYA teks mentahnya saja.';

  const requestBody = {
    contents: [
      {
        role: 'user',
        parts: [
          {
            inlineData: {
              mimeType,
              data: base64Data
            }
          },
          { text: 'Ekstrak seluruh teks dari dokumen/gambar ini tanpa menambahkan komentar.' }
        ]
      }
    ],
    systemInstruction: {
      parts: [{ text: systemPrompt }]
    },
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 2500
    }
  };

  const payload = JSON.stringify(requestBody);
  return await executeWithModelFallback(payload, TIMEOUT_MEDIA_MS, 'dokumen');
}

/**
 * Transkripsikan audio/voice note ke teks dengan Gemini AI.
 * @param {Object|Buffer} param1
 * @param {string} [param2]
 * @returns {Promise<string>}
 */
export async function askGeminiAudioTranscription(param1, param2) {
  let audioBuffer = null;
  let mimeType = 'audio/ogg';

  if (param1 && typeof param1 === 'object' && !Buffer.isBuffer(param1)) {
    audioBuffer = param1.audioBuffer;
    mimeType = param1.mimeType || mimeType;
  } else {
    audioBuffer = param1;
    mimeType = param2 || mimeType;
  }

  if (!audioBuffer || !Buffer.isBuffer(audioBuffer)) {
    throw new Error('Buffer audio untuk transkripsi Gemini tidak valid.');
  }

  const cleanMime = (mimeType || 'audio/ogg').split(';')[0].trim();
  const base64Data = audioBuffer.toString('base64');
  const systemPrompt = 'Kamu adalah asisten transkripsi audio profesional. Dengarkan audio atau voice note yang diberikan dan tuliskan teks transkripnya secara persis, akurat, dan rapi dalam Bahasa Indonesia. JANGAN menambahkan kata pembuka, penutup, salam, atau komentar apa pun. HANYA teks transkripsi audionya saja.';

  const requestBody = {
    contents: [
      {
        role: 'user',
        parts: [
          {
            inlineData: {
              mimeType: cleanMime,
              data: base64Data
            }
          },
          { text: 'Transkripsikan isi rekaman suara ini ke dalam teks lengkap secara persis.' }
        ]
      }
    ],
    systemInstruction: {
      parts: [{ text: systemPrompt }]
    },
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 2000
    }
  };

  const payload = JSON.stringify(requestBody);
  return await executeWithModelFallback(payload, TIMEOUT_MEDIA_MS, 'audio');
}

