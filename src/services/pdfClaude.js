/**
 * PDF 重複検出・テキスト抽出・Claude API 呼び出しを集約したモジュール。
 * Token 節約・重複検出・プロンプト変更はこのファイルのみ編集すればよい。
 */

// --- Token 関連定数（改修時はここを変更） ---
const CLAUDE_MAX_TOKENS = 256;
const CLAUDE_PROMPT = `JSONのみ。説明不要。
{"statementDate":"YYYY-MM-DD or null","items":[{"rawName":"","quantity":num or null,"unitPrice":num or null,"isOriginalArtwork":bool}]}
原画・一点物→isOriginalArtwork:true。不明→null。`;

// テキスト送信時のプレフィックス（短くして Token 節約）
const TEXT_PREFIX = "精算書:\n\n";

// ============================================================
// PDF.js dynamic loader
// ============================================================
let pdfJsReady = false;
export async function ensurePdfJs() {
  if (pdfJsReady) return;
  await new Promise((resolve, reject) => {
    if (typeof window !== "undefined" && window["pdfjs-dist/build/pdf"]) {
      pdfJsReady = true;
      resolve();
      return;
    }
    const script = document.createElement("script");
    script.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
    script.onload = () => {
      window["pdfjs-dist/build/pdf"].GlobalWorkerOptions.workerSrc =
        "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
      pdfJsReady = true;
      resolve();
    };
    script.onerror = reject;
    document.head.appendChild(script);
  });
}

// ============================================================
// PDF 重複検出（ファイルハッシュ）
// ============================================================
export async function hashFile(file) {
  const buf = await file.arrayBuffer();
  const hashBuf = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** 既存精算書と同一ファイル（ハッシュ一致）なら true */
export async function isDuplicatePdf(file, statements) {
  if (!statements?.length) return false;
  const fileHash = await hashFile(file);
  return statements.some((s) => s.fileHash === fileHash);
}

/** 重複チェック + fileHash を1回のハッシュで取得（Token/API 呼び出し前の早期スキップ用） */
export async function getPdfUploadInfo(file, statements) {
  const fileHash = await hashFile(file);
  const isDuplicate = statements?.length
    ? statements.some((s) => s.fileHash === fileHash)
    : false;
  return { fileHash, isDuplicate };
}

// ============================================================
// PDF テキスト抽出
// ============================================================
export async function extractTextFromPDF(file) {
  try {
    await ensurePdfJs();
    const pdfjsLib = window["pdfjs-dist/build/pdf"];
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    let text = "";
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      text += content.items.map((s) => s.str).join(" ") + "\n";
    }
    return { text, isScanned: text.trim().length < 50 };
  } catch (err) {
    console.warn("PDF.js extraction failed:", err);
    return { text: "", isScanned: true };
  }
}

// ============================================================
// Claude 送信内容の組み立て（Token 節約）
// テキスト抽出済みのときはテキストのみ送信し、スキャン時のみ PDF を送る。
// ============================================================
async function buildContent(extractedText, isScanned, pdfFile) {
  if (isScanned) {
    const b64 = await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = (e) => res(e.target.result.split(",")[1]);
      r.onerror = rej;
      r.readAsDataURL(pdfFile);
    });
    return [
      {
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: b64 },
      },
      { type: "text", text: CLAUDE_PROMPT },
    ];
  }
  // テキストのみ送信（Token 節約・高速）
  return [
    {
      type: "text",
      text: `${TEXT_PREFIX}${extractedText}\n\n${CLAUDE_PROMPT}`,
    },
  ];
}

// ============================================================
// Claude API で精算書から JSON 抽出
// ============================================================
export async function extractDataWithClaude(pdfFile, extractedText, isScanned) {
  const content = await buildContent(extractedText, isScanned, pdfFile);

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.REACT_APP_ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: CLAUDE_MAX_TOKENS,
      messages: [{ role: "user", content }],
    }),
  });

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error(`API エラー ${res.status}: ${errBody?.error?.message || res.statusText}`);
  }

  const data = await res.json();
  if (data.error) {
    throw new Error(`Claude API: ${data.error.message}`);
  }

  const rawText = data.content?.map((c) => c.text || "").join("") ?? "";
  const clean = rawText.replace(/```json|```/g, "").trim();
  const match = clean.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error(`解析結果を取得できませんでした。レスポンス: ${rawText.slice(0, 100)}`);
  }
  return JSON.parse(match[0]);
}
