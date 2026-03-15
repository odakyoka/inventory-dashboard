import { parseClaudeExtractionResponse } from "./pdfClaude";

describe("parseClaudeExtractionResponse", () => {
  it("content[].text から JSON を抽出してパースする", () => {
    const apiResponse = {
      content: [{ type: "text", text: '{"statementDate":"2025-04-30","items":[{"rawName":"商品A","quantity":1,"unitPrice":1000,"isOriginalArtwork":false}]}' }],
    };
    const result = parseClaudeExtractionResponse(apiResponse);
    expect(result.statementDate).toBe("2025-04-30");
    expect(result.items).toHaveLength(1);
    expect(result.items[0].rawName).toBe("商品A");
    expect(result.items[0].quantity).toBe(1);
    expect(result.items[0].isOriginalArtwork).toBe(false);
  });

  it("```json ... ``` で囲まれていても抽出する", () => {
    const apiResponse = {
      content: [{ type: "text", text: "```json\n{\"statementDate\":null,\"items\":[]}\n```" }],
    };
    const result = parseClaudeExtractionResponse(apiResponse);
    expect(result.statementDate).toBeNull();
    expect(result.items).toEqual([]);
  });

  it("複数 content ブロックの text を結合してから JSON を探す", () => {
    const apiResponse = {
      content: [
        { type: "text", text: "以下が結果です。\n" },
        { type: "text", text: '{"statementDate":"2025-01-15","items":[{"rawName":"B","quantity":2,"unitPrice":500,"isOriginalArtwork":false}]}' },
      ],
    };
    const result = parseClaudeExtractionResponse(apiResponse);
    expect(result.statementDate).toBe("2025-01-15");
    expect(result.items[0].rawName).toBe("B");
    expect(result.items[0].quantity).toBe(2);
  });

  it("JSON が含まれていない場合はエラー", () => {
    const apiResponse = { content: [{ type: "text", text: "申し訳ありません、解析できませんでした。" }] };
    expect(() => parseClaudeExtractionResponse(apiResponse)).toThrow(/解析結果を取得できませんでした/);
  });

  it("content が空の場合はエラー", () => {
    const apiResponse = { content: [] };
    expect(() => parseClaudeExtractionResponse(apiResponse)).toThrow();
  });
});
