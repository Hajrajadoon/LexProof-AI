import { useState } from "react";
import {
  Args,
  Deploy,
  HttpHandler,
  PublicKey,
  RpcClient,
  SessionBuilder,
} from "casper-js-sdk";
import { connectCasperWallet } from "./casperWallet";

// One-time tool: installs lexproof_registry.wasm on a Casper network.
// The wallet signs; your secret key never leaves the extension.
export default function DeployContract() {
  const [nodeUrl, setNodeUrl] = useState("http://127.0.0.1:8000/api/casper/rpc");
  const [chainName, setChainName] = useState("casper-test");
  const [paymentCspr, setPaymentCspr] = useState("100");
  const [useLegacy, setUseLegacy] = useState(true);
  const [wasmFile, setWasmFile] = useState(null);
  const [log, setLog] = useState([]);
  const [busy, setBusy] = useState(false);

  const say = (m) => setLog((l) => [...l, m]);

  async function deploy() {
    setLog([]);
    setBusy(true);
    try {
      if (!wasmFile) throw new Error("Choose lexproof_registry.wasm first.");
      if (!nodeUrl.trim()) throw new Error("Enter a testnet node RPC URL.");

      const wasmBytes = new Uint8Array(await wasmFile.arrayBuffer());
      say(`Loaded wasm: ${wasmBytes.length} bytes`);

      const { provider, publicKey } = await connectCasperWallet();
      say(`Wallet account: ${publicKey}`);

      const pk = PublicKey.fromHex(publicKey);
      const motes = Math.round(Number(paymentCspr) * 1e9);

      const builder = new SessionBuilder()
        .from(pk)
        .chainName(chainName.trim())
        .wasm(wasmBytes)
        .installOrUpgrade()
        .runtimeArgs(Args.fromMap({}))
        .payment(motes);

      const transaction = useLegacy ? builder.buildFor1_5() : builder.build();

      // The wallet signs the JSON form of the deploy / transaction.
      const legacyDeploy = transaction.getDeploy?.();
      let payload;
      if (legacyDeploy) {
        const dj = Deploy.toJSON(legacyDeploy);
        payload = dj && dj.deploy ? dj : { deploy: dj };
      } else {
        payload = transaction.toJSON();
      }

      say(
        `Format: ${legacyDeploy ? "legacy deploy (1.x)" : "Casper 2.0 transaction"}; payload keys: ${Object.keys(payload).join(", ")}; size: ${JSON.stringify(payload).length} chars`
      );
      say("Approve the signing request in the Casper Wallet popup...");
      const signed = await provider.sign(JSON.stringify(payload), publicKey);
      say(
        `Wallet reply: cancelled=${String(signed?.cancelled)}; fields=${Object.keys(signed || {}).join(", ")}${signed?.message ? `; message=${signed.message}` : ""}`
      );

      if (signed.cancelled) {
        throw new Error(
          "Signing was cancelled (rejected in the wallet, closed, or not accepted by the wallet)."
        );
      }

      // The SDK expects the signature with its algorithm byte in front
      // (01 = ed25519, 02 = secp256k1, same as the public key's first byte).
      let sig = signed.signature;
      if (!sig && signed.signatureHex) {
        sig = Uint8Array.from(signed.signatureHex.match(/.{2}/g).map((b) => parseInt(b, 16)));
      }
      if (sig.length === 64) {
        const tagged = new Uint8Array(65);
        tagged[0] = parseInt(publicKey.slice(0, 2), 16);
        tagged.set(sig, 1);
        sig = tagged;
      }
      transaction.setSignature(sig, pk);

      const rpc = new RpcClient(new HttpHandler(nodeUrl.trim()));
      say("Sending to the network...");
      const result = await rpc.putTransaction(transaction);
      const th = result.transactionHash;
      const hash =
        th?.deploy?.toHex?.() ?? th?.transactionV1?.toHex?.() ?? th?.toHex?.() ??
        String(th ?? result.deployHash ?? "");

      say(`SENT. Transaction hash: ${hash}`);
      say(`Check it at https://testnet.cspr.live/transaction/${hash}`);
    } catch (e) {
      say(`ERROR: ${e?.message || e}`);
      console.error(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ maxWidth: 640, margin: "40px auto", padding: 16, fontFamily: "sans-serif" }}>
      <h2>Deploy LexProof registry contract</h2>
      <p>Use a testnet-only wallet account with test CSPR.</p>

      <label>RPC URL (your backend relay, which forwards to the Casper testnet node)</label>
      <input style={{ width: "100%" }} value={nodeUrl} onChange={(e) => setNodeUrl(e.target.value)} placeholder="http://<node-ip>:7777/rpc" />

      <label>Chain name</label>
      <input style={{ width: "100%" }} value={chainName} onChange={(e) => setChainName(e.target.value)} />

      <label>Payment (CSPR)</label>
      <input style={{ width: "100%" }} value={paymentCspr} onChange={(e) => setPaymentCspr(e.target.value)} />

      <label>
        <input type="checkbox" checked={useLegacy} onChange={(e) => setUseLegacy(e.target.checked)} />{" "}
        Legacy (1.x) format — untick to try the Casper 2.0 format if this fails
      </label>

      <div><input type="file" accept=".wasm" onChange={(e) => setWasmFile(e.target.files?.[0] ?? null)} /></div>

      <button onClick={deploy} disabled={busy} style={{ marginTop: 12 }}>
        {busy ? "Working..." : "Connect wallet & deploy"}
      </button>

      <pre style={{ whiteSpace: "pre-wrap", marginTop: 16 }}>{log.join("\n")}</pre>
    </div>
  );
}