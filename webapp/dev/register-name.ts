import type { Address } from "viem"

export const registerNameTypedData = (chainId: number, sponsor: Address) => ({
  domain: { name: "SimplexSponsor", version: "1", chainId, verifyingContract: sponsor },
  types: {
    RegisterName: [
      { name: "label", type: "string" }, { name: "owner", type: "address" }, { name: "duration", type: "uint256" },
      { name: "resolver", type: "address" }, { name: "data", type: "bytes[]" }, { name: "disputeDays", type: "uint256" }, { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  },
  primaryType: "RegisterName",
} as const)
