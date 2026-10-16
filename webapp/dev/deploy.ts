// Deploys the .simplex contracts (ens-contracts PR #36) to a running local node for the names webapp,
// wired as the PR's test fixture wires them, and seeds names in every state search can answer.
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  createPublicClient, createWalletClient, encodeFunctionData, getAddress, http, labelhash, namehash, zeroAddress, zeroHash,
  type Abi, type Address, type Hex,
} from "viem"
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts"
import { foundry } from "viem/chains"
import { durationFor } from "../src/crypto/registration.ts"

const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8545"
const ENS_CONTRACTS_DIR = process.env.ENS_CONTRACTS_DIR
const OUT = process.env.LOCAL_CHAIN_OUT ?? new URL("./local-chain.json", import.meta.url).pathname
const TLD = process.env.SIMPLEX_TLD ?? "simplex"
// the PR's deploy scripts use 60 s; tests shorten it to keep runs quick
const MIN_COMMITMENT_AGE = BigInt(process.env.MIN_COMMITMENT_AGE ?? "60")
const MAX_COMMITMENT_AGE = 86400n
const MIN_CHAR_LENGTH = 6
// the DNS label limit in bytes
const MAX_LABEL_LENGTH = 63n
// Chainlink's 8 decimals; 1e8 makes 1 attoUSD cost 1 wei, as in the PR's fixture
const FEED_DECIMALS = 8
const FEED_PRICE = 100_000_000n
// the fixture's prices: $10 a year, ten times more for each letter below six
const PRICE_BASE = 1000n
const PRICE_EXCEPTIONS = [1n, 2n, 3n, 4n, 5n].map((n) => ({ labelLength: n, priceCentsPerYear: PRICE_BASE * 10n ** (6n - n) }))
// the seeded names are registered as a paid order is, with the bonus days
const SEED_YEARS = 2
// the registrar's credit in USD with 18 decimals, more than any number of test runs spends
const ALLOWANCE = 1_000_000n * 10n ** 18n
// SimplexController.Reason.Internal
const RESERVED_INTERNAL = 1
// anvil's well-known development mnemonic
const MNEMONIC = "test test test test test test test test test test test junk"

if (!ENS_CONTRACTS_DIR) throw new Error("set ENS_CONTRACTS_DIR to a compiled checkout of ens-contracts PR #36")

const [owner, guardian, registrar, holder] = [0, 1, 2, 3].map((i) => mnemonicToAccount(MNEMONIC, { addressIndex: i }))
const registrarKey = toHex(registrar.getHdKey().privateKey!)
const holderKey = toHex(holder.getHdKey().privateKey!)
const transport = http(RPC_URL)
const publicClient = createPublicClient({ chain: foundry, transport })
const wallet = createWalletClient({ chain: foundry, transport })

interface Contract { address: Address; abi: Abi }

function toHex(bytes: Uint8Array): Hex {
  return `0x${Buffer.from(bytes).toString("hex")}`
}

function artifact(path: string): { abi: Abi; bytecode: Hex } {
  return JSON.parse(readFileSync(join(ENS_CONTRACTS_DIR!, "artifacts/contracts", path), "utf8"))
}

async function deploy(path: string, args: unknown[]): Promise<Contract> {
  const { abi, bytecode } = artifact(path)
  const hash = await wallet.deployContract({ account: owner, abi, bytecode, args })
  const { contractAddress } = await publicClient.waitForTransactionReceipt({ hash })
  return { address: getAddress(contractAddress!), abi }
}

async function write(from: typeof owner, contract: Contract, functionName: string, args: unknown[]): Promise<void> {
  const hash = await wallet.writeContract({ account: from, address: contract.address, abi: contract.abi, functionName, args })
  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  if (receipt.status !== "success") throw new Error(`${functionName} reverted`)
}

const tldNode = namehash(TLD)
const ens = await deploy("registry/ENSRegistry.sol/ENSRegistry.json", [])
const baseRegistrar = await deploy("ethregistrar/BaseRegistrarImplementation.sol/BaseRegistrarImplementation.json", [ens.address, tldNode])
await write(owner, ens, "setSubnodeOwner", [zeroHash, labelhash(TLD), baseRegistrar.address])
await write(owner, baseRegistrar, "setMaxLabelLength", [MAX_LABEL_LENGTH])
const feed = await deploy("ethregistrar/DummyOracle.sol/DummyOracle.json", [FEED_PRICE])
const priceOracle = await deploy("simplex/SimplexPriceOracle.sol/SimplexPriceOracle.json", [feed.address, FEED_DECIMALS, PRICE_BASE, PRICE_EXCEPTIONS])
const implementation = await deploy("simplex/SimplexController.sol/SimplexController.json", [])
const initData = encodeFunctionData({
  abi: implementation.abi,
  functionName: "initialize",
  args: [baseRegistrar.address, priceOracle.address, MIN_COMMITMENT_AGE, MAX_COMMITMENT_AGE, ens.address,
    { tldNode, tldSuffix: `.${TLD}`, minCharLength: MIN_CHAR_LENGTH, smpxNft: zeroAddress, nftGateEnabled: false }, owner.address],
})
const proxy = await deploy("simplex/SimplexControllerProxy.sol/SimplexControllerProxy.json", [implementation.address, initData])
const controller = { address: proxy.address, abi: implementation.abi }
const subnameRegistrar = await deploy("simplex/SubnameRegistrar.sol/SubnameRegistrar.json", [ens.address, baseRegistrar.address])
const resolver = await deploy("simplex/SimplexResolver.sol/SimplexResolver.json", [ens.address, subnameRegistrar.address, controller.address, zeroAddress])
await write(owner, subnameRegistrar, "setResolver", [resolver.address])
await write(owner, baseRegistrar, "addController", [controller.address])
await write(owner, baseRegistrar, "setSubnameHook", [subnameRegistrar.address])
await write(owner, controller, "setDefaultResolver", [resolver.address])
await write(owner, controller, "setBeneficiary", [guardian.address])
const sponsor = await deploy("simplex/SimplexSponsor.sol/SimplexSponsor.json", [controller.address])
await write(owner, controller, "setSponsor", [sponsor.address])
await write(guardian, sponsor, "setRegistrarAllowance", [registrar.address, ALLOWANCE])
await write(owner, controller, "addReservedNames", [["support", "simplex", "official"], RESERVED_INTERNAL])

const chainId = await publicClient.getChainId()
const holderAccount = privateKeyToAccount(holderKey)

const REGISTER_TYPES = {
  RegisterName: [
    { name: "label", type: "string" }, { name: "owner", type: "address" }, { name: "duration", type: "uint256" },
    { name: "resolver", type: "address" }, { name: "data", type: "bytes[]" }, { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const

// A name registered to the holder through the sponsor, as the store's service registers names.
function seedRegistration(label: string, records: Record<string, string>) {
  const node = namehash(`${label}.${TLD}`)
  const data = Object.entries(records).map(([key, value]) =>
    encodeFunctionData({ abi: resolver.abi, functionName: "setText", args: [node, key, value] }))
  return {
    label, owner: holder.address, duration: durationFor(SEED_YEARS), secret: toHex(crypto.getRandomValues(new Uint8Array(32))),
    resolver: resolver.address, data, reverseRecord: 0, referrer: zeroHash,
  }
}

const seeds = [
  seedRegistration("bakery", {
    "simplex.contact": "https://smp8.simplex.im/a#Y8m3qT0vLw2Ab7cD9eF1gH3jK5mN7pQ9rS",
    "simplex.channel": "https://smp9.simplex.im/c#Rk27xN4pDe9Tz1Wb3Yc5Vd7Xf9Hg2Jk4Lm",
  }),
  seedRegistration("harbour", {}),
]
for (const registration of seeds) {
  await write(registrar, controller, "commit", [await publicClient.readContract({ ...controller, functionName: "makeCommitment", args: [registration] })])
}
// the controller makes every registration wait after its commit; the node mines in real time, so wait it out
await new Promise((resolve) => setTimeout(resolve, (Number(MIN_COMMITMENT_AGE) + 2) * 1000))
for (const registration of seeds) {
  const nonce = await publicClient.readContract({ ...sponsor, functionName: "nonces", args: [holder.address] }) as bigint
  const deadline = (await publicClient.getBlock()).timestamp + 3600n
  const signature = await holderAccount.signTypedData({
    domain: { name: "SimplexSponsor", version: "1", chainId, verifyingContract: sponsor.address },
    types: REGISTER_TYPES,
    primaryType: "RegisterName",
    message: { ...registration, nonce, deadline },
  })
  await write(registrar, sponsor, "registerWithCredit", [registration, nonce, deadline, signature])
}

const deployment = {
  rpcUrl: RPC_URL,
  chainId,
  tld: TLD,
  ens: ens.address,
  baseRegistrar: baseRegistrar.address,
  controller: controller.address,
  sponsor: sponsor.address,
  resolver: resolver.address,
  owner: owner.address,
  guardian: guardian.address,
  registrar: registrar.address,
  registrarKey,
  holder: holder.address,
  holderKey,
  minCommitmentAge: Number(MIN_COMMITMENT_AGE),
  maxCommitmentAge: Number(MAX_COMMITMENT_AGE),
}
writeFileSync(OUT, JSON.stringify(deployment, null, 2) + "\n")
console.log(`deployed .${TLD} on chain ${chainId}: controller ${controller.address}, sponsor ${sponsor.address}, resolver ${resolver.address}`)
console.log(`wrote ${OUT}`)
