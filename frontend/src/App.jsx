
import { useEffect, useRef, useState } from "react";
import "./App.css";

const API_URL = (import.meta.env.VITE_API_URL || "http://127.0.0.1:8000").replace(/\/$/, "");

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

  async function loadHistory() {
    try {
      const response = await fetch(`${API_URL}/api/analyses?limit=20`);
      if (!response.ok) throw new Error("Could not load saved analyses.");
      const data = await response.json();
      setAnalysisHistory(Array.isArray(data.analyses) ? data.analyses : []);
      setAnalysisCount(Number(data.total_count ?? data.count ?? 0));
    } catch {
      // The analyzer can still be used locally even if the history API is unavailable.
    } finally {
      setHistoryLoading(false);
    }
  }

  useEffect(() => {
    loadHistory();
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
    setNotice(
      "PDF selected. Click Prepare analysis to extract and analyze its text."
    );
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

      const data = await response.json();

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

      setAnalysis(data);
      await loadHistory();
      setNotice(
        file
          ? `PDF extracted successfully: ${data.page_count} page(s) processed. ${data.saved_to_database ? "Result saved to database." : ""}`
          : `Analysis completed successfully. ${data.saved_to_database ? "Result saved to database." : ""}`
      );
    } catch (error) {
      setNotice(
        error.message === "Failed to fetch"
          ? "Cannot reach the backend. Make sure FastAPI is running at http://127.0.0.1:8000."
          : `Analysis failed: ${error.message}`
      );
    } finally {
      setLoading(false);
    }
  }

  async function copyHash() {
    if (!analysis?.sha256) return;

    try {
      await navigator.clipboard.writeText(analysis.sha256);
      setNotice("SHA-256 hash copied to clipboard.");
    } catch {
      setNotice("Unable to copy automatically. Select and copy the hash manually.");
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

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">L</div>
          <div>
            <h1>LexProof <span>AI</span></h1>
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
            className={activeTab === "verification" ? "nav-item active" : "nav-item"}
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
            <div className="avatar">LP</div>
          </div>
        </header>

        <div className="page-content">
          <section className="welcome-section">
            <div>
              <div className="eyebrow">
                AI-POWERED LEGAL DOCUMENT INTELLIGENCE
              </div>
              <h2>Clarity for every <span>contract.</span></h2>
              <p className="welcome-copy">
                Understand legal documents, identify clauses that deserve a
                closer look, and verify document integrity with blockchain
                technology.
              </p>
            </div>
            <div className="hero-emblem" aria-hidden="true">
              <div className="emblem-ring ring-one" />
              <div className="emblem-ring ring-two" />
              <div className="emblem-center">L<span>✓</span></div>
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
                    <span>Text analyses</span>
                    <span className="stat-icon purple">✧</span>
                  </div>
                  <div className="stat-value">{analysisCount}</div>
                  <div className="stat-foot">Completed this session</div>
                </div>

                <div className="stat-card">
                  <div className="stat-top">
                    <span>Verified records</span>
                    <span className="stat-icon green">⬡</span>
                  </div>
                  <div className="stat-value">0</div>
                  <div className="stat-foot">Blockchain integration pending</div>
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
                    <strong>
                      {file ? file.name : "Click to select a PDF"}
                    </strong>
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
                      <p>Send text to the connected backend</p>
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
                    <button className="text-clear" onClick={clearDocument}>
                      Clear
                    </button>
                  </div>
                </div>
              </section>

              <section className="action-row">
                <div className="action-explanation">
                  <span className="action-lock">⌑</span>
                  <span>
                    Connected to the preliminary text-analysis API. AI model
                    and blockchain integration are still pending.
                  </span>
                </div>

                <button
                  className="primary-button"
                  onClick={handleAnalyze}
                  disabled={loading}
                >
                  {loading ? "Analyzing..." : "Prepare analysis"}{" "}
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
                    <p>Recent results retrieved from the connected database.</p>
                  </div>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={loadHistory}
                    disabled={historyLoading}
                  >
                    {historyLoading ? "Loading..." : "Refresh history"}
                  </button>
                </div>

                {historyLoading ? (
                  <div className="panel flags-panel"><p>Loading saved analyses...</p></div>
                ) : analysisHistory.length === 0 ? (
                  <div className="panel flags-panel">
                    <p>No saved analyses yet. Analyze a PDF or paste text to create your first record.</p>
                  </div>
                ) : (
                  <div className="panel flags-panel">
                    <div className="flag-list">
                      {analysisHistory.map((item) => (
                        <div className="flag-item" key={item.id}>
                          <div className="flag-heading">
                            <strong>{item.document_name || "Pasted text"}</strong>
                            <span>{item.source_type === "pdf" ? `PDF · ${item.page_count ?? "?"} pages` : "Text scan"}</span>
                          </div>
                          <p>
                            {item.created_at ? new Date(item.created_at).toLocaleString() : "Saved analysis"}
                            {" · "}{item.word_count} words · {item.flags?.length ?? 0} topics flagged
                          </p>
                          <button
                            type="button"
                            className="secondary-button"
                            onClick={() => {
                              setAnalysis(item);
                              setNotice(`Loaded saved analysis #${item.id}.`);
                              window.scrollTo({ top: 0, behavior: "smooth" });
                            }}
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
                      <p>Results returned by the LexProof AI backend.</p>
                    </div>
                    <span className="step-badge">
                      {analysis.page_count
                        ? `PDF · ${analysis.page_count} PAGE${analysis.page_count === 1 ? "" : "S"}`
                        : "TEXT SCAN"}
                    </span>
                  </div>

                  <div className="panel result-summary">
                    {analysis.document_name && (
                      <p><strong>File:</strong> {analysis.document_name}</p>
                    )}
                    {analysis.page_count != null && (
                      <p><strong>Pages processed:</strong> {analysis.page_count}</p>
                    )}
                    {analysis.created_at && (
                      <p><strong>Saved on:</strong> {new Date(analysis.created_at).toLocaleString()}</p>
                    )}
                    <h3>Document summary</h3>
                    <p>{analysis.document_summary}</p>
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
                        <strong>{analysis.flags?.length ?? 0}</strong>
                      </div>
                    </div>
                  </div>

                  <div className="panel hash-panel">
                    <h3>SHA-256 document hash</h3>
                    <p>
                      This fingerprint can help check whether text matches a
                      later copy. It is not yet registered on a blockchain.
                    </p>
                    <code className="hash-value">{analysis.sha256}</code>
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={copyHash}
                    >
                      Copy hash
                    </button>
                  </div>

                  <div className="panel flags-panel">
                    <h3>Potential review topics</h3>

                    {!analysis.flags?.length ? (
                      <p>
                        No matching topics were detected by this preliminary
                        keyword scan. This does not mean the document is risk-free.
                      </p>
                    ) : (
                      <div className="flag-list">
                        {analysis.flags.map((flag, index) => (
                          <div className="flag-item" key={`${flag.category}-${index}`}>
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
                      <strong>Important:</strong> This is a preliminary
                      keyword scan, not AI legal advice. A detected topic is
                      not necessarily risky, and this scan may miss important
                      clauses. The hash does not establish authorship, legal
                      validity, or enforceability.
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
                      Explore potential concerns and questions to discuss
                      with a lawyer.
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
          ) : (
            <section className="panel coming-soon">
              <div className="coming-icon">
                {activeTab === "verification" ? "⬡" : "▧"}
              </div>
              <h3>
                {activeTab === "verification"
                  ? "Blockchain verification"
                  : "Document reports"}
              </h3>
              <p>
                {activeTab === "verification"
                  ? "On-chain hash registration and verification will be added after the smart contract is implemented."
                  : "Downloadable reports will be added after report generation is implemented."}
              </p>
              <span className="step-badge">IN DEVELOPMENT</span>
              <button
                className="secondary-button"
                onClick={() => setActiveTab("overview")}
              >
                Back to overview
              </button>
            </section>
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