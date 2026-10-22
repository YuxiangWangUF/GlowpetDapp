import assert from "node:assert/strict";
import test from "node:test";
import { observeWallet } from "../src/wallet-state.js";

function fixture() {
  const events = new Map();
  const pending = new Map();
  let wallet = { address: "", chainId: null };
  const ethereum = {
    on: (name, listener) => events.set(name, listener),
    removeListener: (name) => events.delete(name),
    request: ({ method }) => new Promise((resolve, reject) => pending.set(method, { resolve, reject })),
  };
  return {
    stop: observeWallet(ethereum, (updater) => { wallet = updater(wallet); }),
    events, pending,
    get wallet() { return wallet; },
  };
}
const settle = async () => { await new Promise((resolve) => setImmediate(resolve)); };

test("startup reads populate an already connected wallet", async () => {
  const state = fixture();
  state.pending.get("eth_accounts").resolve(["0xOld"]);
  await settle();
  state.pending.get("eth_chainId").resolve("0xaa36a7");
  await settle();
  assert.deepEqual(state.wallet, { address: "0xOld", chainId: 11155111 });
  state.stop();
});

test("account changes and disconnects take precedence over pending initial reads", async () => {
  for (const nextAccounts of [["0xNew"], []]) {
    const state = fixture();
    state.pending.get("eth_accounts").resolve(["0xOld"]);
    await settle();
    state.events.get("accountsChanged")(nextAccounts);
    state.pending.get("eth_chainId").resolve("0xaa36a7");
    await settle();
    assert.deepEqual(state.wallet, { address: nextAccounts[0] ?? "", chainId: 11155111 });
    state.stop();
  }
});

test("a network change during startup keeps its current chain and fills the account", async () => {
  const state = fixture();
  state.events.get("chainChanged")("0x1");
  state.pending.get("eth_accounts").resolve(["0xOld"]);
  await settle();
  state.pending.get("eth_chainId").resolve("0xaa36a7");
  await settle();
  assert.deepEqual(state.wallet, { address: "0xOld", chainId: 1 });
  state.stop();
});

test("unmount removes listeners and ignores reads completing afterwards", async () => {
  const state = fixture();
  state.stop();
  state.pending.get("eth_accounts").resolve(["0xOld"]);
  await settle();
  assert.deepEqual(state.wallet, { address: "", chainId: null });
  assert.equal(state.pending.has("eth_chainId"), false);
  assert.equal(state.events.size, 0);
});
