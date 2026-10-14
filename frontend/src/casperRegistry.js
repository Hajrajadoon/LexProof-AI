import {
  Args,
  CLValue,
  ContractCallBuilder,
  Deploy,
  HttpHandler,
  PublicKey,
  RpcClient,
} from "casper-js-sdk";

// Payment for the register_hash call, in CSPR (testnet CSPR is free).
const PAYMENT_CSPR = Number(import.meta.env.VITE_CASPER_PAYMENT_CSPR || 10);

// Use the same format that worked on the ?deploy page.
// "legacy" = Casper 1.x deploy, "v2" = Casper 2.0 transaction.
const TX_FORMAT = import.meta.env.VITE_CASPER_TX_FORMAT || "legacy";

export async function getChainConfig(apiUrl) {
  const response = await fetch(`${apiUrl}/api/blockchain/config`);
  if (!response.ok) throw new Error("Could not load blockchain settings.");
  return response.json();
}

export async function registerHashOnChain({
  apiUrl,
  provider,
  publicKey,
  contractHash,
  network,
  documentHash,
}) {
  const pk = PublicKey.fromHex(publicKey);

  const builder = new ContractCallBuilder()
    .from(pk)
    .byHash(contractHash.replace(/^(hash-|entity-contract-)/, ""))
    .entryPoint("register_hash")
    .runtimeArgs(
      Args.fromMap({ document_hash: CLValue.newCLString(documentHash) })
    )
    .chainName(network)
    .payment(Math.round(PAYMENT_CSPR * 1e9));

  const transaction =
    TX_FORMAT === "legacy" ? builder.buildFor1_5() : builder.build();

  // The wallet signs the JSON form of the deploy / transaction.
  const legacyDeploy = transaction.getDeploy?.();
  let payload;
  if (legacyDeploy) {
    const dj = Deploy.toJSON(legacyDeploy);
    payload = dj && dj.deploy ? dj : { deploy: dj };
  } else {
    payload = transaction.toJSON();
  }

  const signed = await provider.sign(JSON.stringify(payload), publicKey);
  if (signed.cancelled) throw new Error("Signing was cancelled in the wallet.");

  // The SDK expects the algorithm byte in front of the signature.
  let sig = signed.signature;
  if (!sig && signed.signatureHex) {
    sig = Uint8Array.from(
      signed.signatureHex.match(/.{2}/g).map((b) => parseInt(b, 16))
    );
  }
  if (sig.length === 64) {
    const tagged = new Uint8Array(65);
    tagged[0] = parseInt(publicKey.slice(0, 2), 16);
    tagged.set(sig, 1);
    sig = tagged;
  }
  transaction.setSignature(sig, pk);

  // Sent through the backend proxy to avoid browser CORS problems.
  const rpc = new RpcClient(new HttpHandler(`${apiUrl}/api/casper/rpc`));
  const result = await rpc.putTransaction(transaction);
  const th = result.transactionHash;
  return (
    th?.deploy?.toHex?.() ??
    th?.transactionV1?.toHex?.() ??
    th?.toHex?.() ??
    String(th ?? result.deployHash ?? "")
  );
}

export async function waitForTx(apiUrl, txHash, timeoutMs = 180000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    await new Promise((r) => setTimeout(r, 6000));
    const response = await fetch(`${apiUrl}/api/blockchain/tx/${txHash}`);
    if (response.ok) {
      const data = await response.json();
      if (data.status !== "pending") return data;
    }
  }
  return { status: "pending", error: null };
}

export async function verifyHashOnChain(apiUrl, documentHash) {
  const response = await fetch(
    `${apiUrl}/api/blockchain/verify/${documentHash}`
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      typeof data.detail === "string" ? data.detail : "Verification failed."
    );
  }
  return data;
}

export async function saveChainResult(apiUrl, analysisId, body) {
  const response = await fetch(
    `${apiUrl}/api/analyses/${analysisId}/blockchain`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );
  if (!response.ok) throw new Error("Could not save the blockchain result.");
  return response.json();
}
