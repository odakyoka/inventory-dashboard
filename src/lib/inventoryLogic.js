/**
 * 在庫・精算の純粋ロジック（データ整合性のユニットテスト用に抽出）
 */

/**
 * 販売記録を期間でフィルタする。
 * saleDate が period.from 〜 period.to の範囲内、または saleDate が無いものは含める。
 */
export function filterRecordsByPeriod(saleRecords, period) {
  return saleRecords.filter((r) => {
    if (!r.saleDate) return true;
    const d = r.saleDate;
    return d >= period.from && d <= period.to;
  });
}

/**
 * 抽出結果（items）と精算書（stmt）・マージ判定（merges）を既存 db に適用した新しい db を返す。
 * confirmExtraction の純粋部分。uuid は id 生成用の関数。
 */
export function applyExtractionToDb(db, items, stmt, merges, uuid) {
  const newDb = {
    statements: [...db.statements],
    saleRecords: [...db.saleRecords],
    products: db.products.map((p) => ({ ...p, aliases: [...p.aliases] })),
  };
  newDb.statements = [...newDb.statements, { ...stmt }];

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

  return newDb;
}
