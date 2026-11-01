// The mock service's view of the local chain: the deployment, its contracts, and the registrar key that pays gas.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  BaseError, ContractFunctionRevertedError, createPublicClient, createWalletClient, decodeErrorResult, encodeFunctionData, getAddress, http, keccak256,
  type Abi, type Address, type Hex,
} from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { foundry } from "viem/chains"
import { BLOCK_POLL_MS } from "../chain-time.ts"

export interface Deployment {
  rpcUrl: string
  chainId: number
  tld: string
  ens: Address
  baseRegistrar: Address
  controller: Address
  sponsor: Address
  resolver: Address
  namePolicy: Address
  generalTermsLink: string
  communityTermsLink: string
  ownerKey: Hex
  registrarKey: Hex
  holderKey: Hex
  minCommitmentAge: number
  maxCommitmentAge: number
}

const ENS_CONTRACTS_DIR = process.env.ENS_CONTRACTS_DIR
if (!ENS_CONTRACTS_DIR) throw new Error("set ENS_CONTRACTS_DIR to the compiled ens-contracts checkout the chain was deployed from")

export const deployment: Deployment = JSON.parse(readFileSync(process.env.LOCAL_CHAIN_OUT ?? new URL("../local-chain.json", import.meta.url).pathname, "utf8"))

function abiOf(path: string): Abi {
  return JSON.parse(readFileSync(join(ENS_CONTRACTS_DIR!, "artifacts/contracts", path), "utf8")).abi
}

export const controller = { address: deployment.controller, abi: abiOf("simplex/SimplexController.sol/SimplexController.json") }
export const sponsor = { address: deployment.sponsor, abi: abiOf("simplex/SimplexSponsor.sol/SimplexSponsor.json") }
export const baseRegistrar = { address: deployment.baseRegistrar, abi: abiOf("ethregistrar/BaseRegistrarImplementation.sol/BaseRegistrarImplementation.json") }
export const resolver = { address: deployment.resolver, abi: abiOf("simplex/SimplexResolver.sol/SimplexResolver.json") }
export const registry = { address: deployment.ens, abi: abiOf("registry/ENSRegistry.sol/ENSRegistry.json") }
export const namePolicy = { address: deployment.namePolicy, abi: abiOf("simplex/SimplexNamePolicy.sol/SimplexNamePolicy.json") }
// the sponsor passes the controller's, the name policy's and the base registrar's reverts through
const revertAbi = [...sponsor.abi, ...controller.abi, ...namePolicy.abi, ...baseRegistrar.abi, ...resolver.abi].filter((item) => item.type === "error")

// A transaction held up at the node is waited for, as the service answers an edit or a registration once it is mined;
// a read or a dry run that hangs gives up much sooner, and the service's own loop tries a transaction again.
const SEND_TIMEOUT_MS = 60_000
const READ_TIMEOUT_MS = 10_000

export const registrar = privateKeyToAccount(deployment.registrarKey)
// the contracts' owner, whose key the /control endpoints use to list community names and set their terms
export const contractsOwner = privateKeyToAccount(deployment.ownerKey)
export const holder = privateKeyToAccount(deployment.holderKey)
const chain = { ...foundry, id: deployment.chainId }
// one quick retry for a read, as a provider drops a request now and then; a send is never retried, which could send twice
const readTransport = http(deployment.rpcUrl, { timeout: READ_TIMEOUT_MS, retryCount: 1 })
const publicClient = createPublicClient({ chain, transport: readTransport, pollingInterval: BLOCK_POLL_MS })
const walletClient = createWalletClient({ chain, transport: readTransport })
const sender = createPublicClient({ chain, transport: http(deployment.rpcUrl, { timeout: SEND_TIMEOUT_MS, retryCount: 0 }), pollingInterval: BLOCK_POLL_MS })

type Contract = { address: Address; abi: Abi }

export function read<T>(contract: Contract, functionName: string, args: unknown[] = []): Promise<T> {
  return publicClient.readContract({ ...contract, functionName, args }) as Promise<T>
}

export class Reverted extends Error {
  readonly revert: string | null
  constructor(revert: string | null) {
    super(`reverted ${revert ?? "without a reason"}`)
    this.revert = revert
  }
}

// a transaction the chain did not answer before it went out: nothing was sent, so sending again is safe
export class NotSent extends Error {
  constructor() {
    super("the transaction was not sent")
  }
}

// A node's revert carries its data or says "execution reverted", which geth answers without data and viem then leaves
// as a plain RPC error; viem reads any internal RPC error (-32603) as a revert, as some nodes answer reverts with it.
function isRevert(e: unknown): boolean {
  if (!(e instanceof BaseError)) return false
  const reverted = e.walk((x) => x instanceof ContractFunctionRevertedError)
  if (reverted instanceof ContractFunctionRevertedError && reverted.raw !== undefined) return true
  return e.walk((x) => x instanceof BaseError && /execution reverted/i.test(x.details ?? "")) !== null
}

// The revert's name from its data, wherever in the error it is: a dry run's revert carries it decoded as raw, a gas
// estimate's as the RPC error's data.
function revertName(e: unknown): string | null {
  if (!(e instanceof BaseError)) return null
  const reverted = e.walk((x) => x instanceof ContractFunctionRevertedError)
  const raw = reverted instanceof ContractFunctionRevertedError && reverted.raw ? reverted.raw : null
  const carried = e.walk((x) => typeof (x as { data?: unknown }).data === "string" && /^0x[0-9a-f]{8}/i.test((x as { data: string }).data))
  const data = raw ?? (carried ? (carried as unknown as { data: Hex }).data : null)
  if (!data) return null
  try {
    return decodeErrorResult({ abi: revertAbi, data }).errorName
  } catch {
    return null
  }
}

// One transaction at a time, as the service's single sender: a dry run, the transaction made
// and signed, then the send and its receipt. Only a failure from the send on can leave a transaction on its way.
// goingOut is told the transaction's hash just before it goes out; `from` is the sending account: the owner for a
// control's change of the contracts' settings, the holder for a rival's commit.
let sending: Promise<unknown> = Promise.resolve()
export function send(contract: Contract, functionName: string, args: unknown[], goingOut?: (hash: Hex) => void, from = registrar): Promise<Hex> {
  const run = async (): Promise<Hex> => {
    let serializedTransaction: Hex
    try {
      await publicClient.simulateContract({ ...contract, functionName, args, account: from })
      const request = await walletClient.prepareTransactionRequest({
        account: from, to: contract.address, data: encodeFunctionData({ abi: contract.abi, functionName, args }), chain: null,
      })
      serializedTransaction = await walletClient.signTransaction({ ...request, chain: null })
    } catch (e) {
      throw isRevert(e) ? new Reverted(revertName(e)) : new NotSent()
    }
    goingOut?.(keccak256(serializedTransaction))
    const hash = await sender.sendRawTransaction({ serializedTransaction })
    const receipt = await sender.waitForTransactionReceipt({ hash, timeout: SEND_TIMEOUT_MS })
    if (receipt.status !== "success") throw new Reverted(null)
    return hash
  }
  const next = sending.then(run, run)
  sending = next.catch(() => undefined)
  return next
}

// whether a sent transaction succeeded, once it is mined; throws while it is not, after the send's own wait
export async function mined(hash: Hex): Promise<boolean> {
  return (await sender.waitForTransactionReceipt({ hash, timeout: SEND_TIMEOUT_MS })).status === "success"
}

export async function ownerOf(labelHash: Hex): Promise<Address | null> {
  try {
    return getAddress(await read<Address>(baseRegistrar, "ownerOf", [BigInt(labelHash)]))
  } catch (e) {
    // ownerOf reverts for a name nobody holds, which is the answer; a read that fails is not
    if (isRevert(e)) return null
    throw e
  }
}

export async function chainNow(): Promise<number> {
  return Number((await publicClient.getBlock()).timestamp)
}
