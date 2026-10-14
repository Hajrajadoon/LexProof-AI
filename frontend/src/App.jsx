
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

function formatDate(value) {
  if (!value) return "Not available";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Not available"
    : date.toLocaleString();
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
  const [walletPublicKey, setWalletPublicKey] = useState("");
const [walletLoading, setWalletLoading] = useState(false);
const [walletError, setWalletError] = useState("");
  const [chainConfig, setChainConfig] = useState(null);
  const [chainBusy, setChainBusy] = useState(false);
  const [chainMessage, setChainMessage] = useState("");

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

  function handleFileChange(event) {
    const selectedFile = event.target.files?.[0];

    if (!selectedFile) return;

    const isPdf =
      selectedFile.type === "application/pdf" ||
      selectedFile.name.toLowerCase().endsWith(".pdf");

    if (!isPdf) {
      setNotice("Please select a PDF document.");
      setFile(null);
      return;
    }

    if (selectedFile.size > 10 * 1024 * 1024) {
      setNotice("The PDF must be 10 MB or smaller.");
      setFile(null);
      return;
    }

    setFile(selectedFile);
    setAnalysis(null);
    setNotice("PDF selected. Click Analyze document to analyze its contents.");
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
        "Blockchain is not configured. Add CASPER_CONTRACT_HASH to backend/.env and restart the backend."
      );
      return;
    }

    setChainBusy(true);
    setChainMessage("");

    try {
      // Free check first, so we do not pay to register a duplicate.
      try {
        const existing = await verifyHashOnChain(API_URL, hash);
        if (existing.registered) {
          setChainMessage("This hash is already registered on the blockchain.");
          return;
        }
      } catch {
        // If the check fails, continue to registration.
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

  function explorerLink(txHash) {
    return `${chainConfig?.explorer_tx_url || "https://testnet.cspr.live/transaction/"}${txHash}`;
  }

  async function copyHash() {
    const hash = analysis?.sha256 || analysis?.file_hash;

    if (!hash) return;

    try {
      await navigator.clipboard.writeText(hash);
      setNotice("SHA-256 hash copied to clipboard.");
    } catch {
      setNotice(
        "Unable to copy automatically. Select and copy the hash manually."
      );
    }
  }

  function handleDownloadReport() {
    if (!analysis) {
      setNotice("Analyze a document or load a saved result before creating a report.");
      return;
    }

    try {
      generateReport(analysis);
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

    if (fileInput.current) {
      fileInput.current.value = "";
    }
  }

  function viewSavedResult(item) {
    setAnalysis(normalizeAnalysis(item));
    setNotice(`Loaded saved analysis #${item.id}.`);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  const aiReport = analysis?.ai_report || null;
  const aiStatus = analysis?.ai_status || "not_run";
  const isAiComplete = aiStatus === "completed" && Boolean(aiReport);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">L</div>
          <div>
            <h1>
              LexProof <span>AI</span>
            </h1>
            <p>LEGAL INTELLIGENCE</p>
          </div>
        </div>

        <div className="workspace-label">WORKSPACE</div>

        <nav className="navigation">
          <button
            className={activeTab === "overview" ? "nav-item active" : "nav-item"}
            onClick={() => setActiveTab("overview")}
          >
            <span>▦</span> Overview
          </button>

          <button
            className={activeTab === "documents" ? "nav-item active" : "nav-item"}
            onClick={() => setActiveTab("documents")}
          >
            <span>▤</span> Documents
          </button>

          <button
            className={
              activeTab === "verification" ? "nav-item active" : "nav-item"
            }
            onClick={() => setActiveTab("verification")}
          >
            <span>⬡</span> Blockchain Verification
          </button>

          <button
            className={activeTab === "reports" ? "nav-item active" : "nav-item"}
            onClick={() => setActiveTab("reports")}
          >
            <span>▧</span> Reports
          </button>
        </nav>

        <div className="sidebar-bottom">
          <div className="security-card">
            <div className="security-icon">⬡</div>
            <h3>Privacy by design</h3>
            <p>
              Documents stay off-chain. Only verification hashes will be
              registered on the blockchain.
            </p>
          </div>

          <div className="network-status">
            <span className="status-dot" />
            <span>Development environment</span>
          </div>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div className="breadcrumb">
            Workspace <span>/</span>{" "}
            {activeTab === "overview"
              ? "Overview"
              : activeTab === "documents"
                ? "Documents"
                : activeTab === "verification"
                  ? "Blockchain Verification"
                  : "Reports"}
          </div>

<div className="topbar-right">
  <span className="network-badge">
    <span className="status-dot" /> Local preview
  </span>

  {walletPublicKey ? (
    <>
      <span
        className="wallet-key"
        title={walletPublicKey}
      >
        {walletPublicKey.slice(0, 10)}...
        {walletPublicKey.slice(-6)}
      </span>

      <button
        type="button"
        className="secondary-button wallet-button"
        onClick={handleDisconnectWallet}
        disabled={walletLoading}
      >
        {walletLoading ? "Please wait..." : "Disconnect"}
      </button>
    </>
  ) : (
    <button
      type="button"
      className="primary-button wallet-button"
      onClick={handleConnectWallet}
      disabled={walletLoading}
    >
      {walletLoading ? "Connecting..." : "Connect Casper Wallet"}
    </button>
  )}

  <div className="avatar">LP</div>

  {walletError && (
    <span className="wallet-error" role="alert">
      {walletError}
    </span>
  )}
</div>
        </header>

        <div className="page-content">
          <section className="welcome-section">
            <div>
              <div className="eyebrow">
                AI-POWERED LEGAL DOCUMENT INTELLIGENCE
              </div>
              <h2>
                Clarity for every <span>contract.</span>
              </h2>
              <p className="welcome-copy">
                Understand legal documents, identify clauses that deserve a
                closer look, and verify document integrity with blockchain
                technology.
              </p>
            </div>

            <div className="hero-emblem" aria-hidden="true">
              <div className="emblem-ring ring-one" />
              <div className="emblem-ring ring-two" />
              <div className="emblem-center">
                L<span>✓</span>
              </div>
              <div className="emblem-spark spark-one">✦</div>
              <div className="emblem-spark spark-two">✧</div>
            </div>
          </section>

          {activeTab === "overview" || activeTab === "documents" ? (
            <>
              <section className="stats-grid">
                <div className="stat-card">
                  <div className="stat-top">
                    <span>Documents selected</span>
                    <span className="stat-icon blue">▤</span>
                  </div>
                  <div className="stat-value">{file ? "01" : "00"}</div>
                  <div className="stat-foot">In this session</div>
                </div>

                <div className="stat-card">
                  <div className="stat-top">
                    <span>Saved analyses</span>
                    <span className="stat-icon purple">✧</span>
                  </div>
                  <div className="stat-value">{analysisCount}</div>
                  <div className="stat-foot">Retrieved from database</div>
                </div>

                <div className="stat-card">
                  <div className="stat-top">
                    <span>Verified records</span>
                    <span className="stat-icon green">⬡</span>
                  </div>
                  <div className="stat-value">
                    {analysisHistory.filter((item) => item.chain_status === "success").length}
                  </div>
                  <div className="stat-foot">Registered on Casper blockchain</div>
                </div>
              </section>

              <section className="section-heading">
                <div>
                  <h3>Analyze a document</h3>
                  <p>Start with a PDF or paste the text of a contract.</p>
                </div>
                <span className="step-badge">STEP 01 / 03</span>
              </section>

              <section className="analyzer-grid">
                <div className="panel upload-panel">
                  <div className="panel-heading">
                    <div className="panel-icon">↑</div>
                    <div>
                      <h3>Upload legal document</h3>
                      <p>Choose a PDF from your computer</p>
                    </div>
                  </div>

                  <button
                    type="button"
                    className="dropzone"
                    onClick={() => fileInput.current?.click()}
                  >
                    <div className="upload-illustration">↑</div>
                    <strong>{file ? file.name : "Click to select a PDF"}</strong>
                    <span>
                      {file
                        ? `${(file.size / 1024 / 1024).toFixed(2)} MB · Selected`
                        : "PDF documents up to 10 MB"}
                    </span>
                    <span className="browse-button">
                      {file ? "Choose another file" : "Browse files"}
                    </span>
                  </button>

                  <input
                    ref={fileInput}
                    type="file"
                    accept=".pdf,application/pdf"
                    hidden
                    onChange={handleFileChange}
                  />

                  <div className="privacy-note">
                    <span>▣</span> Do not upload sensitive documents to this demo.
                  </div>
                </div>

                <div className="panel paste-panel">
                  <div className="panel-heading">
                    <div className="panel-icon purple-icon">Aa</div>
                    <div>
                      <h3>Paste contract text</h3>
                      <p>Analyze with the connected Gemini AI backend</p>
                    </div>
                  </div>

                  <textarea
                    value={documentText}
                    onChange={(event) => setDocumentText(event.target.value)}
                    placeholder="Paste a contract clause or agreement text here..."
                    aria-label="Contract text"
                    maxLength={100000}
                  />

                  <div className="textarea-footer">
                    <span>{documentText.length} characters</span>
                    <button
                      type="button"
                      className="text-clear"
                      onClick={clearDocument}
                    >
                      Clear
                    </button>
                  </div>
                </div>
              </section>

              <section className="action-row">
                <div className="action-explanation">
                  <span className="action-lock">⌑</span>
                  <span>
                    AI analysis is connected. After analyzing, register the
                    document hash on the Casper blockchain from the results.
                  </span>
                </div>

                <button
                  type="button"
                  className="primary-button"
                  onClick={handleAnalyze}
                  disabled={loading}
                >
                  {loading ? "Analyzing..." : "Analyze document"}{" "}
                  <span>{loading ? "…" : "→"}</span>
                </button>
              </section>

              {notice && (
                <div className="notice" role="status">
                  {notice}
                </div>
              )}

              <section className="saved-history-section">
                <div className="section-heading">
                  <div>
                    <h3>Saved analysis history</h3>
                    <p>Recent results retrieved from the connected backend.</p>
                  </div>

                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => loadHistory(true)}
                    disabled={historyLoading}
                  >
                    {historyLoading ? "Loading..." : "Refresh history"}
                  </button>
                </div>

                {historyError && (
                  <div className="notice" role="alert">
                    <strong>History could not be loaded.</strong>
                    <p>{historyError}</p>
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => loadHistory(true)}
                      disabled={historyLoading}
                    >
                      Try again
                    </button>
                  </div>
                )}

                {historyLoading ? (
                  <div className="panel flags-panel">
                    <p>Loading saved analyses...</p>
                  </div>
                ) : analysisHistory.length === 0 ? (
                  <div className="panel flags-panel">
                    <p>
                      {historyError
                        ? "History is unavailable until the error is resolved."
                        : "No saved analyses found. Analyze a PDF or paste text to create your first record."}
                    </p>
                  </div>
                ) : (
                  <div className="panel flags-panel">
                    <div className="flag-list">
                      {analysisHistory.map((item, index) => (
                        <div
                          className="flag-item"
                          key={item.id ?? `${item.document_name}-${index}`}
                        >
                          <div className="flag-heading">
                            <strong>{item.document_name}</strong>
                            <span>
                              {item.ai_status === "completed" && item.ai_report
                                ? "AI report ready"
                                : item.ai_status === "unavailable"
                                  ? "AI unavailable"
                                  : item.page_count != null
                                    ? `PDF · ${item.page_count} pages`
                                    : "Keyword scan"}
                            </span>
                          </div>

                          <p>
                            {formatDate(item.created_at)} · {item.word_count}{" "}
                            words · {item.flags.length} topics flagged
                          </p>

                          <button
                            type="button"
                            className="secondary-button"
                            onClick={() => viewSavedResult(item)}
                          >
                            View saved result
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </section>

              {analysis && (
                <section className="analysis-results" aria-live="polite">
                  <div className="section-heading">
                    <div>
                      <h3>Analysis results</h3>
                      <p>
                        Review the AI report and document integrity information.
                      </p>
                    </div>
                    <span className="step-badge">
                      {analysis.page_count != null
                        ? `PDF · ${analysis.page_count} PAGE${analysis.page_count === 1 ? "" : "S"}`
                        : "TEXT ANALYSIS"}
                    </span>
                  </div>

                  <div className="panel result-summary">
                    <div className="flag-heading">
                      <h3>Document overview</h3>
                      <span
                        className={`ai-status-pill ${
                          isAiComplete
                            ? "ai-status-completed"
                            : aiStatus === "unavailable"
                              ? "ai-status-unavailable"
                              : "ai-status-not-run"
                        }`}
                      >
                        {isAiComplete
                          ? "Gemini AI completed"
                          : aiStatus === "unavailable"
                            ? "AI unavailable"
                            : "AI report not available"}
                      </span>
                    </div>

                    <p>
                      <strong>File:</strong>{" "}
                      {analysis.document_name || analysis.filename}
                    </p>

                    {analysis.page_count != null && (
                      <p>
                        <strong>Pages processed:</strong> {analysis.page_count}
                      </p>
                    )}

                    {analysis.created_at && (
                      <p>
                        <strong>Saved on:</strong> {formatDate(analysis.created_at)}
                      </p>
                    )}

                    {aiReport?.document_type && (
                      <p>
                        <strong>Document type:</strong> {aiReport.document_type}
                      </p>
                    )}

                    <h3>{isAiComplete ? "AI-generated summary" : "Document summary"}</h3>
                    <p>
                      {aiReport?.summary ||
                        analysis.document_summary ||
                        "No summary is available for this record."}
                    </p>

                    <div className="result-metrics">
                      <div>
                        <span>Words</span>
                        <strong>{analysis.word_count}</strong>
                      </div>
                      <div>
                        <span>Characters</span>
                        <strong>{analysis.character_count}</strong>
                      </div>
                      <div>
                        <span>Topics flagged</span>
                        <strong>{analysis.flags.length}</strong>
                      </div>
                    </div>

                    {!isAiComplete && (
                      <p className="muted-note">
                        This record has no usable AI report. It may have been
                        created by the keyword-only analyzer, or AI analysis
                        may have been unavailable. Run the analysis again after
                        confirming that the Gemini-enabled backend is connected.
                      </p>
                    )}
                  </div>

                  {isAiComplete && (
                    <>
                      <div className="panel ai-report-panel">
                        <div className="panel-heading">
                          <div className="panel-icon purple-icon">✓</div>
                          <div>
                            <h3>Key obligations</h3>
                            <p>Responsibilities identified in the document</p>
                          </div>
                        </div>

                        {Array.isArray(aiReport.key_obligations) &&
                        aiReport.key_obligations.length > 0 ? (
                          <ul className="ai-list">
                            {aiReport.key_obligations.map((item, index) => (
                              <li key={`obligation-${index}`}>
                                {typeof item === "object" && item !== null ? (
                                  <>
                                    {item.party && (
                                      <strong>{item.party}: </strong>
                                    )}
                                    {getObligationText(item)}
                                    {item.evidence && (
                                      <p>
                                        <em>Evidence: {item.evidence}</em>
                                      </p>
                                    )}
                                  </>
                                ) : (
                                  getObligationText(item)
                                )}
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p>No key obligations were returned in this report.</p>
                        )}
                      </div>

                      <div className="panel ai-report-panel">
                        <div className="panel-heading">
                          <div className="panel-icon">!</div>
                          <div>
                            <h3>AI risk findings</h3>
                            <p>
                              Potential concerns to review; severity is an AI
                              assessment, not a legal conclusion.
                            </p>
                          </div>
                        </div>

                        {!Array.isArray(aiReport.risk_findings) ||
                        aiReport.risk_findings.length === 0 ? (
                          <p>
                            No specific risk findings were returned by the AI.
                            This does not guarantee that the document is risk-free.
                          </p>
                        ) : (
                          <div className="ai-risk-list">
                            {aiReport.risk_findings.map((finding, index) => {
                              const title =
                                finding.category ||
                                finding.title ||
                                finding.type ||
                                "Potential concern";

                              return (
                                <article
                                  className="ai-risk-item"
                                  key={`risk-${index}`}
                                >
                                  <div className="flag-heading">
                                    <h4>{title}</h4>
                                    <span
                                      className={`severity-pill severity-${severityLabel(
                                        finding.severity
                                      )}`}
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
                                    <blockquote className="evidence-quote">
                                      <strong>Evidence from document</strong>
                                      <br />
                                      “{finding.evidence}”
                                    </blockquote>
                                  )}

                                  {finding.recommendation && (
                                    <div className="recommendation-note">
                                      <strong>Suggested review:</strong>{" "}
                                      {finding.recommendation}
                                    </div>
                                  )}
                                </article>
                              );
                            })}
                          </div>
                        )}
                      </div>

                      <div className="panel ai-report-panel">
                        <div className="panel-heading">
                          <div className="panel-icon purple-icon">?</div>
                          <div>
                            <h3>Questions for a lawyer</h3>
                            <p>
                              Questions to help guide a professional review
                            </p>
                          </div>
                        </div>

                        {Array.isArray(aiReport.questions_for_lawyer) &&
                        aiReport.questions_for_lawyer.length > 0 ? (
                          <ol className="ai-list ordered-list">
                            {aiReport.questions_for_lawyer.map(
                              (question, index) => (
                                <li key={`question-${index}`}>
                                  {typeof question === "string"
                                    ? question
                                    : question?.question ||
                                      question?.text ||
                                      "Question details unavailable"}
                                </li>
                              )
                            )}
                          </ol>
                        ) : (
                          <p>
                            No lawyer questions were returned in this report.
                          </p>
                        )}
                      </div>
                    </>
                  )}

                  <div className="panel hash-panel">
                    <h3>SHA-256 document hash</h3>
                    <p>
                      {analysis.chain_status === "success"
                        ? "This hash is registered on the Casper blockchain. Only the hash is stored on-chain, never the document."
                        : "This fingerprint can help check whether text matches a later copy. Register it on the Casper blockchain to create a verifiable record."}
                    </p>
                    <code className="hash-value">
                      {analysis.sha256 || analysis.file_hash || "Hash not available"}
                    </code>
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={copyHash}
                      disabled={!analysis.sha256 && !analysis.file_hash}
                    >
                      Copy hash
                    </button>

                    {analysis.id && (
                      <div style={{ marginTop: 16 }}>
                        <button
                          type="button"
                          className="primary-button"
                          onClick={handleRegisterOnChain}
                          disabled={
                            chainBusy ||
                            analysis.chain_status === "success" ||
                            (!analysis.sha256 && !analysis.file_hash)
                          }
                        >
                          {analysis.chain_status === "success"
                            ? "Registered on Casper"
                            : chainBusy
                              ? "Working..."
                              : "Register on Casper blockchain"}
                        </button>{" "}
                        <button
                          type="button"
                          className="secondary-button"
                          onClick={handleVerifyOnChain}
                          disabled={chainBusy}
                        >
                          Verify on-chain
                        </button>

                        {chainMessage && (
                          <p role="status" style={{ marginTop: 12 }}>
                            {chainMessage}
                          </p>
                        )}

                        {analysis.chain_tx_hash && (
                          <p style={{ marginTop: 8 }}>
                            Transaction:{" "}
                            <a
                              href={explorerLink(analysis.chain_tx_hash)}
                              target="_blank"
                              rel="noreferrer"
                            >
                              {analysis.chain_tx_hash.slice(0, 16)}...
                            </a>{" "}
                            ({analysis.chain_status})
                          </p>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="panel flags-panel">
                    <h3>Potential review topics</h3>

                    {!analysis.flags.length ? (
                      <p>
                        No matching topics were detected by the keyword scan.
                        This does not mean the document is risk-free.
                      </p>
                    ) : (
                      <div className="flag-list">
                        {analysis.flags.map((flag, index) => (
                          <div
                            className="flag-item"
                            key={`${flag.category}-${index}`}
                          >
                            <div className="flag-heading">
                              <strong>{flag.category}</strong>
                              <span>
                                {flag.occurrences} match
                                {flag.occurrences === 1 ? "" : "es"}
                              </span>
                            </div>
                            <p>{flag.note}</p>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="disclaimer">
                    <span>ⓘ</span>
                    <p>
                      <strong>Important:</strong> AI-generated findings are
                      informational, may be incomplete or incorrect, and are
                      not legal advice. Review the original contract and consult
                      a qualified lawyer before making decisions. A hash alone
                      does not establish authorship, legal validity, or
                      enforceability.
                    </p>
                  </div>
                </section>
              )}

              <section className="workflow-section">
                <div className="section-heading">
                  <div>
                    <h3>How LexProof works</h3>
                    <p>A clear path from contract to verifiable record.</p>
                  </div>
                </div>

                <div className="workflow-grid">
                  <div className="workflow-card">
                    <div className="workflow-number">01</div>
                    <div className="workflow-symbol">✧</div>
                    <h4>Understand</h4>
                    <p>
                      Generate a plain-language summary and highlight clauses
                      that may need review.
                    </p>
                  </div>

                  <div className="workflow-connector">→</div>

                  <div className="workflow-card">
                    <div className="workflow-number">02</div>
                    <div className="workflow-symbol purple-symbol">⌕</div>
                    <h4>Review</h4>
                    <p>
                      Explore potential concerns and questions to discuss with
                      a lawyer.
                    </p>
                  </div>

                  <div className="workflow-connector">→</div>

                  <div className="workflow-card">
                    <div className="workflow-number">03</div>
                    <div className="workflow-symbol green-symbol">⬡</div>
                    <h4>Verify</h4>
                    <p>
                      Register a document hash on-chain to check whether a
                      later copy matches.
                    </p>
                  </div>
                </div>
              </section>
            </>
          ) : activeTab === "reports" ? (
            <section className="panel">
              <div className="panel-heading">
                <div className="panel-icon purple-icon">▧</div>
                <div>
                  <h3>Document reports</h3>
                  <p>Generate a downloadable PDF from your analysis results.</p>
                </div>
              </div>

              {analysis ? (
                <>
                  <p>
                    <strong>Document:</strong>{" "}
                    {analysis.document_name ||
                      analysis.filename ||
                      "Untitled document"}
                  </p>

                  <p>
                    The report includes the available summary, obligations,
                    risk findings, questions for a lawyer, and SHA-256 hash.
                  </p>

                  <button
                    type="button"
                    className="primary-button"
                    onClick={handleDownloadReport}
                  >
                    Download PDF report <span>↓</span>
                  </button>
                </>
              ) : (
                <p>
                  No analysis is selected yet. Return to Overview and run an
                  analysis, or select a saved result from the history, then
                  return here to download its report.
                </p>
              )}

              <button
                type="button"
                className="secondary-button"
                onClick={() => setActiveTab("overview")}
              >
                Back to overview
              </button>
            </section>
          ) : (
            <section className="panel">
              <h3>Blockchain verification</h3>
              <p>
                Documents are registered on the Casper blockchain by their
                SHA-256 hash only. The document itself never leaves your
                backend.
              </p>

              {!chainConfig?.configured && (
                <p role="alert">
                  The backend has no CASPER_CONTRACT_HASH yet. Deploy the
                  contract and add its hash to backend/.env.
                </p>
              )}

              {analysisHistory.filter((item) => item.chain_status).length === 0 ? (
                <p>
                  No documents have been registered yet. Analyze a document in
                  Overview, then press Register on Casper blockchain.
                </p>
              ) : (
                analysisHistory
                  .filter((item) => item.chain_status)
                  .map((item) => (
                    <div key={item.id} style={{ margin: "12px 0" }}>
                      <strong>{item.filename}</strong> ({item.chain_status})
                      {item.chain_tx_hash && (
                        <>
                          {" "}
                          <a
                            href={explorerLink(item.chain_tx_hash)}
                            target="_blank"
                            rel="noreferrer"
                          >
                            View transaction
                          </a>
                        </>
                      )}
                      <div>
                        <button
                          type="button"
                          className="secondary-button"
                          onClick={() => {
                            viewSavedResult(item);
                            setActiveTab("overview");
                          }}
                        >
                          Open result
                        </button>
                      </div>
                    </div>
                  ))
              )}

              <button
                type="button"
                className="secondary-button"
                onClick={() => setActiveTab("overview")}
              >
                Back to overview
              </button>
            </section>
          )}

          {notice && activeTab !== "overview" && activeTab !== "documents" && (
            <div className="notice" role="status">
              {notice}
            </div>
          )}

          <footer className="footer">
            <span>LexProof AI · Legal intelligence, with transparency.</span>
            <span>Prototype · Not legal advice</span>
          </footer>
        </div>
      </main>
    </div>
  );
}

export default App;
