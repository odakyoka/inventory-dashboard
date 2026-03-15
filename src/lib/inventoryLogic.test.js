import { filterRecordsByPeriod, applyExtractionToDb } from "./inventoryLogic";

describe("filterRecordsByPeriod", () => {
  it("期間内の saleDate を持つレコードだけを返す", () => {
    const records = [
      { id: "1", saleDate: "2025-02-15" },
      { id: "2", saleDate: "2025-03-01" },
      { id: "3", saleDate: "2025-04-30" },
      { id: "4", saleDate: "2025-05-01" },
      { id: "5", saleDate: null },
    ];
    const period = { from: "2025-03-01", to: "2025-04-30" };
    const result = filterRecordsByPeriod(records, period);
    expect(result).toHaveLength(3); // 3月1日, 4月30日, saleDate null
    expect(result.map((r) => r.id)).toEqual(["2", "3", "5"]);
  });

  it("saleDate がないレコードは常に含める", () => {
    const records = [{ id: "1", saleDate: null }];
    const period = { from: "2025-01-01", to: "2025-01-31" };
    expect(filterRecordsByPeriod(records, period)).toHaveLength(1);
  });

  it("期間外のみのときは saleDate なし以外は空", () => {
    const records = [
      { id: "1", saleDate: "2024-12-31" },
      { id: "2", saleDate: "2025-05-01" },
    ];
    const period = { from: "2025-01-01", to: "2025-04-30" };
    expect(filterRecordsByPeriod(records, period)).toHaveLength(0);
  });
});

describe("applyExtractionToDb", () => {
  let uuidCounter;
  const uuid = () => `id-${++uuidCounter}`;

  beforeEach(() => {
    uuidCounter = 0;
  });

  it("include: true のアイテムだけ商品・販売記録が増える", () => {
    const db = {
      statements: [],
      saleRecords: [],
      products: [],
    };
    const stmt = { id: "stmt1", statementDate: "2025-04-30" };
    const items = [
      { rawName: "商品A", quantity: 2, unitPrice: 1000, include: true },
      { rawName: "商品B", quantity: 1, unitPrice: 500, include: false },
    ];
    const newDb = applyExtractionToDb(db, items, stmt, [], uuid);

    expect(newDb.statements).toHaveLength(1);
    expect(newDb.products).toHaveLength(1);
    expect(newDb.products[0].canonicalName).toBe("商品A");
    expect(newDb.saleRecords).toHaveLength(1);
    expect(newDb.saleRecords[0].quantity).toBe(2);
    expect(newDb.saleRecords[0].unitPrice).toBe(1000);
    expect(newDb.saleRecords[0].statementId).toBe("stmt1");
  });

  it("既存商品と同名なら新規商品は作らず販売記録だけ追加", () => {
    const db = {
      statements: [],
      saleRecords: [],
      products: [{ id: "p1", canonicalName: "既存商品", aliases: [], latestUnitPrice: 500 }],
    };
    const stmt = { id: "stmt1", statementDate: "2025-04-30" };
    const items = [{ rawName: "既存商品", quantity: 1, unitPrice: 600, include: true }];
    const newDb = applyExtractionToDb(db, items, stmt, [], uuid);

    expect(newDb.products).toHaveLength(1);
    expect(newDb.products[0].latestUnitPrice).toBe(600);
    expect(newDb.saleRecords).toHaveLength(1);
    expect(newDb.saleRecords[0].productId).toBe("p1");
  });

  it("merge 判定で existingId に紐づくとエイリアスが付く", () => {
    const db = {
      statements: [],
      saleRecords: [],
      products: [{ id: "p1", canonicalName: "正式名", aliases: [], latestUnitPrice: 100 }],
    };
    const stmt = { id: "stmt1", statementDate: "2025-04-30" };
    const items = [{ rawName: "表記ゆれ名", quantity: 1, unitPrice: 100, include: true }];
    const merges = [{ rawName: "表記ゆれ名", existingId: "p1", decision: "merge" }];
    const newDb = applyExtractionToDb(db, items, stmt, merges, uuid);

    expect(newDb.products).toHaveLength(1);
    expect(newDb.products[0].aliases).toContain("表記ゆれ名");
    expect(newDb.saleRecords[0].productId).toBe("p1");
  });
});
