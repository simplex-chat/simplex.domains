// The camera reading a QR code into a field, as the app's own scan does: the platform's detector where it has one, else jsQR.
import { el, icon } from "../dom.ts"
import { readQr } from "../scan.ts"

interface Detector { detect(source: HTMLVideoElement): Promise<{ rawValue: string }[]> }
interface DetectorClass { new (options: { formats: string[] }): Detector; getSupportedFormats(): Promise<string[]> }
type Reader = (video: HTMLVideoElement) => Promise<string | null>

const QR_FORMAT = "qr_code"
// a frame is read this often, which jsQR keeps up with on a phone at the width below
const READ_EVERY_MS = 200
// the widest frame jsQR is given: a link's QR fills much of the view, so a camera's full frame only slows it
const READ_WIDTH = 640
const SCAN_TITLE_ID = "scan-title"
// a touch screen's pointer: the camera is asked about on a phone only
const TOUCH = "(pointer: coarse)"

let cameras: Promise<boolean> | null = null
// the browser lists the kinds of devices without asking for the camera, so the button shows only where one is
function hasCamera(): Promise<boolean> {
  cameras ??= navigator.mediaDevices?.enumerateDevices
    ? navigator.mediaDevices.enumerateDevices().then((devices) => devices.some((d) => d.kind === "videoinput"), () => false)
    : Promise.resolve(false)
  return cameras
}

async function nativeReader(): Promise<Reader | null> {
  const Native = (window as unknown as { BarcodeDetector?: DetectorClass }).BarcodeDetector
  if (!Native || !(await Native.getSupportedFormats().catch((): string[] => [])).includes(QR_FORMAT)) return null
  const detector = new Native({ formats: [QR_FORMAT] })
  return async (video) => (await detector.detect(video))[0]?.rawValue ?? null
}

function pixelReader(): Reader {
  const canvas = el("canvas", {})
  const context = canvas.getContext("2d", { willReadFrequently: true })!
  return (video) => {
    if (!video.videoWidth) return Promise.resolve(null)
    const scale = Math.min(1, READ_WIDTH / video.videoWidth)
    canvas.width = Math.round(video.videoWidth * scale)
    canvas.height = Math.round(video.videoHeight * scale)
    context.drawImage(video, 0, 0, canvas.width, canvas.height)
    return readQr(context.getImageData(0, 0, canvas.width, canvas.height))
  }
}

const stopTracks = (stream: MediaStream) => { for (const track of stream.getTracks()) track.stop() }

// A field's scan button, shown on a phone with a camera; `found` hears whether it has one.
export function scanButton(onclick: () => void, found?: (camera: boolean) => void): HTMLButtonElement {
  const scan = el("button", { class: "scan", type: "button", "aria-label": "Scan QR code", hidden: true, onclick }, icon("scan"))
  if (matchMedia(TOUCH).matches) {
    void hasCamera().then((camera) => {
      scan.hidden = !camera
      found?.(camera)
    })
  }
  return scan
}

// Shows the rear camera over the page, with `hint` saying what to point it at, until it reads a QR code, resolving with
// its text, or with null once closed or once `signal` ends, as the page that asked is left, the permission prompt open or
// not. A camera refused, missing or busy rejects with the browser's DOMException, and so does a reader that cannot start,
// the camera stopped.
export async function scanQr(signal: AbortSignal, hint: string): Promise<string | null> {
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false })
  if (signal.aborted) {
    stopTracks(stream)
    return null
  }
  let read: Reader
  try {
    read = await nativeReader() ?? pixelReader()
  } catch {
    stopTracks(stream)
    throw new DOMException("the QR reader did not start", "NotSupportedError")
  }
  const video = el("video", { playsinline: true, "aria-hidden": "true" })
  video.muted = true
  video.srcObject = stream
  const dialog = el("dialog", { class: "modal", "aria-labelledby": SCAN_TITLE_ID })
  const close = () => dialog.close()
  dialog.append(el("div", { class: "modal-backdrop", onclick: close }),
    el("div", { class: "pop scan-pop" },
      el("h2", { id: SCAN_TITLE_ID }, "Scan a QR code"),
      el("p", { class: "soft" }, hint),
      video,
      el("button", { class: "text-link", type: "button", onclick: close }, "Cancel")))
  return new Promise((resolve) => {
    let done = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (text: string | null) => {
      if (done) return
      done = true
      clearTimeout(timer)
      stopTracks(stream)
      signal.removeEventListener("abort", close)
      if (dialog.open) dialog.close()
      dialog.remove()
      resolve(text)
    }
    dialog.addEventListener("close", () => finish(null))
    signal.addEventListener("abort", close, { once: true })
    const look = async () => {
      const text = await read(video).catch(() => null)
      if (done) return
      if (text) return finish(text)
      timer = setTimeout(() => void look(), READ_EVERY_MS)
    }
    document.body.append(dialog)
    dialog.showModal()
    // a play cut short by Cancel rejects, with nothing left to show
    void video.play().catch(() => undefined)
    void look()
  })
}
