/**
 * Gemini AI Assistant & Vision Service
 * Uses Google Gemini REST API (gemini-1.5-flash) with low temperature (0.2)
 * and strict system prompt guardrails for concise, accurate WhatsApp responses.
 */
import https from 'https';

const DEFAULT_SYSTEM_PROMPT = `Kamu adalah Asisten AI Pintar WhatsApp yang ramah, sopan, akurat, dan serba tahu.
Aturan Penting:
1. Jawablah pertanyaan pengguna dengan Bahasa Indonesia yang baik, ramah, dan tepat sasaran.
2. Format jawaban secara ringkas dan rapi khas WhatsApp (gunakan *bold*, _italic_, bullet points). Jangan memberikan jawaban yang terlalu panjang membosankan kecuali diminta detail.
3. Jangan mengarang atau memberikan informasi palsu. Jika tidak tahu, katakan sejujurnya.
4. Jangan menyertakan tag HTML atau format markdown aneh yang tidak didukung WhatsApp.`;

function getApiKey() {
  return process.env.GEMINI_API_KEY || '';
}

/**
 * Send text prompt to Gemini AI.
 * @param {string} prompt
 * @param {string} customSystemPrompt
 * @returns {Promise<string>}
 */
export async function askGeminiText({ prompt, systemPrompt = DEFAULT_SYSTEM_PROMPT }) {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY belum dikonfigurasi di file .env');
  }

  const requestBody = {
    contents: [
      {
        role: 'user',
        parts: [{ text: prompt }]
      }
    ],
    systemInstruction: {
      parts: [{ text: systemPrompt }]
    },
    generationConfig: {
      temperature: 0.2,       // Low temperature for deterministic, factual, concise responses
      maxOutputTokens: 600,  // Compact WhatsApp length
      topP: 0.8,
      topK: 40
    }
  };

  const payload = JSON.stringify(requestBody);

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
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
          if (!replyText) {
            return reject(new Error('Gemini API mengembalikan respons kosong.'));
          }
          resolve(replyText.trim());
        } catch (e) {
          reject(new Error(`Gagal memproses JSON Gemini API: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/**
 * Send image + text prompt to Gemini Vision AI.
 * @param {string} prompt
 * @param {Buffer} imageBuffer
 * @param {string} mimeType - e.g. 'image/jpeg', 'image/png'
 * @param {string} customSystemPrompt
 * @returns {Promise<string>}
 */
export async function askGeminiVision({ prompt = 'Jelaskan atau analisis gambar ini dengan jelas dan ringkas.', imageBuffer, mimeType = 'image/jpeg', systemPrompt = DEFAULT_SYSTEM_PROMPT }) {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY belum dikonfigurasi di file .env');
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
      temperature: 0.2,
      maxOutputTokens: 600
    }
  };

  const payload = JSON.stringify(requestBody);

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
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
            return reject(new Error(`Gemini Vision API Error (${res.statusCode}): ${errDetails}`));
          }
          const replyText = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
          if (!replyText) {
            return reject(new Error('Gemini Vision API mengembalikan respons kosong.'));
          }
          resolve(replyText.trim());
        } catch (e) {
          reject(new Error(`Gagal memproses JSON Gemini Vision: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}


export async function askGeminiOCR({ imageBuffer, mimeType = 'image/jpeg' }) {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY belum dikonfigurasi di file .env');
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
      maxOutputTokens: 2000
    }
  };

  const payload = JSON.stringify(requestBody);

  return new Promise((resolve, reject) => {
    // Menggunakan gemini-1.5-pro untuk hasil bacaan dokumen yang jauh lebih baik (Premium Feature)
    const req = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/gemini-1.5-pro:generateContent?key=${apiKey}`,
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
            return reject(new Error(`Gemini OCR API Error (${res.statusCode}): ${errDetails}`));
          }
          const replyText = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
          if (!replyText) {
            return reject(new Error('Gemini OCR tidak menemukan teks apa pun.'));
          }
          resolve(replyText.trim());
        } catch (e) {
          reject(new Error(`Gagal memproses JSON Gemini OCR: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}
