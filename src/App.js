import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import {
  getPdfUploadInfo,
  extractTextFromPDF,
  extractDataWithClaude,
} from "./services/pdfClaude";

// ============================================================
// STORAGE HELPERS
// ============================================================
const STORAGE_KEY = "inventory_v1";
function loadData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function saveData(data) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch {}
}

function initState() {
  const saved = loadData();
  if (saved) return saved;
  return { products: [], saleRecords: [], statements: [] };
}

function uuid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// ============================================================
// SIMILARITY (simple Levenshtein)
// ============================================================
function similarity(a, b) {
  const s1 = a.toLowerCase().replace(/[\s　・·]/g, "");
  const s2 = b.toLowerCase().replace(/[\s　・·]/g, "");
  if (s1 === s2) return 1;
  const longer = s1.length > s2.length ? s1 : s2;
  const shorter = s1.length > s2.length ? s2 : s1;
  if (longer.length === 0) return 1;
  const dist = levenshtein(longer, shorter);
  return (longer.length - dist) / longer.length;
}
function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[a.length][b.length];
}

// ============================================================
// DATE HELPERS
// ============================================================
function thisYear() {
  const y = new Date().getFullYear();
  return { from: `${y}-01-01`, to: `${y}-12-31` };
}
function fmtDate(d) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("ja-JP", { year: "numeric", month: "short", day: "numeric" });
}
function fmtNum(n) { return n?.toLocaleString("ja-JP") ?? "—"; }

// ============================================================
// MAIN APP
// ============================================================
export default function App() {
  const [dark, setDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
  const [page, setPage] = useState("dashboard");
  const [db, setDb] = useState(initState);
  const [period, setPeriod] = useState(thisYear);
  const [search, setSearch] = useState("");
  const [sortCol, setSortCol] = useState("totalAmount");
  const [sortDir, setSortDir] = useState("desc");

  // Upload state
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState("");
  const [extractedItems, setExtractedItems] = useState(null); // pending confirmation
  const [pendingStatement, setPendingStatement] = useState(null);
  const [mergeProposals, setMergeProposals] = useState([]);

  // Manual add
  const [showManual, setShowManual] = useState(false);
  const [manualForm, setManualForm] = useState({ name: "", quantity: "", unitPrice: "", date: "" });

  // Notify
  const [toast, setToast] = useState(null);

  const fileInputRef = useRef();

  useEffect(() => { saveData(db); }, [db]);

  function showToast(msg, type = "success") {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  }

  function deleteProduct(productId) {
    setDb((prev) => ({
      ...prev,
      products: prev.products.filter((p) => p.id !== productId),
      saleRecords: prev.saleRecords.filter((r) => r.productId !== productId),
    }));
    showToast("商品を削除しました");
  }

  // ---- COMPUTED ----
  const filteredRecords = useMemo(() => {
    return db.saleRecords.filter((r) => {
      if (!r.saleDate) return true;
      const d = r.saleDate;
      return d >= period.from && d <= period.to;
    });
  }, [db.saleRecords, period]);

  const productStats = useMemo(() => {
    const map = {};
    for (const r of filteredRecords) {
      if (!map[r.productId]) {
        const prod = db.products.find((p) => p.id === r.productId);
        if (!prod || prod.isExcluded) continue;
        map[r.productId] = { product: prod, quantity: 0, amount: 0, lastDate: null };
      }
      map[r.productId].quantity += r.quantity || 0;
      map[r.productId].amount += (r.quantity || 0) * (r.unitPrice || 0);
      if (r.saleDate && (!map[r.productId].lastDate || r.saleDate > map[r.productId].lastDate))
        map[r.productId].lastDate = r.saleDate;
    }
    let arr = Object.values(map);
    arr = arr.filter((x) => !search || x.product.canonicalName.includes(search));
    arr.sort((a, b) => {
      const av = sortCol === "name" ? a.product.canonicalName : sortCol === "quantity" ? a.quantity : a.amount;
      const bv = sortCol === "name" ? b.product.canonicalName : sortCol === "quantity" ? b.quantity : b.amount;
      return sortDir === "asc" ? (av > bv ? 1 : -1) : (av < bv ? 1 : -1);
    });
    return arr;
  }, [filteredRecords, db.products, search, sortCol, sortDir]);

  const totalAmount = productStats.reduce((s, x) => s + x.amount, 0);
  const totalQty = productStats.reduce((s, x) => s + x.quantity, 0);

  // ---- UPLOAD ----
  async function handleFiles(files) {
    if (!files.length) return;
    setUploading(true);
    for (const file of files) {
      if (!file.name.toLowerCase().endsWith(".pdf")) { showToast(`${file.name} はPDFではありません`, "error"); continue; }
      try {
        // ① PDF 重複チェック（API 呼び出し前にハッシュで判定 → Token 節約）
        setUploadProgress(`${file.name} の重複チェック中...`);
        const { fileHash, isDuplicate } = await getPdfUploadInfo(file, db.statements);
        if (isDuplicate) {
          showToast(`${file.name} はすでに登録済みです`, "error");
          continue;
        }

        setUploadProgress(`${file.name} を解析中...`);
        const { text, isScanned } = await extractTextFromPDF(file);
        setUploadProgress(`Claude APIで内容を読み取り中...`);
        const result = await extractDataWithClaude(file, text, isScanned);
        const stmt = { id: uuid(), fileName: file.name, fileHash, statementDate: result.statementDate, uploadedAt: new Date().toISOString(), extractionStatus: "completed" };
        setPendingStatement(stmt);
        // check merge proposals
        const proposals = [];
        for (const item of result.items || []) {
          if (item.isOriginalArtwork) continue;
          for (const p of db.products) {
            const sim = similarity(item.rawName, p.canonicalName);
            if (sim > 0.6 && sim < 1 && !p.aliases.includes(item.rawName)) {
              proposals.push({ rawName: item.rawName, existingId: p.id, existingName: p.canonicalName, sim, decision: null });
            }
          }
        }
        setMergeProposals(proposals);
        setExtractedItems(result.items.map((i) => ({ ...i, include: !i.isOriginalArtwork, _id: uuid() })));
      } catch (e) {
        showToast(`${file.name}: ${e.message}`, "error");
      }
    }
    setUploading(false);
    setUploadProgress("");
  }

  function confirmExtraction(items, stmt, merges) {
    // 深いコピーでミューテーション問題を回避
    const newDb = {
      statements: [...db.statements],
      saleRecords: [...db.saleRecords],
      products: db.products.map((p) => ({ ...p, aliases: [...p.aliases] })),
    };
    newDb.statements = [...newDb.statements, { ...stmt }];

    // resolve merge decisions
    const mergeMap = {};
    for (const m of merges) {
      if (m.decision === "merge") mergeMap[m.rawName] = m.existingId;
      else if (m.decision === "new") mergeMap[m.rawName] = null;
    }

    for (const item of items) {
      if (!item.include) continue;

      let existing = newDb.products.find(
        (p) => p.canonicalName === item.rawName || p.aliases.includes(item.rawName)
      );
      if (!existing && mergeMap[item.rawName] !== undefined && mergeMap[item.rawName]) {
        existing = newDb.products.find((p) => p.id === mergeMap[item.rawName]);
        if (existing && !existing.aliases.includes(item.rawName)) {
          existing.aliases = [...existing.aliases, item.rawName];
        }
      }

      let productId;
      if (existing) {
        productId = existing.id;
        if (item.unitPrice != null) existing.latestUnitPrice = item.unitPrice;
      } else {
        const newProd = {
          id: uuid(),
          canonicalName: item.rawName,
          aliases: [],
          latestUnitPrice: item.unitPrice ?? null,
          isExcluded: false,
          createdAt: new Date().toISOString(),
        };
        newDb.products = [...newDb.products, newProd];
        productId = newProd.id;
      }

      newDb.saleRecords = [
        ...newDb.saleRecords,
        {
          id: uuid(),
          productId,
          statementId: stmt.id,
          quantity: item.quantity ?? 0,
          unitPrice: item.unitPrice ?? 0,
          saleDate: stmt.statementDate,
          source: "pdf",
        },
      ];
    }

    setDb(newDb);
    setExtractedItems(null);
    setPendingStatement(null);
    setMergeProposals([]);
    setPage("dashboard");
    showToast("精算書を登録しました");
  }

  function addManual() {
    if (!manualForm.name || !manualForm.quantity) { showToast("商品名と数量は必須です", "error"); return; }
    const newDb = {
      statements: [...db.statements],
      saleRecords: [...db.saleRecords],
      products: db.products.map((p) => ({ ...p, aliases: [...p.aliases] })),
    };
    let existing = newDb.products.find((p) => p.canonicalName === manualForm.name || p.aliases.includes(manualForm.name));
    let productId;
    if (existing) {
      productId = existing.id;
      if (manualForm.unitPrice) existing.latestUnitPrice = Number(manualForm.unitPrice);
    } else {
      const np = { id: uuid(), canonicalName: manualForm.name, aliases: [], latestUnitPrice: Number(manualForm.unitPrice) || null, isExcluded: false, createdAt: new Date().toISOString() };
      newDb.products = [...newDb.products, np];
      productId = np.id;
    }
    const record = { id: uuid(), productId, statementId: null, quantity: Number(manualForm.quantity), unitPrice: Number(manualForm.unitPrice) || null, saleDate: manualForm.date || null, source: "manual" };
    newDb.saleRecords = [...newDb.saleRecords, record];
    setDb(newDb);
    setManualForm({ name: "", quantity: "", unitPrice: "", date: "" });
    setShowManual(false);
    showToast("手動で登録しました");
  }

  function deleteStatement(id) {
    setDb((prev) => ({
      ...prev,
      statements: prev.statements.filter((s) => s.id !== id),
      saleRecords: prev.saleRecords.filter((r) => r.statementId !== id),
    }));
    showToast("精算書を削除しました");
  }

  function exportCSV() {
    const rows = [["商品名", "販売数量", "単価", "売上金額", "最終販売日", "登録元"]];
    for (const x of productStats) {
      const src = db.saleRecords.filter((r) => r.productId === x.product.id && filteredRecords.includes(r));
      const sources = [...new Set(src.map((r) => r.source))].join("/");
      rows.push([x.product.canonicalName, x.quantity, x.product.latestUnitPrice ?? "", x.amount, x.lastDate ?? "", sources]);
    }
    const csv = rows.map((r) => r.map((c) => `"${c}"`).join(",")).join("\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `売上集計_${period.from}_${period.to}.csv`; a.click();
  }

  // ---- STYLES ----
  const c = dark ? colors.dark : colors.light;

  return (
    <div style={{ minHeight: "100vh", background: c.bg, color: c.text, fontFamily: "'Noto Sans JP', 'Hiragino Sans', sans-serif", display: "flex", flexDirection: "column" }}>
      {/* Toast */}
      {toast && (
        <div style={{ position: "fixed", top: 20, right: 20, zIndex: 9999, background: toast.type === "error" ? c.danger : c.accent, color: c.bg, padding: "10px 18px", borderRadius: 10, fontSize: 13, fontWeight: 600, boxShadow: "0 4px 20px rgba(0,0,0,0.2)", animation: "fadeIn 0.2s ease" }}>
          {toast.msg}
        </div>
      )}

      {/* Extraction Dialog */}
      {extractedItems && (
        <ExtractionDialog
          items={extractedItems} setItems={setExtractedItems}
          statement={pendingStatement}
          mergeProposals={mergeProposals} setMergeProposals={setMergeProposals}
          onConfirm={confirmExtraction}
          onCancel={() => { setExtractedItems(null); setPendingStatement(null); setMergeProposals([]); }}
          c={c} dark={dark}
        />
      )}

      {/* Manual Add Dialog */}
      {showManual && (
        <div style={overlayStyle}>
          <div style={{ ...dialogStyle(c), width: 420 }}>
            <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 20, color: c.text }}>手動で商品を登録</div>
            {[["商品名 *", "name", "text"], ["販売数量 *", "quantity", "number"], ["単価（円）", "unitPrice", "number"], ["販売日", "date", "date"]].map(([label, key, type]) => (
              <div key={key} style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 12, color: c.muted, marginBottom: 4 }}>{label}</div>
                <input type={type} value={manualForm[key]} onChange={(e) => setManualForm((f) => ({ ...f, [key]: e.target.value }))}
                  style={{ ...inputStyle(c), width: "100%", boxSizing: "border-box" }} />
              </div>
            ))}
            <div style={{ display: "flex", gap: 10, marginTop: 20, justifyContent: "flex-end" }}>
              <button onClick={() => setShowManual(false)} style={btnSecondary(c)}>キャンセル</button>
              <button onClick={addManual} style={btnPrimary(c)}>登録する</button>
            </div>
          </div>
        </div>
      )}

      {/* Layout */}
      <div style={{ display: "flex", flex: 1 }}>
        {/* Sidebar */}
        <Sidebar page={page} setPage={setPage} dark={dark} setDark={setDark} c={c} stmtCount={db.statements.length} />

        {/* Main */}
        <main style={{ flex: 1, padding: "28px 32px", overflowY: "auto", maxWidth: "100%" }}>
          {page === "dashboard" && (
            <Dashboard
              c={c} period={period} setPeriod={setPeriod}
              productStats={productStats} totalAmount={totalAmount} totalQty={totalQty}
              search={search} setSearch={setSearch}
              sortCol={sortCol} setSortCol={setSortCol} sortDir={sortDir} setSortDir={setSortDir}
              onManual={() => setShowManual(true)}
              onExport={exportCSV}
              onUpload={() => setPage("upload")}
              onDeleteProduct={deleteProduct}
              saleRecords={db.saleRecords}
              statements={db.statements}
              productCount={db.products.filter(p => !p.isExcluded).length}
            />
          )}
          {page === "upload" && (
            <UploadPage
              c={c} uploading={uploading} uploadProgress={uploadProgress}
              onFiles={handleFiles} fileInputRef={fileInputRef}
              onBack={() => setPage("dashboard")}
            />
          )}
          {page === "statements" && (
            <StatementsPage c={c} statements={db.statements} saleRecords={db.saleRecords} products={db.products} onDelete={deleteStatement} />
          )}
          {page === "settings" && (
            <SettingsPage c={c} db={db} setDb={setDb} showToast={showToast} />
          )}
        </main>
      </div>

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;600;700&family=DM+Mono:wght@400;500&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        input, button, select { font-family: inherit; }
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #888; border-radius: 3px; }
        @keyframes fadeIn { from { opacity:0; transform:translateY(-6px); } to { opacity:1; transform:translateY(0); } }
        @keyframes spin { to { transform: rotate(360deg); } }
        @media (max-width: 768px) {
          .sidebar { display: none !important; }
          .mobile-nav { display: flex !important; }
          main { padding: 16px !important; }
        }
      `}</style>
    </div>
  );
}

// ============================================================
// SIDEBAR
// ============================================================
function Sidebar({ page, setPage, dark, setDark, c, stmtCount }) {
  const nav = [
    { id: "dashboard", label: "ダッシュボード" },
    { id: "upload", label: "精算書アップロード" },
    { id: "statements", label: "精算書一覧", badge: stmtCount },
    { id: "settings", label: "設定" },
  ];
  return (
    <aside className="sidebar" style={{ width: 220, background: c.sidebar, borderRight: `1px solid ${c.border}`, display: "flex", flexDirection: "column", padding: "20px 0", flexShrink: 0 }}>
      <div style={{ padding: "0 20px 24px", borderBottom: `1px solid ${c.border}` }}>
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.12em", color: c.accent, textTransform: "uppercase", marginBottom: 4 }}>ORITAKEI</div>
        <div style={{ fontSize: 18, fontWeight: 700, color: c.text, lineHeight: 1.2 }}>在庫管理</div>
      </div>
      <nav style={{ flex: 1, padding: "12px 0" }}>
        {nav.map((n) => (
          <button key={n.id} onClick={() => setPage(n.id)} style={{
            display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "10px 20px",
            background: page === n.id ? c.accentBg : "transparent",
            border: "none", cursor: "pointer", color: page === n.id ? c.accent : c.muted,
            fontSize: 13, fontWeight: page === n.id ? 700 : 400,
            borderLeft: `3px solid ${page === n.id ? c.accent : "transparent"}`,
            transition: "all 0.15s",
          }}>
            <span style={{ flex: 1, textAlign: "left" }}>{n.label}</span>
            {n.badge > 0 && <span style={{ background: c.accent, color: "#fff", borderRadius: 10, padding: "1px 7px", fontSize: 10, fontWeight: 700 }}>{n.badge}</span>}
          </button>
        ))}
      </nav>
      <div style={{ padding: "16px 20px", borderTop: `1px solid ${c.border}` }}>
        <button onClick={() => setDark(!dark)} style={{ display: "flex", alignItems: "center", gap: 8, background: "none", border: `1px solid ${c.border}`, borderRadius: 8, padding: "7px 12px", cursor: "pointer", color: c.muted, fontSize: 12, width: "100%" }}>
          <span>{dark ? "☀" : "☾"}</span>
          <span>{dark ? "ライトモード" : "ダークモード"}</span>
        </button>
      </div>
    </aside>
  );
}

// ============================================================
// DELETE BUTTON (inline confirm — no window.confirm)
// ============================================================
function DeleteButton({ onConfirm, c }) {
  const [confirming, setConfirming] = useState(false);
  if (confirming) {
    return (
      <div style={{ display: "flex", gap: 4, alignItems: "center", justifyContent: "center" }}>
        <button
          onClick={() => { onConfirm(); setConfirming(false); }}
          style={{ background: c.accent, color: c.bg, border: "none", borderRadius: 5, padding: "3px 9px", cursor: "pointer", fontSize: 11, fontWeight: 700 }}
        >確認</button>
        <button
          onClick={() => setConfirming(false)}
          style={{ background: "none", border: `1px solid ${c.border}`, borderRadius: 5, padding: "3px 9px", cursor: "pointer", color: c.muted, fontSize: 11 }}
        >×</button>
      </div>
    );
  }
  return (
    <button
      onClick={() => setConfirming(true)}
      style={{ background: "none", border: `1px solid ${c.border}`, borderRadius: 6, padding: "4px 10px", cursor: "pointer", color: c.muted, fontSize: 11, transition: "all 0.15s" }}
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = c.text; e.currentTarget.style.color = c.text; }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = c.border; e.currentTarget.style.color = c.muted; }}
    >削除</button>
  );
}

// ============================================================
// DASHBOARD
// ============================================================
const YEAR_MIN = 2000; // プルダウンに表示する最古の年

function Dashboard({ c, period, setPeriod, productStats, totalAmount, totalQty, search, setSearch, sortCol, setSortCol, sortDir, setSortDir, onManual, onExport, onUpload, onDeleteProduct, saleRecords, statements, productCount }) {
  const currentYear = new Date().getFullYear();
  const yearOptions = Array.from(
    { length: currentYear - YEAR_MIN + 1 },
    (_, i) => currentYear - i
  ); // [2026, 2025, 2024, ...]

  function toggleSort(col) {
    if (sortCol === col) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortCol(col); setSortDir("desc"); }
  }
  function SortIcon({ col }) {
    if (sortCol !== col) return <span style={{ color: c.muted, fontSize: 10 }}>⇅</span>;
    return <span style={{ color: c.accent, fontSize: 10 }}>{sortDir === "asc" ? "↑" : "↓"}</span>;
  }

  return (
    <div>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 24, flexWrap: "wrap", gap: 12 }}>
        <div>
          <div style={{ fontSize: 22, fontWeight: 700, color: c.text }}>売上ダッシュボード</div>
          <div style={{ fontSize: 13, color: c.muted, marginTop: 2 }}>{period.from} 〜 {period.to}</div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <button onClick={onUpload} style={{ display: "flex", alignItems: "center", gap: 6, background: c.accent, color: c.bg, border: "none", borderRadius: 8, padding: "8px 14px", cursor: "pointer", fontSize: 13, fontWeight: 700, boxShadow: `0 2px 8px rgba(0,0,0,0.18)` }}>
            <span style={{ fontSize: 15 }}>↑</span> 精算書をアップロード
          </button>
          <div style={{ width: 1, height: 24, background: c.border, margin: "0 2px" }} />
          <select
            value={period.from.slice(0, 4)}
            onChange={(e) => {
              const y = Number(e.target.value);
              setPeriod({ from: `${y}-01-01`, to: `${y}-12-31` });
            }}
            style={{ ...inputStyle(c), fontSize: 13, padding: "6px 12px", minWidth: 88 }}
          >
            {yearOptions.map((y) => (
              <option key={y} value={y}>{y}年</option>
            ))}
          </select>
        </div>
      </div>

      {/* Summary Cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 14, marginBottom: 28 }}>
        {[
          { label: "総売上金額", value: `¥${fmtNum(totalAmount)}`, sub: "期間合計", icon: "¥" },
          { label: "総販売点数", value: `${fmtNum(totalQty)} 点`, sub: "期間合計", icon: "#" },
          { label: "登録商品数", value: `${productCount} 種`, sub: "在庫管理対象", icon: "◻" },
        ].map((card) => (
          <div key={card.label} style={{ background: c.card, border: `1px solid ${c.border}`, borderRadius: 14, padding: "18px 22px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
              <div style={{ fontSize: 12, color: c.muted, fontWeight: 500 }}>{card.label}</div>
              <div style={{ fontSize: 18, color: c.accentLight, fontFamily: "'DM Mono', monospace" }}>{card.icon}</div>
            </div>
            <div style={{ fontSize: 26, fontWeight: 700, color: c.text, marginTop: 8, fontFamily: "'DM Mono', monospace", letterSpacing: "-0.02em" }}>{card.value}</div>
            <div style={{ fontSize: 11, color: c.muted, marginTop: 4 }}>{card.sub}</div>
          </div>
        ))}
      </div>

      {/* Table Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: c.text }}>商品別 売上リスト</div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <div style={{ position: "relative" }}>
            <span style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: c.muted, display: "flex", alignItems: "center", pointerEvents: "none" }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.7 }}>
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.35-4.35" />
              </svg>
            </span>
            <input placeholder="商品名で検索..." value={search} onChange={(e) => setSearch(e.target.value)}
              style={{ ...inputStyle(c), paddingLeft: 34, width: 180, fontSize: 12 }} />
          </div>
          <button onClick={onManual} style={btnSecondary(c)}>＋ 手動追加</button>
          <button onClick={onExport} style={btnSecondary(c)}>↓ CSV</button>
        </div>
      </div>

      {/* Table */}
      <div style={{ background: c.card, border: `1px solid ${c.border}`, borderRadius: 14, overflow: "hidden" }}>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${c.border}` }}>
                {[
                  { col: "name", label: "商品名", align: "left" },
                  { col: "quantity", label: "販売数量", align: "right" },
                  { col: null, label: "単価", align: "right" },
                  { col: "totalAmount", label: "売上金額", align: "right" },
                  { col: null, label: "最終販売日", align: "right" },
                  { col: null, label: "登録元", align: "center" },
                ].map((h) => (
                  <th key={h.label} onClick={h.col ? () => toggleSort(h.col) : undefined}
                    style={{ padding: "12px 16px", textAlign: h.align, color: c.muted, fontWeight: 600, fontSize: 11, letterSpacing: "0.05em", textTransform: "uppercase", cursor: h.col ? "pointer" : "default", whiteSpace: "nowrap", background: c.tableHead }}>
                    {h.label} {h.col && <SortIcon col={h.col} />}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {productStats.length === 0 ? (
                <tr><td colSpan={6} style={{ padding: "48px 16px", textAlign: "center" }}>
                  <div style={{ color: c.muted, fontSize: 13, marginBottom: 14 }}>データがありません。精算書をアップロードするか、手動で商品を追加してください。</div>
                  <button onClick={onUpload} style={{ background: c.accent, color: c.bg, border: "none", borderRadius: 8, padding: "9px 20px", cursor: "pointer", fontSize: 13, fontWeight: 700 }}>
                    ↑ 精算書をアップロードする
                  </button>
                </td></tr>
              ) : productStats.map((x, i) => {
                const srcs = [...new Set(saleRecords.filter((r) => r.productId === x.product.id).map((r) => r.source))];
                return (
                  <tr key={x.product.id} style={{ borderBottom: `1px solid ${c.border}`, background: i % 2 === 0 ? "transparent" : c.rowAlt, transition: "background 0.1s" }}
                    onMouseEnter={(e) => e.currentTarget.style.background = c.rowHover}
                    onMouseLeave={(e) => e.currentTarget.style.background = i % 2 === 0 ? "transparent" : c.rowAlt}>
                    <td style={{ padding: "13px 16px", fontWeight: 600, color: c.text }}>{x.product.canonicalName}</td>
                    <td style={{ padding: "13px 16px", textAlign: "right", fontFamily: "'DM Mono', monospace", color: c.text }}>{fmtNum(x.quantity)}</td>
                    <td style={{ padding: "13px 16px", textAlign: "right", fontFamily: "'DM Mono', monospace", color: c.muted }}>¥{fmtNum(x.product.latestUnitPrice)}</td>
                    <td style={{ padding: "13px 16px", textAlign: "right", fontFamily: "'DM Mono', monospace", fontWeight: 700, color: c.accent }}>¥{fmtNum(x.amount)}</td>
                    <td style={{ padding: "13px 16px", textAlign: "right", color: c.muted, fontSize: 12 }}>{fmtDate(x.lastDate)}</td>
                    <td style={{ padding: "13px 16px", textAlign: "center" }}>
                      {srcs.map((s) => (
                        <span key={s} style={{ background: s === "pdf" ? c.accentBg : c.mutedBg, color: s === "pdf" ? c.accent : c.muted, fontSize: 10, fontWeight: 700, borderRadius: 5, padding: "2px 7px", marginLeft: 3 }}>
                          {s === "pdf" ? "PDF" : "手動"}
                        </span>
                      ))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            {productStats.length > 0 && (
              <tfoot>
                <tr style={{ borderTop: `2px solid ${c.border}`, background: c.tableHead }}>
                  <td style={{ padding: "12px 16px", fontWeight: 700, color: c.text }}>合計</td>
                  <td style={{ padding: "12px 16px", textAlign: "right", fontFamily: "'DM Mono', monospace", fontWeight: 700, color: c.text }}>{fmtNum(totalQty)}</td>
                  <td />
                  <td style={{ padding: "12px 16px", textAlign: "right", fontFamily: "'DM Mono', monospace", fontWeight: 700, color: c.accent }}>¥{fmtNum(totalAmount)}</td>
                  <td /><td />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>

      {/* Uploaded PDFs */}
      <div style={{ marginTop: 28 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: c.text, marginBottom: 12 }}>アップロード済み精算書</div>
        {statements.length === 0 ? (
          <div style={{ background: c.card, border: `1px solid ${c.border}`, borderRadius: 12, padding: "20px 24px", color: c.muted, fontSize: 13 }}>
            まだ精算書がアップロードされていません
          </div>
        ) : (
          <div style={{ background: c.card, border: `1px solid ${c.border}`, borderRadius: 12, overflow: "hidden" }}>
            {statements.map((s, i) => (
              <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 18px", borderBottom: i < statements.length - 1 ? `1px solid ${c.border}` : "none" }}>
                <span style={{ fontSize: 15, color: c.muted, flexShrink: 0 }}>📄</span>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: c.text }}>{s.fileName}</div>
                  <div style={{ fontSize: 11, color: c.muted, marginTop: 2 }}>
                    アップロード日時: {s.uploadedAt ? new Date(s.uploadedAt).toLocaleString("ja-JP", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—"}
                    {s.statementDate && <span style={{ marginLeft: 12 }}>精算日: {fmtDate(s.statementDate)}</span>}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================
// UPLOAD PAGE
// ============================================================
function UploadPage({ c, uploading, uploadProgress, onFiles, fileInputRef, onBack }) {
  const [dragging, setDragging] = useState(false);
  function onDrop(e) { e.preventDefault(); setDragging(false); onFiles([...e.dataTransfer.files]); }
  return (
    <div>
      <button onClick={onBack} style={{ display: "flex", alignItems: "center", gap: 5, background: "none", border: "none", cursor: "pointer", color: c.muted, fontSize: 13, marginBottom: 16, padding: 0 }}
        onMouseEnter={(e) => e.currentTarget.style.color = c.text}
        onMouseLeave={(e) => e.currentTarget.style.color = c.muted}>
        ← ダッシュボードに戻る
      </button>
      <div style={{ fontSize: 22, fontWeight: 700, color: c.text, marginBottom: 8 }}>精算書アップロード</div>
      <div style={{ fontSize: 13, color: c.muted, marginBottom: 28 }}>PDFをアップロードするとClaudeが自動で内容を解析します。デジタル・スキャン両方に対応しています。</div>

      <div onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => !uploading && fileInputRef.current?.click()}
        style={{ border: `2px dashed ${dragging ? c.accent : c.border}`, borderRadius: 16, padding: "64px 32px", textAlign: "center", cursor: uploading ? "default" : "pointer", background: dragging ? c.accentBg : c.card, transition: "all 0.2s" }}>
        {uploading ? (
          <div>
            <div style={{ fontSize: 32, marginBottom: 12, animation: "spin 1s linear infinite", display: "inline-block" }}>⟳</div>
            <div style={{ fontSize: 15, fontWeight: 600, color: c.text, marginBottom: 6 }}>解析中...</div>
            <div style={{ fontSize: 12, color: c.muted }}>{uploadProgress}</div>
          </div>
        ) : (
          <div>
            <div style={{ fontSize: 48, marginBottom: 12 }}>↑</div>
            <div style={{ fontSize: 16, fontWeight: 700, color: c.text, marginBottom: 8 }}>PDFをドラッグ＆ドロップ</div>
            <div style={{ fontSize: 13, color: c.muted, marginBottom: 16 }}>または クリックしてファイルを選択</div>
            <div style={{ fontSize: 12, color: c.muted }}>複数ファイルの一括アップロード対応 · PDF形式のみ</div>
          </div>
        )}
      </div>
      <input ref={fileInputRef} type="file" accept=".pdf" multiple style={{ display: "none" }} onChange={(e) => onFiles([...e.target.files])} />

      <div style={{ marginTop: 24, background: c.card, border: `1px solid ${c.border}`, borderRadius: 12, padding: "16px 20px" }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: c.text, marginBottom: 10 }}>抽出する情報</div>
        {[["精算日", "精算書に記載された日付"], ["商品名", "表記揺れは自動で検出・統合"], ["販売数量", "個数・点数など"], ["販売単価", "商品ごとの単価"]].map(([k, v]) => (
          <div key={k} style={{ display: "flex", gap: 12, marginBottom: 6, alignItems: "flex-start" }}>
            <span style={{ color: c.accent, fontWeight: 700, fontSize: 12, minWidth: 72 }}>{k}</span>
            <span style={{ fontSize: 12, color: c.muted }}>{v}</span>
          </div>
        ))}
        <div style={{ marginTop: 12, padding: "10px 12px", background: c.warningBg, borderRadius: 8, fontSize: 12, color: c.warningText, border: `1px solid ${c.warningBorder}` }}>
          ⚠ 原画・原作品など一点物は在庫集計から自動除外されます
        </div>
      </div>
    </div>
  );
}

// ============================================================
// EXTRACTION DIALOG
// ============================================================
function ExtractionDialog({ items, setItems, statement, mergeProposals, setMergeProposals, onConfirm, onCancel, c, dark }) {
  const unresolvedMerge = mergeProposals.some((m) => m.decision === null);
  const step = mergeProposals.length > 0 && unresolvedMerge ? "merge" : "confirm";

  return (
    <div style={overlayStyle}>
      <div style={{ ...dialogStyle(c), width: "min(680px, 95vw)", maxHeight: "85vh", display: "flex", flexDirection: "column" }}>
        <div style={{ fontSize: 17, fontWeight: 700, color: c.text, marginBottom: 4 }}>
          {step === "merge" ? "商品名の統合確認" : "抽出結果の確認"}
        </div>
        <div style={{ fontSize: 12, color: c.muted, marginBottom: 16 }}>
          {step === "merge" ? "既存の商品と似た名前が見つかりました。同一商品として統合しますか？" : `${statement?.fileName} から ${items.length} 件の商品情報が抽出されました。`}
        </div>

        <div style={{ overflowY: "auto", flex: 1 }}>
          {step === "merge" ? (
            mergeProposals.map((m, i) => (
              <div key={i} style={{ background: c.bg, border: `1px solid ${c.border}`, borderRadius: 10, padding: "14px 16px", marginBottom: 10 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: c.text }}>「{m.rawName}」</div>
                    <div style={{ fontSize: 12, color: c.muted, marginTop: 2 }}>既存: 「{m.existingName}」 （類似度 {Math.round(m.sim * 100)}%）</div>
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={() => setMergeProposals((prev) => prev.map((x, j) => j === i ? { ...x, decision: "merge" } : x))}
                    style={{ ...btnSmall(c), background: m.decision === "merge" ? c.accent : c.card, color: m.decision === "merge" ? "#fff" : c.text, flex: 1 }}>
                    ✓ 同一商品として統合
                  </button>
                  <button onClick={() => setMergeProposals((prev) => prev.map((x, j) => j === i ? { ...x, decision: "new" } : x))}
                    style={{ ...btnSmall(c), background: m.decision === "new" ? c.danger : c.card, color: m.decision === "new" ? "#fff" : c.text, flex: 1 }}>
                    ✗ 別商品として登録
                  </button>
                </div>
              </div>
            ))
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: `1px solid ${c.border}` }}>
                  {["登録", "商品名", "数量", "単価", "備考"].map((h) => (
                    <th key={h} style={{ padding: "8px 12px", textAlign: "left", color: c.muted, fontWeight: 600, fontSize: 11, textTransform: "uppercase" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {items.map((item, i) => (
                  <tr key={item._id} style={{ borderBottom: `1px solid ${c.border}`, opacity: item.include ? 1 : 0.4 }}>
                    <td style={{ padding: "10px 12px" }}>
                      <input type="checkbox" checked={item.include} onChange={(e) => setItems((prev) => prev.map((x, j) => j === i ? { ...x, include: e.target.checked } : x))} />
                    </td>
                    <td style={{ padding: "10px 12px" }}>
                      <input value={item.rawName} onChange={(e) => setItems((prev) => prev.map((x, j) => j === i ? { ...x, rawName: e.target.value } : x))}
                        style={{ ...inputStyle(c), width: "100%", fontSize: 12 }} />
                    </td>
                    <td style={{ padding: "10px 12px" }}>
                      <input type="number" value={item.quantity ?? ""} onChange={(e) => setItems((prev) => prev.map((x, j) => j === i ? { ...x, quantity: Number(e.target.value) } : x))}
                        style={{ ...inputStyle(c), width: 70, fontSize: 12 }} />
                    </td>
                    <td style={{ padding: "10px 12px" }}>
                      <input type="number" value={item.unitPrice ?? ""} onChange={(e) => setItems((prev) => prev.map((x, j) => j === i ? { ...x, unitPrice: Number(e.target.value) } : x))}
                        style={{ ...inputStyle(c), width: 90, fontSize: 12 }} />
                    </td>
                    <td style={{ padding: "10px 12px" }}>
                      {item.isOriginalArtwork && <span style={{ background: "#FEF3C7", color: "#92400E", fontSize: 10, fontWeight: 700, borderRadius: 4, padding: "2px 6px" }}>原画・除外</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div style={{ display: "flex", gap: 10, marginTop: 20, justifyContent: "flex-end", paddingTop: 16, borderTop: `1px solid ${c.border}` }}>
          <button onClick={onCancel} style={btnSecondary(c)}>キャンセル</button>
          {step === "merge" ? (
            <button onClick={() => setMergeProposals((prev) => prev.map((m) => ({ ...m, decision: m.decision ?? "new" })))}
              style={btnPrimary(c)}>次へ →</button>
          ) : (
            <button onClick={() => onConfirm(items, statement, mergeProposals)} style={btnPrimary(c)}>
              {items.filter((i) => i.include).length} 件を登録する
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================================
// STATEMENTS PAGE
// ============================================================
function StatementsPage({ c, statements, saleRecords, products, onDelete }) {
  return (
    <div>
      <div style={{ fontSize: 22, fontWeight: 700, color: c.text, marginBottom: 8 }}>精算書一覧</div>
      <div style={{ fontSize: 13, color: c.muted, marginBottom: 24 }}>アップロード済みの精算書と登録されたデータを管理します。</div>
      {statements.length === 0 ? (
        <div style={{ background: c.card, border: `1px solid ${c.border}`, borderRadius: 14, padding: "48px 32px", textAlign: "center", color: c.muted }}>
          まだ精算書がアップロードされていません
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {statements.map((s) => {
            const recs = saleRecords.filter((r) => r.statementId === s.id);
            const prodNames = [...new Set(recs.map((r) => products.find((p) => p.id === r.productId)?.canonicalName).filter(Boolean))];
            return (
              <div key={s.id} style={{ background: c.card, border: `1px solid ${c.border}`, borderRadius: 12, padding: "16px 20px", display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 700, fontSize: 14, color: c.text, marginBottom: 4 }}>📄 {s.fileName}</div>
                  <div style={{ fontSize: 12, color: c.muted, marginBottom: 6 }}>
                    精算日: {fmtDate(s.statementDate)} · アップロード: {fmtDate(s.uploadedAt?.slice(0, 10))} · {recs.length} 件のレコード
                  </div>
                  {prodNames.length > 0 && (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                      {prodNames.map((n) => <span key={n} style={{ background: c.accentBg, color: c.accent, fontSize: 10, fontWeight: 600, borderRadius: 5, padding: "2px 8px" }}>{n}</span>)}
                    </div>
                  )}
                </div>
                <DeleteButton onConfirm={() => onDelete(s.id)} c={c} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ============================================================
// SETTINGS PAGE
// ============================================================
function SettingsPage({ c, db, setDb, showToast }) {
  function exportBackup() {
    const blob = new Blob([JSON.stringify(db, null, 2)], { type: "application/json" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `inventory_backup_${new Date().toISOString().slice(0, 10)}.json`; a.click();
    showToast("バックアップをエクスポートしました");
  }
  function importBackup(e) {
    const file = e.target.files[0]; if (!file) return;
    const r = new FileReader();
    r.onload = (ev) => {
      try {
        const parsed = JSON.parse(ev.target.result);
        if (parsed.products && parsed.saleRecords && parsed.statements) {
          setDb(parsed); showToast("データをインポートしました");
        } else showToast("無効なバックアップファイルです", "error");
      } catch { showToast("JSONの読み込みに失敗しました", "error"); }
    };
    r.readAsText(file);
  }

  return (
    <div>
      <div style={{ fontSize: 22, fontWeight: 700, color: c.text, marginBottom: 24 }}>設定</div>

      <Section title="データ管理" c={c}>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button onClick={exportBackup} style={btnSecondary(c)}>↓ バックアップをエクスポート（JSON）</button>
          <label style={{ ...btnSecondary(c), cursor: "pointer" }}>
            ↑ バックアップをインポート
            <input type="file" accept=".json" style={{ display: "none" }} onChange={importBackup} />
          </label>
        </div>
        <div style={{ fontSize: 12, color: c.muted, marginTop: 8 }}>データはブラウザのローカルストレージに保存されています。ブラウザのデータをクリアすると削除されるため、定期的にバックアップを取ることをお勧めします。</div>
      </Section>

      <Section title="商品エイリアス（名寄せ）" c={c}>
        {db.products.length === 0 ? (
          <div style={{ fontSize: 13, color: c.muted }}>登録された商品がありません</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {db.products.map((p) => (
              <div key={p.id} style={{ background: c.bg, border: `1px solid ${c.border}`, borderRadius: 8, padding: "10px 14px" }}>
                <div style={{ fontWeight: 700, fontSize: 13, color: c.text, marginBottom: 4 }}>{p.canonicalName}</div>
                {p.aliases.length > 0 && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                    {p.aliases.map((a) => <span key={a} style={{ background: c.mutedBg, color: c.muted, fontSize: 11, borderRadius: 4, padding: "1px 7px" }}>{a}</span>)}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title="データのリセット" c={c}>
        <DeleteButton onConfirm={() => { setDb({ products: [], saleRecords: [], statements: [] }); showToast("データをリセットしました"); }} c={c} />
      </Section>
    </div>
  );
}

function Section({ title, c, children }) {
  return (
    <div style={{ background: c.card, border: `1px solid ${c.border}`, borderRadius: 14, padding: "20px 24px", marginBottom: 16 }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: c.text, marginBottom: 14, paddingBottom: 10, borderBottom: `1px solid ${c.border}` }}>{title}</div>
      {children}
    </div>
  );
}

// ============================================================
// STYLE HELPERS
// ============================================================
const overlayStyle = { position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 };
const dialogStyle = (c) => ({ background: c.card, border: `1px solid ${c.border}`, borderRadius: 16, padding: 24, boxShadow: "0 20px 60px rgba(0,0,0,0.3)" });
const inputStyle = (c) => ({ background: c.bg, border: `1px solid ${c.border}`, borderRadius: 7, padding: "7px 10px", color: c.text, fontSize: 13, outline: "none" });
const btnPrimary = (c) => ({ background: c.accent, color: c.bg, border: "none", borderRadius: 8, padding: "8px 16px", cursor: "pointer", fontSize: 13, fontWeight: 600 });
const btnSecondary = (c) => ({ background: c.card, color: c.text, border: `1px solid ${c.border}`, borderRadius: 8, padding: "8px 16px", cursor: "pointer", fontSize: 13 });
const btnSmall = (c) => ({ background: c.card, color: c.text, border: `1px solid ${c.border}`, borderRadius: 6, padding: "5px 10px", cursor: "pointer", fontSize: 12, fontWeight: 600 });

// ============================================================
// COLOR TOKENS — monochrome
// ============================================================
const colors = {
  light: {
    bg: "#F5F5F5", card: "#FFFFFF", sidebar: "#FAFAFA", text: "#111111", muted: "#888888",
    border: "#E0E0E0", accent: "#111111", accentBg: "#F0F0F0", accentLight: "#AAAAAA",
    mutedBg: "#EFEFEF", tableHead: "#F7F7F7", rowAlt: "#FAFAFA", rowHover: "#F0F0F0",
    danger: "#555555",
    warningBg: "#fff3cd", warningText: "#856404", warningBorder: "#ffc107",
  },
  dark: {
    bg: "#111111", card: "#1A1A1A", sidebar: "#161616", text: "#F0F0F0", muted: "#777777",
    border: "#2E2E2E", accent: "#F0F0F0", accentBg: "#242424", accentLight: "#999999",
    mutedBg: "#202020", tableHead: "#141414", rowAlt: "#181818", rowHover: "#242424",
    danger: "#AAAAAA",
    warningBg: "#3d3500", warningText: "#e6c64c", warningBorder: "#6b5a00",
  },
};
