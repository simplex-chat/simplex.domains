import { createPublicClient, getAddress, http, keccak256, parseAbi, toHex, type Hex } from "viem"
import { mainnet } from "viem/chains"
import { type Deployment, MAINNET, type PriceException } from "../src/config.ts"

const RPC_URL = process.env.RPC_URL
if (!RPC_URL) throw new Error("set RPC_URL to an Ethereum mainnet RPC")

const client = createPublicClient({ chain: mainnet, transport: http(RPC_URL) })
const SPONSOR = parseAbi(["function controller() view returns (address)"])
const CONTROLLER = parseAbi([
  "function sponsor() view returns (address)",
  "function defaultResolver() view returns (address)",
  "function namePolicy() view returns (address)",
  "function tldSuffix() view returns (string)",
  "function prices() view returns (address)",
])
const ORACLE = parseAbi([
  "struct LabelPrice { uint256 labelLength; uint256 priceCentsPerYear; }",
  "function prices() view returns (uint256 base, LabelPrice[] exceptions)",
])
const POLICY = parseAbi([
  "function generalTermsLink() view returns (string)",
  "function generalTermsHash() view returns (bytes32)",
  "function communityTermsLink() view returns (string)",
  "function communityTermsHash() view returns (bytes32)",
])

const controller = await client.readContract({ address: getAddress(MAINNET.sponsor), abi: SPONSOR, functionName: "controller" })
const [chainId, sponsor, resolver, namePolicy, tldSuffix, oracle] = await Promise.all([
  client.getChainId(),
  client.readContract({ address: controller, abi: CONTROLLER, functionName: "sponsor" }),
  client.readContract({ address: controller, abi: CONTROLLER, functionName: "defaultResolver" }),
  client.readContract({ address: controller, abi: CONTROLLER, functionName: "namePolicy" }),
  client.readContract({ address: controller, abi: CONTROLLER, functionName: "tldSuffix" }),
  client.readContract({ address: controller, abi: CONTROLLER, functionName: "prices" }),
])
const [base, exceptions] = await client.readContract({ address: oracle, abi: ORACLE, functionName: "prices" })
const [generalLink, generalHash, communityLink, communityHash] = await Promise.all([
  client.readContract({ address: namePolicy, abi: POLICY, functionName: "generalTermsLink" }),
  client.readContract({ address: namePolicy, abi: POLICY, functionName: "generalTermsHash" }),
  client.readContract({ address: namePolicy, abi: POLICY, functionName: "communityTermsLink" }),
  client.readContract({ address: namePolicy, abi: POLICY, functionName: "communityTermsHash" }),
])
const general = { link: generalLink, hash: generalHash }
const community = { link: communityLink, hash: communityHash }

const priced = (list: readonly PriceException[]) => JSON.stringify([...list].sort((a, b) => a.labelLength - b.labelLength))
const chainTermsHeld = (held: Deployment["generalTerms"], terms: { link: string; hash: Hex }) =>
  keccak256(toHex(terms.link)) === terms.hash && held.some((t) => t.link === terms.link && t.hash.toLowerCase() === terms.hash.toLowerCase())

const checks: [string, unknown, unknown][] = [
  ["chain id", chainId, MAINNET.chainId],
  ["sponsor", sponsor, getAddress(MAINNET.sponsor)],
  ["resolver", resolver, getAddress(MAINNET.resolver)],
  ["name policy", namePolicy, getAddress(MAINNET.namePolicy)],
  ["TLD", tldSuffix, `.${MAINNET.tld}`],
  ["base price", base, BigInt(MAINNET.priceBaseCentsPerYear)],
  ["price exceptions", priced(exceptions.map((e) => ({ labelLength: Number(e.labelLength), centsPerYear: Number(e.priceCentsPerYear) }))), priced(MAINNET.priceExceptions)],
  [`general terms ${general.link} ${general.hash}`, chainTermsHeld(MAINNET.generalTerms, general), true],
  [`community terms ${community.link} ${community.hash}`, chainTermsHeld(MAINNET.communityTerms, community), true],
]
const differs = checks.filter(([, chain, held]) => chain !== held)
for (const [what, chain, held] of differs) console.error(`${what}: the chain has ${String(chain)}, MAINNET ${String(held)}`)
if (differs.length) process.exit(1)
console.log(`MAINNET matches chain ${chainId}: controller ${controller}, sponsor ${sponsor}, resolver ${resolver}, name policy ${namePolicy}, price oracle ${oracle}`)
