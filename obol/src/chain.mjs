// Robinhood Chain testnet: clients, the deployed addresses, the ABIs the Worker touches.
import { createPublicClient, createWalletClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import D from "./deployment.json" with { type: "json" };

export { D };
export const NETWORK = "eip155:46630";
export const chainOf = (rpc) => ({ id: 46630, name: "Robinhood Chain Testnet", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
export const pub = (env) => createPublicClient({ chain: chainOf(env.RPC), transport: http(env.RPC) });
export const signer = (env, key) => {
  const account = privateKeyToAccount(key.startsWith("0x") ? key : `0x${key}`);
  return { account, wallet: createWalletClient({ account, chain: chainOf(env.RPC), transport: http(env.RPC) }) };
};

export const SALE = parseAbi(["function walletOf(uint256) view returns (address)", "function sold() view returns (uint256)"]);
export const NFT = parseAbi(["function ownerOf(uint256) view returns (address)"]);
export const DOLLAR = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,bytes signature)",
]);
export const ACCOUNT = parseAbi([
  "function approvePayment(address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce) returns (bytes32)",
  "function spentToday() view returns (uint256)",
  "function constitution() view returns (address configuredBy,address agent,uint128 maxPerCall,uint128 maxPerDay,uint128 maxEthPerCall)",
]);

export const usd6 = (dec) => BigInt(Math.round(Number(dec) * 1e6)); // "0.02" → 20000n
export const fmt6 = (raw) => (Number(raw) / 1e6).toFixed(2);

/** for messages.mjs: who may speak for daemon `from` right now — its holder, and its wallet's constitution */
export const senderOf = (env) => async (from) => {
  const client = pub(env);
  const owner = await client.readContract({ address: D.nft, abi: NFT, functionName: "ownerOf", args: [BigInt(from)] }).catch(() => null);
  if (!owner) return null;
  const w = await client.readContract({ address: D.sale, abi: SALE, functionName: "walletOf", args: [BigInt(from)] });
  const [configuredBy, agent] = await client.readContract({ address: w, abi: ACCOUNT, functionName: "constitution" });
  return { owner, agent, configuredBy };
};
