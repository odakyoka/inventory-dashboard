import { render, screen } from "@testing-library/react";
import App from "./App";

// jsdom に matchMedia がないためモック（App の useState 初期化で使用）
const matchMediaMock = () => ({ matches: false, addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {} });
beforeAll(() => {
  Object.defineProperty(window, "matchMedia", { value: matchMediaMock, writable: true });
});

test("renders app title", () => {
  render(<App />);
  expect(screen.getByText("ORITAKEI")).toBeInTheDocument();
});
