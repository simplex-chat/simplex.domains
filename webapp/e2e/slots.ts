// Each worker's mock and page server listen on the first slot's ports plus the slot's index, as its chain does.
const MOCK_PORT = 8099
const PAGE_PORT = 5173

export const mockUrl = (slot: number) => `http://127.0.0.1:${MOCK_PORT + slot}`
export const pagePort = (slot: number) => PAGE_PORT + slot
export const pageUrl = (slot: number) => `http://127.0.0.1:${pagePort(slot)}`
