# App.js リファクタリング方針（Token 節約・改修箇所の明確化）

## 目的
- **Token 消費の最小化**: プロンプト短縮・max_tokens 削減・テキスト抽出済み時はテキストのみ送信
- **改修箇所をわかりやすくする**: Claude/PDF 関連を一箇所に集約し、今後の変更がしやすい構成にする

---

## 1. PDF 重複ファイル検出

**現状**: すでに実装済み（`hashFile` + `db.statements` の `fileHash` 比較）。

**リファクタで行うこと**:
- 重複判定ロジックを **Claude/PDF 用モジュール** に集約する
- 「重複チェック → スキップ」を関数化し、`handleFiles` からは `isDuplicatePdf(file, statements)` のような 1 呼び出しにする
- 改修時は「PDF 重複」を変えたい → そのモジュールだけ見ればよい状態にする

---

## 2. max_tokens 削減

**現状**: `max_tokens: 512`

**変更案**:
- 返却は 1 つの JSON オブジェクトのみ想定なので **256** に削減
- 精算書の行数が極端に多い場合は不足する可能性があるため、定数化して後から 384 などに変更しやすくする

---

## 3. プロンプト短縮

**現状**:
```
精算書からJSONのみ返答（説明不要）:
{"statementDate":"YYYY-MM-DDまたはnull","items":[{"rawName":"商品名","quantity":数値またはnull,"unitPrice":数値またはnull,"isOriginalArtwork":true/false}]}
・原画・原作品・一点物はisOriginalArtwork:true ・不明項目はnull
```

**短縮案**（Token 節約）:
```
JSONのみ。説明不要。
{"statementDate":"YYYY-MM-DD or null","items":[{"rawName":"","quantity":num or null,"unitPrice":num or null,"isOriginalArtwork":bool}]}
原画・一点物→isOriginalArtwork:true。不明→null。
```

または、システムメッセージで形式を指定する方式にすれば、ユーザーメッセージ側のプロンプトをさらに短くできる（API が system をサポートしている場合）。

---

## 4. テキスト抽出済みはテキストのみ送信

**現状**: すでに実装済み。
- `extractTextFromPDF` でテキスト取得成功かつ文字数十分 → `isScanned: false` → `extractDataWithClaude` 内で `content = [{ type: "text", text: ... }]` のみ送信
- スキャン PDF のときだけ base64 PDF を送信

**リファクタで行うこと**:
- この分岐を **Claude 用モジュール内** に閉じ込め、コメントで「テキストのみ送信（Token 節約）」と明記する
- 送信ペイロードを組み立てる関数を `buildClaudeContent(extractedText, isScanned, pdfFile)` のように分離すると、改修時に見つけやすい

---

## 5. ファイル分割（改修箇所の明確化）

| 役割 | 新規ファイル | 中身 |
|------|--------------|------|
| PDF 重複・ハッシュ・テキスト抽出・Claude 呼び出し | `src/services/pdfClaude.js` | `hashFile`, `isDuplicatePdf`, `extractTextFromPDF`, `extractDataWithClaude`, プロンプト・max_tokens 定数 |
| ストレージ・UUID | `src/utils/storage.js`（任意） | `loadData`, `saveData`, `initState`, `uuid` |
| 類似度・日付・フォーマット | `src/utils/helpers.js`（任意） | `similarity`, `levenshtein`, `fmtDate`, `fmtNum`, `thisYear` |

**最小構成**では、**Token 関連の改修を一箇所にまとめる**ために `src/services/pdfClaude.js` の追加だけ行う。

- **プロンプト・max_tokens を変えたい** → `pdfClaude.js` のみ編集
- **PDF 重複の仕様を変えたい** → `pdfClaude.js` の `isDuplicatePdf` 周辺を編集
- **テキストのみ送信の条件を変えたい** → `pdfClaude.js` の `buildContent` 相当を編集

---

## 6. 変更まとめ

| 項目 | 変更内容 |
|------|----------|
| PDF 重複検出 | ロジックは維持しつつ、`pdfClaude.js` に集約して呼び出しを `isDuplicatePdf(file, statements)` に |
| max_tokens | 512 → 256（定数 `CLAUDE_MAX_TOKENS` で管理） |
| プロンプト | 短縮版に変更し、同じファイル内の定数で管理 |
| テキストのみ送信 | 既存ロジックを `pdfClaude.js` 内に移動し、コメントで意図を明記 |
| 改修しやすさ | Claude/PDF 関連を `src/services/pdfClaude.js` に集約し、App.js は UI とオーケストレーションに集中 |

この方針で進めると、Token 消費を抑えつつ、今後の変更箇所が分かりやすい構成になります。
