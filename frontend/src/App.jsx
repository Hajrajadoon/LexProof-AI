import { useCallback, useEffect, useRef, useState } from "react";
import { generateReport } from "./generateReport";
import {
  connectCasperWallet,
  disconnectCasperWallet,
} from "./casperWallet";
import {
  getChainConfig,
  registerHashOnChain,
  saveChainResult,
  verifyHashOnChain,
  waitForTx,
} from "./casperRegistry";
import "./App.css";

const API_URL = (
  import.meta.env.VITE_API_URL || "http://127.0.0.1:8000"
).replace(/\/+$/, "");

const MAX_PDF_MB = 15;
const MAX_PDF_BYTES = MAX_PDF_MB * 1024 * 1024;
const HASH_PATTERN = /^[0-9a-fA-F]{64}$/;
const HISTORY_PREVIEW = 6;

/* ------------------------------------------------------------------
   Helpers (data handling is unchanged from the previous version)
------------------------------------------------------------------ */

function formatDate(value) {
  if (!value) return "Not available";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Not available"
    : date.toLocaleString();
}

function formatShortDate(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleDateString(undefined, {
        day: "numeric",
        month: "short",
        year: "numeric",
      });
}

function severityLabel(severity) {
  const normalized = String(severity || "unknown").toLowerCase();

  return [
    "critical",
    "high",
    "medium",
    "low",
    "info",
    "informational",
  ].includes(normalized)
    ? normalized
    : "unknown";
}

const SEVERITY_RANK = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
  informational: 4,
  unknown: 5,
};

function severityTone(label) {
  if (label === "critical" || label === "high") return "red";
  if (label === "medium") return "amber";
  if (label === "unknown") return "";
  return "green";
}

function parseJsonIfNeeded(value) {
  if (typeof value !== "string") return value;

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeAnalysis(record = {}) {
  const aiReport = parseJsonIfNeeded(record.ai_report);
  const analysisType = String(record.analysis_type || "").toLowerCase();

  const status =
    record.ai_status ||
    (aiReport && typeof aiReport === "object"
      ? "completed"
      : analysisType.includes("gemini")
        ? "completed"
        : "not_run");

  const rawFlags = record.flags ?? record.keyword_findings ?? [];

  const flags = Array.isArray(rawFlags)
    ? rawFlags.map((flag) => {
        if (typeof flag === "string") {
          return {
            category: flag,
            occurrences: 1,
            note: "This topic may deserve review.",
          };
        }

        return {
          ...flag,
          category: flag.category || flag.title || "Review topic",
          occurrences: Number(flag.occurrences ?? flag.count ?? 1),
          note:
            flag.note ||
            flag.description ||
            "This topic may deserve review.",
        };
      })
    : [];

  return {
    ...record,
    filename:
      record.filename ||
      record.document_name ||
      record.file_name ||
      "Pasted text",
    document_name:
      record.document_name ||
      record.filename ||
      record.file_name ||
      "Pasted text",
    document_summary:
      record.document_summary ||
      record.summary ||
      aiReport?.summary ||
      "",
    character_count:
      record.character_count ??
      record.characterCount ??
      record.characters ??
      0,
    word_count: record.word_count ?? record.wordCount ?? 0,
    sha256: record.sha256 || record.file_hash || "",
    file_hash: record.file_hash || record.sha256 || "",
    page_count: record.page_count ?? null,
    flags,
    ai_report:
      aiReport && typeof aiReport === "object" && !Array.isArray(aiReport)
        ? aiReport
        : null,
    ai_status: status,
    analysis_type: record.analysis_type || "preliminary_keyword_scan",
  };
}

function getObligationText(item) {
  if (typeof item === "string" || typeof item === "number") {
    return String(item);
  }

  if (!item || typeof item !== "object") {
    return "Obligation details unavailable";
  }

  return (
    item.obligation ||
    item.description ||
    item.text ||
    item.requirement ||
    item.title ||
    "Obligation details unavailable"
  );
}

function chainFields(record = {}) {
  return {
    chain_tx_hash: record.chain_tx_hash || null,
    chain_status: record.chain_status || null,
    chain_network: record.chain_network || null,
    chain_contract_hash: record.chain_contract_hash || null,
    chain_account: record.chain_account || null,
    chain_error: record.chain_error || null,
    chain_registered_at: record.chain_registered_at || null,
  };
}

function noticeTone(message) {
  const text = String(message || "").toLowerCase();

  if (/unavailable|first\.|please select|must be/.test(text)) return "warning";
  if (/failed|could not|cannot|unable|error/.test(text)) return "error";
  if (/completed|copied|generated|connected|refreshed|loaded|saved/.test(text)) {
    return "success";
  }
  return "info";
}

function friendlyChainError(error) {
  const text = String(error || "");
  if (/user error:?\s*1\b/i.test(text)) {
    return "Already registered: this hash was already on-chain, so the contract rejected the duplicate.";
  }
  return text;
}

function shortHash(value, head = 10, tail = 8) {
  if (!value) return "";
  return value.length <= head + tail + 1
    ? value
    : `${value.slice(0, head)}…${value.slice(-tail)}`;
}

function networkLabel(network) {
  return network === "casper-test" ? "Casper Testnet" : network || "Casper";
}

/* ------------------------------------------------------------------
   Small presentational pieces
------------------------------------------------------------------ */

const ICON_PATHS = {
  grid: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </>
  ),
  file: (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5M9 13h6M9 17h6" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3l7 3v5c0 5-3 8-7 10-4-2-7-5-7-10V6z" />
      <path d="M9 12l2 2 4-4" />
    </>
  ),
  report: (
    <>
      <rect x="5" y="5" width="14" height="16" rx="2" />
      <path d="M9 5V4h6v1M9 12h6M9 16h4" />
    </>
  ),
  upload: <path d="M12 16V4M7 9l5-5 5 5M5 20h14" />,
  download: <path d="M12 4v12M7 11l5 5 5-5M5 20h14" />,
  type: <path d="M4 7V5h16v2M12 5v14M9 19h6" />,
  check: <path d="M5 12.5l5 5 9-10" />,
  alert: (
    <>
      <path d="M12 4l9 16H3z" />
      <path d="M12 10v4M12 17.5v.01" />
    </>
  ),
  copy: (
    <>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V6a2 2 0 0 1 2-2h9" />
    </>
  ),
  external: (
    <>
      <path d="M14 4h6v6M20 4l-9 9" />
      <path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" />
    </>
  ),
  wallet: (
    <>
      <path d="M4 7a2 2 0 0 1 2-2h12v3" />
      <rect x="3" y="7" width="18" height="13" rx="2" />
      <circle cx="16.5" cy="13.5" r="1" />
    </>
  ),
  refresh: (
    <>
      <path d="M20 11a8 8 0 0 0-14-4M4 4v4h4" />
      <path d="M4 13a8 8 0 0 0 14 4M20 20v-4h-4" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8v.01" />
    </>
  ),
  sparkle: <path d="M12 3l2 5 5 2-5 2-2 5-2-5-5-2 5-2z" />,
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-4-4" />
    </>
  ),
  x: <path d="M6 6l12 12M18 6L6 18" />,
};

function Icon({ name, className = "" }) {
  return (
    <svg
      className={`icon ${className}`.trim()}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      {ICON_PATHS[name]}
    </svg>
  );
}

function LogoMark({ className = "" }) {
  return (
    <svg
      className={className}
      viewBox="0 0 100 100"
      role="img"
      aria-label="LexProof AI"
    >
      <defs>
        <linearGradient id="lpLogoBg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#1e3a8a" />
          <stop offset="1" stopColor="#0f1e3d" />
        </linearGradient>
        <linearGradient id="lpLogoCheck" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#2dd4bf" />
          <stop offset="1" stopColor="#22c55e" />
        </linearGradient>
      </defs>
      <rect width="100" height="100" rx="24" fill="url(#lpLogoBg)" />
      <path
        d="M32 20V74H64"
        fill="none"
        stroke="#ffffff"
        strokeWidth="10"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M54 46L68 60L90 30"
        fill="none"
        stroke="url(#lpLogoCheck)"
        strokeWidth="9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function AiBadge({ item }) {
  if (item.ai_status === "completed" && item.ai_report) {
    return <span className="badge blue">AI report</span>;
  }
  if (item.ai_status === "unavailable") {
    return <span className="badge amber">AI unavailable</span>;
  }
  return <span className="badge">Keyword scan</span>;
}

function ChainBadge({ status }) {
  if (status === "success") {
    return (
      <span className="badge green">
        <span className="dot" /> Registered
      </span>
    );
  }
  if (status === "pending") {
    return (
      <span className="badge amber">
        <span className="dot amber" /> Pending
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className="badge red">
        <span className="dot red" /> Failed
      </span>
    );
  }
  return null;
}

function chainSteps(analysis, busy) {
  const status = analysis?.chain_status;

  return [
    { key: "hash", label: "Hash created", state: "done" },
    {
      key: "sign",
      label: "Signed with Casper Wallet and sent",
      state: analysis?.chain_tx_hash ? "done" : busy ? "active" : "todo",
    },
    {
      key: "confirm",
      label: status === "failed" ? "Transaction failed" : "Confirmed on-chain",
      state:
        status === "success"
          ? "done"
          : status === "failed"
            ? "error"
            : status === "pending"
              ? "active"
              : "todo",
    },
  ];
}

/* ------------------------------------------------------------------
   Main component
------------------------------------------------------------------ */

const PAGE_TITLES = {
  overview: "Overview",
  documents: "Documents",
  verification: "Blockchain Verification",
  reports: "Reports",
};

function App() {
  const fileInput = useRef(null);

  const [file, setFile] = useState(null);
  const [documentText, setDocumentText] = useState("");
  const [activeTab, setActiveTab] = useState("overview");
  const [notice, setNotice] = useState("");
  const [analysis, setAnalysis] = useState(null);
  const [loading, setLoading] = useState(false);
  const [analysisCount, setAnalysisCount] = useState(0);
  const [analysisHistory, setAnalysisHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState("");
  const [showAllHistory, setShowAllHistory] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [walletPublicKey, setWalletPublicKey] = useState("");
  const [walletLoading, setWalletLoading] = useState(false);
  const [walletError, setWalletError] = useState("");
  const [chainConfig, setChainConfig] = useState(null);
  const [chainBusy, setChainBusy] = useState(false);
  const [chainMessage, setChainMessage] = useState("");
  const [checkHash, setCheckHash] = useState("");
  const [checkBusy, setCheckBusy] = useState(false);
  const [checkResult, setCheckResult] = useState(null);

  const handleConnectWallet = async () => {
    setWalletLoading(true);
    setWalletError("");

    try {
      const { publicKey } = await connectCasperWallet();
      setWalletPublicKey(publicKey);
      setNotice("Casper Wallet connected successfully.");
    } catch (error) {
      setWalletError(
        error instanceof Error
          ? error.message
          : "Could not connect to Casper Wallet."
      );
    } finally {
      setWalletLoading(false);
    }
  };

  const handleDisconnectWallet = async () => {
    setWalletLoading(true);
    setWalletError("");

    try {
      await disconnectCasperWallet();
      setWalletPublicKey("");
      setNotice("Casper Wallet disconnected.");
    } catch (error) {
      setWalletError(
        error instanceof Error
          ? error.message
          : "Could not disconnect Casper Wallet."
      );
    } finally {
      setWalletLoading(false);
    }
  };

  const loadHistory = useCallback(async (showNotice = false) => {
    setHistoryLoading(true);
    setHistoryError("");

    try {
      const response = await fetch(`${API_URL}/api/analyses?limit=20`, {
        method: "GET",
        headers: { Accept: "application/json" },
        cache: "no-store",
      });

      const responseText = await response.text();

      if (!response.ok) {
        throw new Error(
          `History API returned HTTP ${response.status}` +
            (responseText ? `: ${responseText.slice(0, 250)}` : ".")
        );
      }

      if (!responseText.trim()) {
        throw new Error("The history API returned an empty response.");
      }

      let data;

      try {
        data = JSON.parse(responseText);
      } catch {
        throw new Error("The history API did not return valid JSON.");
      }

      const records = Array.isArray(data)
        ? data
        : Array.isArray(data?.analyses)
          ? data.analyses
          : Array.isArray(data?.items)
            ? data.items
            : Array.isArray(data?.results)
              ? data.results
              : null;

      if (!records) {
        throw new Error(
          "Unexpected history response format. Expected an array of analyses."
        );
      }

      const normalizedRecords = records.map(normalizeAnalysis);

      setAnalysisHistory(normalizedRecords);

      const returnedCount = Number(
        data?.total_count ?? data?.count ?? normalizedRecords.length
      );

      setAnalysisCount(
        Number.isFinite(returnedCount) && returnedCount >= 0
          ? returnedCount
          : normalizedRecords.length
      );

      if (showNotice) {
        setNotice(
          `History refreshed successfully. ${normalizedRecords.length} record(s) loaded.`
        );
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown history error.";

      setHistoryError(message);

      if (showNotice) {
        setNotice(`Could not refresh history: ${message}`);
      }

      console.error("LexProof history loading failed:", error);
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  useEffect(() => {
    getChainConfig(API_URL)
      .then(setChainConfig)
      .catch(() => setChainConfig({ configured: false }));
  }, []);

  // Bring the results into view whenever a different analysis is opened.
  const openAnalysisId = analysis?.id ?? null;

  useEffect(() => {
    if (openAnalysisId === null) return;

    const timer = setTimeout(() => {
      document
        .getElementById("results")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 80);

    return () => clearTimeout(timer);
  }, [openAnalysisId]);

  // Success and info messages disappear by themselves. Errors stay until dismissed.
  useEffect(() => {
    if (!notice || noticeTone(notice) === "error") return undefined;

    const timer = setTimeout(() => setNotice(""), 7000);
    return () => clearTimeout(timer);
  }, [notice]);

  function acceptFile(selectedFile) {
    if (!selectedFile) return;

    const isPdf =
      selectedFile.type === "application/pdf" ||
      selectedFile.name.toLowerCase().endsWith(".pdf");

    if (!isPdf) {
      setNotice("Please select a PDF document.");
      setFile(null);
      return;
    }

    if (selectedFile.size > MAX_PDF_BYTES) {
      setNotice(`The PDF must be ${MAX_PDF_MB} MB or smaller.`);
      setFile(null);
      return;
    }

    setFile(selectedFile);
    setAnalysis(null);
    setNotice("PDF selected. Click Analyze document to analyze its contents.");
  }

  function handleFileChange(event) {
    acceptFile(event.target.files?.[0]);
  }

  function handleDrop(event) {
    event.preventDefault();
    setDragActive(false);
    acceptFile(event.dataTransfer?.files?.[0]);
  }

  async function handleAnalyze() {
    const text = documentText.trim();

    if (!file && !text) {
      setNotice("Upload a PDF or paste contract text first.");
      return;
    }

    setLoading(true);
    setNotice("");
    setAnalysis(null);
    setChainMessage("");

    try {
      let response;

      if (file) {
        const formData = new FormData();
        formData.append("file", file);

        response = await fetch(`${API_URL}/api/analyze-pdf`, {
          method: "POST",
          body: formData,
        });
      } else {
        response = await fetch(`${API_URL}/api/analyze-text`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({ text }),
        });
      }

      const responseText = await response.text();
      let data;

      try {
        data = responseText ? JSON.parse(responseText) : {};
      } catch {
        throw new Error(
          `The backend returned an invalid response (HTTP ${response.status}).`
        );
      }

      if (!response.ok) {
        let message = "The document could not be analyzed.";

        if (typeof data.detail === "string") {
          message = data.detail;
        } else if (Array.isArray(data.detail)) {
          message = data.detail
            .map((item) => item.msg || "Invalid input")
            .join("; ");
        }

        throw new Error(message);
      }

      const normalized = normalizeAnalysis(data);
      setAnalysis(normalized);

      await loadHistory();

      if (normalized.ai_report && normalized.ai_status === "completed") {
        setNotice(
          `${file ? "PDF" : "Text"} analysis completed. Gemini AI report is ready.` +
            (data.saved_to_database ? " Result saved to database." : "")
        );
      } else if (normalized.ai_status === "unavailable") {
        setNotice(
          "Analysis finished, but AI was unavailable. Review the keyword scan below."
        );
      } else {
        setNotice(
          "The document was processed, but the response contains no AI report. Check the backend response and server logs."
        );
      }
    } catch (error) {
      console.error("LexProof document analysis failed:", error);

      setNotice(
        error.message === "Failed to fetch"
          ? `Cannot reach the backend at ${API_URL}. Check your backend and frontend configuration.`
          : `Analysis failed: ${error.message}`
      );
    } finally {
      setLoading(false);
    }
  }

  async function handleRegisterOnChain() {
    const hash = (analysis?.sha256 || analysis?.file_hash || "").toLowerCase();

    if (!analysis?.id || !hash) {
      setChainMessage("Analyze a document first.");
      return;
    }

    if (!chainConfig?.configured) {
      setChainMessage(
        "Blockchain is not configured. Add CASPER_CONTRACT_HASH to the backend settings and restart the backend."
      );
      return;
    }

    setChainBusy(true);
    setChainMessage("");

    try {
      // 1) Was this same document already registered by an earlier analysis?
      const earlier = analysisHistory.find(
        (item) =>
          item.id !== analysis.id &&
          (item.file_hash || "").toLowerCase() === hash &&
          item.chain_status === "success" &&
          item.chain_tx_hash
      );

      if (earlier) {
        const linked = await saveChainResult(API_URL, analysis.id, {
          tx_hash: earlier.chain_tx_hash,
          status: "success",
          account: earlier.chain_account || undefined,
        });
        setAnalysis((prev) => ({ ...prev, ...chainFields(linked) }));
        setChainMessage(
          "This document was already registered earlier. That blockchain record is now linked to this analysis. No new transaction was needed."
        );
        await loadHistory();
        return;
      }

      // 2) Free on-chain check, so we never pay for a duplicate.
      try {
        const existing = await verifyHashOnChain(API_URL, hash);
        if (existing.registered) {
          setChainMessage("This hash is already registered on the blockchain.");
          return;
        }
      } catch (checkError) {
        const reason =
          checkError instanceof Error ? checkError.message : "unknown error";
        const proceed = window.confirm(
          "Could not check the blockchain first (" +
            reason +
            "). Registering a hash that already exists fails and still costs CSPR. Register anyway?"
        );
        if (!proceed) {
          setChainMessage("Registration cancelled. No CSPR was spent.");
          return;
        }
      }

      setChainMessage("Connecting to Casper Wallet...");
      const { provider, publicKey } = await connectCasperWallet();
      setWalletPublicKey(publicKey);

      setChainMessage(
        "Approve the transaction in Casper Wallet. It uses a small amount of CSPR."
      );

      const txHash = await registerHashOnChain({
        apiUrl: API_URL,
        provider,
        publicKey,
        contractHash: chainConfig.contract_hash,
        network: chainConfig.network,
        documentHash: hash,
      });

      await saveChainResult(API_URL, analysis.id, {
        tx_hash: txHash,
        status: "pending",
        account: publicKey,
      });

      setAnalysis((prev) => ({
        ...prev,
        chain_tx_hash: txHash,
        chain_status: "pending",
        chain_network: chainConfig.network,
        chain_account: publicKey,
      }));

      setChainMessage("Transaction sent. Waiting for the network to confirm...");

      const finalResult = await waitForTx(API_URL, txHash);

      const saved = await saveChainResult(API_URL, analysis.id, {
        tx_hash: txHash,
        status: finalResult.status,
        account: publicKey,
        error: finalResult.error,
      });

      setAnalysis((prev) => ({ ...prev, ...chainFields(saved) }));

      setChainMessage(
        finalResult.status === "success"
          ? "Registered on the Casper blockchain."
          : finalResult.status === "failed"
            ? `The transaction failed: ${finalResult.error || "unknown error"}`
            : "Still pending. Press Verify on-chain in a minute."
      );

      await loadHistory();
    } catch (error) {
      setChainMessage(
        error instanceof Error ? error.message : "Blockchain registration failed."
      );
    } finally {
      setChainBusy(false);
    }
  }

  async function handleVerifyOnChain() {
    const hash = (analysis?.sha256 || analysis?.file_hash || "").toLowerCase();

    if (!hash) return;

    setChainBusy(true);
    setChainMessage("Checking the blockchain...");

    try {
      const result = await verifyHashOnChain(API_URL, hash);
      setChainMessage(
        result.registered
          ? "Verified: this hash is registered on the Casper blockchain."
          : "Not found: this hash is not registered on the blockchain."
      );
    } catch (error) {
      setChainMessage(
        error instanceof Error ? error.message : "Verification failed."
      );
    } finally {
      setChainBusy(false);
    }
  }

  async function handleCheckHash(event) {
    event.preventDefault();

    const value = checkHash.trim().toLowerCase();

    if (!HASH_PATTERN.test(value)) {
      setCheckResult({
        tone: "bad",
        message:
          "Enter a 64-character SHA-256 hash (digits 0-9 and letters a-f).",
      });
      return;
    }

    setCheckBusy(true);
    setCheckResult(null);

    try {
      const result = await verifyHashOnChain(API_URL, value);
      setCheckResult(
        result.registered
          ? {
              tone: "ok",
              message: "Registered: this hash is on the Casper blockchain.",
            }
          : {
              tone: "bad",
              message:
                "Not found: this hash is not registered on the blockchain.",
            }
      );
    } catch (error) {
      setCheckResult({
        tone: "bad",
        message: error instanceof Error ? error.message : "Verification failed.",
      });
    } finally {
      setCheckBusy(false);
    }
  }

  function explorerLink(txHash) {
    return `${chainConfig?.explorer_tx_url || "https://testnet.cspr.live/transaction/"}${txHash}`;
  }

  async function copyText(value, label) {
    if (!value) return;

    try {
      await navigator.clipboard.writeText(value);
      setNotice(`${label} copied to clipboard.`);
    } catch {
      setNotice(`Unable to copy automatically. Select and copy the ${label} manually.`);
    }
  }

  function handleDownloadReport(target = analysis) {
    if (!target) {
      setNotice("Analyze a document or load a saved result before creating a report.");
      return;
    }

    try {
      generateReport(target);
      setNotice("PDF report generated. Check your browser downloads.");
    } catch (error) {
      console.error("LexProof PDF report generation failed:", error);
      setNotice(
        `Could not generate the PDF report: ${
          error instanceof Error ? error.message : "Unknown error."
        }`
      );
    }
  }

  function clearDocument() {
    setDocumentText("");
    setFile(null);
    setAnalysis(null);
    setNotice("");
    setChainMessage("");

    if (fileInput.current) {
      fileInput.current.value = "";
    }
  }

  function viewSavedResult(item) {
    setAnalysis(normalizeAnalysis(item));
    setChainMessage("");
    setNotice(`Loaded saved analysis #${item.id}.`);
  }

  /* ---------- derived values ---------- */

  const aiReport = analysis?.ai_report || null;
  const aiStatus = analysis?.ai_status || "not_run";
  const isAiComplete = aiStatus === "completed" && Boolean(aiReport);

  const obligations = Array.isArray(aiReport?.key_obligations)
    ? aiReport.key_obligations
    : [];
  const questions = Array.isArray(aiReport?.questions_for_lawyer)
    ? aiReport.questions_for_lawyer
    : [];
  const risks = Array.isArray(aiReport?.risk_findings)
    ? [...aiReport.risk_findings].sort(
        (a, b) =>
          SEVERITY_RANK[severityLabel(a?.severity)] -
          SEVERITY_RANK[severityLabel(b?.severity)]
      )
    : [];

  const severityCounts = risks.reduce((counts, finding) => {
    const label = severityLabel(finding?.severity);
    counts[label] = (counts[label] || 0) + 1;
    return counts;
  }, {});

  const metrics = analysis
    ? [{ label: "Words", value: analysis.word_count }].concat(
        isAiComplete
          ? [
              { label: "Risk findings", value: risks.length },
              { label: "Obligations", value: obligations.length },
              { label: "Lawyer questions", value: questions.length },
            ]
          : [{ label: "Keyword topics", value: analysis.flags.length }]
      )
    : [];

  const analysisHash = (analysis?.sha256 || analysis?.file_hash || "").toLowerCase();
  const chainStatus = analysis?.chain_status || null;
  const proofClass =
    chainStatus === "success"
      ? "ok"
      : chainStatus === "failed"
        ? "bad"
        : chainStatus === "pending"
          ? "wait"
          : "";

  const registeredItems = analysisHistory.filter((item) => item.chain_status);
  const verifiedCount = analysisHistory.filter(
    (item) => item.chain_status === "success"
  ).length;
  const visibleHistory = showAllHistory
    ? analysisHistory
    : analysisHistory.slice(0, HISTORY_PREVIEW);

  const networkText =
    chainConfig === null
      ? "Connecting…"
      : chainConfig.configured
        ? networkLabel(chainConfig.network)
        : "Blockchain not configured";
  const networkDot =
    chainConfig === null ? "gray" : chainConfig.configured ? "" : "amber";

  const showWorkspace = activeTab === "overview" || activeTab === "documents";
  const toastTone = noticeTone(notice);

  /* ---------- render ---------- */

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <LogoMark className="brand-logo" />
          <div>
            <div className="brand-name">
              LexProof <span>AI</span>
            </div>
            <div className="brand-tag">LEGAL INTELLIGENCE</div>
          </div>
        </div>

        <div className="nav-label">WORKSPACE</div>

        <nav className="nav" aria-label="Main">
          {[
            ["overview", "grid", "Overview"],
            ["documents", "file", "Documents"],
            ["verification", "shield", "Blockchain Verification"],
            ["reports", "report", "Reports"],
          ].map(([key, icon, label]) => (
            <button
              key={key}
              type="button"
              className={activeTab === key ? "nav-item active" : "nav-item"}
              aria-current={activeTab === key ? "page" : undefined}
              onClick={() => setActiveTab(key)}
            >
              <Icon name={icon} /> {label}
            </button>
          ))}
        </nav>

        <div className="sidebar-bottom">
          <div className="privacy-card">
            <Icon name="lock" />
            <h3>Privacy by design</h3>
            <p>
              Only the SHA-256 hash is written to the blockchain. Your document
              is never put on-chain.
            </p>
          </div>

          <div className="env-line">
            <span className="dot amber" />
            <span>Prototype · Testnet only</span>
          </div>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="crumbs">
            Workspace <span aria-hidden="true">/</span>{" "}
            <strong>{PAGE_TITLES[activeTab]}</strong>
          </div>

          <div className="topbar-right">
            <span className="pill">
              <span className={`dot ${networkDot}`.trim()} /> {networkText}
            </span>

            {walletPublicKey ? (
              <>
                <span className="pill mono" title={walletPublicKey}>
                  <Icon name="wallet" className="" />
                  {shortHash(walletPublicKey, 8, 6)}
                </span>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={handleDisconnectWallet}
                  disabled={walletLoading}
                >
                  {walletLoading ? "Please wait…" : "Disconnect"}
                </button>
              </>
            ) : (
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={handleConnectWallet}
                disabled={walletLoading}
              >
                <Icon name="wallet" />
                {walletLoading ? "Connecting…" : "Connect Casper Wallet"}
              </button>
            )}

            {walletError && (
              <span className="wallet-error" role="alert">
                {walletError}
              </span>
            )}
          </div>
        </header>

        <div className="page">
          {activeTab === "overview" && (
            <>
              <section className="hero">
                <div>
                  <div className="eyebrow">
                    AI-POWERED LEGAL DOCUMENT INTELLIGENCE
                  </div>
                  <h2>
                    Clarity for every <span>contract.</span>
                  </h2>
                  <p>
                    Understand legal documents, identify clauses that deserve a
                    closer look, and verify document integrity with blockchain
                    technology.
                  </p>
                </div>

                <ol className="hero-steps">
                  <li>
                    <span className="num">1</span>
                    <div>
                      <strong>Understand</strong>
                      <span>Plain-language summary and key obligations</span>
                    </div>
                  </li>
                  <li>
                    <span className="num">2</span>
                    <div>
                      <strong>Review</strong>
                      <span>Flagged risks with evidence and lawyer questions</span>
                    </div>
                  </li>
                  <li>
                    <span className="num">3</span>
                    <div>
                      <strong>Verify</strong>
                      <span>Register the document hash on Casper</span>
                    </div>
                  </li>
                </ol>
              </section>

              <section className="stats" aria-label="Summary">
                <div className="stat">
                  <span className="icon-box">
                    <Icon name="file" />
                  </span>
                  <div style={{ minWidth: 0 }}>
                    <div className="stat-label">Selected document</div>
                    <div className="stat-value">{file ? "1" : "0"}</div>
                    <div className="stat-note">
                      {file ? file.name : "Nothing selected yet"}
                    </div>
                  </div>
                </div>

                <div className="stat">
                  <span className="icon-box teal">
                    <Icon name="sparkle" />
                  </span>
                  <div>
                    <div className="stat-label">Saved analyses</div>
                    <div className="stat-value">{analysisCount}</div>
                    <div className="stat-note">Stored in the database</div>
                  </div>
                </div>

                <div className="stat">
                  <span className="icon-box green">
                    <Icon name="shield" />
                  </span>
                  <div>
                    <div className="stat-label">Verified on-chain</div>
                    <div className="stat-value">{verifiedCount}</div>
                    <div className="stat-note">Registered on Casper</div>
                  </div>
                </div>
              </section>
            </>
          )}

          {activeTab === "documents" && (
            <div className="page-title">
              <h2>Documents</h2>
              <p>Analyze a new document or reopen a saved one.</p>
            </div>
          )}

          {showWorkspace && (
            <>
              <div className="section-head">
                <div>
                  <h2>Analyze a document</h2>
                  <p>Upload a PDF or paste the text of a contract.</p>
                </div>
              </div>

              <section className="analyzer">
                <div className="card">
                  <div className="card-head">
                    <div className="card-title">
                      <span className="icon-box">
                        <Icon name="upload" />
                      </span>
                      <div>
                        <h3>Upload a PDF</h3>
                        <p>Up to {MAX_PDF_MB} MB</p>
                      </div>
                    </div>
                  </div>

                  <button
                    type="button"
                    className={
                      "dropzone" +
                      (dragActive ? " drag" : "") +
                      (file ? " has-file" : "")
                    }
                    onClick={() => fileInput.current?.click()}
                    onDragEnter={(event) => {
                      event.preventDefault();
                      setDragActive(true);
                    }}
                    onDragOver={(event) => event.preventDefault()}
                    onDragLeave={() => setDragActive(false)}
                    onDrop={handleDrop}
                  >
                    <span className={file ? "icon-box green" : "icon-box"}>
                      <Icon name={file ? "check" : "upload"} />
                    </span>
                    <strong>
                      {file ? file.name : "Drop a PDF here, or click to browse"}
                    </strong>
                    <span className="hint">
                      {file
                        ? `${(file.size / 1024 / 1024).toFixed(2)} MB · Click to choose another file`
                        : `PDF documents up to ${MAX_PDF_MB} MB`}
                    </span>
                  </button>

                  <input
                    ref={fileInput}
                    type="file"
                    accept=".pdf,application/pdf"
                    hidden
                    onChange={handleFileChange}
                  />

                  <p className="fineprint">
                    <Icon name="alert" />
                    <span>
                      Do not upload sensitive or confidential documents to this
                      demo.
                    </span>
                  </p>
                </div>

                <div className="card">
                  <div className="card-head">
                    <div className="card-title">
                      <span className="icon-box teal">
                        <Icon name="type" />
                      </span>
                      <div>
                        <h3>Paste contract text</h3>
                        <p>Analyzed by Google Gemini</p>
                      </div>
                    </div>
                  </div>

                  <textarea
                    className="paste"
                    value={documentText}
                    onChange={(event) => setDocumentText(event.target.value)}
                    placeholder="Paste a contract clause or agreement text here..."
                    aria-label="Contract text"
                    maxLength={100000}
                  />

                  <div className="paste-foot">
                    <span>{documentText.length.toLocaleString()} / 100,000 characters</span>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={clearDocument}
                    >
                      Clear
                    </button>
                  </div>
                </div>
              </section>

              {loading ? (
                <div className="analyzing" role="status">
                  <span className="spinner dark" />
                  <div>
                    <strong>Analyzing your document…</strong>
                    <span>
                      Extracting the text and running the Gemini review. Longer
                      documents can take a little while.
                    </span>
                  </div>
                </div>
              ) : (
                <section className="action-bar">
                  <p>
                    <Icon name="shield" />
                    After the analysis you can register the document hash on
                    the Casper blockchain.
                  </p>

                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={handleAnalyze}
                  >
                    <Icon name="sparkle" /> Analyze document
                  </button>
                </section>
              )}

              <div className="section-head">
                <div>
                  <h2>Saved analyses</h2>
                  <p>Recent results retrieved from the connected backend.</p>
                </div>

                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => loadHistory(true)}
                  disabled={historyLoading}
                >
                  {historyLoading ? (
                    <span className="spinner dark" />
                  ) : (
                    <Icon name="refresh" />
                  )}
                  Refresh
                </button>
              </div>

              {historyError && (
                <div className="alert" role="alert">
                  <Icon name="alert" />
                  <div>
                    <strong>History could not be loaded.</strong>
                    {historyError}
                  </div>
                </div>
              )}

              {historyLoading && analysisHistory.length === 0 ? (
                <div className="history" aria-busy="true">
                  <div className="skeleton" />
                  <div className="skeleton" />
                  <div className="skeleton" />
                </div>
              ) : analysisHistory.length === 0 ? (
                <div className="card empty">
                  <span className="icon-box">
                    <Icon name="file" />
                  </span>
                  <strong>No saved analyses yet</strong>
                  <p>
                    {historyError
                      ? "History is unavailable until the error above is resolved."
                      : "Analyze a PDF or paste some text and your first result will appear here."}
                  </p>
                </div>
              ) : (
                <>
                  <div className="history">
                    {visibleHistory.map((item, index) => (
                      <div
                        className="history-row"
                        key={item.id ?? `${item.document_name}-${index}`}
                      >
                        <span className="icon-box">
                          <Icon
                            name={
                              item.page_count != null ||
                              /\.pdf$/i.test(item.document_name)
                                ? "file"
                                : "type"
                            }
                          />
                        </span>

                        <div className="history-main">
                          <div className="history-name" title={item.document_name}>
                            {item.document_name}
                          </div>
                          <div className="history-meta">
                            {formatDate(item.created_at)} · {item.word_count}{" "}
                            words
                          </div>
                        </div>

                        <div className="history-badges">
                          <AiBadge item={item} />
                          <ChainBadge status={item.chain_status} />
                        </div>

                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={() => viewSavedResult(item)}
                        >
                          View
                        </button>
                      </div>
                    ))}
                  </div>

                  {analysisHistory.length > HISTORY_PREVIEW && (
                    <div className="more-row">
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => setShowAllHistory((value) => !value)}
                      >
                        {showAllHistory
                          ? "Show fewer"
                          : `Show all ${analysisHistory.length}`}
                      </button>
                    </div>
                  )}
                </>
              )}

              {analysis && (
                <>
                  <div className="section-head" id="results">
                    <div>
                      <h2>Analysis results</h2>
                      <p>
                        Review the AI report and the document integrity
                        information.
                      </p>
                    </div>
                  </div>

                  <section className="results" aria-live="polite">
                    <div className="card result-head">
                      <div className="result-head-top">
                        <div style={{ minWidth: 0 }}>
                          <h3>{analysis.document_name || analysis.filename}</h3>
                          <div className="result-meta">
                            <span>
                              {analysis.page_count != null
                                ? `PDF · ${analysis.page_count} page${analysis.page_count === 1 ? "" : "s"}`
                                : /\.pdf$/i.test(analysis.document_name || "")
                                  ? "PDF document"
                                  : "Text analysis"}
                            </span>
                            {analysis.created_at && (
                              <span>Saved {formatDate(analysis.created_at)}</span>
                            )}
                            {aiReport?.document_type && (
                              <span>Type: {aiReport.document_type}</span>
                            )}
                          </div>
                        </div>

                        <div className="tags">
                          <span
                            className={
                              "badge " +
                              (isAiComplete
                                ? "blue"
                                : aiStatus === "unavailable"
                                  ? "amber"
                                  : "")
                            }
                          >
                            {isAiComplete
                              ? "Gemini AI completed"
                              : aiStatus === "unavailable"
                                ? "AI unavailable"
                                : "AI report not available"}
                          </span>
                          <ChainBadge status={chainStatus} />
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            onClick={() => handleDownloadReport()}
                          >
                            <Icon name="download" /> PDF report
                          </button>
                        </div>
                      </div>

                      <p className="summary-text">
                        {aiReport?.summary ||
                          analysis.document_summary ||
                          "No summary is available for this record."}
                      </p>

                      <div className="metrics">
                        {metrics.map((metric) => (
                          <div className="metric" key={metric.label}>
                            <span>{metric.label}</span>
                            <strong>{metric.value}</strong>
                          </div>
                        ))}
                      </div>

                      {!isAiComplete && (
                        <p className="note">
                          This record has no usable AI report. It may have been
                          created by the keyword-only analyzer, or AI analysis
                          may have been unavailable. Run the analysis again
                          after confirming that the Gemini-enabled backend is
                          connected.
                        </p>
                      )}
                    </div>

                    <div className="results-layout">
                      <div className="results-main">
                        {isAiComplete && (
                          <>
                            <div className="card">
                              <div className="card-head">
                                <div className="card-title">
                                  <span className="icon-box red">
                                    <Icon name="alert" />
                                  </span>
                                  <div>
                                    <h3>Risk findings</h3>
                                    <p>
                                      Potential concerns to review. Severity is
                                      an AI assessment, not a legal conclusion.
                                    </p>
                                  </div>
                                </div>
                              </div>

                              {risks.length === 0 ? (
                                <p className="muted">
                                  No specific risk findings were returned by the
                                  AI. This does not guarantee that the document
                                  is risk-free.
                                </p>
                              ) : (
                                <>
                                  <div className="sev-summary">
                                    {Object.keys(SEVERITY_RANK)
                                      .filter((label) => severityCounts[label])
                                      .map((label) => (
                                        <span
                                          key={label}
                                          className={`badge ${severityTone(label)}`.trim()}
                                        >
                                          {severityCounts[label]} {label}
                                        </span>
                                      ))}
                                  </div>

                                  <div className="findings">
                                    {risks.map((finding, index) => {
                                      const title =
                                        finding.category ||
                                        finding.title ||
                                        finding.type ||
                                        "Potential concern";
                                      const label = severityLabel(finding.severity);

                                      return (
                                        <article
                                          className={`finding sev-${label}`}
                                          key={`risk-${index}`}
                                        >
                                          <div className="finding-head">
                                            <h4>{title}</h4>
                                            <span
                                              className={`badge ${severityTone(label)}`.trim()}
                                            >
                                              {String(
                                                finding.severity || "Unrated"
                                              ).toUpperCase()}
                                            </span>
                                          </div>

                                          {finding.explanation && (
                                            <p>{finding.explanation}</p>
                                          )}

                                          {finding.evidence && (
                                            <blockquote className="quote">
                                              <small>Evidence from document</small>
                                              “{finding.evidence}”
                                            </blockquote>
                                          )}

                                          {finding.recommendation && (
                                            <div className="callout">
                                              <strong>Suggested review:</strong>{" "}
                                              {finding.recommendation}
                                            </div>
                                          )}
                                        </article>
                                      );
                                    })}
                                  </div>
                                </>
                              )}
                            </div>

                            <div className="card">
                              <div className="card-head">
                                <div className="card-title">
                                  <span className="icon-box green">
                                    <Icon name="check" />
                                  </span>
                                  <div>
                                    <h3>Key obligations</h3>
                                    <p>Responsibilities identified in the document</p>
                                  </div>
                                </div>
                              </div>

                              {obligations.length > 0 ? (
                                <ul className="list">
                                  {obligations.map((item, index) => (
                                    <li key={`obligation-${index}`}>
                                      <span className="marker check">
                                        <Icon name="check" />
                                      </span>
                                      <div>
                                        {typeof item === "object" &&
                                        item !== null ? (
                                          <>
                                            {item.party && (
                                              <strong>{item.party}: </strong>
                                            )}
                                            {getObligationText(item)}
                                            {item.evidence && (
                                              <span className="evidence">
                                                Evidence: {item.evidence}
                                              </span>
                                            )}
                                          </>
                                        ) : (
                                          getObligationText(item)
                                        )}
                                      </div>
                                    </li>
                                  ))}
                                </ul>
                              ) : (
                                <p className="muted">
                                  No key obligations were returned in this
                                  report.
                                </p>
                              )}
                            </div>

                            <div className="card">
                              <div className="card-head">
                                <div className="card-title">
                                  <span className="icon-box teal">
                                    <Icon name="info" />
                                  </span>
                                  <div>
                                    <h3>Questions for a lawyer</h3>
                                    <p>Questions to help guide a professional review</p>
                                  </div>
                                </div>
                              </div>

                              {questions.length > 0 ? (
                                <ol className="list">
                                  {questions.map((question, index) => (
                                    <li key={`question-${index}`}>
                                      <span className="marker">{index + 1}</span>
                                      <div>
                                        {typeof question === "string"
                                          ? question
                                          : question?.question ||
                                            question?.text ||
                                            "Question details unavailable"}
                                      </div>
                                    </li>
                                  ))}
                                </ol>
                              ) : (
                                <p className="muted">
                                  No lawyer questions were returned in this
                                  report.
                                </p>
                              )}
                            </div>
                          </>
                        )}

                        {(analysis.flags.length > 0 || !isAiComplete) && (
                          <div className="card">
                            <div className="card-head">
                              <div className="card-title">
                                <span className="icon-box amber">
                                  <Icon name="search" />
                                </span>
                                <div>
                                  <h3>Keyword scan</h3>
                                  <p>
                                    A simple scan for common contract topics. It
                                    does not replace the AI review.
                                  </p>
                                </div>
                              </div>
                            </div>

                            {!analysis.flags.length ? (
                              <p className="muted">
                                No matching topics were detected. This does not
                                mean the document is risk-free.
                              </p>
                            ) : (
                              <div className="tags">
                                {analysis.flags.map((flag, index) => (
                                  <span
                                    className="badge amber"
                                    key={`${flag.category}-${index}`}
                                    title={flag.note}
                                  >
                                    {String(flag.category).replace(/_/g, " ")} ·{" "}
                                    {flag.occurrences} match
                                    {flag.occurrences === 1 ? "" : "es"}
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                        )}

                        <div className="disclaimer">
                          <Icon name="info" />
                          <p>
                            <strong>Important:</strong> AI-generated findings
                            are informational, may be incomplete or incorrect,
                            and are not legal advice. Review the original
                            contract and consult a qualified lawyer before
                            making decisions. A hash alone does not establish
                            authorship, legal validity, or enforceability.
                          </p>
                        </div>
                      </div>

                      <aside className="results-aside">
                        <div className="card">
                          <div className="card-head">
                            <div className="card-title">
                              <span className="icon-box teal">
                                <Icon name="shield" />
                              </span>
                              <div>
                                <h3>Blockchain proof</h3>
                                <p>Register the hash on Casper</p>
                              </div>
                            </div>
                          </div>

                          <div className={`proof-status ${proofClass}`.trim()}>
                            <span
                              className={
                                "icon-box " +
                                (chainStatus === "success"
                                  ? "green"
                                  : chainStatus === "failed"
                                    ? "red"
                                    : chainStatus === "pending"
                                      ? "amber"
                                      : "")
                              }
                            >
                              <Icon
                                name={
                                  chainStatus === "success"
                                    ? "check"
                                    : chainStatus === "failed"
                                      ? "alert"
                                      : "shield"
                                }
                              />
                            </span>
                            <div>
                              <strong>
                                {chainStatus === "success"
                                  ? "Registered on Casper"
                                  : chainStatus === "failed"
                                    ? "Registration failed"
                                    : chainStatus === "pending"
                                      ? "Waiting for confirmation"
                                      : "Not registered yet"}
                              </strong>
                              <span>
                                {chainStatus === "success"
                                  ? "Only the hash is stored on-chain."
                                  : "Only the hash is sent, never the document."}
                              </span>
                            </div>
                          </div>

                          <ol className="stepper">
                            {chainSteps(analysis, chainBusy).map((step, index) => (
                              <li key={step.key} className={`step ${step.state}`}>
                                <span className="bubble">
                                  {step.state === "done" ? (
                                    <Icon name="check" />
                                  ) : step.state === "error" ? (
                                    <Icon name="x" />
                                  ) : (
                                    index + 1
                                  )}
                                </span>
                                {step.label}
                              </li>
                            ))}
                          </ol>

                          <span className="field-label">SHA-256 hash</span>
                          <div className="hash-box">
                            <code>{analysisHash || "Hash not available"}</code>
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              onClick={() => copyText(analysisHash, "SHA-256 hash")}
                              disabled={!analysisHash}
                              aria-label="Copy hash"
                            >
                              <Icon name="copy" />
                            </button>
                          </div>

                          {analysis.id && (
                            <div className="proof-actions">
                              <button
                                type="button"
                                className={
                                  chainStatus === "success"
                                    ? "btn btn-success"
                                    : "btn btn-primary"
                                }
                                onClick={handleRegisterOnChain}
                                disabled={
                                  chainBusy ||
                                  chainStatus === "success" ||
                                  !analysisHash
                                }
                              >
                                {chainBusy ? (
                                  <span className="spinner" />
                                ) : chainStatus === "success" ? (
                                  <Icon name="check" />
                                ) : (
                                  <Icon name="wallet" />
                                )}
                                {chainStatus === "success"
                                  ? "Registered on Casper"
                                  : chainBusy
                                    ? "Working…"
                                    : "Register on Casper blockchain"}
                              </button>

                              <button
                                type="button"
                                className="btn btn-secondary"
                                onClick={handleVerifyOnChain}
                                disabled={chainBusy || !analysisHash}
                              >
                                <Icon name="shield" /> Verify on-chain
                              </button>
                            </div>
                          )}

                          {chainMessage && (
                            <div className="chain-message" role="status">
                              {chainMessage}
                            </div>
                          )}

                          {analysis.chain_tx_hash && (
                            <dl className="kv">
                              <div>
                                <dt>Transaction</dt>
                                <dd>
                                  <a
                                    className="txlink"
                                    href={explorerLink(analysis.chain_tx_hash)}
                                    target="_blank"
                                    rel="noreferrer"
                                  >
                                    {shortHash(analysis.chain_tx_hash, 8, 6)}
                                    <Icon name="external" />
                                  </a>
                                </dd>
                              </div>
                              <div>
                                <dt>Network</dt>
                                <dd>{networkLabel(analysis.chain_network)}</dd>
                              </div>
                              {analysis.chain_registered_at && (
                                <div>
                                  <dt>Registered</dt>
                                  <dd>{formatShortDate(analysis.chain_registered_at)}</dd>
                                </div>
                              )}
                            </dl>
                          )}

                          {chainStatus === "failed" && analysis.chain_error && (
                            <p className="note">
                              {friendlyChainError(analysis.chain_error)}
                            </p>
                          )}
                        </div>
                      </aside>
                    </div>
                  </section>
                </>
              )}
            </>
          )}

          {activeTab === "reports" && (
            <>
              <div className="page-title">
                <h2>Reports</h2>
                <p>Download a PDF report for any analysis.</p>
              </div>

              <div className="card">
                <div className="card-head">
                  <div className="card-title">
                    <span className="icon-box">
                      <Icon name="report" />
                    </span>
                    <div>
                      <h3>Current analysis</h3>
                      <p>
                        The report includes the summary, obligations, risk
                        findings, lawyer questions, the SHA-256 hash and the
                        blockchain details.
                      </p>
                    </div>
                  </div>
                </div>

                {analysis ? (
                  <div className="history-row">
                    <span className="icon-box">
                      <Icon name="file" />
                    </span>
                    <div className="history-main">
                      <div className="history-name">
                        {analysis.document_name || analysis.filename}
                      </div>
                      <div className="history-meta">
                        {formatDate(analysis.created_at)} · {analysis.word_count}{" "}
                        words
                      </div>
                    </div>
                    <div className="history-badges">
                      <ChainBadge status={analysis.chain_status} />
                    </div>
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      onClick={() => handleDownloadReport()}
                    >
                      <Icon name="download" /> Download PDF
                    </button>
                  </div>
                ) : (
                  <p className="muted">
                    No analysis is selected. Open a saved result below, or run a
                    new analysis from Overview.
                  </p>
                )}
              </div>

              <div className="section-head">
                <div>
                  <h2>Saved analyses</h2>
                  <p>Pick any saved analysis to download its report.</p>
                </div>
              </div>

              {analysisHistory.length === 0 ? (
                <div className="card empty">
                  <span className="icon-box">
                    <Icon name="report" />
                  </span>
                  <strong>Nothing to report yet</strong>
                  <p>Analyze a document first, then come back to download its report.</p>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={() => setActiveTab("overview")}
                  >
                    Go to Overview
                  </button>
                </div>
              ) : (
                <div className="history">
                  {analysisHistory.slice(0, 10).map((item, index) => (
                    <div
                      className="history-row"
                      key={item.id ?? `${item.document_name}-${index}`}
                    >
                      <span className="icon-box">
                        <Icon name="file" />
                      </span>
                      <div className="history-main">
                        <div className="history-name">{item.document_name}</div>
                        <div className="history-meta">
                          {formatDate(item.created_at)} · {item.word_count} words
                        </div>
                      </div>
                      <div className="history-badges">
                        <ChainBadge status={item.chain_status} />
                      </div>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => handleDownloadReport(item)}
                      >
                        <Icon name="download" /> Download
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {activeTab === "verification" && (
            <>
              <div className="page-title">
                <h2>Blockchain Verification</h2>
                <p>
                  Documents are registered on the Casper blockchain by their
                  SHA-256 hash only. The text is processed by the backend and
                  Google Gemini, but it is never put on-chain.
                </p>
              </div>

              {chainConfig && !chainConfig.configured && (
                <div className="alert warn" role="alert">
                  <Icon name="alert" />
                  <div>
                    <strong>Blockchain is not configured.</strong>
                    The backend has no CASPER_CONTRACT_HASH yet. Deploy the
                    contract and add its hash to the backend settings.
                  </div>
                </div>
              )}

              <div className="card">
                <div className="card-head">
                  <div className="card-title">
                    <span className="icon-box teal">
                      <Icon name="search" />
                    </span>
                    <div>
                      <h3>Check a hash</h3>
                      <p>See whether any SHA-256 hash is registered on-chain.</p>
                    </div>
                  </div>
                </div>

                <form className="inline-form" onSubmit={handleCheckHash}>
                  <label className="sr-only" htmlFor="hash-check">
                    SHA-256 hash
                  </label>
                  <input
                    id="hash-check"
                    value={checkHash}
                    onChange={(event) => setCheckHash(event.target.value)}
                    placeholder="Paste a 64-character SHA-256 hash"
                    spellCheck="false"
                    autoComplete="off"
                  />
                  <button
                    type="submit"
                    className="btn btn-primary"
                    disabled={checkBusy || !checkHash.trim()}
                  >
                    {checkBusy ? <span className="spinner" /> : <Icon name="shield" />}
                    Check
                  </button>
                </form>

                {checkResult && (
                  <div className={`result-line ${checkResult.tone}`} role="status">
                    {checkResult.message}
                  </div>
                )}
              </div>

              <div className="section-head">
                <div>
                  <h2>Registered documents</h2>
                  <p>Every registration attempt made from this workspace.</p>
                </div>
              </div>

              {registeredItems.length === 0 ? (
                <div className="card empty">
                  <span className="icon-box teal">
                    <Icon name="shield" />
                  </span>
                  <strong>No documents registered yet</strong>
                  <p>
                    Analyze a document, then press Register on Casper
                    blockchain in the results.
                  </p>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={() => setActiveTab("overview")}
                  >
                    Analyze a document
                  </button>
                </div>
              ) : (
                <div className="vlist">
                  {registeredItems.map((item) => (
                    <div className="vrow" key={item.id}>
                      <div style={{ minWidth: 0 }}>
                        <div className="vrow-name" title={item.document_name}>
                          {item.document_name}
                        </div>
                        <div className="vrow-sub">
                          {formatShortDate(item.chain_registered_at || item.created_at)}
                        </div>
                      </div>

                      <div>
                        <ChainBadge status={item.chain_status} />
                      </div>

                      <div>
                        {item.chain_tx_hash ? (
                          <a
                            className="txlink"
                            href={explorerLink(item.chain_tx_hash)}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {shortHash(item.chain_tx_hash, 8, 6)}
                            <Icon name="external" />
                          </a>
                        ) : (
                          <span className="muted">No transaction</span>
                        )}
                      </div>

                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => {
                          viewSavedResult(item);
                          setActiveTab("overview");
                        }}
                      >
                        Open result
                      </button>

                      {item.chain_status === "failed" && item.chain_error && (
                        <div className="vrow-error">
                          {friendlyChainError(item.chain_error)}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          <footer className="footer">
            <span>LexProof AI · Legal intelligence, with transparency.</span>
            <span>Prototype · Not legal advice</span>
          </footer>
        </div>
      </main>

      {notice && (
        <div className="toast-wrap">
          <div
            className={`toast ${toastTone}`}
            role={toastTone === "error" ? "alert" : "status"}
          >
            <span className="toast-msg">{notice}</span>
            <button
              type="button"
              className="toast-close"
              onClick={() => setNotice("")}
              aria-label="Dismiss message"
            >
              <Icon name="x" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
