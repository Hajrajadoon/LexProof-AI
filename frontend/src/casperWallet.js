
const REQUESTS_TIMEOUT_MS = 30 * 60 * 1000;

export function getCasperWalletProvider() {
  if (typeof window === "undefined") {
    throw new Error("Casper Wallet is only available in a browser.");
  }

  const Provider = window.CasperWalletProvider;

  if (typeof Provider !== "function") {
    throw new Error(
      "Casper Wallet was not detected. Make sure the extension is enabled and refresh this page."
    );
  }

  return Provider({
    timeout: REQUESTS_TIMEOUT_MS,
  });
}

export async function connectCasperWallet() {
  const provider = getCasperWalletProvider();

  const connected = await provider.requestConnection();

  if (!connected) {
    throw new Error("Wallet connection was cancelled or not approved.");
  }

  const publicKey = await provider.getActivePublicKey();

  if (!publicKey) {
    throw new Error("Connected, but no active public key was returned.");
  }

  return { provider, publicKey };
}

export async function disconnectCasperWallet() {
  const provider = getCasperWalletProvider();
  return provider.disconnectFromSite();
}
