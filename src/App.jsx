import { useCallback, useEffect, useMemo, useState } from "react";
import { BrowserProvider, Contract, JsonRpcProvider, isAddress, isHexString } from "ethers";
import DOMPurify from "dompurify";
import {
  ACCESSORY_NAMES,
  CLAIM_DOMAIN_NAME,
  CLAIM_DOMAIN_VERSION,
  CLAIM_TYPES,
  DEPLOY_BLOCK,
  EYE_NAMES,
  EYEWEAR_NAMES,
  FRAME_NAMES,
  GLOWPET_ABI,
  GLOWPET_ADDRESS,
  MOUTH_NAMES,
  PALETTE_NAMES,
  PROOF_BASE_URL,
  SEPOLIA_CHAIN_ID,
  SEPOLIA_CHAIN_ID_HEX,
  SEPOLIA_EXPLORER_URL,
  SEPOLIA_RPC_URL,
  SERIES_ID,
  SERIES_STRIDE,
  SPECIES_NAMES,
  addressUrl,
  decodeTokenURI,
  describeError,
  loadClaimFile,
  normalizePetState,
  normalizeSeriesInfo,
  padSerial,
  parseClaimCode,
  parseProof,
  sameAddress,
  shortAddress,
  stageName,
  tokenUrl,
  txUrl,
} from "./contract.js";

const CONFIGURED = isAddress(GLOWPET_ADDRESS);

export default function App() {
  // Claim data can arrive pre-filled from the charm's QR link.
  const initialClaim = useMemo(() => {
    try {
      return parseClaimCode(window.location.search);
    } catch {
      return {};
    }
  }, []);

  const [wallet, setWallet] = useState({ address: "", chainId: null });
  const [seriesId, setSeriesId] = useState(() => initialClaim.seriesId ?? SERIES_ID);
  const [series, setSeries] = useState(null);
  const [seriesError, setSeriesError] = useState("");

  const [serialInput, setSerialInput] = useState(
    initialClaim.serial !== undefined ? String(initialClaim.serial) : "",
  );
  const [secretInput, setSecretInput] = useState(initialClaim.secret ?? "");
  const [proofInput, setProofInput] = useState(
    initialClaim.proof?.length ? initialClaim.proof.join(", ") : "",
  );
  const [claimCodeInput, setClaimCodeInput] = useState("");
  const [claimSource, setClaimSource] = useState(initialClaim.source ?? "");

  // `?token=1000001` shows any pet read-only, no wallet required. Handy for
  // sharing a pet and for looking at a deployment before claiming.
  const [linkedTokenId, setLinkedTokenId] = useState(() => {
    const raw = new URLSearchParams(window.location.search).get("token");
    return raw && /^\d+$/.test(raw) ? BigInt(raw) : null;
  });
  const [reducedMotion] = useState(
    () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
  );
  const [allowMotion, setAllowMotion] = useState(
    () =>
      new URLSearchParams(window.location.search).get("motion") === "1" ||
      !reducedMotion,
  );

  const [pet, setPet] = useState(null);
  const [petLoading, setPetLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState("");
  const [txHash, setTxHash] = useState("");
  const [status, setStatus] = useState(() =>
    initialClaim.serial !== undefined
      ? {
          tone: "info",
          text: `Claim data for charm #${padSerial(initialClaim.serial)} loaded from the link. Review it, then activate.`,
        }
      : { tone: "", text: "" },
  );

  // The claim link carries the secret in its query string. Copy it into React
  // state and replace the history entry immediately so it does not linger in
  // the address bar, browser history, screenshots or shared links.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (!params.has("secret") && !params.has("proof") && !params.has("serial")) return;

    params.delete("secret");
    params.delete("proof");
    params.delete("serial");

    const search = params.toString();
    window.history.replaceState({}, "", window.location.pathname + (search ? `?${search}` : ""));
  }, []);

  const isSepolia = wallet.chainId === SEPOLIA_CHAIN_ID;

  const readProvider = useMemo(
    () => new JsonRpcProvider(SEPOLIA_RPC_URL, SEPOLIA_CHAIN_ID, { staticNetwork: true }),
    [],
  );
  const readContract = useMemo(
    () => (CONFIGURED ? new Contract(GLOWPET_ADDRESS, GLOWPET_ABI, readProvider) : null),
    [readProvider],
  );

  const storageKey = wallet.address
    ? `glowpet:v1:${SEPOLIA_CHAIN_ID}:${seriesId.toString()}:${wallet.address.toLowerCase()}`
    : "";

  // -------------------------------------------------------------------------
  // Wallet lifecycle
  // -------------------------------------------------------------------------

  useEffect(() => {
    const eth = window.ethereum;
    if (!eth) return undefined;

    let cancelled = false;

    (async () => {
      try {
        const accounts = await eth.request({ method: "eth_accounts" });
        if (cancelled || !accounts?.length) return;
        const chainIdHex = await eth.request({ method: "eth_chainId" });
        setWallet({ address: accounts[0], chainId: Number(chainIdHex) });
      } catch {
        // A locked wallet is not an error; the user can still connect manually.
      }
    })();

    const onAccountsChanged = (accounts) => {
      setWallet((previous) => ({ ...previous, address: accounts?.[0] ?? "" }));
    };
    const onChainChanged = (chainIdHex) => {
      setWallet((previous) => ({ ...previous, chainId: Number(chainIdHex) }));
    };

    eth.on?.("accountsChanged", onAccountsChanged);
    eth.on?.("chainChanged", onChainChanged);

    return () => {
      cancelled = true;
      eth.removeListener?.("accountsChanged", onAccountsChanged);
      eth.removeListener?.("chainChanged", onChainChanged);
    };
  }, []);

  const connectWallet = useCallback(async () => {
    if (!window.ethereum) {
      setStatus({
        tone: "error",
        text: "MetaMask was not detected. Install it, unlock it, and reload this page.",
      });
      return;
    }

    setBusy(true);
    setBusyLabel("Connecting");
    try {
      const provider = new BrowserProvider(window.ethereum);
      const accounts = await provider.send("eth_requestAccounts", []);
      const network = await provider.getNetwork();
      setWallet({ address: accounts[0], chainId: Number(network.chainId) });

      if (Number(network.chainId) !== SEPOLIA_CHAIN_ID) {
        setStatus({ tone: "warn", text: "Wallet connected. Switch to Sepolia to activate a charm." });
      } else {
        setStatus({ tone: "success", text: "Wallet connected." });
      }
    } catch (error) {
      setStatus({ tone: "error", text: describeError(error) });
    } finally {
      setBusy(false);
      setBusyLabel("");
    }
  }, []);

  const switchToSepolia = useCallback(async () => {
    if (!window.ethereum) return false;

    setBusy(true);
    setBusyLabel("Switching network");
    try {
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: SEPOLIA_CHAIN_ID_HEX }],
      });
      setWallet((previous) => ({ ...previous, chainId: SEPOLIA_CHAIN_ID }));
      return true;
    } catch (error) {
      // 4902: the wallet does not know this chain yet.
      if (error.code === 4902) {
        try {
          await window.ethereum.request({
            method: "wallet_addEthereumChain",
            params: [
              {
                chainId: SEPOLIA_CHAIN_ID_HEX,
                chainName: "Sepolia",
                nativeCurrency: { name: "Sepolia ETH", symbol: "ETH", decimals: 18 },
                rpcUrls: [SEPOLIA_RPC_URL],
                blockExplorerUrls: [SEPOLIA_EXPLORER_URL],
              },
            ],
          });
          setWallet((previous) => ({ ...previous, chainId: SEPOLIA_CHAIN_ID }));
          return true;
        } catch (addError) {
          setStatus({ tone: "error", text: describeError(addError) });
          return false;
        }
      }

      setStatus({ tone: "error", text: describeError(error) });
      return false;
    } finally {
      setBusy(false);
      setBusyLabel("");
    }
  }, []);

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (!CONFIGURED) return undefined;

    let cancelled = false;
    readProvider
      .getCode(GLOWPET_ADDRESS)
      .then((code) => {
        if (!cancelled && code === "0x") {
          setSeriesError(
            "No contract code at VITE_GLOWPET_ADDRESS on this RPC. Check the address and the network.",
          );
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [readProvider]);

  useEffect(() => {
    if (!readContract) return undefined;

    let cancelled = false;
    setSeriesError("");

    readContract
      .seriesInfo(seriesId)
      .then((info) => {
        if (!cancelled) setSeries(normalizeSeriesInfo(info));
      })
      .catch((error) => {
        if (cancelled) return;
        setSeries(null);
        setSeriesError(describeError(error));
      });

    return () => {
      cancelled = true;
    };
  }, [readContract, seriesId]);

  const loadPet = useCallback(
    async (tokenId, { quiet = false } = {}) => {
      if (!readContract) return null;
      if (!quiet) {
        setPetLoading(true);
        setStatus({ tone: "info", text: "Reading the pet from the contract…" });
      }

      try {
        const [uri, state, owner] = await Promise.all([
          readContract.tokenURI(tokenId),
          readContract.petState(tokenId),
          readContract.ownerOf(tokenId),
        ]);
        const decoded = decodeTokenURI(uri);

        const next = {
          tokenId: BigInt(tokenId),
          owner,
          metadata: decoded.metadata,
          svg: decoded.svg,
          traits: normalizePetState(state),
        };
        setPet(next);

        if (!quiet) setStatus({ tone: "", text: "" });
        return next;
      } catch (error) {
        if (!quiet) setStatus({ tone: "error", text: describeError(error) });
        return null;
      } finally {
        if (!quiet) setPetLoading(false);
      }
    },
    [readContract],
  );

  // Read-only view of a shared token link.
  useEffect(() => {
    if (!linkedTokenId || !readContract) return;
    loadPet(linkedTokenId, { quiet: true });
  }, [linkedTokenId, readContract, loadPet]);

  // Reopen the pet this wallet activated last, if it still owns it.
  useEffect(() => {
    if (!storageKey || !isSepolia || !readContract) return undefined;

    let cancelled = false;
    const saved = localStorage.getItem(storageKey);
    if (!saved) {
      if (!linkedTokenId) setPet(null);
      return undefined;
    }

    (async () => {
      try {
        const owner = await readContract.ownerOf(saved);
        if (cancelled) return;

        if (!sameAddress(owner, wallet.address)) {
          localStorage.removeItem(storageKey);
          setPet(null);
          return;
        }
        await loadPet(saved, { quiet: true });
      } catch {
        if (!cancelled) setPet(null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [storageKey, isSepolia, readContract, wallet.address, loadPet, linkedTokenId]);

  async function findMyPet() {
    if (!readContract || !wallet.address) return;

    setBusy(true);
    setBusyLabel("Scanning events");
    try {
      const logs = await readContract.queryFilter(
        readContract.filters.Claimed(wallet.address),
        DEPLOY_BLOCK,
        "latest",
      );

      if (!logs.length) {
        setStatus({ tone: "info", text: "No Glowpet claim was found for this wallet in this series." });
        return;
      }

      const latest = logs[logs.length - 1];
      const tokenId = latest.args?.tokenId ?? latest.args?.[1];
      if (storageKey) localStorage.setItem(storageKey, tokenId.toString());
      await loadPet(tokenId);
      setStatus({ tone: "success", text: "Found your Glowpet on-chain." });
    } catch (error) {
      const hint =
        DEPLOY_BLOCK === 0
          ? " Set VITE_DEPLOY_BLOCK to the deployment block if the RPC rejects a full-history scan."
          : "";
      setStatus({ tone: "error", text: describeError(error) + hint });
    } finally {
      setBusy(false);
      setBusyLabel("");
    }
  }

  // -------------------------------------------------------------------------
  // Claim
  // -------------------------------------------------------------------------

  function applyClaimCode(raw) {
    const text = String(raw ?? "").trim();
    if (!text) return false;

    try {
      const parsed = parseClaimCode(text);
      let changed = false;

      if (parsed.serial !== undefined) {
        setSerialInput(String(parsed.serial));
        changed = true;
      }
      if (parsed.secret) {
        setSecretInput(parsed.secret);
        changed = true;
      }
      if (parsed.proof?.length) {
        setProofInput(parsed.proof.join(", "));
        changed = true;
      }
      if (parsed.seriesId !== undefined) setSeriesId(parsed.seriesId);

      if (!changed) throw new Error("No claim fields were found in that code.");

      setClaimCodeInput("");
      setClaimSource(parsed.source ?? "claim code");
      setStatus({ tone: "info", text: "Claim code loaded. Review it, then activate." });
      return true;
    } catch (error) {
      setStatus({ tone: "error", text: error.message || "Could not read that claim code." });
      return false;
    }
  }

  async function loadProofFile() {
    const serial = Number(serialInput);
    if (!Number.isInteger(serial) || serial < 1) {
      setStatus({ tone: "warn", text: "Enter a charm serial first." });
      return;
    }

    setBusy(true);
    setBusyLabel("Loading proof");
    try {
      const data = await loadClaimFile(serial);
      if (!data) {
        setStatus({
          tone: "warn",
          text: `No proof file is served for #${padSerial(serial)}. Use the charm's QR code or paste its claim data.`,
        });
        return;
      }

      if (data.secret) setSecretInput(data.secret);
      if (data.proof?.length) setProofInput(data.proof.join(", "));
      if (data.seriesId !== undefined) setSeriesId(BigInt(data.seriesId));

      setClaimSource(`proof file #${padSerial(serial)}`);
      setStatus({ tone: "info", text: `Loaded claim data for charm #${padSerial(serial)}.` });
    } catch (error) {
      setStatus({ tone: "error", text: error.message });
    } finally {
      setBusy(false);
      setBusyLabel("");
    }
  }

  async function claim(event) {
    event?.preventDefault();

    if (!CONFIGURED) {
      setStatus({ tone: "error", text: "Set VITE_GLOWPET_ADDRESS before claiming." });
      return;
    }
    if (!window.ethereum) {
      setStatus({ tone: "error", text: "MetaMask was not detected. Install it and reload." });
      return;
    }

    const serial = Number(serialInput);
    if (!Number.isInteger(serial) || serial < 1) {
      setStatus({ tone: "error", text: "Enter a valid charm serial." });
      return;
    }
    if (series && serial > series.maxSupply) {
      setStatus({
        tone: "error",
        text: `Serial ${serial} is outside this series (1–${series.maxSupply}).`,
      });
      return;
    }

    const secret = secretInput.trim().toLowerCase();
    if (!isHexString(secret, 32)) {
      setStatus({
        tone: "error",
        text: "The claim secret must be 32 bytes of hex (0x followed by 64 characters).",
      });
      return;
    }

    let proof;
    try {
      proof = parseProof(proofInput);
    } catch (error) {
      setStatus({ tone: "error", text: error.message });
      return;
    }
    if (proof.length === 0 && series?.maxSupply !== 1) {
      setStatus({ tone: "error", text: "Paste the Merkle proof from the charm's tag." });
      return;
    }

    if (!wallet.address) {
      await connectWallet();
      return;
    }
    if (!isSepolia) {
      const switched = await switchToSepolia();
      if (!switched) return;
    }

    setBusy(true);
    setBusyLabel("Activating");
    setTxHash("");
    setStatus({ tone: "info", text: "Confirm the claim transaction in your wallet." });

    let claimedTo = wallet.address;

    try {
      const provider = new BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();
      const signerAddress = await signer.getAddress();
      claimedTo = signerAddress;
      const network = await provider.getNetwork();
      const contract = new Contract(GLOWPET_ADDRESS, GLOWPET_ABI, signer);

      if (!sameAddress(wallet.address, signerAddress)) {
        setWallet((previous) => ({ ...previous, address: signerAddress }));
      }

      const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const domain = {
        name: CLAIM_DOMAIN_NAME,
        version: CLAIM_DOMAIN_VERSION,
        chainId: Number(network.chainId),
        verifyingContract: GLOWPET_ADDRESS,
      };

      // The signature binds this serial to the signer. A front-runner can copy
      // the secret, proof and signature, but the token can only be minted to
      // this address.
      setBusyLabel("Signing");
      setStatus({
        tone: "info",
        text: "Sign the claim message in your wallet. It authorises this serial to be minted to your address only.",
      });
      const signature = await signer.signTypedData(domain, CLAIM_TYPES, {
        seriesId,
        serial,
        recipient: signerAddress,
        deadline,
      });

      setBusyLabel("Activating");
      setStatus({
        tone: "info",
        text: "Signature received. Confirm the claim transaction in your wallet.",
      });
      const tx = await contract.claim(
        seriesId,
        serial,
        secret,
        proof,
        signerAddress,
        deadline,
        signature,
      );
      setTxHash(tx.hash);
      setStatus({ tone: "info", text: "Transaction sent. Waiting for the block…" });

      const receipt = await tx.wait();

      let tokenId = seriesId * SERIES_STRIDE + BigInt(serial);
      for (const log of receipt.logs) {
        try {
          const parsed = contract.interface.parseLog(log);
          if (parsed?.name === "Claimed") tokenId = parsed.args.tokenId;
        } catch {
          // Logs emitted by other contracts in the same transaction.
        }
      }

      localStorage.setItem(
        `glowpet:v1:${SEPOLIA_CHAIN_ID}:${seriesId.toString()}:${signerAddress.toLowerCase()}`,
        tokenId.toString(),
      );
      const loaded = await loadPet(tokenId);

      if (loaded) {
        const species = SPECIES_NAMES[loaded.traits.species] ?? "Glowpet";
        setStatus({
          tone: "success",
          text: `${species} #${padSerial(serial)} is home. The portrait was rendered by the contract.`,
        });
      } else {
        setStatus({ tone: "success", text: "Charm activated on-chain. Open the token to view it." });
      }

      readContract
        ?.seriesInfo(seriesId)
        .then((info) => setSeries(normalizeSeriesInfo(info)))
        .catch(() => {});

      setLinkedTokenId(null);
      window.history.replaceState({}, "", window.location.pathname);
    } catch (error) {
      // A relayer may have submitted the same signed claim first. The token is
      // still ours, so show it instead of an alarming "already claimed" error.
      const revertName = error.revert?.name ?? error.info?.error?.name;
      if (revertName === "AlreadyClaimed" && claimedTo && readContract) {
        try {
          const existingId = seriesId * SERIES_STRIDE + BigInt(serial);
          const owner = await readContract.ownerOf(existingId);
          if (sameAddress(owner, claimedTo)) {
            localStorage.setItem(
              `glowpet:v1:${SEPOLIA_CHAIN_ID}:${seriesId.toString()}:${claimedTo.toLowerCase()}`,
              existingId.toString(),
            );
            await loadPet(existingId);
            setStatus({
              tone: "success",
              text: "Your claim was already relayed on-chain. The pet is in your wallet.",
            });
            return;
          }
        } catch {
          // Fall through to the normal error message.
        }
      }

      setStatus({ tone: "error", text: describeError(error) });
    } finally {
      setBusy(false);
      setBusyLabel("");
    }
  }

  // -------------------------------------------------------------------------
  // Derived display data
  // -------------------------------------------------------------------------

  const proofCount = useMemo(() => {
    try {
      return parseProof(proofInput).length;
    } catch {
      return 0;
    }
  }, [proofInput]);

  const safeSvg = useMemo(() => (pet ? sanitizeSvg(pet.svg) : ""), [pet]);

  const traitRows = useMemo(() => {
    if (!pet) return [];
    const t = pet.traits;

    return [
      ["Species", SPECIES_NAMES[t.species] ?? `#${t.species}`],
      ["Palette", PALETTE_NAMES[t.palette] ?? `#${t.palette}`],
      ["Eyes", EYE_NAMES[t.eyeStyle] ?? `#${t.eyeStyle}`],
      ["Mouth", MOUTH_NAMES[t.mouthStyle] ?? `#${t.mouthStyle}`],
      ["Accessory", ACCESSORY_NAMES[t.accessory] ?? `#${t.accessory}`],
      [
        "Eyewear",
        t.eyewear ? `${EYEWEAR_NAMES[t.eyewear]} · ${FRAME_NAMES[t.frameColor]}` : "None",
      ],
      ["Shape", t.bodyShape ? "Slender" : "Round"],
      ["Tilt", `${t.tilt > 0 ? "+" : ""}${t.tilt}°`],
    ];
  }, [pet]);

  const claimButtonLabel = !wallet.address
    ? "Connect wallet to activate"
    : busy
      ? busyLabel || "Working…"
      : "Activate Glowpet";

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div className="page">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Glowpet home">
          <span className="brand-mark">
            <Logo />
          </span>
          <span className="brand-name">Glowpet</span>
          <span className="brand-badge">{series?.label ?? "ΔX"}</span>
        </a>

        <div className="wallet-area">
          {wallet.address ? (
            <>
              <span className={`network ${isSepolia ? "ok" : "bad"}`}>
                {isSepolia ? "Sepolia" : "Wrong network"}
              </span>
              <span className="wallet-address" title={wallet.address}>
                {shortAddress(wallet.address)}
              </span>
            </>
          ) : (
            <button type="button" className="ghost" onClick={connectWallet} disabled={busy}>
              Connect wallet
            </button>
          )}
        </div>
      </header>

      {wallet.address && !isSepolia && (
        <div className="banner">
          <span>Glowpet lives on the Sepolia testnet.</span>
          <button type="button" className="ghost small" onClick={switchToSepolia} disabled={busy}>
            Switch network
          </button>
        </div>
      )}

      <main>
        <section className="hero">
          <p className="eyebrow">PHYSICAL CHARM · ON-CHAIN PET</p>
          <h1>
            Every charm carries
            <br />
            <em>one unique pet.</em>
          </h1>
          <p className="lede">
            A limited-edition pendant with a screen. Scan its tag to claim the pet
            whose identity is derived from the charm's serial — owned by you,
            rendered by the contract, impossible to duplicate.
          </p>
        </section>

        <div className="layout">
          <section className="card claim-card">
            <div className="card-head">
              <div>
                <p className="eyebrow">ACTIVATE</p>
                <h2>Unbox your pet</h2>
              </div>
              {series && (
                <span className="serial-badge">
                  {series.minted.toLocaleString("en-US")} / {series.maxSupply.toLocaleString("en-US")}
                </span>
              )}
            </div>

            {!CONFIGURED ? (
              <SetupNotice />
            ) : (
              <>
                <div className="series-stats">
                  <div>
                    <span>Series</span>
                    <strong>{series?.label ?? "—"}</strong>
                  </div>
                  <div>
                    <span>Claimed</span>
                    <strong>
                      {series
                        ? `${series.minted.toLocaleString("en-US")} / ${series.maxSupply.toLocaleString("en-US")}`
                        : "—"}
                    </strong>
                  </div>
                  <div>
                    <span>Status</span>
                    <strong>{series ? (series.open ? "Open" : "Closed") : "—"}</strong>
                  </div>
                </div>

                {seriesError && <div className="status error">{seriesError}</div>}

                <form onSubmit={claim}>
                  <label htmlFor="serial">Charm serial</label>
                  <div className="input-row">
                    <input
                      id="serial"
                      inputMode="numeric"
                      autoComplete="off"
                      placeholder="000123"
                      value={serialInput}
                      onChange={(event) =>
                        setSerialInput(event.target.value.replace(/[^\d]/g, ""))
                      }
                    />
                    <button
                      type="button"
                      className="ghost small"
                      onClick={loadProofFile}
                      disabled={busy || !PROOF_BASE_URL}
                      title={
                        PROOF_BASE_URL
                          ? "Load a demo proof file served by this site"
                          : "No proof file service configured"
                      }
                    >
                      Load proof
                    </button>
                  </div>
                  <p className="hint">
                    Printed on the charm's tag. 1–{series ? series.maxSupply.toLocaleString("en-US") : "…"}.
                  </p>

                  <label htmlFor="secret">Claim secret</label>
                  <input
                    id="secret"
                    className="mono"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="0x…"
                    value={secretInput}
                    onChange={(event) => setSecretInput(event.target.value)}
                  />

                  <label htmlFor="proof">Merkle proof</label>
                  <textarea
                    id="proof"
                    className="mono"
                    rows={3}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="0x…, 0x…, 0x…"
                    value={proofInput}
                    onChange={(event) => setProofInput(event.target.value)}
                  />
                  <p className="hint">
                    {proofCount > 0
                      ? `${proofCount} proof node${proofCount === 1 ? "" : "s"} recognized.`
                      : "Comma, space or newline separated."}
                  </p>

                  <button type="submit" className="primary" disabled={busy}>
                    {claimButtonLabel}
                  </button>
                </form>

                <details className="paste-code">
                  <summary>Have a claim link or QR payload?</summary>
                  <textarea
                    className="mono"
                    rows={2}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="Paste the link or JSON from the charm…"
                    value={claimCodeInput}
                    onChange={(event) => setClaimCodeInput(event.target.value)}
                  />
                  <button
                    type="button"
                    className="ghost small"
                    onClick={() => applyClaimCode(claimCodeInput)}
                    disabled={!claimCodeInput.trim()}
                  >
                    Use this code
                  </button>
                </details>
              </>
            )}

            {status.text && <div className={`status ${status.tone}`}>{status.text}</div>}

            {txHash && (
              <a className="tx-link" href={txUrl(txHash)} target="_blank" rel="noreferrer">
                View transaction on Etherscan ↗
              </a>
            )}

            {claimSource && <p className="source">Credentials: {claimSource}</p>}
          </section>

          <section className="card pet-card">
            {petLoading ? (
              <div className="empty">
                <div className="spinner" aria-hidden="true" />
                <p>Reading the contract…</p>
              </div>
            ) : pet ? (
              <>
                <div
                  className={`pet-stage${allowMotion ? " force-motion" : " motion-off"}`}
                  dangerouslySetInnerHTML={{ __html: safeSvg }}
                  aria-label="On-chain Glowpet portrait"
                />

                <div className="pet-head">
                  <div>
                    <h2>
                      {SPECIES_NAMES[pet.traits.species] ?? "Glowpet"}{" "}
                      <span>#{padSerial(pet.traits.serial)}</span>
                    </h2>
                    <p>
                      {series?.label ?? "Glowpet"} · Token {pet.tokenId.toString()}
                    </p>
                  </div>
                  <span className="stage-pill">
                    {stageName(pet.traits.stage)} · Lv.{pet.traits.level}
                  </span>
                </div>

                <dl className="traits">
                  {traitRows.map(([label, value]) => (
                    <div className="trait" key={label}>
                      <dt>{label}</dt>
                      <dd>{value}</dd>
                    </div>
                  ))}
                </dl>

                <div className="pet-footer">
                  <button
                    type="button"
                    className="ghost small"
                    onClick={() => loadPet(pet.tokenId)}
                    disabled={busy}
                  >
                    Refresh
                  </button>
                  <button
                    type="button"
                    className="ghost small"
                    onClick={() => setAllowMotion((value) => !value)}
                  >
                    {allowMotion ? "Pause motion" : "Preview motion"}
                  </button>
                  <a
                    className="tx-link"
                    href={tokenUrl(GLOWPET_ADDRESS, pet.tokenId)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open on Etherscan ↗
                  </a>
                </div>

                <p className="owner">Owned by {shortAddress(pet.owner)}</p>

                {reducedMotion && !allowMotion && (
                  <p className="motion-note">
                    Idle motion is paused because your system asks for reduced motion. Use{" "}
                    <strong>Preview motion</strong> to watch the loop.
                  </p>
                )}
              </>
            ) : (
              <div className="empty">
                <EmptyPet />
                <p className="eyebrow">NO PET YET</p>
                <h2>Your charm is still asleep.</h2>
                <p>
                  Scan the code on your pendant to load its serial and claim
                  credential. The contract will draw a pet that only this serial
                  can produce.
                </p>
                {wallet.address && isSepolia && (
                  <button type="button" className="ghost" onClick={findMyPet} disabled={busy}>
                    Find my Glowpet on-chain
                  </button>
                )}
              </div>
            )}
          </section>
        </div>
      </main>

      <footer>
        <span>Art, traits and ownership live on Sepolia. No backend, no custody.</span>
        <span className="footer-links">
          {CONFIGURED && (
            <a href={addressUrl(GLOWPET_ADDRESS)} target="_blank" rel="noreferrer">
              Contract ↗
            </a>
          )}
          <span>Testnet only · no monetary value</span>
        </span>
      </footer>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small presentational pieces
// ---------------------------------------------------------------------------

function Logo() {
  return (
    <svg viewBox="0 0 40 40" width="26" height="26" aria-hidden="true">
      <ellipse cx="12.5" cy="10" rx="5" ry="7" fill="#c4b5fd" transform="rotate(-20 12.5 10)" />
      <ellipse cx="27.5" cy="10" rx="5" ry="7" fill="#c4b5fd" transform="rotate(20 27.5 10)" />
      <ellipse cx="20" cy="23" rx="14" ry="12" fill="#ede9fe" />
      <circle cx="15" cy="22" r="2" fill="#1b1726" />
      <circle cx="25" cy="22" r="2" fill="#1b1726" />
      <path
        d="M17 27 q3 3 6 0"
        stroke="#1b1726"
        strokeWidth="1.6"
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  );
}

function EmptyPet() {
  return (
    <svg className="empty-pet" viewBox="0 0 220 190" aria-hidden="true">
      <defs>
        <linearGradient id="empty-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#2a2638" />
          <stop offset="100%" stopColor="#15121f" />
        </linearGradient>
      </defs>
      <path
        d="M62 58 L48 20 L90 42"
        fill="#221e31"
        stroke="#4c4563"
        strokeLinejoin="round"
        strokeWidth="2"
      />
      <path
        d="M158 58 L172 20 L130 42"
        fill="#221e31"
        stroke="#4c4563"
        strokeLinejoin="round"
        strokeWidth="2"
      />
      <ellipse
        cx="110"
        cy="102"
        rx="70"
        ry="60"
        fill="url(#empty-fill)"
        stroke="#4c4563"
        strokeDasharray="7 9"
        strokeWidth="2"
      />
      <circle cx="86" cy="94" r="6" fill="#4c4563" />
      <circle cx="134" cy="94" r="6" fill="#4c4563" />
      <path
        d="M102 114 q8 6 16 0"
        stroke="#4c4563"
        strokeWidth="3"
        fill="none"
        strokeLinecap="round"
      />
      <text x="186" y="156" fill="#6f6b7c" fontSize="26" fontFamily="monospace">
        ?
      </text>
    </svg>
  );
}

function SetupNotice() {
  return (
    <div className="setup">
      <p className="eyebrow">CONFIGURATION</p>
      <h2>Deploy the contracts first</h2>
      <p>
        Add the Glowpet address to <code>.env</code>, then restart the dev server:
      </p>
      <pre>VITE_GLOWPET_ADDRESS=0x…</pre>
      <ol>
        <li>
          Deploy <code>GlowpetFaceArt</code>
        </li>
        <li>
          Deploy <code>GlowpetArt(faceArtAddress)</code>
        </li>
        <li>
          Deploy <code>Glowpet(artAddress)</code>
        </li>
        <li>
          Call <code>createSeries(...)</code> with the generated root
        </li>
      </ol>
      <p className="hint">The full walkthrough is in README.md.</p>
    </div>
  );
}

/**
 * The SVG comes from the Glowpet contract, but the browser still deserves a
 * defence-in-depth pass before inlining it into the DOM. DOMPurify's SVG
 * profile is maintained against parser and mutation-XSS bypasses; a regex
 * sanitizer is not a security boundary.
 */
function sanitizeSvg(svg) {
  if (!svg) return "";

  // Older deployments name the head gradient "head". DOMPurify's
  // DOM-clobbering protection removes that id because `head` is a document
  // property, which leaves fill="url(#head)" pointing at nothing and makes the
  // head transparent. Rename it to a non-clobbering id before sanitizing.
  const normalized = String(svg)
    .replace(/id="head"/g, 'id="gp-head-fill"')
    .replace(/url\(#head\)/g, "url(#gp-head-fill)");

  return DOMPurify.sanitize(normalized, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ["script", "foreignObject", "iframe", "object", "embed", "style"],
  });
}
