// apps/web/src/components/ConnectProviderModal.test.tsx
import { test, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { ConnectProviderModal } from "./ConnectProviderModal";
import { getProvider } from "../../../../packages/shared/providers";

afterEach(cleanup);

test("renders a field per registry field and submits their values", () => {
  let submitted: Record<string, string> | null = null;
  render(
    <ConnectProviderModal
      provider={getProvider("coinbase")!}
      pending={false}
      error={null}
      onSubmit={(f) => { submitted = f; }}
      onCancel={() => {}}
    />,
  );
  fireEvent.change(screen.getByLabelText("API key name"), { target: { value: "org/key" } });
  fireEvent.change(screen.getByLabelText("Private key (PEM)"), { target: { value: "-----BEGIN-----" } });
  fireEvent.click(screen.getByRole("button", { name: "Connect" }));
  expect(submitted).toEqual({ key_name: "org/key", private_key: "-----BEGIN-----" });
});

test("edit mode: pre-fills config, allows submit without re-entering a set secret, omits blank secrets", () => {
  let submitted: Record<string, string> | null = null;
  render(
    <ConnectProviderModal
      provider={getProvider("zerion")!}
      pending={false}
      error={null}
      mode="edit"
      initialConfig={{ wallets: "0xabc" }}
      setSecretKeys={["api_key"]}
      onSubmit={(f) => { submitted = f; }}
      onCancel={() => {}}
    />,
  );
  // config pre-filled
  expect((screen.getByLabelText("Wallet addresses (one per line)") as HTMLTextAreaElement).value).toBe("0xabc");
  // submit enabled without typing the api key (it's already set)
  const save = screen.getByRole("button", { name: "Save" });
  expect((save as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(save);
  // blank api_key omitted; wallets sent
  expect(submitted).toEqual({ wallets: "0xabc" });
});
