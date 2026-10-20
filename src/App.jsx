import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BrowserProvider, Contract, JsonRpcProvider, isAddress, isHexString } from "ethers";
import DOMPurify from "dompurify";
import { authorizeClaim, CLAIM_PROTOCOL_VERSION, scrubClaimParameters } from "./claim-authorization.js";
import PendantView from "./PendantView.jsx";
import PlushCompanion from "./PlushCompanion.jsx";
import { makeGardenKey } from "./garden-state.js";
import {
  ACCESSORY_NAMES,
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

const CONFIGURED = isAddress(GLOWPET_ADDRESS) && !/^0x0{40}$/i.test(GLOWPET_ADDRESS);
const GardenView = lazy(() => import("./GardenView.jsx"));

export default function App() {
  // Claim data can arrive pre-filled from the charm's QR link.
  const initialClaim = useMemo(() => {
    try {
      return parseClaimCode(window.location.search);
    } catch (error) {
      return { error: error.message };
    }
  }, []);

  const [wallet, setWallet] = useState({ address: "", chainId: null });
  const [seriesId, setSeriesId] = useState(() => {
    const token = new URLSearchParams(window.location.search).get("token");
    return initialClaim.seriesId ?? (token && /^\d+$/.test(token) && BigInt(token) >= SERIES_STRIDE
      ? BigInt(token) / SERIES_STRIDE : SERIES_ID);
  });
  const [series, setSeries] = useState(null);
  const [seriesError, setSeriesError] = useState("");
  const [readChainId, setReadChainId] = useState(null);
  const [view, setView] = useState(() => {
    const tokenParam = new URLSearchParams(window.location.search).get("token");
    const requested = new URLSearchParams(window.location.search).get("view");
    if (tokenParam) return ["pendant", "garden"].includes(requested) ? requested : "pet";
    if (
      initialClaim.error ||
      initialClaim.serial !== undefined ||
      initialClaim.secret ||
      initialClaim.proof?.length
    ) {
      return "activate";
    }
    return ["home", "pets", "activate", "garden"].includes(requested) ? requested : "home";
  });
  const [featuredPet, setFeaturedPet] = useState(null);
  const [featuredLoading, setFeaturedLoading] = useState(true);
  const [collection, setCollection] = useState([]);
  const [collectionLoading, setCollectionLoading] = useState(false);
  const [collectionReady, setCollectionReady] = useState(false);
  const [collectionError, setCollectionError] = useState("");
  const [collectionNonce, setCollectionNonce] = useState(0);

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
  const petRequest = useRef(0);
  const findRequest = useRef(0);
  const [petLoading, setPetLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState("");
  const [txHash, setTxHash] = useState("");
  const [status, setStatus] = useState(() =>
    initialClaim.error
      ? { tone: "error", text: initialClaim.error }
      : initialClaim.serial !== undefined
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
    const params = scrubClaimParameters(window.location.search);
    const search = params.toString();
    window.history.replaceState({}, "", window.location.pathname + (search ? `?${search}` : ""));
  }, []);

  const isSepolia = wallet.chainId === SEPOLIA_CHAIN_ID;
  // A local Hardhat demo is a different chain from the wallet. Claims must be
  // blocked: otherwise MetaMask sends the claim calldata to a no-code address
  // on Sepolia, which succeeds without minting anything.
  const isDemoChain = readChainId !== null && readChainId !== SEPOLIA_CHAIN_ID;

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

  useEffect(() => {
    findRequest.current += 1;
  }, [wallet.address, seriesId]);

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
    let cancelled = false;
    readProvider
      .send("eth_chainId", [])
      .then((hex) => {
        if (!cancelled) setReadChainId(Number(BigInt(hex)));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [readProvider]);

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

  const fetchPet = useCallback(
    async (tokenId) => {
      if (!readContract) return null;
      const [uri, state, owner] = await Promise.all([
        readContract.tokenURI(tokenId),
        readContract.petState(tokenId),
        readContract.ownerOf(tokenId),
      ]);
      const decoded = decodeTokenURI(uri);

      return {
        tokenId: BigInt(tokenId),
        owner,
        metadata: decoded.metadata,
        svg: decoded.svg,
        traits: normalizePetState(state),
      };
    },
    [readContract],
  );

  const loadPetWithRetry = useCallback(
    async (tokenId, { attempts = 5, delayMs = 1000, quiet = false } = {}) => {
      if (!readContract) return null;
      const requestId = ++petRequest.current;
      if (!quiet) {
        setPetLoading(true);
        setStatus({ tone: "info", text: "Reading the pet from the contract…" });
      }
      let failure;
      for (let attempt = 0; attempt < attempts; attempt++) {
        if (requestId !== petRequest.current) return null;
        try {
          const next = await fetchPet(tokenId);
          if (requestId !== petRequest.current) return null;
          setPet(next);
          setPetLoading(false);
          if (!quiet) setStatus({ tone: "", text: "" });
          return next;
        } catch (error) {
          failure = error;
          if (requestId !== petRequest.current) return null;
          if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
      if (requestId === petRequest.current) {
        setPetLoading(false);
        if (!quiet) setStatus({ tone: "error", text: describeError(failure) });
      }
      return null;
    },
    [readContract, fetchPet],
  );

  const loadPet = useCallback(
    (tokenId, options = {}) => loadPetWithRetry(tokenId, { ...options, attempts: 1 }),
    [loadPetWithRetry],
  );

  const discoverPets = useCallback(
    async ({ owner = null, limit = 12 } = {}) => {
      if (!readContract) return [];

      const [claims, transfers] = await Promise.all([
        readContract.queryFilter(
          owner ? readContract.filters.Claimed(owner) : readContract.filters.Claimed(),
          DEPLOY_BLOCK,
          "latest",
        ),
        owner
          ? readContract.queryFilter(
              readContract.filters.Transfer(null, owner),
              DEPLOY_BLOCK,
              "latest",
            )
          : Promise.resolve([]),
      ]);

      const base = seriesId * SERIES_STRIDE;
      const candidates = new Map();

      for (const log of [...claims, ...transfers]) {
        const tokenId = log.args?.tokenId;
        if (tokenId === undefined || tokenId < base || tokenId >= base + SERIES_STRIDE) {
          continue;
        }
        const key = tokenId.toString();
        const previous = candidates.get(key);
        if (!previous || Number(log.blockNumber) >= Number(previous.blockNumber)) {
          candidates.set(key, log);
        }
      }

      const ordered = [...candidates.values()].sort(
        (a, b) =>
          Number(b.blockNumber) - Number(a.blockNumber) ||
          Number(b.index ?? 0) - Number(a.index ?? 0),
      );

      const pets = [];
      for (const log of ordered) {
        if (pets.length >= limit) break;
        const tokenId = log.args.tokenId;
        try {
          const currentOwner = await readContract.ownerOf(tokenId);
          if (owner && !sameAddress(currentOwner, owner)) continue;
          const fetched = await fetchPet(tokenId);
          if (fetched) pets.push(fetched);
        } catch {
          // A token that is not indexed yet, or that no longer exists.
        }
      }
      return pets;
    },
    [readContract, seriesId, fetchPet],
  );

  // Read-only view of a shared token link.
  useEffect(() => {
    if (view === "pendant") return;
    if (!linkedTokenId || !readContract) return;
    loadPetWithRetry(linkedTokenId, { attempts: 4 });
    return () => { petRequest.current += 1; };
  }, [linkedTokenId, readContract, loadPetWithRetry, view]);

  // Reopen the pet this wallet activated last, if it still owns it.
  useEffect(() => {
    if (linkedTokenId || !storageKey || !isSepolia || !readContract) return undefined;

    let cancelled = false;
    const saved = readSavedPet(storageKey);
    if (!saved) {
      if (!linkedTokenId) setPet(null);
      return undefined;
    }

    (async () => {
      try {
        const owner = await readContract.ownerOf(saved);
        if (cancelled) return;

        if (!sameAddress(owner, wallet.address)) {
          savePet(storageKey, null);
          setPet(null);
          return;
        }
        await loadPetWithRetry(saved, { quiet: true, attempts: 4 });
      } catch {
        if (!cancelled) setPet(null);
      }
    })();

    return () => {
      cancelled = true;
      petRequest.current += 1;
    };
  }, [storageKey, isSepolia, readContract, wallet.address, loadPetWithRetry, linkedTokenId]);

  // Homepage showcase: the most recent pet claimed in the active series.
  useEffect(() => {
    if (!readContract) {
      setFeaturedLoading(false);
      return undefined;
    }

    let cancelled = false;
    setFeaturedLoading(true);
    (async () => {
      try {
        const logs = await readContract.queryFilter(
          readContract.filters.Claimed(),
          DEPLOY_BLOCK,
          "latest",
        );
        const base = seriesId * SERIES_STRIDE;
        const latest = [...logs].reverse().find((log) => {
          const tokenId = log.args?.tokenId;
          return tokenId !== undefined && tokenId >= base && tokenId < base + SERIES_STRIDE;
        });
        if (!latest) {
          if (!cancelled) setFeaturedPet(null);
          return;
        }
        const fetched = await fetchPet(latest.args.tokenId);
        if (!cancelled) setFeaturedPet(fetched);
      } catch {
        if (!cancelled) setFeaturedPet(null);
      } finally {
        if (!cancelled) setFeaturedLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [readContract, seriesId, fetchPet]);

  // Collection scan runs when the My Pets view opens, or when the wallet,
  // series or demo chain changes. On a local demo it shows the series claims
  // read-only; on a real deployment it shows only the connected wallet's pets.
  useEffect(() => {
    if (view !== "pets") return undefined;
    if (!readContract) {
      setCollectionLoading(false);
      setCollectionReady(true);
      return undefined;
    }

    const owner = isDemoChain ? null : wallet.address;
    if (!isDemoChain && !owner) {
      setCollection([]);
      setCollectionError("");
      setCollectionLoading(false);
      setCollectionReady(true);
      return undefined;
    }

    let cancelled = false;
    setCollectionLoading(true);
    setCollectionReady(false);
    setCollectionError("");

    discoverPets({ owner })
      .then((pets) => {
        if (!cancelled) setCollection(pets);
      })
      .catch((error) => {
        if (!cancelled) setCollectionError(describeError(error));
      })
      .finally(() => {
        if (!cancelled) {
          setCollectionLoading(false);
          setCollectionReady(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    view,
    isDemoChain,
    wallet.address,
    readContract,
    discoverPets,
    collectionNonce,
  ]);

  async function findMyPet() {
    if (!readContract || !wallet.address) return;
    const requestId = ++findRequest.current;

    setBusy(true);
    setBusyLabel("Scanning events");
    try {
      const account = wallet.address;

      // Claims cover mints; Transfer also covers pets received from someone
      // else. Both are filtered to this wallet and the active series below.
      const [claims, transfers] = await Promise.all([
        readContract.queryFilter(
          readContract.filters.Claimed(account),
          DEPLOY_BLOCK,
          "latest",
        ),
        readContract.queryFilter(
          readContract.filters.Transfer(null, account),
          DEPLOY_BLOCK,
          "latest",
        ),
      ]);

      const base = seriesId * SERIES_STRIDE;
      const candidates = [...claims, ...transfers]
        .filter((log) => {
          const tokenId = log.args?.tokenId;
          return (
            tokenId !== undefined &&
            tokenId >= base &&
            tokenId < base + SERIES_STRIDE
          );
        })
        .sort(
          (a, b) =>
            Number(b.blockNumber) - Number(a.blockNumber) ||
            Number(b.index ?? 0) - Number(a.index ?? 0),
        );
      if (requestId !== findRequest.current) return;

      // Walk newest to oldest, skip duplicates, and only accept a token the
      // wallet still owns. A claimed-then-transferred token must not be shown.
      const seen = new Set();
      for (const log of candidates) {
        const tokenId = log.args.tokenId;
        const key = tokenId.toString();
        if (seen.has(key)) continue;
        seen.add(key);

        try {
          const owner = await readContract.ownerOf(tokenId);
          if (requestId !== findRequest.current) return;
          if (!sameAddress(owner, account)) continue;
        } catch {
          continue;
        }

        if (storageKey) savePet(storageKey, key);
        const loaded = await loadPet(tokenId);
        if (requestId !== findRequest.current) return;
        // loadPet sets its own error status on failure; do not overwrite it.
        if (loaded) {
          setLinkedTokenId(tokenId);
          setView("pet");
          const params = new URLSearchParams({ token: key });
          window.history.replaceState({}, "", `${window.location.pathname}?${params}`);
          window.scrollTo({ top: 0, behavior: reducedMotion ? "auto" : "smooth" });
          setStatus({ tone: "success", text: "Found your Glowpet on-chain." });
        }
        return;
      }

      setStatus({
        tone: "info",
        text: "No Glowpet currently owned by this wallet in this series.",
      });
    } catch (error) {
      const hint =
        DEPLOY_BLOCK === 0
          ? " Set VITE_DEPLOY_BLOCK to the deployment block if the RPC rejects a full-history scan."
          : "";
      if (requestId !== findRequest.current) return;
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
      if (parsed.proof) setProofInput(parsed.proof.join(", "));
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
      if (data.proof) setProofInput(data.proof.join(", "));
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
    if (isDemoChain) {
      setStatus({
        tone: "warn",
        text: `This local demo is read-only (chain ${readChainId}). Deploy the contracts to Sepolia to activate a charm.`,
      });
      return;
    }
    if (!window.ethereum) {
      setStatus({ tone: "error", text: "MetaMask was not detected. Install it and reload." });
      return;
    }

    // The button doubles as "Connect wallet" before the form is complete.
    // Ask for the connection first so an empty serial does not block it.
    if (!wallet.address) {
      await connectWallet();
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
      if (Number(network.chainId) !== SEPOLIA_CHAIN_ID) {
        throw new Error("Switch your wallet to Sepolia before activating this charm.");
      }

      // Do not send calldata to an address that has no contract on the
      // wallet's chain. This catches a local contract address used on Sepolia.
      const code = await provider.getCode(GLOWPET_ADDRESS);
      if (code === "0x") {
        setStatus({
          tone: "error",
          text: "No Glowpet contract at this address on the connected network. The transaction was not sent.",
        });
        return;
      }

      const contract = new Contract(GLOWPET_ADDRESS, GLOWPET_ABI, signer);
      let protocol;
      try {
        protocol = await contract.claimProtocolVersion();
      } catch {
        throw new Error("This deployment uses the older claim protocol. Deploy Glowpet v2 and generate a new series before activating.");
      }
      if (Number(protocol) !== CLAIM_PROTOCOL_VERSION) {
        throw new Error("This deployment does not support v2 claim credentials.");
      }

      if (!sameAddress(wallet.address, signerAddress)) {
        setWallet((previous) => ({ ...previous, address: signerAddress }));
      }

      const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
      setBusyLabel("Preparing claim");
      setStatus({
        tone: "info",
        text: "Checking your charm and preparing an authorization for your wallet.",
      });
      const currentSeries = normalizeSeriesInfo(await contract.seriesInfo(seriesId));
      if (!currentSeries.open) throw new Error("This series is closed and no longer accepting claims.");
      const { credentialSigner, signature } = await authorizeClaim({
        secret,
        proof,
        root: currentSeries.root,
        chainId: Number(network.chainId),
        contractAddress: GLOWPET_ADDRESS,
        seriesId,
        serial,
        recipient: signerAddress,
        deadline,
      });

      setBusyLabel("Activating");
      setStatus({
        tone: "info",
        text: "Your charm is verified. Confirm the activation transaction in your wallet.",
      });
      const tx = await contract.claim(
        seriesId,
        serial,
        credentialSigner,
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

      savePet(
        `glowpet:v1:${SEPOLIA_CHAIN_ID}:${seriesId.toString()}:${signerAddress.toLowerCase()}`,
        tokenId.toString(),
      );
      setSecretInput("");
      setProofInput("");
      setClaimCodeInput("");
      // Keep a ?token= view so a refresh can recover the portrait, and bring
      // the pet card into view instead of leaving the user on the form.
      setLinkedTokenId(tokenId);
      const urlParams = new URLSearchParams({ token: tokenId.toString() });
      if (allowMotion) urlParams.set("motion", "1");
      window.history.replaceState({}, "", `${window.location.pathname}?${urlParams.toString()}`);
      setView("pet");
      window.scrollTo({ top: 0, behavior: reducedMotion ? "auto" : "smooth" });
      setStatus({ tone: "success", text: "Charm activated on-chain. Loading your pet…" });

      readContract
        ?.seriesInfo(seriesId)
        .then((info) => setSeries(normalizeSeriesInfo(info)))
        .catch(() => {});
    } catch (error) {
      // A relayer may have submitted the same signed claim first. The token is
      // still ours, so show it instead of an alarming "already claimed" error.
      const revertName = error.revert?.name ?? error.info?.error?.name;
      if (revertName === "AlreadyClaimed" && claimedTo && readContract) {
        try {
          const existingId = seriesId * SERIES_STRIDE + BigInt(serial);
          const owner = await readContract.ownerOf(existingId);
          if (sameAddress(owner, claimedTo)) {
            savePet(
              `glowpet:v1:${SEPOLIA_CHAIN_ID}:${seriesId.toString()}:${claimedTo.toLowerCase()}`,
              existingId.toString(),
            );
            setSecretInput("");
            setProofInput("");
            setClaimCodeInput("");
            openPet(existingId);
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

  const claimButtonLabel = isDemoChain
    ? "Read-only local demo"
    : !wallet.address
      ? "Connect wallet to activate"
      : busy
        ? busyLabel || "Working…"
        : "Activate Glowpet";

  const homePet = pet ?? featuredPet;
  const homeSvg = useMemo(() => (homePet ? sanitizeSvg(homePet.svg) : ""), [homePet]);

  function navigate(next) {
    findRequest.current += 1;
    petRequest.current += 1;
    setPetLoading(false);
    setLinkedTokenId(null);
    setView(next);
    const params = new URLSearchParams(window.location.search);
    params.delete("token");
    params.set("view", next);
    const search = params.toString();
    window.history.replaceState({}, "", window.location.pathname + (search ? `?${search}` : ""));
    window.scrollTo({ top: 0, behavior: reducedMotion ? "auto" : "smooth" });
  }

  function openPet(tokenId) {
    findRequest.current += 1;
    const id = BigInt(tokenId);
    petRequest.current += 1;
    setPetLoading(true);
    setSeriesId(id / SERIES_STRIDE);
    setLinkedTokenId(id);
    setView("pet");
    setPet(null);
    const params = new URLSearchParams(window.location.search);
    params.set("token", id.toString());
    params.delete("view");
    if (allowMotion) params.set("motion", "1");
    window.history.replaceState({}, "", `${window.location.pathname}?${params.toString()}`);
    if (id === linkedTokenId && view === "pet") loadPetWithRetry(id, { attempts: 4 });
    window.scrollTo({ top: 0, behavior: reducedMotion ? "auto" : "smooth" });
  }

  function openPendant() {
    const params = new URLSearchParams({ token: pet.tokenId.toString(), view: "pendant" });
    setView("pendant");
    window.history.replaceState({}, "", `${window.location.pathname}?${params}`);
    window.scrollTo({ top: 0, behavior: reducedMotion ? "auto" : "smooth" });
  }

  function openGarden(companion = null) {
    findRequest.current += 1;
    petRequest.current += 1;
    setPetLoading(false);
    setStatus({ tone: "", text: "" });
    const params = new URLSearchParams({ view: "garden" });
    if (companion) {
      setPet(companion);
      setLinkedTokenId(companion.tokenId);
      setSeriesId(companion.traits.seriesId);
      params.set("token", companion.tokenId.toString());
    } else {
      setLinkedTokenId(null);
    }
    setView("garden");
    window.history.replaceState({}, "", `${window.location.pathname}?${params}`);
    window.scrollTo({ top: 0, behavior: reducedMotion ? "auto" : "smooth" });
  }

  function renderGarden() {
    const companion = linkedTokenId && pet?.tokenId === linkedTokenId ? pet : null;
    if (linkedTokenId && (!companion || readChainId === null)) {
      return (
        <section className="card collection-empty">
          <p className="eyebrow">YOUR GARDEN</p>
          <h1>{petLoading ? "Meeting your companion…" : "This companion is unavailable"}</h1>
          <p>{status.text || "We need to read this pet before opening its care journal."}</p>
          <div className="page-actions">
            <button type="button" className="ghost" disabled={petLoading} onClick={() => {
              readProvider.send("eth_chainId", [])
                .then((hex) => setReadChainId(Number(BigInt(hex))))
                .catch(() => setStatus({ tone: "error", text: "The network is unavailable. Try again, or use the guest garden." }));
              loadPetWithRetry(linkedTokenId);
            }}>
              Retry pet
            </button>
            <button type="button" className="primary" onClick={() => openGarden(null)}>Play in the guest garden</button>
          </div>
        </section>
      );
    }
    const key = makeGardenKey(companion ? {
      chainId: readChainId,
      contractAddress: GLOWPET_ADDRESS,
      tokenId: companion.tokenId,
      owner: companion.owner,
    } : {});
    return (
      <Suspense fallback={<div className="card collection-empty">Opening your garden…</div>}>
        <GardenView
          key={key}
          storageKey={key}
          pet={companion}
          onBack={() => companion ? openPet(companion.tokenId) : navigate("home")}
          onOpenPet={companion ? () => openPet(companion.tokenId) : undefined}
        />
      </Suspense>
    );
  }

  function renderHome() {
    return (
      <>
        <section className="home-hero">
          <div className="home-copy">
            <p className="eyebrow">PHYSICAL CHARM · ON-CHAIN PET</p>
            <h1>
              Every charm carries
              <br />
              <em>one unique pet.</em>
            </h1>
            <p className="lede">
              A limited-edition pendant with a screen. Scan its tag to claim the
              pet whose identity is derived from the charm's serial — owned by
              you, rendered by the contract, impossible to duplicate.
            </p>
            <div className="home-actions">
              <button type="button" className="primary home-cta" onClick={() => navigate("activate")}>
                Activate a Pet
              </button>
              <button type="button" className="ghost home-cta" onClick={() => navigate("pets")}>
                My Pets
              </button>
              <button type="button" className="ghost home-cta" onClick={() => openGarden(null)}>
                Enter the garden
              </button>
            </div>
            <div className="home-stats">
              <span>
                <strong>{series ? series.minted.toLocaleString("en-US") : "—"}</strong> claimed
              </span>
              <span>
                <strong>{series ? series.maxSupply.toLocaleString("en-US") : "—"}</strong> edition
              </span>
              <span>
                <strong>{series ? (series.open ? "Open" : "Closed") : "—"}</strong> status
              </span>
            </div>
          </div>

          <div className="home-showcase card">
            {homeSvg && homePet ? (
              <>
                <div
                  className="pet-stage force-motion"
                  dangerouslySetInnerHTML={{ __html: homeSvg }}
                  aria-label="Featured on-chain Glowpet"
                />
                <div className="home-showcase-meta">
                  <div>
                    <h2>
                      {SPECIES_NAMES[homePet.traits.species] ?? "Glowpet"}{" "}
                      <span>#{padSerial(homePet.traits.serial)}</span>
                    </h2>
                    <p>
                      {series?.label ?? "Glowpet"} · Token {homePet.tokenId.toString()}
                    </p>
                  </div>
                  <button
                    type="button"
                    className="ghost small"
                    onClick={() => openPet(homePet.tokenId)}
                  >
                    View pet
                  </button>
                </div>
              </>
            ) : featuredLoading ? (
              <div className="home-showcase-empty">
                <div className="spinner" aria-hidden="true" />
                <p>Looking for the newest pet on-chain…</p>
              </div>
            ) : (
              <div className="home-showcase-empty home-plush-preview">
                <span className="eyebrow">DELTAX · SOFT LITTLE FRIENDS</span>
                <PlushCompanion model="rabbit" motion forceMotion />
                <p>A little softness. A little everyday magic.</p>
                <button type="button" className="ghost small" onClick={() => openGarden(null)}>
                  Choose a Glowpet
                </button>
              </div>
            )}
          </div>
        </section>

        <section className="home-features">
          <article className="feature-card">
            <span className="feature-index">01</span>
            <h3>One charm, one pet</h3>
            <p>
              The serial and a private secret in the tag claim exactly one pet.
              No two charms share the same companion.
            </p>
          </article>
          <article className="feature-card">
            <span className="feature-index">02</span>
            <h3>Drawn by the contract</h3>
            <p>
              Traits and the SVG portrait are generated on-chain from the token
              id. No server, no IPFS, no disappearing art.
            </p>
          </article>
          <article className="feature-card">
            <span className="feature-index">03</span>
            <h3>Yours to carry</h3>
            <p>
              A standard ERC-721 asset. Transfer it, view it in your wallet, or
              take it anywhere — the website is only the entrance.
            </p>
          </article>
        </section>

        <section className="home-species">
          <p className="eyebrow">14 SPECIES</p>
          <div className="species-strip">
            {SPECIES_NAMES.map((name) => (
              <span key={name}>{name}</span>
            ))}
          </div>
        </section>
      </>
    );
  }

  function renderPets() {
    const canBrowse = isDemoChain || Boolean(wallet.address);

    return (
      <>
        <section className="page-head">
          <div>
            <p className="eyebrow">COLLECTION</p>
            <h1>My Pets</h1>
            <p className="lede">
              Select a companion to view its on-chain portrait, traits and history.
            </p>
          </div>
          <div className="page-actions">
            <button type="button" className="primary" onClick={() => navigate("activate")}>
              Activate a Pet
            </button>
            {!isDemoChain && !wallet.address && (
              <button type="button" className="ghost" onClick={connectWallet} disabled={busy}>
                Connect wallet
              </button>
            )}
            {canBrowse && (
              <button
                type="button"
                className="ghost"
                onClick={() => setCollectionNonce((value) => value + 1)}
                disabled={collectionLoading}
              >
                Refresh
              </button>
            )}
          </div>
        </section>

        {isDemoChain && (
          <p className="motion-note collection-note">
            Local demo collection: showing pets claimed in this series. Claims
            are read-only.
          </p>
        )}

        {!canBrowse ? (
          <section className="card collection-empty">
            <EmptyPet />
            <h2>Connect to see your pets</h2>
            <p>Your pets are held by your wallet, not by this website.</p>
            <button type="button" className="primary" onClick={connectWallet} disabled={busy}>
              Connect wallet
            </button>
          </section>
        ) : collectionLoading || !collectionReady ? (
          <div className="pet-grid" aria-label="Loading pets">
            {Array.from({ length: 6 }).map((_, index) => (
              <div className="pet-tile pet-tile-skeleton" key={index}>
                <div className="pet-tile-thumb" />
                <div className="pet-tile-body">
                  <span className="skeleton-line" />
                  <span className="skeleton-line short" />
                </div>
              </div>
            ))}
          </div>
        ) : collectionError ? (
          <div className="status error">{collectionError}</div>
        ) : collection.length === 0 ? (
          <section className="card collection-empty">
            <EmptyPet />
            <h2>No pets in this collection yet</h2>
            <p>Scan a charm's tag or enter its claim link to bring one home.</p>
            <button type="button" className="primary" onClick={() => navigate("activate")}>
              Activate a Pet
            </button>
          </section>
        ) : (
          <>
            <p className="collection-meta">
              {collection.length} pet{collection.length === 1 ? "" : "s"} · newest first
            </p>
            <div className="pet-grid">
              {collection.map((p) => (
                <button
                  type="button"
                  className="pet-tile"
                  key={p.tokenId.toString()}
                  onClick={() => openPet(p.tokenId)}
                >
                  <div
                    className="pet-tile-thumb"
                    dangerouslySetInnerHTML={{ __html: sanitizeSvg(p.svg) }}
                  />
                  <div className="pet-tile-body">
                    <div className="pet-tile-name">
                      <strong>{SPECIES_NAMES[p.traits.species] ?? "Glowpet"}</strong>
                      <span>#{padSerial(p.traits.serial)}</span>
                    </div>
                    <small>
                      {stageName(p.traits.stage)} · Lv.{p.traits.level}
                    </small>
                    <small>Owned by {shortAddress(p.owner)}</small>
                  </div>
                </button>
              ))}
            </div>
          </>
        )}
      </>
    );
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div className="page">
      <header className="topbar">
        <button type="button" className="brand" onClick={() => navigate("home")} aria-label="Glowpet home">
          <span className="brand-mark">
            <Logo />
          </span>
          <span className="brand-name">Glowpet</span>
          <span className="brand-badge">{series?.label ?? "ΔX"}</span>
        </button>

        <nav className="nav" aria-label="Main navigation">
          <button
            type="button"
            className={`nav-link${view === "home" ? " active" : ""}`}
            aria-current={view === "home" ? "page" : undefined}
            onClick={() => navigate("home")}
          >
            Home
          </button>
          <button
            type="button"
            className={`nav-link${view === "activate" ? " active" : ""}`}
            aria-current={view === "activate" ? "page" : undefined}
            onClick={() => navigate("activate")}
          >
            Activate
          </button>
          <button
            type="button"
            className={`nav-link${view === "pets" || view === "pet" ? " active" : ""}`}
            aria-current={view === "pets" || view === "pet" ? "page" : undefined}
            onClick={() => navigate("pets")}
          >
            My Pets
          </button>
          <button
            type="button"
            className={`nav-link${view === "garden" ? " active" : ""}`}
            aria-current={view === "garden" ? "page" : undefined}
            onClick={() => { if (view !== "garden") openGarden(pet); }}
          >
            Garden
          </button>
        </nav>

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

      {isDemoChain && (
        <div className="banner">
          <span>
            Local demo chain {readChainId}. Claims are read-only; deploy to Sepolia
            to activate a charm.
          </span>
        </div>
      )}

      <main>
        {(view === "home" || view === "pets") && status.text && (
          <div className={`status ${status.tone}`} role="status">{status.text}</div>
        )}
        {view === "home" && renderHome()}
        {view === "pets" && renderPets()}
        {view === "garden" && renderGarden()}
        {view === "pendant" && (linkedTokenId || pet) && (
          <PendantView
            tokenId={linkedTokenId ?? pet.tokenId}
            fetchPet={fetchPet}
            initialPet={pet}
            allowMotion={allowMotion}
            onClose={() => openPet(linkedTokenId ?? pet.tokenId)}
          />
        )}

        {(view === "activate" || view === "pet") && (
          <>
            {view === "pet" ? (
              <section className="page-head">
                <div>
                  <button type="button" className="back-link" onClick={() => navigate("pets")}>
                    ← Back to My Pets
                  </button>
                  <p className="eyebrow">PET DETAIL</p>
                  <h1>
                    {pet
                      ? `${SPECIES_NAMES[pet.traits.species] ?? "Glowpet"} #${padSerial(pet.traits.serial)}`
                      : linkedTokenId
                        ? `Token #${linkedTokenId.toString()}`
                        : "Pet detail"}
                  </h1>
                  <p className="lede">
                    {pet
                      ? `${stageName(pet.traits.stage)} · Lv.${pet.traits.level} · owned by ${shortAddress(pet.owner)}`
                      : "Reading this pet's portrait, traits and ownership from the contract."}
                  </p>
                </div>
                <div className="page-actions">
                  <button type="button" className="ghost" onClick={() => navigate("pets")}>
                    My Pets
                  </button>
                  <button type="button" className="primary" onClick={() => navigate("activate")}>
                    Activate a Pet
                  </button>
                </div>
              </section>
            ) : (
              <section className="page-head">
                <div>
                  <p className="eyebrow">ACTIVATE</p>
                  <h1>Unbox your pet</h1>
                  <p className="lede">
                    Scan the tag on your charm, or enter its serial and claim
                    credential below. The contract draws a pet only this charm
                    can produce.
                  </p>
                </div>
              </section>
            )}

            {view === "pet" && status.text && (
              <div className={`status ${status.tone}`}>{status.text}</div>
            )}
            {view === "pet" && txHash && !isDemoChain && (
              <a className="tx-link" href={txUrl(txHash)} target="_blank" rel="noreferrer">
                View activation transaction on Etherscan ↗
              </a>
            )}

            <div className={`layout${view === "pet" ? " detail-layout" : ""}`}>
              {view === "activate" && (
          <section className="card claim-card">
            <div className="card-head">
              <div>
                <p className="eyebrow">CLAIM CREDENTIALS</p>
                <h2>Your charm</h2>
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
                  <p className="hint">Use the credential printed on your charm, never your wallet's private key. It stays in this browser.</p>

                  <button type="submit" className="primary" disabled={busy || isDemoChain}>
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

            {txHash && !isDemoChain && (
              <a className="tx-link" href={txUrl(txHash)} target="_blank" rel="noreferrer">
                View transaction on Etherscan ↗
              </a>
            )}

            {claimSource && <p className="source">Credentials: {claimSource}</p>}
          </section>
              )}

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
                  <button type="button" className="primary small" onClick={() => openGarden(pet)}>
                    Care & garden
                  </button>
                  <button type="button" className="ghost small" onClick={openPendant}>
                    Pendant mode
                  </button>
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
                  {isDemoChain ? (
                    <span className="tx-link">Local demo · no explorer</span>
                  ) : (
                    <a
                      className="tx-link"
                      href={tokenUrl(GLOWPET_ADDRESS, pet.tokenId)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open on Etherscan ↗
                    </a>
                  )}
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
                {linkedTokenId ? (
                  <>
                    <p className="eyebrow">PET UNAVAILABLE</p>
                    <h2>Token #{linkedTokenId.toString()}</h2>
                    <p>
                      This token could not be loaded. Check the network and token
                      number, or retry after a recent claim confirms.
                    </p>
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => loadPetWithRetry(linkedTokenId)}
                      disabled={busy}
                    >
                      Retry now
                    </button>
                  </>
                ) : (
                  <>
                    <EmptyPet />
                    <p className="eyebrow">NO PET YET</p>
                    <h2>Your charm is still asleep.</h2>
                    <p>
                      Scan the code on your pendant to load its serial and claim
                      credential. The contract will draw a pet that only this serial
                      can produce.
                    </p>
                    {wallet.address && isSepolia && !isDemoChain && (
                      <button type="button" className="ghost" onClick={findMyPet} disabled={busy}>
                        Find my Glowpet on-chain
                      </button>
                    )}
                  </>
                )}
              </div>
            )}
          </section>
            </div>
          </>
        )}
      </main>

      <footer>
        <span>
          {isDemoChain
            ? `Local demo on chain ${readChainId}. No explorer; claims are disabled.`
            : "Art, traits and ownership live on Sepolia. No backend, no custody."}
        </span>
        <span className="footer-links">
          {CONFIGURED && !isDemoChain && (
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

// Storage is a convenience only. Disabled/full storage must never turn a mined
// claim into a reported failure, or stop a shared pet from loading.
function readSavedPet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function savePet(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch { /* The ?token URL still restores the pet. */ }
}
