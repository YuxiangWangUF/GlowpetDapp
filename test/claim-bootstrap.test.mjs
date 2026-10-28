import test from "node:test";
import assert from "node:assert/strict";
import { Wallet } from "ethers";
import {
  captureClaimBootstrap,
  getBootstrapClaim,
  resetClaimBootstrap,
} from "../src/claim-bootstrap.js";

const secret = Wallet.createRandom().privateKey;

function fakeWindow({ search = "", hash = "" } = {}) {
  const replaced = [];
  return {
    location: { pathname: "/", search, hash },
    history: {
      replaceState(_state, _title, url) {
        replaced.push(url);
      },
    },
    replaced,
  };
}

test.afterEach(() => resetClaimBootstrap());

test("a fragment credential is captured before the URL is scrubbed", () => {
  const win = fakeWindow({
    search: "?view=activate&source=tag",
    hash: `#claim=protocolVersion=2&chainId=11155111&series=1&serial=7&secret=${secret}&proof=`,
  });
  const captured = captureClaimBootstrap(win);

  assert.equal(captured.serial, 7);
  assert.equal(captured.secret, secret.toLowerCase());
  assert.equal(captured.error, "");
  assert.equal(captured.source, "claim link (fragment)");
  assert.equal(win.replaced.at(-1), "/?view=activate&source=tag");
  assert.equal(getBootstrapClaim().serial, 7);
});

test("legacy query credentials still parse but private fields are removed", () => {
  const win = fakeWindow({
    search: `?protocolVersion=2&chainId=11155111&series=1&serial=7&secret=${secret}&proof=&token=1000007&view=pendant`,
  });
  const captured = captureClaimBootstrap(win);

  assert.equal(captured.serial, 7);
  assert.equal(captured.secret, secret.toLowerCase());
  assert.equal(win.replaced.at(-1), "/?token=1000007&view=pendant");
});

test("conflicting fragment and query claim data is rejected instead of merged", () => {
  const win = fakeWindow({
    search: `?protocolVersion=2&serial=8&secret=${secret}`,
    hash: `#claim=protocolVersion=2&serial=7&secret=${secret}`,
  });
  const captured = captureClaimBootstrap(win);

  assert.match(captured.error, /conflicting claim data/);
  assert.equal(captured.serial, undefined);
  assert.equal(win.replaced.at(-1), "/");
});

test("malformed fragment credentials do not become a silent fallback", () => {
  const win = fakeWindow({
    search: `?protocolVersion=2&serial=7&secret=${secret}`,
    hash: "#claim=protocolVersion=2&serial=not-a-number",
  });
  const captured = captureClaimBootstrap(win);

  assert.notEqual(captured.error, "");
  assert.equal(captured.serial, undefined);
  assert.equal(win.replaced.at(-1), "/");
});

test("public navigation is untouched when no credential is present", () => {
  const win = fakeWindow({ search: "?view=garden&motion=1&token=1000007" });
  const captured = captureClaimBootstrap(win);

  assert.deepEqual(captured, { error: "" });
  assert.equal(win.replaced.at(-1), "/?view=garden&motion=1&token=1000007");
});
